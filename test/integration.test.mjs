/**
 * 集成测试：真的 cordis 上下文 + 真的命令服务 + 构建产物 lib/index.js。
 * 验证「命令真的注册进 registry、真的能执行、真的截断会话表面」。
 * 与 host.test.mjs 的区别：那边用假 ctx，这边走真服务。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import commandsPlugin from '@deepseek-ai/dsh-commands';
import { Session } from '@deepseek-ai/dsh-session';
import * as built from '../lib/index.js';

/** 起一个只装了命令服务和本插件的上下文。 */
async function boot() {
  const ctx = new Context();
  ctx.plugin(commandsPlugin);
  ctx.plugin(built);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return ctx;
}

/** 造会话 + 假 agent。 */
function makeAgent() {
  const session = Session.create(`ses_it_${Math.random().toString(36).slice(2)}`);
  session.append('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('user/message', { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二条' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  const agent = { id: 'agent-1', status: 'idle', session, inbox: { nextStep: [] }, cancel() {}, whenIdle: async () => {} };
  return { agent, session };
}

test('构建产物能被真 cordis 挂载，三个命令都进了 registry', async () => {
  const ctx = await boot();
  const { agent } = makeAgent();
  const names = ctx.commands.list(agent).map((descriptor) => descriptor.name).sort();
  assert.deepEqual(names, ['rewind', 'rewind-lite', 'undo']);
});

test('通过真 registry 执行回退：表面截断，返回标记 seq', async () => {
  const ctx = await boot();
  const { agent, session } = makeAgent();
  const definition = ctx.commands.find(agent, 'rewind');
  assert.ok(definition !== undefined);
  const result = await definition.handler({ agent, rawInput: '@1', commandId: 'cid', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.equal(typeof result.sourceEventSeq, 'number');
  assert.deepEqual(session.surface.nodes, [0, result.sourceEventSeq]);
});

test('真 registry 上裸命令只列候选', async () => {
  const ctx = await boot();
  const { agent, session } = makeAgent();
  const definition = ctx.commands.find(agent, 'rewind');
  const before = session.seq;
  const result = await definition.handler({ agent, rawInput: '', commandId: 'cid', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /@0/);
  assert.equal(session.seq, before, '列候选不改会话');
});
