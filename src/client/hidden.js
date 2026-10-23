/**
 * 客户端纯计算：算出「哪些聊天行要隐藏」。
 *
 * 为什么要隐藏：DSH 的聊天界面渲染的是追加记录（transcript），不是模型表面。
 * 回退只截断模型表面，所以旧消息仍会显示 —— 必须由客户端把它们藏起来，用户
 * 看到的才和模型看到的一致。
 *
 * 数据来源是持久化的 command 节点：每次成功执行都落在会话日志里（
 * /rewind-lite @12 chat），带 outcome.sourceEventSeq（= 回退标记的 seq）。
 * 所以「刷新页面 / 切会话 / 重启 DSH 之后仍然隐藏」，不依赖内存状态。
 *
 * @module dsh-rewind-lite/client/hidden
 */

/** 执行过回退的命令名（引擎通道 + 人类命令都要认）。 */
export const ENGINE_COMMANDS = new Set(['rewind-lite', 'rewind', 'undo']);

/**
 * 从命令参数里取回退目标 seq（`@12 chat` → 12）。
 * 只看结构化 args，不去解析宿主的返回文案（文案会变、会本地化）。
 * @param {unknown} args
 * @returns {number|undefined}
 */
export function targetSeqOfArgs(args) {
  const match = String(args ?? '').match(/@(\d+)/);
  return match === null ? undefined : Number(match[1]);
}

/** 一条回退切掉的区间：[目标消息 seq, 标记 seq]，闭区间。 */
function spansOf(snap) {
  const spans = [];
  if (snap === undefined || snap === null || !Array.isArray(snap.order)) return spans;
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === undefined || node.kind !== 'command') continue;
    const command = node.data ?? {};
    if (!ENGINE_COMMANDS.has(command.name)) continue;
    // 失败的执行必须留着可见（用户要看错误），只有成功且带标记的才产生区间。
    if (command.outcome?.kind !== 'success') continue;
    const marker = command.outcome.sourceEventSeq;
    if (typeof marker !== 'number') continue;
    const target = targetSeqOfArgs(command.args);
    if (target === undefined) continue;
    spans.push({ start: target, end: marker });
  }
  return spans;
}

/** 合并重叠/相邻区间（相邻也要并：中间没有活内容）。 */
function coalesce(spans) {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end + 1) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/** 区间二分查找：某个 seq 是否落在任何被撤回的区间里。 */
function inCuts(cuts, seq) {
  let low = 0;
  let high = cuts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cut = cuts[middle];
    if (seq < cut.start) high = middle - 1;
    else if (seq > cut.end) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * 一个聊天快照里要隐藏的 anchorSeq 集合。
 *
 * 两类进集合：
 *   1. 落在回退区间里的行（被撤回的用户消息、助手回复、工具行……）；
 *   2. 成功回退命令自己的行（结果噪音，留着反而让人误以为没回退）。
 * 失败的命令、裸 /rewind 的候选列表不隐藏。
 * @param {any} snap uiConversation "chat" 视图的快照
 * @returns {Set<number>}
 */
export function hiddenSeqsOf(snap) {
  const hidden = new Set();
  if (snap === undefined || snap === null || !Array.isArray(snap.order)) return hidden;
  const cuts = coalesce(spansOf(snap));
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === undefined) continue;
    const anchor = typeof node.anchorSeq === 'number' ? node.anchorSeq : node.data?.seq;
    if (typeof anchor !== 'number') continue;
    if (cuts.length > 0 && inCuts(cuts, anchor)) {
      hidden.add(anchor);
      continue;
    }
    if (node.kind === 'command') {
      const command = node.data ?? {};
      if (ENGINE_COMMANDS.has(command.name) && command.outcome?.kind === 'success' && command.outcome.sourceEventSeq !== undefined) {
        hidden.add(anchor);
      }
    }
  }
  return hidden;
}

/** 用户消息（含 steering 气泡）的纯文本。 */
export function messageTextAt(snap, seq) {
  if (snap === undefined || snap === null || !Array.isArray(snap.order)) return undefined;
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue;
    const data = node.data ?? {};
    if (data.seq !== seq) continue;
    return (data.content ?? [])
      .map((block) => (block !== null && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('');
  }
  return undefined;
}

/** 可回退的候选（真人消息、仍在渲染里的），最新在前。 */
export function candidatesOf(snap) {
  const candidates = [];
  if (snap === undefined || snap === null || !Array.isArray(snap.order)) return candidates;
  const hidden = hiddenSeqsOf(snap);
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === undefined || node.kind !== 'user') continue;
    const data = node.data ?? {};
    if (typeof data.seq !== 'number') continue;
    if (data.source?.kind !== 'user') continue;
    if (hidden.has(data.seq)) continue;
    const text = (data.content ?? [])
      .map((block) => (block !== null && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    candidates.push({
      seq: data.seq,
      time: typeof data.time === 'number' ? data.time : undefined,
      preview: text.length <= 60 ? text : `${text.slice(0, 59)}…`,
    });
  }
  return candidates.reverse();
}
