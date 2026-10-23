/**
 * dsh-rewind-lite 客户端半侧（源码）。
 *
 * 1. 每条用户消息的动作行里插一个「↶」按钮 —— 点按钮 + 二次确认，不用打字；
 * 2. 隐藏被回退撤回的聊天行（transcript 不动，视觉上一致）；
 * 3. 回退成功后把原提示词回填输入框；
 * 4. 保留 /rewind、/undo 命令与选择器（键盘党、找不到按钮时的退路）。
 *
 * 依赖的 DOM 约定都是 harness 内部属性（data-chat-anchor-key /
 * data-chat-node-key / data-composer-input），UI 升级可能漂移 —— 本项目唯一
 * 脆弱点，README「维护须知」里列了排查顺序。
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { candidatesOf, hiddenSeqsOf, messageTextAt } from './hidden.js';

export const name = 'dsh-rewind-lite';

/** 客户端服务依赖：slots（挂载点）、sessions（命令通道）、commandUi（选择器）。 */
export const inject = ['slots', 'sessions', 'commandUi'];

/** 挂载点：每个会话头部动作位（只借它拿一个按会话存在的 React 挂载）。 */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions';

/** 客户端执行回退用的内部命令（宿主侧注册）。 */
const ENGINE_COMMAND = 'rewind-lite';

/** 隐藏行属性、按钮类名、样式 id。 */
const HIDDEN_ATTR = 'data-rewind-lite-hidden';
const BTN_CLASS = 'dsh-rewind-lite-btn';
const STYLE_ID = 'dsh-rewind-lite/style';

/** 用户消息行（含 steering 气泡）。 */
const USER_ROW_SELECTOR =
  '[data-chat-flow-kind="user"][data-chat-anchor-key],[data-chat-flow-kind="steering"][data-chat-anchor-key]';

const TICK_MS = 150;
const SETTLE_TIMEOUT_MS = 20000;

/** 注入样式（幂等）。 */
function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
  const style = document.createElement('style');
  style.dataset.pluginCss = STYLE_ID;
  style.textContent = `
[${HIDDEN_ATTR}]{display:none!important}
.dsh-rewind-lite-btn{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;padding:0;margin:0;border:none;border-radius:6px;
  background:transparent;color:#8a8a8a;cursor:pointer;flex:none;
  transition:background-color .12s,color .12s;
}
.dsh-rewind-lite-btn:hover{background:rgba(101,64,244,.10);color:#6540F4}
.dsh-rewind-lite-btn:focus-visible{outline:2px solid rgba(101,64,244,.5);outline-offset:1px}
.dsh-rewind-lite-pop{
  position:fixed;z-index:9999;min-width:240px;max-width:300px;
  background:#fff;border:1px solid #e8e8ec;border-radius:10px;
  box-shadow:0 12px 32px rgba(15,17,26,.16);padding:12px 14px;
  font:13px/1.5 -apple-system,"PingFang SC",sans-serif;color:#1a1a1a;
}
.dsh-rewind-lite-pop-title{font-size:13px;font-weight:600;margin:0 0 4px}
.dsh-rewind-lite-pop-body{font-size:12px;color:#7a7a82;margin:0 0 10px}
.dsh-rewind-lite-pop-actions{display:flex;gap:8px;justify-content:flex-end}
.dsh-rewind-lite-pop-actions button{
  height:28px;padding:0 12px;border-radius:8px;border:1px solid #e0e0e6;
  background:#fff;color:#1a1a1a;font-size:12px;cursor:pointer;
}
.dsh-rewind-lite-pop-actions button:hover{background:#f5f5f7}
.dsh-rewind-lite-pop-actions .is-primary{background:#6540F4;border-color:#6540F4;color:#fff}
.dsh-rewind-lite-pop-actions .is-primary:hover{background:#5433d8}
`;
  document.head.append(style);
}

function uiConversationOf(ctx) {
  try {
    return ctx.get?.('uiConversation');
  } catch {
    return undefined;
  }
}

/** 某个会话的聊天快照；拿不到就 undefined，永不抛。 */
function chatOf(ctx, sessionId) {
  try {
    return uiConversationOf(ctx)?.binding?.(sessionId)?.target?.('chat')?.getSnapshot?.();
  } catch {
    return undefined;
  }
}

