/**
 * dsh-rewind-lite 宿主半侧（host half）。
 *
 * 三件事：
 *   1. 注册 /rewind（含 /undo 别名）与内部引擎通道 /rewind-lite，执行时往会话
 *      日志追加一条回退标记，靠 surfaceOp.replace 截断模型可见表面；
 *   2. 写类工具（write / edit）执行前备份原文件，成功后按「最近一条用户消息」
 *      锚点提交到快照目录（src/snapshot.js）；
 *   3. 模式 both 时，回退顺带把锚点 >= 目标的文件改动还原（写回旧内容 / 删掉
 *      目标之后新建的文件）。
 *
 * 不做 i18n（本机只用中文），不建 RPC。
 *
 * 只追加、不删改会话日志：日志一个事件都不动，只多一条标记；插件没有读标记的
 * 代码，重载时由 harness 折叠日志重建表面，模型上下文自动从目标处截断。
 *
 * @module dsh-rewind-lite/host
 */

import { writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { MARKER_TEXT, buildMarker } from './marker.js';
import { RewindError, formatCandidates, listCandidates, parseTarget, planRewind } from './plan.js';
import { DEFAULT_MAX_FILE_BYTES, SnapshotStore, insideRoot, isSubagentSession, latestHumanSeq, mutationPathOf } from './snapshot.js';

/** 插件名（cordis 条目 id 与客户端 __ModuleLoader__ 条目 id 都取它）。 */
export const name = 'dsh-rewind-lite';

/** 版本号（与 package.json 保持一致，自检文件里带它）。 */
const PLUGIN_VERSION = '0.4.0';

/** 只依赖命令服务；subagent 会话判定与 cancel 都走 agent 自身 API。 */
export const inject = ['commands'];

/** 插件配置。 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用对话回退。'),
  idleTimeoutMs: Schema.number()
    .default(15000)
    .description('回退前等待正在生成的回合停下来（含 maintenance 期）的最长毫秒数。'),
  fileCheckpoint: Schema.boolean().default(true).description('写类工具执行前备份文件，回退时可一并还原。'),
  maxFileBytes: Schema.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES).description('单个文件备份上限（字节），超过则不备份也不还原。'),
  snapshotDir: Schema.string().required(false).description('快照目录，默认 <DSH_HOME>/rewind-lite-snapshots。'),
});



/** 插件加载自检文件（排查「装了没生效」时第一个看的东西）。 */
function writeLoadMarker() {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    writeFileSync(
      join(home, 'rewind-lite-loaded.json'),
      `${JSON.stringify({ version: PLUGIN_VERSION, at: new Date().toISOString(), pid: process.pid }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* 写不了不算错 */
  }
}

/** 候选上限：和 UI 能滚动的列表长度对齐，够用就行。 */
const CANDIDATE_LIMIT = 100;

/** 会话工作目录：快照路径解析和还原沙箱的根。 */
function cwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/** 解析被写路径：相对路径按会话工作目录补全。 */
function resolveTarget(session, path) {
  try {
    const cwd = cwdOf(session);
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  } catch {
    return undefined;
  }
}

/** 还原结果的人话摘要。 */
function restoreSummary(result) {
  const parts = [];
  if (result.restored.length > 0) parts.push(`写回 ${result.restored.length} 个文件`);
  if (result.deleted.length > 0) parts.push(`删除 ${result.deleted.length} 个新建文件`);
  if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个（内容已一致）`);
  if (result.failed.length > 0) parts.push(`失败 ${result.failed.length} 个：${result.failed.map((item) => `${item.path}（${item.reason}）`).join('；')}`);
  return parts.length === 0 ? '没有需要还原的文件改动' : parts.join('，');
}

/** 回退成功后展示给用户的话；seq 与条数由调用处填。 */
function successText(targetSeq, shadowedCount, restoreLine) {
  return [
    `已回退到 @${targetSeq}：撤回这条消息及其之后的 ${shadowedCount} 个上下文节点。`,
    '原提示词已回填到输入框，改完可直接重发（回退本身不可撤销，被撤内容仍留在会话日志里）。',
    restoreLine === undefined ? '' : `文件还原：${restoreLine}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 把异步等待转成带超时/取消的 Promise。 */
async function waitUntilIdle(agent, signal, timeoutMs) {
  if (signal !== undefined && signal.aborted) return false;
  let timer;
  let onAbort;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待空闲超时')), timeoutMs);
        if (signal !== undefined) {
          onAbort = () => reject(new Error('已取消'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** 清掉未读的 steering 插话：它们属于被撤掉的「未来」，留着会在下次发言前先送达。 */
function dropSteering(agent) {
  const inbox = agent?.inbox;
  if (inbox === undefined || inbox.nextStep === undefined) return;
  for (const message of [...inbox.nextStep]) {
    try {
      inbox.remove(message.id);
    } catch {
      /* 已经送出的插话移除会抛错，忽略即可 */
    }
  }
}

/** 渲染规划错误。 */
function planErrorText(error) {
  if (error instanceof RewindError) {
    const table = {
      'no-user-messages': '这条会话里还没有可回退的用户消息。',
      'invalid-index': error.message,
      'not-a-user-message': error.message,
      'not-on-surface': error.message,
      'bad-target': error.message,
    };
    return table[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把还原过的文件重新登记到 harness 的观察状态里。
 *
 * 还原走的是 node:fs 直写，harness 的 fs 服务看不到这次变更；不同步的话，模型
 * 下次再改同一个文件会被「文件已变更」拦下。拿不到 fs 服务就跳过（不影响还原本身）。
 */
async function syncObservations(ctx, agent, session, restore) {
  let fs;
  try {
    fs = ctx.get?.('fs');
  } catch {
    fs = undefined;
  }
  if (fs === undefined || typeof fs.resolve !== 'function') return;
  const cwd = cwdOf(session);
  for (const path of [...restore.restored, ...restore.deleted]) {
    try {
      const target = await fs.resolve(path, { cwd });
      const info = await fs.stat(target).catch(() => undefined);
      const observation = info === undefined ? { kind: 'absent' } : { kind: 'present', version: info.version };
      ctx.emit('fs/observed', target, observation, { agent });
    } catch {
      /* 同步失败不影响还原结果 */
    }
  }
}

/**
 * 一个命令处理器：/rewind、/undo、/rewind-lite 共用。
 * @param {any} ctx
 * @param {any} invocation
 * @param {{idleTimeoutMs:number,fileCheckpoint?:boolean}} cfg
 * @param {Set<string>} inflight 同一会话的并发回退守卫
 * @param {SnapshotStore|undefined} store 文件快照仓库
 */
async function runRewind(ctx, invocation, cfg, inflight, store) {
  const { agent } = invocation;
  const session = agent?.session;
  if (session === undefined) return { kind: 'error', text: '当前会话不可用。' };
  if (isSubagentSession(session)) {
    return { kind: 'error', text: '子代理会话不支持回退（请回到主会话操作）。' };
  }

  const events = session.snapshotEvents();
  const surface = session.surface.nodes;
  const input = String(invocation.rawInput ?? '').trim();

  // 裸命令 = 列候选，不执行。
  if (input === '') {
    return { kind: 'success', text: formatCandidates(listCandidates(events, surface, CANDIDATE_LIMIT)) };
  }

  const [rawTarget, rawMode] = input.split(/\s+/);
  const mode = rawMode ?? 'chat';
  if (mode !== 'chat' && mode !== 'both') {
    return { kind: 'error', text: `看不懂的模式「${mode}」：只支持 chat（仅对话）或 both（对话+文件）。` };
  }
  const target = parseTarget(rawTarget);
  if (target === undefined) {
    return { kind: 'error', text: `看不懂的目标「${rawTarget}」，用法：/rewind @<seq>（seq 见裸 /rewind 的列表）。` };
  }
  if (target.kind === 'index') {
    return { kind: 'error', text: '为避免和日志序号混淆，请用 @<seq> 形式指定目标，例如 /rewind @123。' };
  }

  // 同一会话并发回退会各算一份表面区间，后一次的 replace 会指向已被遮蔽的节点
  // 而直接失败 —— 在这里挡掉，给用户一句人话。
  const sessionId = String(session.id);
  if (inflight.has(sessionId)) {
    return { kind: 'error', text: '这个会话正在执行另一次回退，请稍候再试。' };
  }
  inflight.add(sessionId);
  try {
    // 正在生成的回合必须先停下：status 在 maintenance 期间也读 idle，所以不能
    // 只看 status，必须等 whenIdle() 的活动 Promise 真正结束。
    if (agent.status !== 'idle') {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
      } catch {
        /* 已经停下就无需再取消 */
      }
      const idle = await waitUntilIdle(agent, invocation.signal, cfg.idleTimeoutMs);
      if (!idle) return { kind: 'error', text: '等待当前回合停下超时，回退已放弃（会话未改动）。' };
    }
    if (invocation.signal !== undefined && invocation.signal.aborted) {
      return { kind: 'error', text: '回退已取消。' };
    }

    dropSteering(agent);

    let plan;
    try {
      plan = planRewind(session.snapshotEvents(), session.surface.nodes, target);
    } catch (error) {
      return { kind: 'error', text: planErrorText(error) };
    }

    const marker = buildMarker();
    let event;
    try {
      event = session.append('user/message', marker, {
        surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: 'error', text: `回退失败（会话未改动）：${reason}` };
    }

    // 文件还原：在对话已经回退成功之后单独做。它失败了也不会让对话回退失效。
    let restoreLine;
    if (mode === 'both') {
      if (store === undefined || cfg.fileCheckpoint === false) {
        restoreLine = '已关闭文件备份（配置 fileCheckpoint），只回退了对话。';
      } else {
        try {
          const restorePlan = await store.planRestore(sessionId, plan.targetSeq);
          if (restorePlan.length === 0) {
            restoreLine = '没有需要还原的文件改动。';
          } else {
            const outcome = await store.applyRestore(sessionId, restorePlan, { cwd: cwdOf(session) });
            await syncObservations(ctx, agent, session, outcome);
            restoreLine = restoreSummary(outcome);
          }
        } catch (error) {
          restoreLine = `还原文件时出错（对话已回退）：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    // sourceEventSeq 让客户端能把「回退从哪到哪」当成持久化事实来隐藏旧行。
    return {
      kind: 'success',
      text: successText(plan.targetSeq, plan.shadowedSeqs.length, restoreLine),
      sourceEventSeq: event.seq,
    };
  } finally {
    inflight.delete(sessionId);
  }
}

/** 工具调用 → 一次写前捕获的标识。 */
function pendingKeyOf(exec) {
  return `${exec?.agent?.id ?? 'anon'}:${exec?.callId ?? ''}`;
}

/**
 * 写前捕获：在工具真正动文件之前把原内容暂存下来。
 * 只认 write / edit；不在会话工作目录内的路径、符号链接、超过上限的文件都不备份。
 */
async function captureBefore(store, pending, exec) {
  const agent = exec?.agent;
  const session = agent?.session;
  if (session === undefined) return;
  if (isSubagentSession(session)) return;
  const path = mutationPathOf(exec);
  if (path === undefined) return;
  const abs = resolveTarget(session, path);
  if (abs === undefined || !insideRoot(cwdOf(session), abs)) return;
  const key = pendingKeyOf(exec);
  let info;
  try {
    info = await lstat(abs);
  } catch {
    // 文件不存在 = 这是一次创建，回退到这一步就该删掉它。
    pending.set(key, { path: abs, existed: false });
    return;
  }
  if (!info.isFile()) return;
  if (info.size > store.maxFileBytes) return;
  try {
    const staged = await store.stage(abs);
    pending.set(key, { path: abs, existed: true, staged, mode: info.mode & 0o7777, size: info.size });
  } catch {
    /* 备份失败就放弃这次记录（宁可少还原，不可乱还原） */
  }
}

/** 写后提交：成功才提交，锚点 = 当前最新用户消息 seq。 */
async function commitAfter(store, pending, exec, result) {
  const key = pendingKeyOf(exec);
  const capture = pending.get(key);
  if (capture === undefined) return;
  pending.delete(key);
  if (result?.isError === true) {
    await store.discard(capture.staged);
    return;
  }
  const session = exec?.agent?.session;
  if (session === undefined) {
    await store.discard(capture.staged);
    return;
  }
  try {
    await store.record(String(session.id), latestHumanSeq(session), { ...capture, callId: String(exec.callId ?? '') });
  } catch {
    await store.discard(capture.staged);
  }
}

/**
 * cordis 插件入口。
 * @param {any} ctx
 * @param {{enabled?:boolean,idleTimeoutMs?:number,fileCheckpoint?:boolean,maxFileBytes?:number,snapshotDir?:string}} config
 */
export function apply(ctx, config) {
  const cfg = {
    enabled: true,
    idleTimeoutMs: 15000,
    fileCheckpoint: true,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    snapshotDir: undefined,
    ...(config ?? {}),
  };
  if (cfg.enabled === false) return;

  // 自检标记：插件真的被 harness 加载时会写这个文件。
  // 排查「装了但没生效」时先看它（重启后时间戳没变 = 没加载）。
  writeLoadMarker();

  const inflight = new Set();

  // 快照仓库：默认放 DSH_HOME 下，测试/调试可用配置改目录。
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const store = cfg.fileCheckpoint === false
    ? undefined
    : new SnapshotStore({
        root: cfg.snapshotDir ?? join(dshHome, 'rewind-lite-snapshots'),
        maxFileBytes: cfg.maxFileBytes,
      });
  const pending = new Map();

  // 写前备份 / 写后提交：只在 harness 提供工具事件时挂（单测里的假 ctx 没有）。
  if (store !== undefined && typeof ctx.on === 'function') {
    ctx.on('tools/execute', async (exec, next) => {
      try {
        await captureBefore(store, pending, exec);
      } catch {
        /* 捕获失败不阻塞工具本身 */
      }
      return next();
    });
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        await commitAfter(store, pending, exec, result);
      } catch {
        /* 提交失败不影响工具结果 */
      }
      return next();
    });
    ctx.on('tools/result', (exec) => {
      // 工具抛错会跳过 post-execute：这里是暂存文件的兜底清理。
      const capture = pending.get(pendingKeyOf(exec));
      pending.delete(pendingKeyOf(exec));
      if (capture?.staged !== undefined) void store.discard(capture.staged);
      return undefined;
    });
  }

  /** 每个命令单独注册：某个名字被别人占了，只失去这个名字，不影响其他命令。 */
  const register = (definition) => {
    try {
      ctx.effect(() => ctx.commands.register(definition), `dsh-rewind-lite: /${definition.name}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        ctx.logger?.warn?.(`[dsh-rewind-lite] 注册 /${definition.name} 失败：${reason}`);
      } catch {
        /* 日志不可用就算了 */
      }
    }
  };

  const handler = (invocation) => runRewind(ctx, invocation, cfg, inflight, store);

  register({
    name: 'rewind',
    description: '回退对话到更早的用户消息，可一并还原文件（撤回该消息及其之后内容，原提示词回填输入框）',
    input: { hint: '裸命令看候选；/rewind @<seq> [chat|both] 执行回退' },
    handler,
  });
  register({
    name: 'undo',
    description: '同 /rewind：回退对话到更早的用户消息',
    input: { hint: '裸命令看候选；/undo @<seq> [chat|both] 执行回退' },
    handler,
  });
  register({
    name: 'rewind-lite',
    description: '内部通道：@<seq> chat|both（客户端按钮调用，请勿手输）',
    input: { hint: '@<seq> chat|both' },
    handler,
  });
}

/** 给测试用：导出占位文本，避免测试里写死字符串。 */
export { MARKER_TEXT };
