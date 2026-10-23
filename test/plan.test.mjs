/**
 * 纯规划逻辑的单测：不依赖 harness、不建会话。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RewindError,
  formatCandidates,
  isHumanUserMessage,
  listCandidates,
  messagePreview,
  parseTarget,
  planRewind,
} from '../src/plan.js';

const humanEvent = (seq, text, time = seq * 1000) => ({
  type: 'user/message',
  seq,
  time,
  data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
});
const assistantEvent = (seq) => ({
  type: 'assistant/message',
  seq,
  time: seq * 1000,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] },
});
const injectedEvent = (seq) => ({
  type: 'user/message',
  seq,
  time: seq * 1000,
  data: { id: `i${seq}`, role: 'user', content: [{ type: 'text', text: '注入' }], source: { kind: 'goal' } },
});

test('只认真人用户消息', () => {
  assert.equal(isHumanUserMessage(humanEvent(0, 'hi')), true);
  assert.equal(isHumanUserMessage(injectedEvent(1)), false);
  assert.equal(isHumanUserMessage(assistantEvent(2)), false);
  assert.equal(isHumanUserMessage(null), false);
});

test('候选最新在前，且排除被遮蔽的', () => {
  const events = [humanEvent(0, 'a'), assistantEvent(1), humanEvent(2, 'b'), injectedEvent(3), humanEvent(4, 'c')];
  const surface = [0, 2, 4]; // 1、3 已被遮蔽
  const candidates = listCandidates(events, surface);
  assert.deepEqual(candidates.map((c) => c.seq), [4, 2, 0]);
  assert.deepEqual(candidates.map((c) => c.index), [1, 2, 3]);

  const limited = listCandidates(events, surface, 2);
  assert.deepEqual(limited.map((c) => c.seq), [4, 2]);
});

test('预览压成一行并截断', () => {
  assert.equal(messagePreview({ content: [{ type: 'text', text: '  多行\n文本  ' }] }), '多行 文本');
  const long = messagePreview({ content: [{ type: 'text', text: 'x'.repeat(200) }] });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('…'));
  assert.equal(messagePreview({ content: [] }), '');
});

test('目标解析只接受十进制整数', () => {
  assert.deepEqual(parseTarget('@12'), { kind: 'seq', seq: 12 });
  assert.deepEqual(parseTarget(' 3 '), { kind: 'index', index: 3 });
  assert.equal(parseTarget('@1e3'), undefined);
  assert.equal(parseTarget('@0x10'), undefined);
  assert.equal(parseTarget('@'), undefined);
  assert.equal(parseTarget('0'), undefined, 'index 从 1 开始');
  assert.equal(parseTarget(''), undefined);
});

test('计划：撤回目标及其之后的一切', () => {
  const events = [humanEvent(0, 'a'), assistantEvent(1), humanEvent(2, 'b'), assistantEvent(3)];
  const plan = planRewind(events, [0, 1, 2, 3], { kind: 'seq', seq: 2 });
  assert.equal(plan.targetSeq, 2);
  assert.equal(plan.targetIndex, 2);
  assert.deepEqual(plan.shadowedSeqs, [2, 3]);
  assert.equal(plan.surfaceStart, 2);
  assert.equal(plan.surfaceEnd, 3);
});

test('计划：按最近序号选目标', () => {
  const events = [humanEvent(0, 'a'), humanEvent(2, 'b'), humanEvent(4, 'c')];
  const plan = planRewind(events, [0, 2, 4], { kind: 'index', index: 2 });
  assert.equal(plan.targetSeq, 2);
  assert.deepEqual(plan.shadowedSeqs, [2, 4]);
});

test('计划：三种拒绝', () => {
  const events = [humanEvent(0, 'a'), assistantEvent(1), humanEvent(2, 'b')];
  assert.throws(
    () => planRewind(events, [0, 1, 2], { kind: 'index', index: 9 }),
    (error) => error instanceof RewindError && error.code === 'invalid-index',
  );
  assert.throws(
    () => planRewind(events, [0, 1], { kind: 'seq', seq: 2 }),
    (error) => error.code === 'not-on-surface',
  );
  assert.throws(
    () => planRewind(events, [0, 1, 2], { kind: 'seq', seq: 1 }),
    (error) => error.code === 'not-a-user-message',
  );
});

test('候选列表渲染成人话', () => {
  const text = formatCandidates([{ seq: 7, time: Date.UTC(2026, 9, 23, 4, 5), preview: '改一下首页', index: 1 }]);
  assert.match(text, /@7/);
  assert.match(text, /改一下首页/);
  assert.match(text, /\/rewind @<seq>/);
  assert.match(formatCandidates([]), /还没有可回退/);
});