function sessionFaceOf(ctx, sessionId) {
  try {
    return ctx.sessions?.binding?.(sessionId)?.session;
  } catch {
    return undefined;
  }
}

/** 行元素 → 快照节点 → anchorSeq。 */
function anchorOfRow(chat, row) {
  const flowKey = row.dataset?.chatAnchorKey;
  const nodeKey = row.dataset?.chatNodeKey;
  const node = (flowKey !== undefined ? chat?.nodes?.get?.(flowKey) : undefined) ?? (nodeKey !== undefined ? chat?.nodes?.get?.(nodeKey) : undefined);
  return typeof node?.anchorSeq === 'number' ? node.anchorSeq : undefined;
}

/**
 * 找动作行容器：行内最后一个「不是我们的」按钮的父元素。
 * 结构式定位是因为 harness 没有用户消息级的官方 action slot；跳过自己的按钮，
 * 避免第二次刷新时把按钮插进自己的父元素。
 */
function actionsContainerOf(row) {
  const buttons = Array.from(row.querySelectorAll?.('button') ?? []);
  const last = buttons.filter((button) => !button.classList.contains(BTN_CLASS)).at(-1);
  const container = last?.parentElement;
  if (container === undefined || container === null) return undefined;
  return container;
}

/** 写输入框：优先 harness 的 setDraft，失败退 DOM。 */
function setComposerText(ctx, sessionId, text) {
  try {
    const conversation = ctx.get?.('conversation');
    const scope = ctx.sessions?.scope?.(sessionId);
    const input = conversation?.input;
    if (input !== undefined && scope !== undefined) {
      const shell = input.for(scope);
      shell.setDraft(text);
      try {
        shell.focus?.();
      } catch {
        /* 焦点失败不影响文本 */
      }
      return true;
    }
  } catch {
    /* 退 DOM */
  }
  return fillComposerDom(text);
}

