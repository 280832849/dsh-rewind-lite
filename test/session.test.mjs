/**
 * 离线不变量测试：真的用 @deepseek-ai/dsh-session 建会话，验证
 * 「追加一条 replace 标记 = 模型上下文截断」这件事在本机安装的 SDK 版本上成立。
 * 没有 harness、没有网络、不碰真实会话。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Session, foldSurface } from '@deepseek-ai/dsh-session';
import { buildMarker, MARKER_TEXT } from '../src/marker.js';
import { listCandidates, planRewind } from '../src/plan.js';

/** 造一条真人用户消息载荷。 */
function human(text, id = text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** 造一条「注入上下文」——user/message 但 source 不是 user。 */
function injected(text, id = text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-skill-badge' } };
}

/** 追加一条回退标记（和 host.js 里的执行路径一致）。 */
function rewindTo(session, targetSeq) {
  const plan = planRewind(session.snapshotEvents(), session.surface.nodes, { kind: 'seq', seq: targetSeq });
  const marker = session.append('user/message', buildMarker(), {
    surfaceOp: { op: 'replace', startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
    sourceEventSeqs: [...plan.shadowedSeqs],
  });
  return { plan, marker };
}

test('回退到某条消息：表面截断，日志只增不减', () => {
  const session = Session.create('ses_rewind_test');
  const u1 = session.append('user/message', human('第一条'), { surfaceOp: 'append' });
  const u2 = session.append('user/message', human('第二条'), { surfaceOp: 'append' });
  const u3 = session.append('user/message', human('第三条'), { surfaceOp: 'append' });
  assert.deepEqual(session.surface.nodes, [u1.seq, u2.seq, u3.seq]);

  const { plan, marker } = rewindTo(session, u2.seq);
  assert.equal(plan.targetSeq, u2.seq);
  assert.deepEqual(plan.shadowedSeqs, [u2.seq, u3.seq], '目标消息本身也在撤回范围内');
  assert.deepEqual(session.surface.nodes, [u1.seq, marker.seq], '表面只剩目标之前 + 标记');
  assert.equal(session.seq, 4, '日志长度为 4（只多一条标记）');
  assert.equal(session.eventAt(u3.seq)?.type, 'user/message', '被撤回的事件仍在日志里');
});

test('回退后继续发言，新消息挂在标记之后', () => {
  const session = Session.create('ses_rewind_test2');
  const u1 = session.append('user/message', human('a'), { surfaceOp: 'append' });
  const u2 = session.append('user/message', human('b'), { surfaceOp: 'append' });
  const { marker } = rewindTo(session, u2.seq);
  const u3 = session.append('user/message', human('改好的 b'), { surfaceOp: 'append' });
  assert.deepEqual(session.surface.nodes, [u1.seq, marker.seq, u3.seq]);
});

test('连环回退：可以再回退到更早的消息，跨过已有标记', () => {
  const session = Session.create('ses_rewind_test3');
  const u1 = session.append('user/message', human('a'), { surfaceOp: 'append' });
  const u2 = session.append('user/message', human('b'), { surfaceOp: 'append' });
  const u3 = session.append('user/message', human('c'), { surfaceOp: 'append' });
  rewindTo(session, u3.seq);
  const u4 = session.append('user/message', human('c2'), { surfaceOp: 'append' });
  const { marker: marker2 } = rewindTo(session, u1.seq);
  assert.deepEqual(session.surface.nodes, [marker2.seq]);
  assert.ok(u2.seq > 0 && u4.seq > 0);
});

test('目标已被遮蔽时拒绝回退', () => {
  const session = Session.create('ses_rewind_test4');
  session.append('user/message', human('a'), { surfaceOp: 'append' });
  const u2 = session.append('user/message', human('b'), { surfaceOp: 'append' });
  rewindTo(session, u2.seq);
  assert.throws(
    () => rewindTo(session, u2.seq),
    (error) => error.code === 'not-on-surface',
    '被撤回过的消息不能再回退一次',
  );
});

test('注入上下文不是合法回退目标', () => {
  const session = Session.create('ses_rewind_test5');
  session.append('user/message', human('a'), { surfaceOp: 'append' });
  const ctxEvent = session.append('user/message', injected('【技能内容】'), { surfaceOp: 'append' });
  assert.throws(
    () => rewindTo(session, ctxEvent.seq),
    (error) => error.code === 'not-a-user-message',
  );
  const candidates = listCandidates(session.snapshotEvents(), session.surface.nodes);
  assert.equal(candidates.length, 1, '列表里只出现真人消息');
});

test('日志重放得到同样的表面（重启/重载后一致）', () => {
  const session = Session.create('ses_rewind_test6');
  const u1 = session.append('user/message', human('a'), { surfaceOp: 'append' });
  const u2 = session.append('user/message', human('b'), { surfaceOp: 'append' });
  rewindTo(session, u2.seq);
  const replay = foldSurface(session.snapshotEvents());
  assert.deepEqual(replay.nodes, session.surface.nodes);
  assert.ok(u1.seq === 0);
});

test('标记不是空文本（严格网关会 400）', () => {
  const marker = buildMarker();
  const text = marker.content.map((block) => block.text ?? '').join('');
  assert.ok(text.length > 0);
  assert.equal(text, MARKER_TEXT);
  assert.equal(marker.source.kind, 'dsh-rewind-lite');
});
