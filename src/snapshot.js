/**
 * 文件快照：写前备份 + 回退时还原。
 *
 * 只跟踪 write / edit 两个写类工具：在工具执行前把原文件按字节复制到快照目录，
 * 执行成功后提交到「最近一条用户消息 seq」这个锚点下。回退到 N 时，每个文件取
 * 「锚点 >= N 的最早一条」——那就是 N 之后第一次被改之前的状态：
 *   - 当时文件已存在（existed=true）→ 写回那份内容；
 *   - 当时还不存在（existed=false）→ 说明是 N 之后新建的，删掉。
 *
 * 刻意不做（对比开源版 132KB 的快照引擎）：去重、journal、崩溃续做、自动清理、
 * 版本迁移。换来的是可读、可测、能自己维护。代价写在 README「已知限制」里。
 *
 * 目录结构：
 *   <root>/<sessionId>/<anchorSeq>/<sha1(path)>.json   条目元数据
 *   <root>/<sessionId>/<anchorSeq>/<sha1(path)>.before 原字节
 *   <root>/<sessionId>/.pending/<uuid>                  写前暂存
 *
 * @module dsh-rewind-lite/snapshot
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** 跟踪的写类工具。 */
export const TRACKED_TOOLS = new Set(['write', 'edit']);

/** 单个文件备份上限（超过就不备份、也不记录，避免误删大文件）。 */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 从工具参数里取被写的路径。 */
export function mutationPathOf(exec) {
  if (!TRACKED_TOOLS.has(exec?.name)) return undefined;
  const args = exec.arguments ?? {};
  const path = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : undefined;
  return path === undefined ? undefined : path;
}

/** 子代理会话不跟踪、不还原（它的会话不接受通用 RPC，回退也落不到父会话）。 */
export function isSubagentSession(session) {
  const header = session?.header ?? {};
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0;
}

/** 会话里最新的真人用户消息 seq（提交快照用的锚点）；还没有就 0。 */
export function latestHumanSeq(session) {
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return 0;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') return event.seq;
  }
  return 0;
}

/** 路径是否在根目录内（词法判断，防 `../` 越界）。 */
export function insideRoot(root, path) {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(r + sep);
}

/** sha1(path) 作为条目文件名，一个文件在同一锚点下只有一条记录。 */
function keyOf(path) {
  return createHash('sha1').update(path).digest('hex');
}

/** 条目在盘上的读取结果。 */
function entryOf(anchorSeq, raw) {
  return {
    anchorSeq,
    path: raw.path,
    existed: raw.existed === true,
    mode: typeof raw.mode === 'number' ? raw.mode : undefined,
    time: typeof raw.time === 'number' ? raw.time : 0,
    callId: raw.callId,
    size: raw.size,
  };
}

/**
 * 纯规划：从条目清单算出要还原什么（不碰磁盘，方便单测）。
 * @param {{anchorSeq:number,path:string,existed:boolean,time:number}[]} entries
 * @param {number} targetSeq
 * @returns {{path:string,action:'write'|'delete',entry:any}[]}
 */