function fillComposerDom(text) {
  const editable = document.querySelector('[data-composer-input]');
  if (editable === null) return false;
  editable.focus();
  const selection = document.getSelection();
  if (selection !== null) {
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  try {
    if (document.execCommand('insertText', false, text)) return true;
  } catch {
    /* 走直接写入 */
  }
  editable.textContent = text;
  editable.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function knownCommandSeqs(chat) {
  const seqs = new Set();
  if (chat === undefined || !Array.isArray(chat.order)) return seqs;
  for (const key of chat.order) {
    const node = chat.nodes?.get?.(key);
    if (node !== undefined && node.kind === 'command') {
      seqs.add(typeof node.anchorSeq === 'number' ? node.anchorSeq : node.data?.seq);
    }
  }
  return seqs;
}

/** 等这次回退命令落地（轮询聊天快照，直到出现带标记的成功命令节点）。 */
async function waitForSettle(ctx, sessionId, seq, knownBefore) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const chat = chatOf(ctx, sessionId);
    if (chat !== undefined && Array.isArray(chat.order)) {
      for (const key of chat.order) {
        const node = chat.nodes?.get?.(key);
        if (node === undefined || node.kind !== 'command') continue;
        const command = node.data ?? {};
        const anchor = typeof node.anchorSeq === 'number' ? node.anchorSeq : command.seq;
        if (knownBefore.has(anchor)) continue;
        if (command.name !== ENGINE_COMMAND) continue;
        if (!String(command.args ?? '').includes(`@${seq}`)) continue;
        if (command.outcome?.kind === 'success' && command.outcome.sourceEventSeq !== undefined) return 'success';
        if (command.outcome?.kind === 'error') return 'error';
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  return 'timeout';
}

/** 输入框当前文本（去掉占位/空白差异，用来校验回填是否真的落地）。 */
function composerTextNow() {
  const editable = typeof document === 'undefined' ? null : document.querySelector('[data-composer-input]');
  return String(editable?.textContent ?? '').replace(/\s+/g, '');
}

/** 回填是否已在输入框里生效。 */
function draftApplied(text) {
  const wanted = String(text).replace(/\s+/g, '');
  if (wanted === '') return true;
  return composerTextNow().includes(wanted);
}

/**
 * 把被撤回的提示词写回输入框，并校验真的落地。
 *
 * 为什么不是一次就完：回退会先取消正在跑的回合，输入端在这期间会重渲染一
 * 次，draft 可能被重置。所以写完校验，不对就重试，最后退到 DOM 直接写。
 */
async function refillComposer(ctx, sessionId, text) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    setComposerText(ctx, sessionId, text);
    if (draftApplied(text)) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  fillComposerDom(text);
  return draftApplied(text);
}

/** 执行一次回退（模式 chat），成功后回填提示词。 */
async function runRewind(ctx, sessionId, seq, mode = 'chat') {
  const face = sessionFaceOf(ctx, sessionId);
  if (face === undefined) return false;
  // 先取原文再执行：执行后聊天快照会重算，提前拿到手才最稳。
  const textBefore = messageTextAt(chatOf(ctx, sessionId), seq);
  const knownBefore = knownCommandSeqs(chatOf(ctx, sessionId));
  let result;
  try {
    result = await face.command(`/${ENGINE_COMMAND} @${seq} ${mode}`);
  } catch {
    return false;
  }
  if (result?.ok !== true || result.value?.matched !== true) return false;
  const settled = await waitForSettle(ctx, sessionId, seq, knownBefore);
  if (settled !== 'success') return false;
  const text = typeof textBefore === 'string' && textBefore !== '' ? textBefore : messageTextAt(chatOf(ctx, sessionId), seq);
  if (typeof text === 'string' && text !== '') {
    const filled = await refillComposer(ctx, sessionId, text);
    if (!filled) console.warn('[dsh-rewind-lite] 提示词回填没落地，原文：', text);
  }
  return true;
}

/** 隐藏被撤回的行，并算出要挂按钮的行。 */
function computeRows(ctx, sessionId) {
  const chat = chatOf(ctx, sessionId);
  const hidden = hiddenSeqsOf(chat);
  const rows = [];
  if (typeof document !== 'undefined') {
    for (const row of document.querySelectorAll(USER_ROW_SELECTOR)) {
      const seq = anchorOfRow(chat, row);
      if (seq === undefined || hidden.has(seq)) continue;
      const container = actionsContainerOf(row);
      if (container === undefined) continue;
      rows.push({ key: seq, seq, container });
    }
  }
  return { chat, hidden, rows };
}

/** 把隐藏属性落到 DOM（只动自己加的属性）。 */
function applyHidden(chat, hidden) {
  if (typeof document === 'undefined') return;
  for (const element of document.querySelectorAll('[data-chat-anchor-key],[data-chat-node-key]')) {
    const anchor = anchorOfRow(chat, element);
    const shouldHide = anchor !== undefined && hidden.has(anchor);
    if (shouldHide) {
      if (!element.hasAttribute(HIDDEN_ATTR)) element.setAttribute(HIDDEN_ATTR, '');
    } else if (element.hasAttribute(HIDDEN_ATTR)) {
      element.removeAttribute(HIDDEN_ATTR);
    }
  }
}

/** Lucide 风格的回退图标（16px、1.25 描边，不用文本符号当图标）。 */
function UndoIcon() {
  return createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    createElement('path', { d: 'M9 14 4 9l5-5' }),
    createElement('path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11' }),
  );
}

/**
 * 每个会话挂一个桥组件：隐藏旧行 + 给每条用户消息插「↶」按钮 + 二次确认浮层。
 */
