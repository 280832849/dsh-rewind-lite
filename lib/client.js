/**
 * dsh-rewind-lite 客户端半侧（构建产物，勿手改；源码在 src/client/）。
 * 模块 id 必须等于包名，dsh.client 的 inject 才能解析到本条目。
 */
window.__ModuleLoader__.load({
  id: "dsh-rewind-lite",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/client/index.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_react_dom = require("react-dom");

// src/client/hidden.js
var ENGINE_COMMANDS = /* @__PURE__ */ new Set(["rewind-lite", "rewind", "undo"]);
function targetSeqOfArgs(args) {
  const match = String(args ?? "").match(/@(\d+)/);
  return match === null ? void 0 : Number(match[1]);
}
function spansOf(snap) {
  const spans = [];
  if (snap === void 0 || snap === null || !Array.isArray(snap.order)) return spans;
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === void 0 || node.kind !== "command") continue;
    const command = node.data ?? {};
    if (!ENGINE_COMMANDS.has(command.name)) continue;
    if (command.outcome?.kind !== "success") continue;
    const marker = command.outcome.sourceEventSeq;
    if (typeof marker !== "number") continue;
    const target = targetSeqOfArgs(command.args);
    if (target === void 0) continue;
    spans.push({ start: target, end: marker });
  }
  return spans;
}
function coalesce(spans) {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== void 0 && span.start <= last.end + 1) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ start: span.start, end: span.end });
  }
  return merged;
}
function inCuts(cuts, seq) {
  let low = 0;
  let high = cuts.length - 1;
  while (low <= high) {
    const middle = low + high >> 1;
    const cut = cuts[middle];
    if (seq < cut.start) high = middle - 1;
    else if (seq > cut.end) low = middle + 1;
    else return true;
  }
  return false;
}
function hiddenSeqsOf(snap) {
  const hidden = /* @__PURE__ */ new Set();
  if (snap === void 0 || snap === null || !Array.isArray(snap.order)) return hidden;
  const cuts = coalesce(spansOf(snap));
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === void 0) continue;
    const anchor = typeof node.anchorSeq === "number" ? node.anchorSeq : node.data?.seq;
    if (typeof anchor !== "number") continue;
    if (cuts.length > 0 && inCuts(cuts, anchor)) {
      hidden.add(anchor);
      continue;
    }
    if (node.kind === "command") {
      const command = node.data ?? {};
      if (ENGINE_COMMANDS.has(command.name) && command.outcome?.kind === "success" && command.outcome.sourceEventSeq !== void 0) {
        hidden.add(anchor);
      }
    }
  }
  return hidden;
}
function messageTextAt(snap, seq) {
  if (snap === void 0 || snap === null || !Array.isArray(snap.order)) return void 0;
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === void 0 || node.kind !== "user" && node.kind !== "steering") continue;
    const data = node.data ?? {};
    if (data.seq !== seq) continue;
    return (data.content ?? []).map((block) => block !== null && block.type === "text" && typeof block.text === "string" ? block.text : "").join("");
  }
  return void 0;
}
function candidatesOf(snap) {
  const candidates = [];
  if (snap === void 0 || snap === null || !Array.isArray(snap.order)) return candidates;
  const hidden = hiddenSeqsOf(snap);
  for (const key of snap.order) {
    const node = snap.nodes?.get?.(key);
    if (node === void 0 || node.kind !== "user") continue;
    const data = node.data ?? {};
    if (typeof data.seq !== "number") continue;
    if (data.source?.kind !== "user") continue;
    if (hidden.has(data.seq)) continue;
    const text = (data.content ?? []).map((block) => block !== null && block.type === "text" && typeof block.text === "string" ? block.text : "").join("").replace(/\s+/g, " ").trim();
    candidates.push({
      seq: data.seq,
      time: typeof data.time === "number" ? data.time : void 0,
      preview: text.length <= 60 ? text : `${text.slice(0, 59)}\u2026`
    });
  }
  return candidates.reverse();
}

