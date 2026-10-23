/**
 * 文件快照模块测试：规划逻辑（纯函数）+ 真实临时目录的备份/还原端到端。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SnapshotStore, insideRoot, planRestoreFrom } from '../src/snapshot.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rewind-lite-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('规划：只取锚点 >= 目标的最早一条', () => {
  const entries = [
    { path: '/w/a.txt', anchorSeq: 0, existed: true, time: 1 },
    { path: '/w/a.txt', anchorSeq: 4, existed: true, time: 5 },
    { path: '/w/a.txt', anchorSeq: 8, existed: true, time: 9 },
    { path: '/w/b.txt', anchorSeq: 4, existed: false, time: 6 },
    { path: '/w/c.txt', anchorSeq: 0, existed: true, time: 1 },
  ];
  const plan = planRestoreFrom(entries, 4);
  assert.deepEqual(
    plan.map((item) => [item.path, item.action, item.entry.anchorSeq]),
    [
      ['/w/a.txt', 'write', 4],
      ['/w/b.txt', 'delete', 4],
    ],
  );
  // 回退到最早：每个文件取自己最早那条
  const all = planRestoreFrom(entries, 0);
  assert.deepEqual(all.map((item) => item.action), ['write', 'delete', 'write']);
});

test('规划：同锚点取时间最早的一条（一次调用内多次写保留最初的 before）', () => {
  const entries = [
    { path: '/w/a.txt', anchorSeq: 4, existed: true, time: 9 },
    { path: '/w/a.txt', anchorSeq: 4, existed: true, time: 5 },
  ];
  const plan = planRestoreFrom(entries, 4);
  assert.equal(plan[0].entry.time, 5);
});

test('路径必须在工作目录内（防越界）', () => {
  assert.equal(insideRoot('/w', '/w/a.txt'), true);
  assert.equal(insideRoot('/w', '/w/sub/a.txt'), true);
  assert.equal(insideRoot('/w', '/w2/a.txt'), false);
  assert.equal(insideRoot('/w', '/w/../etc/passwd'), false);
});

test('端到端：备份 → 改动 → 回退还原旧内容', async () => {
  await withTempDir(async (dir) => {
    const work = join(dir, 'work');
    await mkdir(work, { recursive: true });
    const file = join(work, 'a.txt');
    const store = new SnapshotStore({ root: join(dir, 'snap') });

    await writeFile(file, 'v1', 'utf8');
    const staged1 = await store.stage(file);
    await store.record('ses', 0, { path: file, existed: true, staged: staged1, mode: 0o644, callId: 'c1' });

    // 模拟锚点 4 这一次真实改动：先备份 v2，再把文件改成 v2-edited
    await writeFile(file, 'v2', 'utf8');
    const staged2 = await store.stage(file);
    await store.record('ses', 4, { path: file, existed: true, staged: staged2, mode: 0o644, callId: 'c2' });
    await writeFile(file, 'v2-edited', 'utf8');

    // 回退到 4：还原成 4 之前的状态（v2）
    const plan4 = await store.planRestore('ses', 4);
    assert.equal(plan4.length, 1);
    const outcome4 = await store.applyRestore('ses', plan4, { cwd: work });
    assert.deepEqual(outcome4.restored, [file]);
    assert.equal(await readFile(file, 'utf8'), 'v2');

    // 回到磁盘是 v3 的情况：回退到 0 应还原 v1
    await writeFile(file, 'v3', 'utf8');
    const plan0 = await store.planRestore('ses', 0);
    const outcome0 = await store.applyRestore('ses', plan0, { cwd: work });
    assert.deepEqual(outcome0.restored, [file]);
    assert.equal(await readFile(file, 'utf8'), 'v1');
  });
});

test('端到端：目标之后新建的文件被删掉；内容已一致则跳过', async () => {
  await withTempDir(async (dir) => {
    const work = join(dir, 'work');
    await mkdir(work, { recursive: true });
    const created = join(work, 'new.txt');
    const unchanged = join(work, 'same.txt');
    const store = new SnapshotStore({ root: join(dir, 'snap') });

    await writeFile(created, 'hello', 'utf8');
    await store.record('ses', 4, { path: created, existed: false, callId: 'c3' });

    await writeFile(unchanged, 'same', 'utf8');
    const staged = await store.stage(unchanged);
    await store.record('ses', 4, { path: unchanged, existed: true, staged, mode: 0o644, callId: 'c4' });

    const plan = await store.planRestore('ses', 4);
    assert.deepEqual(plan.map((item) => item.action).sort(), ['delete', 'write']);
    const outcome = await store.applyRestore('ses', plan, { cwd: work });
    assert.deepEqual(outcome.deleted, [created]);
    assert.deepEqual(outcome.skipped, [unchanged]);
    await assert.rejects(() => stat(created));
    assert.equal(await readFile(unchanged, 'utf8'), 'same');
  });
});

test('端到端：工作目录外的路径拒绝还原', async () => {
  await withTempDir(async (dir) => {
    const work = join(dir, 'work');
    await mkdir(work, { recursive: true });
    const outside = join(dir, 'outside.txt');
    await writeFile(outside, 'keep', 'utf8');
    const store = new SnapshotStore({ root: join(dir, 'snap') });
    const staged = await store.stage(outside);
    await store.record('ses', 0, { path: outside, existed: true, staged, mode: 0o644 });
    const plan = await store.planRestore('ses', 0);
    const outcome = await store.applyRestore('ses', plan, { cwd: work });
    assert.equal(outcome.restored.length, 0);
    assert.equal(outcome.failed.length, 1);
    assert.equal(await readFile(outside, 'utf8'), 'keep');
  });
});