function createBridge(ctx) {
  return function RewindBridge({ sessionId }) {
    const [rows, setRows] = useState([]);
    const [pending, setPending] = useState(null); // { seq, top, left }
    const rowsRef = useRef([]);

    const refresh = useCallback(() => {
      if (typeof sessionId !== 'string' || typeof document === 'undefined') return;
      try {
        const { chat, hidden, rows: next } = computeRows(ctx, sessionId);
        applyHidden(chat, hidden);
        // 只有目标真变了才 setState，避免 MutationObserver 自激循环。
        const same =
          next.length === rowsRef.current.length &&
          next.every((row, index) => row.key === rowsRef.current[index].key && row.container === rowsRef.current[index].container);
        if (!same) {
          rowsRef.current = next;
          setRows(next);
        }
      } catch {
        /* 快照未就绪，下次再来 */
      }
    }, [sessionId]);

    useEffect(() => {
      ensureStyle();
      if (typeof sessionId !== 'string' || typeof document === 'undefined') return undefined;
      let frame = 0;
      let disposed = false;
      const schedule = () => {
        if (disposed || frame !== 0) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          refresh();
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-chat-anchor-key', 'data-chat-node-key'],
      });
      let unsubscribe;
      try {
        unsubscribe = uiConversationOf(ctx)?.binding?.(sessionId)?.target?.('chat')?.subscribe?.(schedule);
      } catch {
        unsubscribe = undefined;
      }
      schedule();
      return () => {
        disposed = true;
        if (frame !== 0) cancelAnimationFrame(frame);
        observer.disconnect();
        try {
          unsubscribe?.();
        } catch {
          /* 忽略 */
        }
      };
    }, [sessionId, refresh]);

    const openConfirm = (seq, event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const left = Math.min(Math.max(8, rect.left - 100), Math.max(8, window.innerWidth - 320));
      setPending({ seq, top: Math.round(rect.bottom + 8), left: Math.round(left) });
    };

    useEffect(() => {
      if (pending === null) return undefined;
      const onKey = (event) => {
        if (event.key === 'Escape') setPending(null);
      };
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, [pending]);

    const onConfirm = async (mode) => {
      const seq = pending?.seq;
      setPending(null);
      if (typeof seq === 'number') await runRewind(ctx, sessionId, seq, mode);
    };

    return createElement(
      'span',
      null,
      rows.map((row) =>
        createPortal(
          createElement(
            'button',
            {
              key: `rewind-${row.key}`,
              type: 'button',
              className: BTN_CLASS,
              title: '回退到这里（撤回这条及其之后的内容）',
              'aria-label': '回退到这里',
              onClick: (event) => openConfirm(row.seq, event),
            },
            createElement(UndoIcon, null),
          ),
          row.container,
        ),
      ),
      pending !== null
        ? createPortal(
            createElement(
              'div',
              { className: 'dsh-rewind-lite-pop', style: { top: `${pending.top}px`, left: `${pending.left}px` } },
              createElement('p', { className: 'dsh-rewind-lite-pop-title' }, '回退到这条消息？'),
              createElement(
                'p',
                { className: 'dsh-rewind-lite-pop-body' },
                '「只回退对话」只撤上下文；「对话+文件」还会把 AI 改过的文件还原成改动前。提示词都会回到输入框；回退不可撤销。',
              ),
              createElement(
                'div',
                { className: 'dsh-rewind-lite-pop-actions' },
                createElement('button', { type: 'button', onClick: () => setPending(null) }, '取消'),
                createElement('button', { type: 'button', onClick: () => void onConfirm('chat') }, '只回退对话'),
                createElement('button', { type: 'button', className: 'is-primary', onClick: () => void onConfirm('both') }, '对话+文件'),
              ),
            ),
            document.body,
          )
        : null,
    );
  };
}

function clockOf(time) {
  if (typeof time !== 'number') return '';
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 客户端插件入口。
 * @param {any} ctx
 */
export function apply(ctx) {
  const disposers = [];
  const slots = ctx.slots;

  // 1) 每条用户消息的「↶」按钮 + 隐藏撤回行。
  try {
    disposers.push(ctx.slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
      { name: HEADER_ACTIONS_SLOT, id: 'dsh-rewind-lite-bridge', order: 1000 },
      createBridge(ctx),
    )));
  } catch (error) {
    console.warn('[dsh-rewind-lite] 挂载按钮失败：', error);
  }

  // 2) /rewind、/undo 的选择器（键盘退路）。
  const commandUi = (() => {
    try {
      return ctx.get?.('commandUi') ?? ctx.commandUi;
    } catch {
      return undefined;
    }
  })();
  for (const commandName of ['rewind', 'undo']) {
    try {
      const dispose = commandUi?.decorate?.({
        name: commandName,
        available: (session) => candidatesOf(chatOf(ctx, session?.sessionId)).length > 0,
        ui: {
          kind: 'popupSelect',
          options: async (session) =>
            candidatesOf(chatOf(ctx, session?.sessionId)).map((candidate) => ({
              id: String(candidate.seq),
              label: candidate.preview || '(无文本)',
              detail: clockOf(candidate.time),
            })),
          onSelect: (option, session) => {
            void runRewind(ctx, session?.sessionId, Number(option?.id));
          },
        },
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      console.warn(`[dsh-rewind-lite] 装饰 /${commandName} 失败：`, error);
    }
  }

  // 3) 卸载清理。
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 忽略 */
      }
    }
    document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)?.remove();
  }, 'dsh-rewind-lite client');
}
