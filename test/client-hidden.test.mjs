/**
 * 客户端纯逻辑测试：用假的聊天快照验证「隐藏哪些行」和「候选怎么算」。
 * 不需要浏览器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidatesOf, hiddenSeqsOf, messageTextAt, targetSeqOfArgs } from '../src/client/hidden.js';

/** 造一个 Map 形状的聊天快照。 */
function chatOf(nodes) {
  const map = new Map(nodes.map((node) => [node.key, node]));
  return { order: nodes.map((node) => node.key), nodes: map };
}

const userNode = (seq, text, time = seq * 1000) => ({
  key: `u${seq}`,
  kind: 'user',
  anchorSeq: seq,
  data: { seq, time, source: { kind: 'user' }, content: [{ type: 'text', text }] },
});

const assistantNode = (seq) => ({ key: `a${seq}`, kind: 'assistant', anchorSeq: seq, data: { seq } });

const commandNode = (seq, name, args, outcome) => ({
  key: `c${seq}`,
  kind: 'command',
  anchorSeq: seq,
  data: { seq, name, args, outcome },
});

test('args 里取 @seq', () => {
  assert.equal(targetSeqOfArgs('@12 chat'), 12);
  assert.equal(targetSeqOfArgs('preview @3 both'), 3);
  assert.equal(targetSeqOfArgs('2 chat'), undefined);
  assert.equal(targetSeqOfArgs(null), undefined);
});

test('没有回退命令时什么都不隐藏', () => {
  const chat = chatOf([userNode(0, 'a'), assistantNode(1), userNode(2, 'b')]);
  assert.equal(hiddenSeqsOf(chat).size, 0);
});

test('一次成功回退：目标到标记之间全隐藏，命令行也隐藏', () => {
  const chat = chatOf([
    userNode(0, '第一条'),
    assistantNode(1),
    userNode(2, '第二条'),
    assistantNode(3),
    commandNode(5, 'rewind-lite', '@2 chat', { kind: 'success', sourceEventSeq: 5 }),
  ]);
  const hidden = hiddenSeqsOf(chat);
  assert.deepEqual([...hidden].sort((a, b) => a - b), [2, 3, 5]);
  assert.equal(hidden.has(0), false, '目标之前的消息保留');
});

test('失败的回退命令不隐藏（用户要看错误）', () => {
  const chat = chatOf([userNode(0, 'a'), commandNode(3, 'rewind-lite', '@9 chat', { kind: 'error', text: '失败' })]);
  assert.equal(hiddenSeqsOf(chat).size, 0);
});

test('两次回退的区间不会把中间新流量一起吞掉', () => {
  const chat = chatOf([
    userNode(0, 'a'),
    userNode(2, 'b'),
    commandNode(4, 'rewind-lite', '@2 chat', { kind: 'success', sourceEventSeq: 4 }),
    // 回退后新的发言与它自己的回退
    userNode(6, 'c'),
    commandNode(8, 'rewind-lite', '@6 chat', { kind: 'success', sourceEventSeq: 8 }),
    // 两次回退之间仍活在表面上的消息
    userNode(10, 'd'),
  ]);
  const hidden = hiddenSeqsOf(chat);
  assert.equal(hidden.has(0), false);
  assert.equal(hidden.has(2), true);
  assert.equal(hidden.has(6), true);
  assert.equal(hidden.has(10), false, '第二次回退之后的新消息不该被隐藏');
});

test('候选：只列真人消息、排除已隐藏的、最新在前', () => {
  const chat = chatOf([
    userNode(0, 'a'),
    userNode(2, 'b'),
    { key: 'i3', kind: 'user', anchorSeq: 3, data: { seq: 3, source: { kind: 'goal' }, content: [{ type: 'text', text: '注入' }] } },
    commandNode(5, 'rewind-lite', '@2 chat', { kind: 'success', sourceEventSeq: 5 }),
  ]);
  const candidates = candidatesOf(chat);
  assert.deepEqual(candidates.map((c) => c.seq), [0], '2 被隐藏、3 是注入上下文');
});

test('取回填文本', () => {
  const chat = chatOf([userNode(2, '改一下首页文案')]);
  assert.equal(messageTextAt(chat, 2), '改一下首页文案');
  assert.equal(messageTextAt(chat, 99), undefined);
});