// src/client/client/index.jsx
var name = "dsh-rewind-lite";
var inject = ["slots", "sessions", "commandUi"];
var HEADER_ACTIONS_SLOT = "conversation.session.header.actions";
var ENGINE_COMMAND = "rewind-lite";
var HIDDEN_ATTR = "data-rewind-lite-hidden";
var BTN_CLASS = "dsh-rewind-lite-btn";
var STYLE_ID = "dsh-rewind-lite/style";
var USER_ROW_SELECTOR = '[data-chat-flow-kind="user"][data-chat-anchor-key],[data-chat-flow-kind="steering"][data-chat-anchor-key]';
var TICK_MS = 150;
var SETTLE_TIMEOUT_MS = 2e4;
function ensureStyle() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
  const style = document.createElement("style");
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
    return ctx.get?.("uiConversation");
  } catch {
    return void 0;
  }
}
function chatOf(ctx, sessionId) {
  try {
    return uiConversationOf(ctx)?.binding?.(sessionId)?.target?.("chat")?.getSnapshot?.();
  } catch {
    return void 0;
  }
}
function sessionFaceOf(ctx, sessionId) {
  try {
    return ctx.sessions?.binding?.(sessionId)?.session;
  } catch {
    return void 0;
  }
}
function anchorOfRow(chat, row) {
  const flowKey = row.dataset?.chatAnchorKey;
  const nodeKey = row.dataset?.chatNodeKey;
  const node = (flowKey !== void 0 ? chat?.nodes?.get?.(flowKey) : void 0) ?? (nodeKey !== void 0 ? chat?.nodes?.get?.(nodeKey) : void 0);
  return typeof node?.anchorSeq === "number" ? node.anchorSeq : void 0;
}
function actionsContainerOf(row) {
  const buttons = Array.from(row.querySelectorAll?.("button") ?? []);
  const last = buttons.filter((button) => !button.classList.contains(BTN_CLASS)).at(-1);
  const container = last?.parentElement;
  if (container === void 0 || container === null) return void 0;
  return container;
}
function setComposerText(ctx, sessionId, text) {
  try {
    const conversation = ctx.get?.("conversation");
    const scope = ctx.sessions?.scope?.(sessionId);
    const input = conversation?.input;
    if (input !== void 0 && scope !== void 0) {
      const shell = input.for(scope);
      shell.setDraft(text);
      try {
        shell.focus?.();
      } catch {
      }
      return true;
    }
  } catch {
  }
  return fillComposerDom(text);
}
function fillComposerDom(text) {
  const editable = document.querySelector("[data-composer-input]");
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
    if (document.execCommand("insertText", false, text)) return true;
  } catch {
  }
  editable.textContent = text;
  editable.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
