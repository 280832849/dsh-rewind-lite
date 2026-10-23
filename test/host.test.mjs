/**
 * 宿主命令面的测试：用真的 @deepseek-ai/dsh-session 当会话，假 ctx/agent 驱动
 * 命令处理器。覆盖「裸命令列候选」「执行回退」「各种拒绝」和守卫。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session } from '@deepseek-ai/dsh-session';
import { apply } from '../src/host.js';

/** 造一个假 cordis ctx：记录注册的命令，effect 立即执行。 */
function fakeCtx() {
  const defs = new Map();
  const ctx = {
    commands: {
      register(definition) {
        defs.set(definition.name, definition);
        return () => defs.delete(definition.name);
      },
    },
    effect(fn) {
      return fn();
    },
    logger: { warn() {} },
  };
  return { ctx, defs };
}

/** 造一个真人用户消息。 */
function human(text, id = text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** 造一个会话 + 三条用户消息，返回会话与各事件。 */
function seededSession() {
  const session = Session.create('ses_host_test');
  const u1 = session.append('user/message', human('第一条'), { surfaceOp: 'append' });
  const u2 = session.append('user/message', human('第二条'), { surfaceOp: 'append' });
  const u3 = session.append('user/message', human('第三条'), { surfaceOp: 'append' });
  return { session, u1, u2, u3 };
}

/** 造一个假 agent，包装真会话。 */
function fakeAgent(session, overrides = {}) {
  const calls = { cancel: 0 };
  const agent = {
    status: 'idle',
    session,
    inbox: { nextStep: [] },
    cancel() {
      calls.cancel += 1;
    },
    whenIdle: async () => {},
    ...overrides,
  };
  return { agent, calls };
}

/** 调一个已注册的命令。 */
async function invoke(defs, name, agent, rawInput, signal = undefined) {
  const definition = defs.get(name);
  assert.ok(definition !== undefined, `命令 ${name} 没注册`);
  return definition.handler({ agent, rawInput, signal, commandId: 'cid' });
}

test('注册了 /rewind、/undo、/rewind-lite 三个命令', () => {
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  assert.deepEqual([...defs.keys()].sort(), ['rewind', 'rewind-lite', 'undo']);
  assert.match(defs.get('rewind').description, /回退/);
});

test('配置 enabled=false 时什么都不注册', () => {
  const { ctx, defs } = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(defs.size, 0);
});

test('裸 /rewind 只列候选，不执行', async () => {
  const { session, u1, u2 } = seededSession();
  const { agent } = fakeAgent(session);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'rewind', agent, '');
  assert.equal(result.kind, 'success');
  assert.match(result.text, new RegExp(`@${u1.seq}`));
  assert.match(result.text, new RegExp(`@${u2.seq}`));
  assert.equal(session.surface.nodes.length, 3, '列表不该改动会话');
});

test('执行回退：表面截断、日志只多一条标记、返回标记 seq', async () => {
  const { session, u1, u2, u3 } = seededSession();
  const { agent } = fakeAgent(session);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'rewind', agent, `@${u2.seq}`);
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已回退/);
  assert.equal(typeof result.sourceEventSeq, 'number');
  assert.deepEqual(session.surface.nodes, [u1.seq, result.sourceEventSeq]);
  assert.equal(session.seq, 4, '3 条消息 + 1 条标记');
  assert.equal(session.eventAt(u3.seq)?.type, 'user/message', '被撤的事件仍可读');
  assert.equal(session.surface.nodes[0], u1.seq);
});

test('/undo 与 /rewind 等价', async () => {
  const { session, u2 } = seededSession();
  const { agent } = fakeAgent(session);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'undo', agent, `@${u2.seq}`);
  assert.equal(result.kind, 'success');
});

test('目标已被遮蔽时给出人话错误，且不改会话', async () => {
  const { session, u2 } = seededSession();
  const { agent } = fakeAgent(session);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  await invoke(defs, 'rewind', agent, `@${u2.seq}`);
  const before = session.seq;
  const again = await invoke(defs, 'rewind', agent, `@${u2.seq}`);
  assert.equal(again.kind, 'error');
  assert.match(again.text, /不在模型上下文/);
  assert.equal(session.seq, before);
});

test('index 形式被拒，提示改用 @seq', async () => {
  const { session } = seededSession();
  const { agent } = fakeAgent(session);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'rewind', agent, '2');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /@<seq>/);
});

test('子会话直接拒绝', async () => {
  const { session } = seededSession();
  // 假会话：只提供 header 即可，处理在读取事件之前就返回。
  const fake = {
    id: 'child',
    header: { origin: 'subagent' },
    snapshotEvents: () => [],
    surface: { nodes: [] },
    append() {
      throw new Error('不该走到这里');
    },
  };
  const { agent } = fakeAgent(fake);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'rewind', agent, '@0');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /子代理会话/);
  assert.ok(session.seq > 0);
});

test('回合运行中：先取消、等空闲，再回退', async () => {
  const { session, u2 } = seededSession();
  const order = [];
  let cancels = 0;
  const { agent } = fakeAgent(session, {
    status: 'running',
    cancel: () => {
      cancels += 1;
      order.push('cancel');
    },
    whenIdle: async () => {
      order.push('idle');
    },
  });
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'rewind', agent, `@${u2.seq}`);
  assert.equal(result.kind, 'success');
  assert.equal(cancels, 1);
  assert.deepEqual(order, ['cancel', 'idle']);
});

test('等空闲超时：放弃回退并说明会话未改动', async () => {
  const { session, u2 } = seededSession();
  const { agent } = fakeAgent(session, {
    status: 'running',
    cancel: () => {},
    whenIdle: () => new Promise(() => {}),
  });
  const { ctx, defs } = fakeCtx();
  apply(ctx, { idleTimeoutMs: 30 });
  const before = session.seq;
  const result = await invoke(defs, 'rewind', agent, `@${u2.seq}`);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /超时/);
  assert.equal(session.seq, before);
});

test('回退顺带清掉未读 steering 插话', async () => {
  const { session, u2 } = seededSession();
  const removed = [];
  const { agent } = fakeAgent(session, {
    inbox: {
      nextStep: [{ id: 'a' }, { id: 'b' }],
      remove(id) {
        removed.push(id);
      },
    },
  });
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  await invoke(defs, 'rewind', agent, `@${u2.seq}`);
  assert.deepEqual(removed, ['a', 'b']);
});

test('未知模式明确拒绝', async () => {
  const { session, u2 } = seededSession();
  const { agent } = fakeAgent(session);
  const { ctx, defs } = fakeCtx();
  apply(ctx, {});
  const result = await invoke(defs, 'rewind-lite', agent, `@${u2.seq} foo`);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /chat.*both/);
});
