# AGENTS.md — dsh-rewind-lite 维护手册

给「以后接手维护这个插件的 AI」看的。用户只关心能不能用，不关心实现细节；维护者要保证 DSH 升级后它还能用。

## 项目定位

- 自研、本地维护的 DSH 对话回退插件，替代第三方 `dsh-rewind`（那个 8882 行代码 + 9269 行测试，功能全但维护面大）。
- 语义与开源版一致：**就地回退，只追加一条 `user/message` 标记，`surfaceOp.replace` 覆盖目标及之后节点**。
- 刻意不做：i18n（只有中文）、设置卡片、RPC 通道、自动清理、文件快照引擎。

## 目录

```
src/host.js          宿主半侧：命令注册 + 守卫 + append 标记 + 工具钩子接线
src/snapshot.js      文件快照：写前备份、提交、规划、还原（含路径守卫）
src/plan.js          纯规划：候选、目标解析、区间计算（可离线单测）
src/marker.js        标记构造（非空文本，source.kind = dsh-rewind-lite）
src/client/index.jsx 客户端半侧：隐藏行、选择器装饰、回填输入框
src/client/hidden.js 客户端纯逻辑：从 command 节点算撤回区间
scripts/build.mjs    构建（esbuild）+ 产物形状冒烟校验
test/*.test.mjs      34 个离线测试
lib/                 构建产物（不手改）
```

## 升级 DSH 后的检查清单

1. `npm run build && npm test` —— **必须全绿**。
   - `test/session.test.mjs` 挂：`surfaceOp.replace` 语义变了，先读 `@deepseek-ai/dsh-session` 的 `surface.d.ts`，改 `src/host.js` 的 append 调用与 `src/plan.js` 的区间算法。
   - `test/host.test.mjs` 挂：命令注册或 agent API（`status` / `cancel` / `whenIdle` / `inbox.nextStep`）变了。
   - `test/client-hidden.test.mjs` 挂：命令行节点形状变了（`kind:'command'`、`data.name`、`data.args`、`data.outcome.sourceEventSeq`）。
   - `test/snapshot.test.mjs` / `test/host-restore.test.mjs` 挂：文件备份/还原坏了。重点看有没有变：`tools/execute`、`tools/post-execute`、`tools/result` 三个事件（`src/host.js` 的 `captureBefore` / `commitAfter`）、`write`/`edit` 工具参数里的 `file_path`，以及 `session.header.cwd`。
2. 看浏览器：聊天行是否还有 `data-chat-anchor-key` / `data-chat-node-key`，输入框是否还有 `data-composer-input`。没有就改 `src/client/index.js` 的 `applyHidden()` 与 `fillComposerDom()`。
3. 确认 `uiConversation` 的 chat 视图名仍叫 `chat`、`conversation.input.for(scope).setDraft` 仍存在（`chatOf()` / `setComposerText()`）。
4. 跑一遍真机验证：新建测试会话 → 发 3 条消息 → `/rewind` 选第 2 条 → 确认 ①上下文确实截断（问模型还记不记得第 3 条）②界面第 2 条之后消失 ③输入框回填第 2 条文本。
5. 改版本号 + `npm pack` + `dsh plugin --profile desktop remove/add`（desktop 是 `patchReload: live`，后端热加载、页面需刷新）。

## 版本约束

- `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`：0.2.x 内升级不必然失配，0.3.0 必须重新验证。
- peers 全部 optional：只在学校验 dsh 版本，不逐个校验 peer。
- 若被 loader 拒绝装：查 `dsh-app-boot` 的 compatibility 逻辑，必要时写 profile 的 `compatibility.json` exemptions。

## 出问题怎么退回

```sh
dsh plugin --profile desktop remove dsh-rewind-lite   # 插件卸载
# 会话日志不受影响：标记只是普通事件，其他插件/官方读取时按未知 ignorable 语义处理
```

标记是 `user/message`，不是 ignorable 插件记录——**卸载插件后回退效果不会消失**（表面仍按 replace 折叠）。这是设计取舍：换来的是一致性，代价是「卸载不能撤销已发生的回退」。若要真正恢复对话，只能回退到更早的位置再重发，或另开会话。

## 装/卸踩坑记录（2026-10-23）

踩到一个坑：有些环境里 `dsh` 命令来自另一个旧工具链（open-design runtime 0.1.2-alpha.2），它转发 pnpm 时撞上 **store 版本不匹配**（profile 的 node_modules 是 pnpm 11 的 store/v11，系统 pnpm 是 10，报 `ERR_PNPM_UNEXPECTED_STORE`）。解决办法是用同版本 pnpm 转发：

```sh
mkdir -p /tmp/pnpm11 && printf '#!/bin/bash\nexec npx -y pnpm@11 "$@"\n' > /tmp/pnpm11/pnpm && chmod +x /tmp/pnpm11/pnpm
PATH=/tmp/pnpm11:$PATH dsh plugin --profile desktop add "file:<项目>/dsh-rewind-lite-0.4.0.tgz"
```

`dsh plugin add` 会做两件事：① 往 profile `package.json` 的 dependencies 加包；② 往 `dsh.profile.bundles` 追加包名（**只加依赖不加 bundles 不会加载**）。纯 `pnpm add` 只做 ①，所以必须走 `dsh plugin add`。

- 装之前备份 profile 的 `package.json`（一次，别累积）。
- 装完必须**重启 App**（bundle 在新的 boot 组装时生效），客户端那半侧再刷新页面。
- 卸载：`dsh plugin --profile desktop remove dsh-rewind-lite`，然后重启。