export function planRestoreFrom(entries, targetSeq) {
  const byPath = new Map();
  for (const entry of entries) {
    if (entry.anchorSeq < targetSeq) continue;
    const current = byPath.get(entry.path);
    // 取锚点最早的一条；同锚点按时间最早（一次工具调用内多次写只保留第一次的 before）
    if (current === undefined || entry.anchorSeq < current.anchorSeq || (entry.anchorSeq === current.anchorSeq && entry.time < current.time)) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()]
    .map((entry) => ({ path: entry.path, action: entry.existed ? 'write' : 'delete', entry }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 快照仓库。 */
export class SnapshotStore {
  /**
   * @param {{root:string,maxFileBytes?:number}} options
   */
  constructor({ root, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
    this.root = resolve(root);
    this.maxFileBytes = maxFileBytes;
  }

  sessionDir(sessionId) {
    return join(this.root, String(sessionId));
  }

  /** 把原文件字节暂存到 .pending/，返回暂存路径。 */
  async stage(sourcePath) {
    const pendingDir = join(this.root, '.pending');
    await mkdir(pendingDir, { recursive: true });
    const staged = join(pendingDir, `${randomUUID()}.bin`);
    await copyFile(sourcePath, staged);
    return staged;
  }

  /** 丢弃暂存（失败/取消时）。 */
  async discard(staged) {
    if (typeof staged !== 'string') return;
    await rm(staged, { force: true }).catch(() => {});
  }

  /**
   * 提交一条备份。同一锚点同一路径只记第一次（那才是「改之前」的状态）。
   * @param {string} sessionId
   * @param {number} anchorSeq
   * @param {{path:string,existed:boolean,mode?:number,callId?:string,staged?:string,size?:number}} capture
   */
  async record(sessionId, anchorSeq, capture) {
    const dir = join(this.sessionDir(sessionId), String(anchorSeq));
    const base = keyOf(capture.path);
    const metaPath = join(dir, `${base}.json`);
    try {
      await stat(metaPath);
      // 已有一条：保留更早的那份，暂存丢弃。
      await this.discard(capture.staged);
      return false;
    } catch {
      /* 没有记录，继续写 */
    }
    await mkdir(dir, { recursive: true });
    const meta = {
      path: capture.path,
      existed: capture.existed === true,
      mode: capture.mode,
      time: Date.now(),
      callId: capture.callId,
      size: capture.size,
    };
    if (meta.existed && typeof capture.staged === 'string') {
      await rename(capture.staged, join(dir, `${base}.before`));
    }
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return true;
  }

  /** 读一个会话的全部条目。 */
  async list(sessionId) {
    const dir = this.sessionDir(sessionId);
    let anchors;
    try {
      anchors = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = [];
    for (const anchor of anchors) {
      if (!anchor.isDirectory()) continue;
      const anchorSeq = Number(anchor.name);
      if (!Number.isSafeInteger(anchorSeq)) continue;
      const anchorDir = join(dir, anchor.name);
      let files;
      try {
        files = await readdir(anchorDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(await readFile(join(anchorDir, file), 'utf8'));
          if (typeof raw?.path === 'string') entries.push(entryOf(anchorSeq, raw));
        } catch {
          /* 坏条目跳过：宁可少还原，不可乱还原 */
        }
      }
    }
    return entries;
  }

  /** 锚点目录里某条目的 before 字节路径。 */
  beforePathOf(sessionId, entry) {
    return join(this.sessionDir(sessionId), String(entry.anchorSeq), `${keyOf(entry.path)}.before`);
  }

  /** 纯规划（磁盘无关）。 */
  async planRestore(sessionId, targetSeq) {
    return planRestoreFrom(await this.list(sessionId), targetSeq);
  }

  /**
   * 执行还原计划。只写回记录过的路径，且必须落在 cwd 内；符号链接一律拒绝。
   * @param {string} sessionId
   * @param {{path:string,action:'write'|'delete',entry:any}[]} plan
   * @param {{cwd:string}} options
   * @returns {Promise<{restored:string[],deleted:string[],skipped:string[],failed:{path:string,reason:string}[]}>}
   */
  async applyRestore(sessionId, plan, { cwd }) {
    const result = { restored: [], deleted: [], skipped: [], failed: [] };
    for (const item of plan) {
      const { path, action, entry } = item;
      if (!insideRoot(cwd, path)) {
        result.failed.push({ path, reason: '不在会话工作目录内，拒绝还原' });
        continue;
      }
      try {
        if (action === 'delete') {
          const info = await stat(path).catch(() => undefined);
          if (info === undefined) {
            result.skipped.push(path);
            continue;
          }
          if (!info.isFile()) {
            result.failed.push({ path, reason: '不是普通文件，拒绝删除' });
            continue;
          }
          await unlink(path);
          result.deleted.push(path);
          continue;
        }
        const staged = this.beforePathOf(sessionId, entry);
        const before = await readFile(staged);
        const current = await readFile(path).catch(() => undefined);
        if (current !== undefined && current.equals(before)) {
          result.skipped.push(path);
          continue;
        }
        // 原子写：同目录临时文件 + rename；保留原权限位。
        const tmp = join(dirname(path), `.rewind-lite-${randomUUID()}.tmp`);
        await writeFile(tmp, before, { mode: entry.mode ?? 0o644 });
        await rename(tmp, path);
        if (typeof entry.mode === 'number') await chmod(path, entry.mode).catch(() => {});
        result.restored.push(path);
      } catch (error) {
        result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }
}
