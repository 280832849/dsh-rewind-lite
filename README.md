# dsh-rewind-lite

DeepSeek Harness 插件：**同窗口内就地回退对话到任意更早的用户消息**，只往会话日志追加一条标记，不新建分支、不删改历史；被撤回的原提示词自动回填输入框，改完直接重发。

本地自研维护版：不依赖第三方仓库，代码在本地，DSH 升级后由维护者（DSH 里的 AI 助手）负责适配。

## 已实现（0.1.0）

| 能力 | 状态 |
|---|---|
| `/rewind`、`/undo` 命令 | ✅ |
| 裸命令打开官方 popupSelect 选目标 | ✅ |
| 回退到任意更早的**用户消息**（撤回目标及其之后的所有内容） | ✅ |
| 原提示词回填输入框（`setDraft`，失败退 DOM） | ✅ |
| 聊天界面隐藏被撤回的行（持久化：刷新/换会话/重启后仍然隐藏） | ✅ |
| 只追加不删改：日志保留全部原文，可搜索、可导出 | ✅ |
| 守卫：生成中先取消再回退、并发回退加锁、被压缩遮蔽的目标拒绝、子会话拒绝 | ✅ |
| 消息旁「↶」按钮（二次确认：只回退对话 / 对话+文件） | ✅ |
| 文件还原：回退时把 AI 改过的文件还原、删掉目标之后新建的文件 | ✅ |
| 撤销回退 | ❌（设计如此，见下） |

## 安装

```sh
# 本机开发目录打包
cd "…/dsh-rewind-lite" && npm pack

# 装进 desktop profile（本地路径依赖）
dsh plugin --profile desktop add "file:…/dsh-rewind-lite/dsh-rewind-lite-0.1.0.tgz"
```

desktop profile 是 `patchReload: live`，装完插件后端热加载；**客户端那半侧需要刷新页面**才生效。

卸载：

```sh
dsh plugin --profile desktop remove dsh-rewind-lite
```

## 使用

1. 输入 `/rewind`（或 `/undo`）→ 弹出候选列表（最新的在前）。
2. 选一条 → 回退执行：模型上下文截断到这条消息之前，界面隐藏这条及其之后的行，原提示词回到输入框。
3. 修改后直接发送。

也可以手输 `/rewind @123` 直接指定目标（seq 见候选列表），效果相同。

## 文件快照（v0.4.0）

- **写前备份**：`write` / `edit` 工具执行前把原文件按字节暂存，执行成功后按「最近一条用户消息 seq」锚点提交。
- **回退还原**：回退到 N 时，每个文件取「锚点 >= N 的最早一条」——N 之后第一次被改之前的状态；当时不存在的文件（= N 之后新建的）直接删掉。
- **存储**：`<DSH_HOME>/rewind-lite-snapshots/<sessionId>/<anchorSeq>/`（只留最新几组，不自动清理，体积很小）。
- **安全**：只还原记录过、且落在会话工作目录内的普通文件；符号链接、超 5MB 的文件不备份也不还原；写回用「同目录临时文件 + rename」保持原子性。
- **不备份**：子代理会话的写操作；插件加载之前发生的改动（没有备份可用）。

## 原理（一句话版）

回退 = 往会话日志追加一条 `user/message` 标记，带 `surfaceOp: {op:'replace', startSeq, endSeq}` 覆盖「目标消息及其之后的所有表面节点」。DSH 重放日志时，模型可见表面自动从目标处截断；日志本身一个事件都不动。

客户端另算一遍：扫描持久化的 `command` 节点（`@seq` + `outcome.sourceEventSeq`）得到撤回区间，把落在区间里的 DOM 行隐藏。

## 已知限制

- **回退不可撤销**：想恢复只能重新发消息；被撤内容仍在日志里，但界面上没有一键恢复。
- **文件不还原**：AI 已经改过的文件不会跟着回退（P2）。
- 目标消息被压缩（compaction）遮蔽后不能再回退到它——模型上下文已经到不了那里。
- 回退标记会短暂出现在模型上下文里（内容为 `(已回退，等待重新发送)`），用户重发后与新消息并存，属正常现象。
- 「对话+文件」会覆盖你在 AI 之后又手动改过的文件——这是还原的定义，介意就只选「只回退对话」。
- 文件备份从插件加载后开始记录；插件装上之前的改动没有备份，无法还原。

## 维护须知

### 唯一脆弱点：客户端 DOM 约定

客户端依赖 harness 内部属性定位聊天行与输入框：

| 选择器 | 用途 |
|---|---|
| `[data-chat-anchor-key]` / `[data-chat-node-key]` | 聊天行 → 快照节点 → anchorSeq（判断是否隐藏） |
| `[data-composer-input]` | 输入框 DOM 兜底回填 |

这些属性随 UI 升级可能改名。**DSH 大版本升级后第一件事**：在浏览器里确认这两类属性还在；不在就改 `src/client/index.js` 里的选择器与 `applyHidden()` 的解析逻辑。

### 其它升级适配点

1. `session.snapshotEvents()` 已被标记 deprecated —— 若某次升级删掉它，改用新的只读事件读取 API（`src/host.js` 的两处调用）。
2. `surfaceOp` 的 `replace` 语义与 `sourceEventSeqs` 完整性校验 —— 若语义变化，`src/marker.js` + `src/host.js` 的 append 调用要跟着改。
3. `uiConversation` 服务的 `binding().target('chat')` 视图名与 `conversation.input.for(scope).setDraft` —— 若改名，改 `src/client/index.js` 的 `chatOf` / `setComposerText`。
4. `commandUi.decorate` 的 popupSelect 契约 —— 若变化，退化成「裸命令只列候选、手输 @seq 执行」。

### 改动流程

```sh
npm run build      # esbuild：宿主 ESM + 客户端 __ModuleLoader__ 闭包
npm test           # 34 个离线测试（真 SDK 建会话 + 纯逻辑 + 宿主命令面）
npm pack           # 出 tgz，供 dsh plugin add
```

**升版本前必须先跑测试**：`test/session.test.mjs` 用真的 `@deepseek-ai/dsh-session` 验证「追加标记 = 表面截断」，这个测试挂了就说明 SDK 语义变了，插件必须改，不能硬装。
