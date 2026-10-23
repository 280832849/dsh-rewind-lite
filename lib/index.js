// src/host.js
import { writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join as join2, resolve as resolve2 } from "node:path";
import Schema from "@deepseek-ai/schemastery";

// src/marker.js
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// src/plan.js
var MARKER_SOURCE_KIND = "dsh-rewind-lite";
var PREVIEW_CHARS = 80;
var DEFAULT_LIMIT = 50;
var RewindError = class extends Error {
  /**
   * @param {'no-user-messages'|'invalid-index'|'not-a-user-message'|'not-on-surface'|'bad-target'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "RewindError";
    this.code = code;
  }
};
function isHumanUserMessage(event) {
  return event !== null && typeof event === "object" && event.type === "user/message" && event.data !== null && typeof event.data === "object" && event.data.source !== null && typeof event.data.source === "object" && event.data.source.kind === "user";
}
function messagePreview(message) {
  const text = (message?.content ?? []).map((block) => block !== null && block.type === "text" && typeof block.text === "string" ? block.text : "").join("").replace(/\s+/g, " ").trim();
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS - 1)}\u2026`;
}
function listCandidates(events, surfaceNodes, limit = DEFAULT_LIMIT) {
  const onSurface = new Set(surfaceNodes);
  const candidates = [];
  for (let i = events.length - 1; i >= 0 && candidates.length < limit; i -= 1) {
    const event = events[i];
    if (!isHumanUserMessage(event)) continue;
    if (!onSurface.has(event.seq)) continue;
    candidates.push({
      seq: event.seq,
      time: event.time,
      preview: messagePreview(event.data),
      index: candidates.length + 1
    });
  }
  return candidates;
}
var SEQ_TOKEN = /^@(\d+)$/;
var INDEX_TOKEN = /^(\d+)$/;
function parseTarget(raw) {
  const token = String(raw ?? "").trim();
  const seq = SEQ_TOKEN.exec(token);
  if (seq !== null) {
    const value = Number(seq[1]);
    return Number.isSafeInteger(value) ? { kind: "seq", seq: value } : void 0;
  }
  const index = INDEX_TOKEN.exec(token);
  if (index !== null) {
    const value = Number(index[1]);
    return Number.isSafeInteger(value) && value >= 1 ? { kind: "index", index: value } : void 0;
  }
  return void 0;
}
function planRewind(events, surfaceNodes, target) {
  let targetSeq;
  if (target.kind === "seq") {
    targetSeq = target.seq;
  } else {
    const candidate = listCandidates(events, surfaceNodes, target.index)[target.index - 1];
    if (candidate === void 0) {
      throw new RewindError("invalid-index", `\u6CA1\u6709\u7B2C ${target.index} \u6761\u53EF\u56DE\u9000\u7684\u6D88\u606F`);
    }
    targetSeq = candidate.seq;
  }
  const targetEvent = events.find((event) => event.seq === targetSeq);
  if (targetEvent === void 0) {
    throw new RewindError("not-a-user-message", `\u65E5\u5FD7\u91CC\u6CA1\u6709 seq ${targetSeq} \u8FD9\u6761\u4E8B\u4EF6`);
  }
  if (!isHumanUserMessage(targetEvent)) {
    throw new RewindError("not-a-user-message", `seq ${targetSeq} \u4E0D\u662F\u771F\u4EBA\u53D1\u7684\u7528\u6237\u6D88\u606F\uFF08${targetEvent.type}\uFF09`);
  }
  const targetIndex = surfaceNodes.indexOf(targetSeq);
  if (targetIndex === -1) {
    throw new RewindError("not-on-surface", `seq ${targetSeq} \u7684\u6D88\u606F\u5DF2\u4E0D\u5728\u6A21\u578B\u4E0A\u4E0B\u6587\u91CC\uFF08\u88AB\u538B\u7F29\u906E\u853D\uFF09\uFF0C\u65E0\u6CD5\u56DE\u9000\u5230\u8FD9\u91CC`);
  }
  const shadowedSeqs = surfaceNodes.slice(targetIndex);
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1]
  };
}
function formatCandidates(candidates) {
  if (candidates.length === 0) return "\u8FD9\u6761\u4F1A\u8BDD\u91CC\u8FD8\u6CA1\u6709\u53EF\u56DE\u9000\u7684\u7528\u6237\u6D88\u606F\u3002";
  const lines = candidates.map((candidate) => {
    const time = new Date(candidate.time);
    const hh = String(time.getHours()).padStart(2, "0");
    const mm = String(time.getMinutes()).padStart(2, "0");
    return `${candidate.index}. @${candidate.seq}  ${hh}:${mm}  ${candidate.preview || "(\u65E0\u6587\u672C)"}`;
  });
  return [
    "\u9009\u62E9\u8981\u56DE\u9000\u5230\u7684\u6D88\u606F\uFF08\u4F1A\u64A4\u56DE\u8FD9\u6761\u6D88\u606F\u53CA\u5176\u4E4B\u540E\u7684\u6240\u6709\u5185\u5BB9\uFF0C\u539F\u63D0\u793A\u8BCD\u56DE\u586B\u5230\u8F93\u5165\u6846\uFF09\uFF1A",
    ...lines,
    "\u7528\u6CD5\uFF1A/rewind @<seq>    \u4F8B\uFF1A/rewind @123"
  ].join("\n");
}

// src/marker.js
var MARKER_TEXT = "(\u5DF2\u56DE\u9000\uFF0C\u7B49\u5F85\u91CD\u65B0\u53D1\u9001)";
function buildMarker() {
  const message = createUserMessage({ content: [{ type: "text", text: MARKER_TEXT }] });
  return { ...message, role: "user", source: { kind: MARKER_SOURCE_KIND } };
}

// src/snapshot.js
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
var TRACKED_TOOLS = /* @__PURE__ */ new Set(["write", "edit"]);
var DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
function mutationPathOf(exec) {
  if (!TRACKED_TOOLS.has(exec?.name)) return void 0;
  const args = exec.arguments ?? {};
  const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : void 0;
  return path === void 0 ? void 0 : path;
}
function isSubagentSession(session) {
  const header = session?.header ?? {};
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}
function latestHumanSeq(session) {
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return 0;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "user/message" && event.data?.source?.kind === "user") return event.seq;
  }
  return 0;
}
function insideRoot(root, path) {
  const r = resolve(root);
  const p = resolve(path);
  return p === r || p.startsWith(r + sep);
}
function keyOf(path) {
  return createHash("sha1").update(path).digest("hex");
}
function entryOf(anchorSeq, raw) {
  return {
    anchorSeq,
    path: raw.path,
    existed: raw.existed === true,
    mode: typeof raw.mode === "number" ? raw.mode : void 0,
    time: typeof raw.time === "number" ? raw.time : 0,
    callId: raw.callId,
    size: raw.size
  };
}
function planRestoreFrom(entries, targetSeq) {
  const byPath = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.anchorSeq < targetSeq) continue;
    const current = byPath.get(entry.path);
    if (current === void 0 || entry.anchorSeq < current.anchorSeq || entry.anchorSeq === current.anchorSeq && entry.time < current.time) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()].map((entry) => ({ path: entry.path, action: entry.existed ? "write" : "delete", entry })).sort((a, b) => a.path.localeCompare(b.path));
}
var SnapshotStore = class {
  /**
   * @param {{root:string,maxFileBytes?:number}} options
   */
  constructor({ root, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
    this.root = resolve(root);
    this.maxFileBytes = maxFileBytes;
  }
  sessionDir(sessionId) {
    return join(this.root, String(sessionId));
  }
  /** 把原文件字节暂存到 .pending/，返回暂存路径。 */
  async stage(sourcePath) {
    const pendingDir = join(this.root, ".pending");
    await mkdir(pendingDir, { recursive: true });
    const staged = join(pendingDir, `${randomUUID()}.bin`);
    await copyFile(sourcePath, staged);
    return staged;
  }
  /** 丢弃暂存（失败/取消时）。 */
  async discard(staged) {
    if (typeof staged !== "string") return;
    await rm(staged, { force: true }).catch(() => {
    });
  }
  /**
   * 提交一条备份。同一锚点同一路径只记第一次（那才是「改之前」的状态）。
   * @param {string} sessionId
   * @param {number} anchorSeq
   * @param {{path:string,existed:boolean,mode?:number,callId?:string,staged?:string,size?:number}} capture
   */
  async record(sessionId, anchorSeq, capture) {
    const dir = join(this.sessionDir(sessionId), String(anchorSeq));
    const base = keyOf(capture.path);
    const metaPath = join(dir, `${base}.json`);
    try {
      await stat(metaPath);
      await this.discard(capture.staged);
      return false;
    } catch {
    }
    await mkdir(dir, { recursive: true });
    const meta = {
      path: capture.path,
      existed: capture.existed === true,
      mode: capture.mode,
      time: Date.now(),
      callId: capture.callId,
      size: capture.size
    };
    if (meta.existed && typeof capture.staged === "string") {
      await rename(capture.staged, join(dir, `${base}.before`));
    }
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}
`, "utf8");
    return true;
  }
  /** 读一个会话的全部条目。 */
  async list(sessionId) {
    const dir = this.sessionDir(sessionId);
    let anchors;
    try {
      anchors = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = [];
    for (const anchor of anchors) {
      if (!anchor.isDirectory()) continue;
      const anchorSeq = Number(anchor.name);
      if (!Number.isSafeInteger(anchorSeq)) continue;
      const anchorDir = join(dir, anchor.name);
      let files;
      try {
        files = await readdir(anchorDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(await readFile(join(anchorDir, file), "utf8"));
          if (typeof raw?.path === "string") entries.push(entryOf(anchorSeq, raw));
        } catch {
        }
      }
    }
    return entries;
  }
  /** 锚点目录里某条目的 before 字节路径。 */
  beforePathOf(sessionId, entry) {
    return join(this.sessionDir(sessionId), String(entry.anchorSeq), `${keyOf(entry.path)}.before`);
  }
  /** 纯规划（磁盘无关）。 */
  async planRestore(sessionId, targetSeq) {
    return planRestoreFrom(await this.list(sessionId), targetSeq);
  }
  /**
   * 执行还原计划。只写回记录过的路径，且必须落在 cwd 内；符号链接一律拒绝。
   * @param {string} sessionId
   * @param {{path:string,action:'write'|'delete',entry:any}[]} plan
   * @param {{cwd:string}} options
   * @returns {Promise<{restored:string[],deleted:string[],skipped:string[],failed:{path:string,reason:string}[]}>}
   */
  async applyRestore(sessionId, plan, { cwd }) {
    const result = { restored: [], deleted: [], skipped: [], failed: [] };
    for (const item of plan) {
      const { path, action, entry } = item;
      if (!insideRoot(cwd, path)) {
        result.failed.push({ path, reason: "\u4E0D\u5728\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55\u5185\uFF0C\u62D2\u7EDD\u8FD8\u539F" });
        continue;
      }
      try {
        if (action === "delete") {
          const info = await stat(path).catch(() => void 0);
          if (info === void 0) {
            result.skipped.push(path);
            continue;
          }
          if (!info.isFile()) {
            result.failed.push({ path, reason: "\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF0C\u62D2\u7EDD\u5220\u9664" });
            continue;
          }
          await unlink(path);
          result.deleted.push(path);
          continue;
        }
        const staged = this.beforePathOf(sessionId, entry);
        const before = await readFile(staged);
        const current = await readFile(path).catch(() => void 0);
        if (current !== void 0 && current.equals(before)) {
          result.skipped.push(path);
          continue;
        }
        const tmp = join(dirname(path), `.rewind-lite-${randomUUID()}.tmp`);
        await writeFile(tmp, before, { mode: entry.mode ?? 420 });
        await rename(tmp, path);
        if (typeof entry.mode === "number") await chmod(path, entry.mode).catch(() => {
        });
        result.restored.push(path);
      } catch (error) {
        result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }
};

// src/host.js
var name = "dsh-rewind-lite";
var PLUGIN_VERSION = "0.4.0";
var inject = ["commands"];
var Config = Schema.object({
  enabled: Schema.boolean().default(true).description("\u542F\u7528\u5BF9\u8BDD\u56DE\u9000\u3002"),
  idleTimeoutMs: Schema.number().default(15e3).description("\u56DE\u9000\u524D\u7B49\u5F85\u6B63\u5728\u751F\u6210\u7684\u56DE\u5408\u505C\u4E0B\u6765\uFF08\u542B maintenance \u671F\uFF09\u7684\u6700\u957F\u6BEB\u79D2\u6570\u3002"),
  fileCheckpoint: Schema.boolean().default(true).description("\u5199\u7C7B\u5DE5\u5177\u6267\u884C\u524D\u5907\u4EFD\u6587\u4EF6\uFF0C\u56DE\u9000\u65F6\u53EF\u4E00\u5E76\u8FD8\u539F\u3002"),
  maxFileBytes: Schema.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES).description("\u5355\u4E2A\u6587\u4EF6\u5907\u4EFD\u4E0A\u9650\uFF08\u5B57\u8282\uFF09\uFF0C\u8D85\u8FC7\u5219\u4E0D\u5907\u4EFD\u4E5F\u4E0D\u8FD8\u539F\u3002"),
  snapshotDir: Schema.string().required(false).description("\u5FEB\u7167\u76EE\u5F55\uFF0C\u9ED8\u8BA4 <DSH_HOME>/rewind-lite-snapshots\u3002")
});
function writeLoadMarker() {
  try {
    const home = process.env.DSH_HOME ?? join2(homedir(), ".dsh");
    writeFileSync(
      join2(home, "rewind-lite-loaded.json"),
      `${JSON.stringify({ version: PLUGIN_VERSION, at: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid }, null, 2)}
`,
      "utf8"
    );
  } catch {
  }
}
var CANDIDATE_LIMIT = 100;
function cwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}
function resolveTarget(session, path) {
  try {
    const cwd = cwdOf(session);
    return isAbsolute(path) ? resolve2(path) : resolve2(cwd, path);
  } catch {
    return void 0;
  }
}
function restoreSummary(result) {
  const parts = [];
  if (result.restored.length > 0) parts.push(`\u5199\u56DE ${result.restored.length} \u4E2A\u6587\u4EF6`);
  if (result.deleted.length > 0) parts.push(`\u5220\u9664 ${result.deleted.length} \u4E2A\u65B0\u5EFA\u6587\u4EF6`);
  if (result.skipped.length > 0) parts.push(`\u8DF3\u8FC7 ${result.skipped.length} \u4E2A\uFF08\u5185\u5BB9\u5DF2\u4E00\u81F4\uFF09`);
  if (result.failed.length > 0) parts.push(`\u5931\u8D25 ${result.failed.length} \u4E2A\uFF1A${result.failed.map((item) => `${item.path}\uFF08${item.reason}\uFF09`).join("\uFF1B")}`);
  return parts.length === 0 ? "\u6CA1\u6709\u9700\u8981\u8FD8\u539F\u7684\u6587\u4EF6\u6539\u52A8" : parts.join("\uFF0C");
}
function successText(targetSeq, shadowedCount, restoreLine) {
  return [
    `\u5DF2\u56DE\u9000\u5230 @${targetSeq}\uFF1A\u64A4\u56DE\u8FD9\u6761\u6D88\u606F\u53CA\u5176\u4E4B\u540E\u7684 ${shadowedCount} \u4E2A\u4E0A\u4E0B\u6587\u8282\u70B9\u3002`,
    "\u539F\u63D0\u793A\u8BCD\u5DF2\u56DE\u586B\u5230\u8F93\u5165\u6846\uFF0C\u6539\u5B8C\u53EF\u76F4\u63A5\u91CD\u53D1\uFF08\u56DE\u9000\u672C\u8EAB\u4E0D\u53EF\u64A4\u9500\uFF0C\u88AB\u64A4\u5185\u5BB9\u4ECD\u7559\u5728\u4F1A\u8BDD\u65E5\u5FD7\u91CC\uFF09\u3002",
    restoreLine === void 0 ? "" : `\u6587\u4EF6\u8FD8\u539F\uFF1A${restoreLine}`
  ].filter((line) => line !== "").join("\n");
}
async function waitUntilIdle(agent, signal, timeoutMs) {
  if (signal !== void 0 && signal.aborted) return false;
  let timer;
  let onAbort;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("\u7B49\u5F85\u7A7A\u95F2\u8D85\u65F6")), timeoutMs);
        if (signal !== void 0) {
          onAbort = () => reject(new Error("\u5DF2\u53D6\u6D88"));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    if (onAbort !== void 0 && signal !== void 0) signal.removeEventListener("abort", onAbort);
  }
}
function dropSteering(agent) {
  const inbox = agent?.inbox;
  if (inbox === void 0 || inbox.nextStep === void 0) return;
  for (const message of [...inbox.nextStep]) {
    try {
      inbox.remove(message.id);
    } catch {
    }
  }
}
function planErrorText(error) {
  if (error instanceof RewindError) {
    const table = {
      "no-user-messages": "\u8FD9\u6761\u4F1A\u8BDD\u91CC\u8FD8\u6CA1\u6709\u53EF\u56DE\u9000\u7684\u7528\u6237\u6D88\u606F\u3002",
      "invalid-index": error.message,
      "not-a-user-message": error.message,
      "not-on-surface": error.message,
      "bad-target": error.message
    };
    return table[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
async function syncObservations(ctx, agent, session, restore) {
  let fs;
  try {
    fs = ctx.get?.("fs");
  } catch {
    fs = void 0;
  }
  if (fs === void 0 || typeof fs.resolve !== "function") return;
  const cwd = cwdOf(session);
  for (const path of [...restore.restored, ...restore.deleted]) {
    try {
      const target = await fs.resolve(path, { cwd });
      const info = await fs.stat(target).catch(() => void 0);
      const observation = info === void 0 ? { kind: "absent" } : { kind: "present", version: info.version };
      ctx.emit("fs/observed", target, observation, { agent });
    } catch {
    }
  }
}
async function runRewind(ctx, invocation, cfg, inflight, store) {
  const { agent } = invocation;
  const session = agent?.session;
  if (session === void 0) return { kind: "error", text: "\u5F53\u524D\u4F1A\u8BDD\u4E0D\u53EF\u7528\u3002" };
  if (isSubagentSession(session)) {
    return { kind: "error", text: "\u5B50\u4EE3\u7406\u4F1A\u8BDD\u4E0D\u652F\u6301\u56DE\u9000\uFF08\u8BF7\u56DE\u5230\u4E3B\u4F1A\u8BDD\u64CD\u4F5C\uFF09\u3002" };
  }
  const events = session.snapshotEvents();
  const surface = session.surface.nodes;
  const input = String(invocation.rawInput ?? "").trim();
  if (input === "") {
    return { kind: "success", text: formatCandidates(listCandidates(events, surface, CANDIDATE_LIMIT)) };
  }
  const [rawTarget, rawMode] = input.split(/\s+/);
  const mode = rawMode ?? "chat";
  if (mode !== "chat" && mode !== "both") {
    return { kind: "error", text: `\u770B\u4E0D\u61C2\u7684\u6A21\u5F0F\u300C${mode}\u300D\uFF1A\u53EA\u652F\u6301 chat\uFF08\u4EC5\u5BF9\u8BDD\uFF09\u6216 both\uFF08\u5BF9\u8BDD+\u6587\u4EF6\uFF09\u3002` };
  }
  const target = parseTarget(rawTarget);
  if (target === void 0) {
    return { kind: "error", text: `\u770B\u4E0D\u61C2\u7684\u76EE\u6807\u300C${rawTarget}\u300D\uFF0C\u7528\u6CD5\uFF1A/rewind @<seq>\uFF08seq \u89C1\u88F8 /rewind \u7684\u5217\u8868\uFF09\u3002` };
  }
  if (target.kind === "index") {
    return { kind: "error", text: "\u4E3A\u907F\u514D\u548C\u65E5\u5FD7\u5E8F\u53F7\u6DF7\u6DC6\uFF0C\u8BF7\u7528 @<seq> \u5F62\u5F0F\u6307\u5B9A\u76EE\u6807\uFF0C\u4F8B\u5982 /rewind @123\u3002" };
  }
  const sessionId = String(session.id);
  if (inflight.has(sessionId)) {
    return { kind: "error", text: "\u8FD9\u4E2A\u4F1A\u8BDD\u6B63\u5728\u6267\u884C\u53E6\u4E00\u6B21\u56DE\u9000\uFF0C\u8BF7\u7A0D\u5019\u518D\u8BD5\u3002" };
  }
  inflight.add(sessionId);
  try {
    if (agent.status !== "idle") {
      try {
        agent.cancel({ kind: "user" }, { keepInbox: true });
      } catch {
      }
      const idle = await waitUntilIdle(agent, invocation.signal, cfg.idleTimeoutMs);
      if (!idle) return { kind: "error", text: "\u7B49\u5F85\u5F53\u524D\u56DE\u5408\u505C\u4E0B\u8D85\u65F6\uFF0C\u56DE\u9000\u5DF2\u653E\u5F03\uFF08\u4F1A\u8BDD\u672A\u6539\u52A8\uFF09\u3002" };
    }
    if (invocation.signal !== void 0 && invocation.signal.aborted) {
      return { kind: "error", text: "\u56DE\u9000\u5DF2\u53D6\u6D88\u3002" };
    }
    dropSteering(agent);
    let plan;
    try {
      plan = planRewind(session.snapshotEvents(), session.surface.nodes, target);
    } catch (error) {
      return { kind: "error", text: planErrorText(error) };
    }
    const marker = buildMarker();
    let event;
    try {
      event = session.append("user/message", marker, {
        surfaceOp: { op: "replace", startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs]
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "error", text: `\u56DE\u9000\u5931\u8D25\uFF08\u4F1A\u8BDD\u672A\u6539\u52A8\uFF09\uFF1A${reason}` };
    }
    let restoreLine;
    if (mode === "both") {
      if (store === void 0 || cfg.fileCheckpoint === false) {
        restoreLine = "\u5DF2\u5173\u95ED\u6587\u4EF6\u5907\u4EFD\uFF08\u914D\u7F6E fileCheckpoint\uFF09\uFF0C\u53EA\u56DE\u9000\u4E86\u5BF9\u8BDD\u3002";
      } else {
        try {
          const restorePlan = await store.planRestore(sessionId, plan.targetSeq);
          if (restorePlan.length === 0) {
            restoreLine = "\u6CA1\u6709\u9700\u8981\u8FD8\u539F\u7684\u6587\u4EF6\u6539\u52A8\u3002";
          } else {
            const outcome = await store.applyRestore(sessionId, restorePlan, { cwd: cwdOf(session) });
            await syncObservations(ctx, agent, session, outcome);
            restoreLine = restoreSummary(outcome);
          }
        } catch (error) {
          restoreLine = `\u8FD8\u539F\u6587\u4EF6\u65F6\u51FA\u9519\uFF08\u5BF9\u8BDD\u5DF2\u56DE\u9000\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    return {
      kind: "success",
      text: successText(plan.targetSeq, plan.shadowedSeqs.length, restoreLine),
      sourceEventSeq: event.seq
    };
  } finally {
    inflight.delete(sessionId);
  }
}
function pendingKeyOf(exec) {
  return `${exec?.agent?.id ?? "anon"}:${exec?.callId ?? ""}`;
}
async function captureBefore(store, pending, exec) {
  const agent = exec?.agent;
  const session = agent?.session;
  if (session === void 0) return;
  if (isSubagentSession(session)) return;
  const path = mutationPathOf(exec);
  if (path === void 0) return;
  const abs = resolveTarget(session, path);
  if (abs === void 0 || !insideRoot(cwdOf(session), abs)) return;
  const key = pendingKeyOf(exec);
  let info;
  try {
    info = await lstat(abs);
  } catch {
    pending.set(key, { path: abs, existed: false });
    return;
  }
  if (!info.isFile()) return;
  if (info.size > store.maxFileBytes) return;
  try {
    const staged = await store.stage(abs);
    pending.set(key, { path: abs, existed: true, staged, mode: info.mode & 4095, size: info.size });
  } catch {
  }
}
async function commitAfter(store, pending, exec, result) {
  const key = pendingKeyOf(exec);
  const capture = pending.get(key);
  if (capture === void 0) return;
  pending.delete(key);
  if (result?.isError === true) {
    await store.discard(capture.staged);
    return;
  }
  const session = exec?.agent?.session;
  if (session === void 0) {
    await store.discard(capture.staged);
    return;
  }
  try {
    await store.record(String(session.id), latestHumanSeq(session), { ...capture, callId: String(exec.callId ?? "") });
  } catch {
    await store.discard(capture.staged);
  }
}
function apply(ctx, config) {
  const cfg = {
    enabled: true,
    idleTimeoutMs: 15e3,
    fileCheckpoint: true,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    snapshotDir: void 0,
    ...config ?? {}
  };
  if (cfg.enabled === false) return;
  writeLoadMarker();
  const inflight = /* @__PURE__ */ new Set();
  const dshHome = process.env.DSH_HOME ?? join2(homedir(), ".dsh");
  const store = cfg.fileCheckpoint === false ? void 0 : new SnapshotStore({
    root: cfg.snapshotDir ?? join2(dshHome, "rewind-lite-snapshots"),
    maxFileBytes: cfg.maxFileBytes
  });
  const pending = /* @__PURE__ */ new Map();
  if (store !== void 0 && typeof ctx.on === "function") {
    ctx.on("tools/execute", async (exec, next) => {
      try {
        await captureBefore(store, pending, exec);
      } catch {
      }
      return next();
    });
    ctx.on("tools/post-execute", async (exec, result, next) => {
      try {
        await commitAfter(store, pending, exec, result);
      } catch {
      }
      return next();
    });
    ctx.on("tools/result", (exec) => {
      const capture = pending.get(pendingKeyOf(exec));
      pending.delete(pendingKeyOf(exec));
      if (capture?.staged !== void 0) void store.discard(capture.staged);
      return void 0;
    });
  }
  const register = (definition) => {
    try {
      ctx.effect(() => ctx.commands.register(definition), `dsh-rewind-lite: /${definition.name}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        ctx.logger?.warn?.(`[dsh-rewind-lite] \u6CE8\u518C /${definition.name} \u5931\u8D25\uFF1A${reason}`);
      } catch {
      }
    }
  };
  const handler = (invocation) => runRewind(ctx, invocation, cfg, inflight, store);
  register({
    name: "rewind",
    description: "\u56DE\u9000\u5BF9\u8BDD\u5230\u66F4\u65E9\u7684\u7528\u6237\u6D88\u606F\uFF0C\u53EF\u4E00\u5E76\u8FD8\u539F\u6587\u4EF6\uFF08\u64A4\u56DE\u8BE5\u6D88\u606F\u53CA\u5176\u4E4B\u540E\u5185\u5BB9\uFF0C\u539F\u63D0\u793A\u8BCD\u56DE\u586B\u8F93\u5165\u6846\uFF09",
    input: { hint: "\u88F8\u547D\u4EE4\u770B\u5019\u9009\uFF1B/rewind @<seq> [chat|both] \u6267\u884C\u56DE\u9000" },
    handler
  });
  register({
    name: "undo",
    description: "\u540C /rewind\uFF1A\u56DE\u9000\u5BF9\u8BDD\u5230\u66F4\u65E9\u7684\u7528\u6237\u6D88\u606F",
    input: { hint: "\u88F8\u547D\u4EE4\u770B\u5019\u9009\uFF1B/undo @<seq> [chat|both] \u6267\u884C\u56DE\u9000" },
    handler
  });
  register({
    name: "rewind-lite",
    description: "\u5185\u90E8\u901A\u9053\uFF1A@<seq> chat|both\uFF08\u5BA2\u6237\u7AEF\u6309\u94AE\u8C03\u7528\uFF0C\u8BF7\u52FF\u624B\u8F93\uFF09",
    input: { hint: "@<seq> chat|both" },
    handler
  });
}
export {
  Config,
  MARKER_TEXT,
  apply,
  inject,
  name
};
