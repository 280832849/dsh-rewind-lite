/**
 * 回退标记的构造。
 *
 * 为什么必须是一条 user/message：
 *   1. 从 v2 起，只有 user/message 能用 sourceEventSeqs 声明「我替换了哪些
 *      更早的节点」；
 *   2. 表面替换要求被遮蔽的节点全部出现在 sourceEventSeqs 里，Session.append
 *      会校验完整性，缺一个就抛错。
 *
 * 为什么文本不能为空：严格 OpenAI 兼容网关会拒绝空 content 的 user 消息（400）。
 * 这条标记会短暂留在模型上下文里（紧接着就是用户重发的提示词），所以用一段
 * 中性的中文占位文本。
 *
 * @module dsh-rewind-lite/marker
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { MARKER_SOURCE_KIND } from './plan.js';

/** 标记的占位文本（非空即可，但必须人能看懂）。 */
export const MARKER_TEXT = '(已回退，等待重新发送)';

/**
 * 构造回退标记消息。
 * @returns {any} 一条 user/message 的 data 载荷（source.kind 已换成插件自己的）。
 */
export function buildMarker() {
  const message = createUserMessage({ content: [{ type: 'text', text: MARKER_TEXT }] });
  return { ...message, role: 'user', source: { kind: MARKER_SOURCE_KIND } };
}
