/**
 * 回退的纯规划逻辑：目标解析 + 表面区间计算。
 *
 * 这个文件刻意不做任何 I/O、不引 Session —— 全部从事件日志和有序表面推导，
 * 所以能离线单测（test/plan.test.mjs）。
 *
 * 语义约定（与 dsh-session 的 surfaceOp 契约对齐）：
 *   回退到某条用户消息 = 追加一个 user/message 标记节点，它的 surfaceOp
 *   是 { op:'replace', startSeq, endSeq }，覆盖「目标消息本身 + 它之后的
 *   所有表面节点」。日志（审计、渲染记录）不动，只有模型可见表面被截断，
 *   下一次请求从目标消息之前的状态重新开始。
 *
 * @module dsh-rewind-lite/plan
 */

/** 回退标记的 source.kind，用于在日志里辨认本插件写的标记。 */
export const MARKER_SOURCE_KIND = 'dsh-rewind-lite';

/** 候选预览的最大字符数。 */
export const PREVIEW_CHARS = 80;

/** 默认候选上限（只保留最新的 N 条）。 */
export const DEFAULT_LIMIT = 50;

/** 带错误码的回退失败，宿主把 code 翻成人话。 */
export class RewindError extends Error {
  /**
   * @param {'no-user-messages'|'invalid-index'|'not-a-user-message'|'not-on-surface'|'bad-target'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'RewindError';
    this.code = code;
  }
}

/**
 * 是否是人类用户消息。
 *
 * 表面上的 user/message 不全是人发的：插件注入的上下文、压缩检查点、工具
 * 结果回填都走 user/message，只是 source.kind 不是 'user'。回退边界必须落在
 * 真人发言上，否则会把注入的上下文当成可回退的提示词。
 * @param {any} event
 */
export function isHumanUserMessage(event) {
  return (
    event !== null &&
    typeof event === 'object' &&
    event.type === 'user/message' &&
    event.data !== null &&
    typeof event.data === 'object' &&
    event.data.source !== null &&
    typeof event.data.source === 'object' &&
    event.data.source.kind === 'user'
  );
}

/** 把消息的文本块拼成一行短预览。 */
export function messagePreview(message) {
  const text = (message?.content ?? [])
    .map((block) => (block !== null && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS - 1)}…`;
}

/**
 * 列出可回退的候选：仍在表面上的用户消息，最新的在前。
 * 被压缩遮蔽掉的消息不算 —— 模型上下文已经到不了那里。
 * @param {readonly any[]} events 完整事件日志
 * @param {readonly number[]} surfaceNodes 有序表面节点 seq（session.surface.nodes）
 * @param {number} [limit]
 */
export function listCandidates(events, surfaceNodes, limit = DEFAULT_LIMIT) {
  const onSurface = new Set(surfaceNodes);
  /** @type {{seq:number,time:number,preview:string,index:number}[]} */
  const candidates = [];
  for (let i = events.length - 1; i >= 0 && candidates.length < limit; i -= 1) {
    const event = events[i];
    if (!isHumanUserMessage(event)) continue;
    if (!onSurface.has(event.seq)) continue;
    candidates.push({
      seq: event.seq,
      time: event.time,
      preview: messagePreview(event.data),
      index: candidates.length + 1,
    });
  }
  return candidates;
}

/** `@123` 形式的绝对 seq；`123` 形式的最近第 N 条。 */
const SEQ_TOKEN = /^@(\d+)$/;
const INDEX_TOKEN = /^(\d+)$/;

/**
 * 解析命令参数。两种形式都只接受十进制整数（裸 Number() 会把 @1e3、@0x10
 * 也当数字，甚至把 @ 读成 0）。
 * @param {string} raw
 * @returns {{kind:'seq',seq:number}|{kind:'index',index:number}|undefined}
 */
export function parseTarget(raw) {
  const token = String(raw ?? '').trim();
  const seq = SEQ_TOKEN.exec(token);
  if (seq !== null) {
    const value = Number(seq[1]);
    return Number.isSafeInteger(value) ? { kind: 'seq', seq: value } : undefined;
  }
  const index = INDEX_TOKEN.exec(token);
  if (index !== null) {
    const value = Number(index[1]);
    return Number.isSafeInteger(value) && value >= 1 ? { kind: 'index', index: value } : undefined;
  }
  return undefined;
}

/**
 * 把目标解析成一份经过校验的回退计划。
 * @param {readonly any[]} events
 * @param {readonly number[]} surfaceNodes
 * @param {{kind:'seq',seq:number}|{kind:'index',index:number}} target
 * @returns {{targetSeq:number,targetIndex:number,shadowedSeqs:number[],surfaceStart:number,surfaceEnd:number}}
 * @throws {RewindError}
 */
export function planRewind(events, surfaceNodes, target) {
  let targetSeq;
  if (target.kind === 'seq') {
    targetSeq = target.seq;
  } else {
    const candidate = listCandidates(events, surfaceNodes, target.index)[target.index - 1];
    if (candidate === undefined) {
      throw new RewindError('invalid-index', `没有第 ${target.index} 条可回退的消息`);
    }
    targetSeq = candidate.seq;
  }

  const targetEvent = events.find((event) => event.seq === targetSeq);
  if (targetEvent === undefined) {
    throw new RewindError('not-a-user-message', `日志里没有 seq ${targetSeq} 这条事件`);
  }
  if (!isHumanUserMessage(targetEvent)) {
    throw new RewindError('not-a-user-message', `seq ${targetSeq} 不是真人发的用户消息（${targetEvent.type}）`);
  }

  const targetIndex = surfaceNodes.indexOf(targetSeq);
  if (targetIndex === -1) {
    throw new RewindError('not-on-surface', `seq ${targetSeq} 的消息已不在模型上下文里（被压缩遮蔽），无法回退到这里`);
  }

  // 回退会把目标消息本身也撤掉（时间旅行语义：回到这条消息还没发出去的时候，
  // 文本回填到输入框重发）。所以替换区间从目标开始，而不是从目标的后面开始。
  const shadowedSeqs = surfaceNodes.slice(targetIndex);
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1],
  };
}

/** 候选列表的人话渲染（裸 /rewind 的返回值）。 */
export function formatCandidates(candidates) {
  if (candidates.length === 0) return '这条会话里还没有可回退的用户消息。';
  const lines = candidates.map((candidate) => {
    const time = new Date(candidate.time);
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    return `${candidate.index}. @${candidate.seq}  ${hh}:${mm}  ${candidate.preview || '(无文本)'}`;
  });
  return [
    '选择要回退到的消息（会撤回这条消息及其之后的所有内容，原提示词回填到输入框）：',
    ...lines,
    '用法：/rewind @<seq>    例：/rewind @123',
  ].join('\n');
}