function knownCommandSeqs(chat) {
  const seqs = /* @__PURE__ */ new Set();
  if (chat === void 0 || !Array.isArray(chat.order)) return seqs;
  for (const key of chat.order) {
    const node = chat.nodes?.get?.(key);
    if (node !== void 0 && node.kind === "command") {
      seqs.add(typeof node.anchorSeq === "number" ? node.anchorSeq : node.data?.seq);
    }
  }
  return seqs;
}
async function waitForSettle(ctx, sessionId, seq, knownBefore) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const chat = chatOf(ctx, sessionId);
    if (chat !== void 0 && Array.isArray(chat.order)) {
      for (const key of chat.order) {
        const node = chat.nodes?.get?.(key);
        if (node === void 0 || node.kind !== "command") continue;
        const command = node.data ?? {};
        const anchor = typeof node.anchorSeq === "number" ? node.anchorSeq : command.seq;
        if (knownBefore.has(anchor)) continue;
        if (command.name !== ENGINE_COMMAND) continue;
        if (!String(command.args ?? "").includes(`@${seq}`)) continue;
        if (command.outcome?.kind === "success" && command.outcome.sourceEventSeq !== void 0) return "success";
        if (command.outcome?.kind === "error") return "error";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  return "timeout";
}
function composerTextNow() {
  const editable = typeof document === "undefined" ? null : document.querySelector("[data-composer-input]");
  return String(editable?.textContent ?? "").replace(/\s+/g, "");
}
function draftApplied(text) {
  const wanted = String(text).replace(/\s+/g, "");
  if (wanted === "") return true;
  return composerTextNow().includes(wanted);
}
async function refillComposer(ctx, sessionId, text) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    setComposerText(ctx, sessionId, text);
    if (draftApplied(text)) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  fillComposerDom(text);
  return draftApplied(text);
}
async function runRewind(ctx, sessionId, seq, mode = "chat") {
  const face = sessionFaceOf(ctx, sessionId);
  if (face === void 0) return false;
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
  if (settled !== "success") return false;
  const text = typeof textBefore === "string" && textBefore !== "" ? textBefore : messageTextAt(chatOf(ctx, sessionId), seq);
  if (typeof text === "string" && text !== "") {
    const filled = await refillComposer(ctx, sessionId, text);
    if (!filled) console.warn("[dsh-rewind-lite] \u63D0\u793A\u8BCD\u56DE\u586B\u6CA1\u843D\u5730\uFF0C\u539F\u6587\uFF1A", text);
  }
  return true;
}
function computeRows(ctx, sessionId) {
  const chat = chatOf(ctx, sessionId);
  const hidden = hiddenSeqsOf(chat);
  const rows = [];
  if (typeof document !== "undefined") {
    for (const row of document.querySelectorAll(USER_ROW_SELECTOR)) {
      const seq = anchorOfRow(chat, row);
      if (seq === void 0 || hidden.has(seq)) continue;
      const container = actionsContainerOf(row);
      if (container === void 0) continue;
      rows.push({ key: seq, seq, container });
    }
  }
  return { chat, hidden, rows };
}
function applyHidden(chat, hidden) {
  if (typeof document === "undefined") return;
  for (const element of document.querySelectorAll("[data-chat-anchor-key],[data-chat-node-key]")) {
    const anchor = anchorOfRow(chat, element);
    const shouldHide = anchor !== void 0 && hidden.has(anchor);
    if (shouldHide) {
      if (!element.hasAttribute(HIDDEN_ATTR)) element.setAttribute(HIDDEN_ATTR, "");
    } else if (element.hasAttribute(HIDDEN_ATTR)) {
      element.removeAttribute(HIDDEN_ATTR);
    }
  }
}
function UndoIcon() {
  return (0, import_react.createElement)(
    "svg",
    {
      width: 16,
      height: 16,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.25,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
    (0, import_react.createElement)("path", { d: "M9 14 4 9l5-5" }),
    (0, import_react.createElement)("path", { d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" })
  );
}
function createBridge(ctx) {
  return function RewindBridge({ sessionId }) {
    const [rows, setRows] = (0, import_react.useState)([]);
    const [pending, setPending] = (0, import_react.useState)(null);
    const rowsRef = (0, import_react.useRef)([]);
    const refresh = (0, import_react.useCallback)(() => {
      if (typeof sessionId !== "string" || typeof document === "undefined") return;
      try {
        const { chat, hidden, rows: next } = computeRows(ctx, sessionId);
        applyHidden(chat, hidden);
        const same = next.length === rowsRef.current.length && next.every((row, index) => row.key === rowsRef.current[index].key && row.container === rowsRef.current[index].container);
        if (!same) {
          rowsRef.current = next;
          setRows(next);
        }
      } catch {
      }
    }, [sessionId]);
    (0, import_react.useEffect)(() => {
      ensureStyle();
      if (typeof sessionId !== "string" || typeof document === "undefined") return void 0;
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
        attributeFilter: ["data-chat-anchor-key", "data-chat-node-key"]
      });
      let unsubscribe;
      try {
        unsubscribe = uiConversationOf(ctx)?.binding?.(sessionId)?.target?.("chat")?.subscribe?.(schedule);
      } catch {
        unsubscribe = void 0;
      }
      schedule();
      return () => {
        disposed = true;
        if (frame !== 0) cancelAnimationFrame(frame);
        observer.disconnect();
        try {
          unsubscribe?.();
        } catch {
        }
      };
    }, [sessionId, refresh]);
    const openConfirm = (seq, event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const left = Math.min(Math.max(8, rect.left - 100), Math.max(8, window.innerWidth - 320));
      setPending({ seq, top: Math.round(rect.bottom + 8), left: Math.round(left) });
    };
    (0, import_react.useEffect)(() => {
      if (pending === null) return void 0;
      const onKey = (event) => {
        if (event.key === "Escape") setPending(null);
      };
      document.addEventListener("keydown", onKey, true);
      return () => document.removeEventListener("keydown", onKey, true);
    }, [pending]);
    const onConfirm = async (mode) => {
      const seq = pending?.seq;
      setPending(null);
      if (typeof seq === "number") await runRewind(ctx, sessionId, seq, mode);
    };
    return (0, import_react.createElement)(
      "span",
      null,
      rows.map(
        (row) => (0, import_react_dom.createPortal)(
          (0, import_react.createElement)(
            "button",
            {
              key: `rewind-${row.key}`,
              type: "button",
              className: BTN_CLASS,
              title: "\u56DE\u9000\u5230\u8FD9\u91CC\uFF08\u64A4\u56DE\u8FD9\u6761\u53CA\u5176\u4E4B\u540E\u7684\u5185\u5BB9\uFF09",
              "aria-label": "\u56DE\u9000\u5230\u8FD9\u91CC",
              onClick: (event) => openConfirm(row.seq, event)
            },
            (0, import_react.createElement)(UndoIcon, null)
          ),
          row.container
        )
      ),
      pending !== null ? (0, import_react_dom.createPortal)(
        (0, import_react.createElement)(
          "div",
          { className: "dsh-rewind-lite-pop", style: { top: `${pending.top}px`, left: `${pending.left}px` } },
          (0, import_react.createElement)("p", { className: "dsh-rewind-lite-pop-title" }, "\u56DE\u9000\u5230\u8FD9\u6761\u6D88\u606F\uFF1F"),
          (0, import_react.createElement)(
            "p",
            { className: "dsh-rewind-lite-pop-body" },
            "\u300C\u53EA\u56DE\u9000\u5BF9\u8BDD\u300D\u53EA\u64A4\u4E0A\u4E0B\u6587\uFF1B\u300C\u5BF9\u8BDD+\u6587\u4EF6\u300D\u8FD8\u4F1A\u628A AI \u6539\u8FC7\u7684\u6587\u4EF6\u8FD8\u539F\u6210\u6539\u52A8\u524D\u3002\u63D0\u793A\u8BCD\u90FD\u4F1A\u56DE\u5230\u8F93\u5165\u6846\uFF1B\u56DE\u9000\u4E0D\u53EF\u64A4\u9500\u3002"
          ),
          (0, import_react.createElement)(
            "div",
            { className: "dsh-rewind-lite-pop-actions" },
            (0, import_react.createElement)("button", { type: "button", onClick: () => setPending(null) }, "\u53D6\u6D88"),
            (0, import_react.createElement)("button", { type: "button", onClick: () => void onConfirm("chat") }, "\u53EA\u56DE\u9000\u5BF9\u8BDD"),
            (0, import_react.createElement)("button", { type: "button", className: "is-primary", onClick: () => void onConfirm("both") }, "\u5BF9\u8BDD+\u6587\u4EF6")
          )
        ),
        document.body
      ) : null
    );
  };
}
function clockOf(time) {
  if (typeof time !== "number") return "";
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function apply(ctx) {
  const disposers = [];
  const slots = ctx.slots;
  try {
    disposers.push(ctx.slots.inject(HEADER_ACTIONS_SLOT, () => slots.register(
      { name: HEADER_ACTIONS_SLOT, id: "dsh-rewind-lite-bridge", order: 1e3 },
      createBridge(ctx)
    )));
  } catch (error) {
    console.warn("[dsh-rewind-lite] \u6302\u8F7D\u6309\u94AE\u5931\u8D25\uFF1A", error);
  }
  const commandUi = (() => {
    try {
      return ctx.get?.("commandUi") ?? ctx.commandUi;
    } catch {
      return void 0;
    }
  })();
  for (const commandName of ["rewind", "undo"]) {
    try {
      const dispose = commandUi?.decorate?.({
        name: commandName,
        available: (session) => candidatesOf(chatOf(ctx, session?.sessionId)).length > 0,
        ui: {
          kind: "popupSelect",
          options: async (session) => candidatesOf(chatOf(ctx, session?.sessionId)).map((candidate) => ({
            id: String(candidate.seq),
            label: candidate.preview || "(\u65E0\u6587\u672C)",
            detail: clockOf(candidate.time)
          })),
          onSelect: (option, session) => {
            void runRewind(ctx, session?.sessionId, Number(option?.id));
          }
        }
      });
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      console.warn(`[dsh-rewind-lite] \u88C5\u9970 /${commandName} \u5931\u8D25\uFF1A`, error);
    }
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
      }
    }
    document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)?.remove();
  }, "dsh-rewind-lite client");
}

    return module.exports;
  },
});
