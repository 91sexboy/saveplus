import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { addDefaultRule, createHarness } from "./helpers/harness";

test("06 已接收的任务持久保存：重启后由新实例继续执行，不主动扫描离线历史", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.sendGate = new Promise<void>(() => undefined);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" });
  await new Promise((r) => setTimeout(r, 20));
  h.tg.sendGate = undefined;
  // 第一个任务卡在发送中，停止时它成为“结果不确定”，第二个仍在排队。
  await h.stop();
  const reads = h.tg.readCalls;
  await h.start();
  await h.idle();
  assert.equal(h.task(1).status, "uncertain");
  assert.match(h.task(1).lastError?.message ?? "", /被重启或重载，无法确认是否已发送/);
  assert.equal(h.task(2).status, "done");
  assert.equal(h.tg.stagedSends().length, 1, "结果不确定的任务不会被自动重发");
  assert.equal(h.tg.readCalls - reads, 1, "新实例只读取待执行任务的来源消息，不扫描历史");
  await h.stop();
});

test("06 停止时尚在聚合的相册会落盘为任务，重启后整组发送", async () => {
  const h = await createHarness({ options: { albumDebounceMs: 10_000 } });
  await addDefaultRule(h);
  h.clock.autoAdvanceMaxMs = 5_000;
  await h.emitAlbum("-1001", [
    { id: 10, kind: "photo", groupedId: "g1", text: "组" },
    { id: 11, kind: "photo", groupedId: "g1" },
  ]);
  assert.equal(h.data.tasks.length, 0);
  await h.stop();
  h.clock.autoAdvanceMaxMs = Number.POSITIVE_INFINITY;
  await h.start();
  await h.idle();
  assert.deepEqual(h.data.tasks.map((t) => [t.status, t.memberIds]), [["done", [10, 11]]]);
  assert.equal(h.tg.stagedSends()[0].items?.length, 2);
  await h.stop();
});

test("06 已成功但未清理的任务在重启后只完成清理，不再上传", async () => {
  const h = await createHarness({ options: { backoffBaseMs: 60_000 } });
  await addDefaultRule(h);
  h.clock.autoAdvanceMaxMs = 30_000;
  h.tg.beforeSendResolve = () => fs.chmodSync(h.stagingDir, 0o500);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.task(1).status, "cleanup_pending");
  h.tg.beforeSendResolve = undefined;
  await h.stop();
  fs.chmodSync(h.stagingDir, 0o755);
  h.clock.autoAdvanceMaxMs = Number.POSITIVE_INFINITY;
  h.clock.advance(60_000);
  await h.start();
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.stagedSends().length, 1);
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("06 热重载：旧实例 cleanup 后不再接收或执行，新实例只有一套监听；drain 能完成", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  const oldPlugin = h.plugin;
  const oldLifecycle = h.lifecycle;
  oldLifecycle.abort("reload");
  await oldPlugin.cleanup();
  const drained = await oldLifecycle.drain(3000);
  assert.equal(drained.completed, true);
  assert.equal(drained.pendingTasks, 0);
  await oldPlugin.cleanup();

  await h.start();
  const raw = h.tg.addMessage("-1001", { id: 5, kind: "photo" });
  await oldPlugin.listenMessageHandler?.(raw as never);
  await h.plugin.listenMessageHandler?.(raw as never);
  await h.idle();
  assert.equal(h.data.tasks.length, 1);
  assert.equal(h.tg.stagedSends().length, 1);
  const out: string[] = [];
  await oldPlugin.cmdHandlers.saveplus({ message: ".saveplus status", edit: async (p: { text: string }) => void out.push(p.text) } as never);
  assert.match(out[0], /尚未初始化完成/);
  await h.stop();
});

test("06 同一实例重复 setup 会先停止旧引擎，不产生两套执行者", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  const first = h.engine;
  await h.plugin.setup({ generation: 99, signal: h.lifecycle.signal, lifecycle: h.lifecycle });
  assert.notEqual(h.engine, first);
  assert.equal(first.isStopped, true);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("06 旧实例在发送途中被卸载：其迟到的结果不会写入存储，新实例将其视为结果不确定", async () => {
  const h = await createHarness({ options: { stopTimeoutMs: 100 } });
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 20));
  await h.stop();
  h.tg.sendGate = undefined;
  await h.start();
  release();
  await new Promise((r) => setTimeout(r, 50));
  await h.idle();
  assert.equal(h.task(1).status, "uncertain");
  assert.equal(Object.keys(h.data.successes).length, 0);
  await h.stop();
});

test("06 回归：发送请求挂起时，卸载仍会在 stopTimeoutMs 内结束，宿主 drain 不被拖到超时", async () => {
  const h = await createHarness({ options: { stopTimeoutMs: 150 } });
  await addDefaultRule(h);
  h.tg.sendGate = new Promise<void>(() => undefined);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  h.lifecycle.abort("reload");
  await h.plugin.cleanup();
  const drained = await h.lifecycle.drain(3000);
  assert.equal(drained.timedOut, false);
  assert.equal(drained.completed, true);
  assert.ok(Date.now() - started < 1500, `卸载用时 ${Date.now() - started}ms`);
});
