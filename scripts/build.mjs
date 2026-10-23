#!/usr/bin/env node
/**
 * 构建两个产物到 lib/：
 *   lib/index.js  — 宿主半侧：src/host.js 打包成 ESM，所有 @deepseek-ai/* 保持
 *                   external（由 harness 安装目录解析，不能进包）。
 *   lib/client.js — 客户端半侧：打包成 CJS，再套上 Web 启动约定
 *                   `window.__ModuleLoader__.load({ id, factory })`。
 *                   react / react-dom / react/jsx-runtime 保持 external，由
 *                   web profile 的模块图提供。
 *
 * 这个脚本只做转译与打包，类型检查是另一件事（本项目是 JS，没有 tsc）。
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const LIB = join(ROOT, 'lib');

/** 依赖外置：DSH 运行时提供，绝不能打进包里。 */
const HOST_EXTERNALS = ['@deepseek-ai/*', 'node:*'];
const CLIENT_EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'];

await mkdir(LIB, { recursive: true });

// ---------- 宿主半侧 ----------
await build({
  entryPoints: [join(ROOT, 'src/host.js')],
  outfile: join(LIB, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: HOST_EXTERNALS,
  logLevel: 'warning',
});

// ---------- 客户端半侧 ----------
const clientEntry = join(ROOT, 'src/client/index.jsx');
const clientSource = await readFile(clientEntry, 'utf8');
const built = await build({
  stdin: {
    contents: clientSource,
    resolveDir: join(ROOT, 'src/client'),
    sourcefile: 'client/index.jsx',
    loader: 'jsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: CLIENT_EXTERNALS,
  logLevel: 'warning',
});

const bundle = built.outputFiles[0].text;
const wrapped = `/**
 * ${pkg.name} 客户端半侧（构建产物，勿手改；源码在 src/client/）。
 * 模块 id 必须等于包名，dsh.client 的 inject 才能解析到本条目。
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundle}
    return module.exports;
  },
});
`;
await writeFile(join(LIB, 'client.js'), wrapped, 'utf8');

// ---------- 冒烟校验 ----------
// 宿主产物必须能 import，且形状对（有 name / apply）。
const hostModule = await import(`${join(LIB, 'index.js')}?t=${Date.now()}`);
if (typeof hostModule.name !== 'string' || typeof hostModule.apply !== 'function') {
  throw new Error('lib/index.js 形状不对：缺少 name/apply 导出');
}
if (!wrapped.includes('__ModuleLoader__.load') || !wrapped.includes(`id: ${JSON.stringify(pkg.name)}`)) {
  throw new Error('lib/client.js 不是合法的 __ModuleLoader__ 闭包');
}
console.log(`build ok: ${pkg.name}@${pkg.version} -> lib/index.js + lib/client.js`);
