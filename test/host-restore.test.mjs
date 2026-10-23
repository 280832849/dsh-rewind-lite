/**
 * 宿主「对话+文件」回退的端到端测试：真会话 + 真临时目录 + 真快照仓库。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session } from '@deepseek-ai/dsh-session';
import { apply } from '../src/host.js';
import { SnapshotStore } from '../src/snapshot.js';

function fakeCtx() {
  const defs = new Map();
  const ctx = {
    commands: { register: (definition) => (defs.set(definition.name, definition), () => defs.delete(definition.name)) },
    effect: (fn) => fn(),
    logger: { warn() {} },
    on: () => () => {}, // 有 on 就走工具钩子（这里不需要触发）
    get: () => undefined,
    emit: () => {},
  };
  return { ctx, defs };
}

function human(text, id = text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** 包装真会话，只补一个 cwd 的 header。 */
function sessionWithCwd(id, cwd) {
  const session = Session.create(id);
  return {
    id,
    header: { cwd },
    snapshotEvents: () => session.snapshotEvents(),
    surface: session.surface,
    append: (...args) => session.append(...args),
  };
}

async function invoke(defs, name, agent, rawInput) {
  return defs.get(name).handler({ agent, rawInput, commandId: 'cid', signal: new AbortController().signal });
}

test('对话+文件：回退时把锚点 >= 目标的改动还原', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-both-'));
  try {
    const work = join(dir, 'work');
    const snaps = join(dir, 'snaps');
    await mkdir(work, { recursive: true });
    const file = join(work, 'a.txt');
    const session = sessionWithCwd('ses_both', work);
    const u1 = session.append('user/message', human('改一下 a.txt'), { surfaceOp: 'append' });
    const u2 = session.append('user/message', human('继续'), { surfaceOp: 'append' });
    const u3 = session.append('user/message', human('再改'), { surfaceOp: 'append' });

    // 模拟 u3 之后的一次写操作：先备份，再真正改动
    await writeFile(file, '旧内容', 'utf8');
    const store = new SnapshotStore({ root: snaps });
    const staged = await store.stage(file);
    await store.record('ses_both', u3.seq, { path: file, existed: true, staged, mode: 0o644, callId: 'c1' });
    await writeFile(file, '新内容', 'utf8');

    const agent = { id: 'a1', status: 'idle', session, inbox: { nextStep: [] }, cancel() {}, whenIdle: async () => {} };
    const { ctx, defs } = fakeCtx();
    apply(ctx, { snapshotDir: snaps });

    const result = await invoke(defs, 'rewind-lite', agent, `@${u3.seq} both`);
    assert.equal(result.kind, 'success');
    assert.match(result.text, /写回 1 个文件/);
    assert.equal(await readFile(file, 'utf8'), '旧内容');
    assert.deepEqual(session.surface.nodes, [u1.seq, u2.seq, result.sourceEventSeq]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('只回退对话：文件不动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-chat-'));
  try {
    const work = join(dir, 'work');
    const snaps = join(dir, 'snaps');
    await mkdir(work, { recursive: true });
    const file = join(work, 'a.txt');
    const session = sessionWithCwd('ses_chat', work);
    const u1 = session.append('user/message', human('改 a'), { surfaceOp: 'append' });
    const u2 = session.append('user/message', human('继续'), { surfaceOp: 'append' });

    const store = new SnapshotStore({ root: snaps });
    await writeFile(file, '旧内容', 'utf8');
    const staged = await store.stage(file);
    await store.record('ses_chat', u2.seq, { path: file, existed: true, staged, mode: 0o644 });
    await writeFile(file, '新内容', 'utf8');

    const agent = { id: 'a1', status: 'idle', session, inbox: { nextStep: [] }, cancel() {}, whenIdle: async () => {} };
    const { ctx, defs } = fakeCtx();
    apply(ctx, { snapshotDir: snaps });

    const result = await invoke(defs, 'rewind', agent, `@${u2.seq}`);
    assert.equal(result.kind, 'success');
    assert.doesNotMatch(result.text, /文件还原/);
    assert.equal(await readFile(file, 'utf8'), '新内容');
    assert.deepEqual(session.surface.nodes, [u1.seq, result.sourceEventSeq]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
