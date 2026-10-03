import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDefaultRule, createHarness } from "./helpers/harness";
import { SavePlusError } from "../saveplus";

test("取消处理中的任务：立即中断下载，删除下载到一半的文件，不发送", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.stageGate = new Promise<void>(() => undefined);
  await h.emit("-1001", { id: 1870, kind: "video", cover: "custom" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.task(1).status, "running");
  assert.ok(fs.existsSync(path.join(h.stagingDir, "task_1", "m1870_partial.bin.part")));
  assert.match(await h.cmd(".saveplus task cancel 1"), /正在停止任务 #1：中断下载后取消/);
  h.tg.stageGate = undefined;
  await h.idle();
  assert.equal(h.task(1).status, "cancelled");
  assert.ok(!fs.existsSync(path.join(h.stagingDir, "task_1")));
  assert.equal(h.tg.stagedSends().length, 0);
  assert.match(await h.cmd(".saveplus task show 1"), /已取消[\s\S]*已按用户要求取消/);
  await h.stop();
});

test("取消发送中的任务：等本次发送结束，已发出则保留为已完成", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.task(1).status, "sending");
  assert.match(await h.cmd(".saveplus task cancel 1"), /正在向目标发送，发送请求无法撤回/);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("取消发送中的任务：发送失败则直接取消，不再重试；无法确认时保持结果不确定", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  h.tg.failures.send.push(new SavePlusError("network", "服务器暂时不可用（TIMEOUT）", { transient: true }));
  h.tg.deliverThenFail.push(new SavePlusError("uncertain", "发送过程中断，无法确认是否已发送", { maybeSent: true }));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" });
  await new Promise((r) => setTimeout(r, 30));
  await h.cmd(".saveplus task cancel 1");
  let release2!: () => void;
  release();
  h.tg.sendGate = new Promise<void>((r) => (release2 = r));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.task(2).status, "sending");
  await h.cmd(".saveplus task cancel 2");
  release2();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(h.task(1).status, "cancelled", "发送失败后不再重试");
  assert.equal(h.task(1).attempts, 0);
  assert.equal(h.task(2).status, "uncertain", "无法确认是否发出时保持结果不确定");
  await h.stop();
});

test("批量取消：按规则、按编号列表、全部；结束的任务不受影响", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.addPeer({ peerId: "-1006", title: "第二来源" }, "@second");
  await h.cmd(".saveplus rule add @second @dstchan");
  h.tg.stageGate = new Promise<void>(() => undefined);
  for (const id of [1, 2, 3]) await h.emit("-1001", { id, kind: "photo" });
  for (const id of [7, 8]) await h.emit("-1006", { id, kind: "photo" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.task(1).status, "running");

  const byRule = await h.cmd(".saveplus task cancel rule 1");
  assert.match(byRule, /规则 #1 的任务/);
  assert.match(byRule, /已取消 2 个/);
  assert.match(byRule, /正在停止 1 个处理中的任务/);
  h.tg.stageGate = undefined;
  await h.idle();
  assert.deepEqual([1, 2, 3].map((id) => h.task(id).status), ["cancelled", "cancelled", "cancelled"]);
  assert.deepEqual([4, 5].map((id) => h.task(id).status), ["done", "done"], "其他规则的任务照常完成");

  h.tg.failures.send.push(new SavePlusError("permission", "没有权限"), new SavePlusError("permission", "没有权限"));
  for (const id of [9, 10]) await h.emit("-1006", { id, kind: "photo" });
  await h.idle();
  assert.match(await h.cmd(".saveplus task cancel 6,7"), /已取消 2 个/);
  assert.match(await h.cmd(".saveplus task cancel 6,99"), /任务不存在：99/);
  assert.match(await h.cmd(".saveplus task cancel all"), /没有可取消的任务/);
  assert.match(await h.cmd(".saveplus task cancel 4"), /已完成」，不能取消/);
  assert.match(await h.cmd(".saveplus task cancel"), /用法：/);
  await h.stop();
});

test("task cancel all 取消全部未完成任务；backup cancel 也会停止该备份处理中的任务", async () => {
  const h = await createHarness({ options: { backupPageSize: 5, backupBacklog: 3 } });
  for (let i = 1; i <= 10; i++) h.tg.addMessage("-1001", { id: i, kind: "photo" });
  h.tg.stageGate = new Promise<void>(() => undefined);
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await new Promise((r) => setTimeout(r, 30));
  assert.match(await h.cmd(".saveplus backup cancel 1"), /处理中的任务中断下载后取消/);
  h.tg.stageGate = undefined;
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 0);
  assert.ok(h.data.tasks.every((t) => t.status === "cancelled"));

  await addDefaultRule(h);
  h.tg.stageGate = new Promise<void>(() => undefined);
  for (const id of [20, 21]) await h.emit("-1001", { id, kind: "photo" });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(await h.cmd(".saveplus task cancel all"), /全部未完成任务[\s\S]*已取消 1 个[\s\S]*正在停止 1 个/);
  h.tg.stageGate = undefined;
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 0);
  await h.stop();
});

test("插件停止（重载）时处理中的任务回到排队，而不是被当成取消或失败", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.stageGate = new Promise<void>(() => undefined);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 30));
  await h.stop();
  h.tg.stageGate = undefined;
  await h.start();
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.task(1).attempts, 0);
  await h.stop();
});
