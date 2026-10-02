import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDefaultRule, createHarness } from "./helpers/harness";
import { SavePlusError } from "../saveplus";

const flood = (seconds: number) => new SavePlusError("flood", `FLOOD_WAIT_${seconds}`, { transient: true, seconds });
const net = () => new SavePlusError("network", "网络或客户端错误：Connection closed", { transient: true });

test("05 限流按服务端等待秒数冷却后自动重试，任务与文件不丢失", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.failures.send.push(flood(30));
  const t0 = h.clock.now();
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.task(1).floodWaits, 1);
  assert.equal(h.tg.stagedSends().length, 1);
  assert.ok(h.clock.now() - t0 >= 31_000, "应等待服务端要求的秒数 + 1 秒");
  await h.stop();
});

test("05 瞬时失败有限退避，次数耗尽转为待处理并保留中转文件；手动重试成功后才清理", async () => {
  const h = await createHarness({ options: { maxAttempts: 3 } });
  await addDefaultRule(h);
  h.tg.failures.send.push(net(), net(), net());
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  const t = h.task(1);
  assert.equal(t.status, "needs_attention");
  assert.match(t.lastError?.message ?? "", /已自动重试 3 次/);
  assert.equal(h.tg.stageCalls.length, 1, "重试复用已下载的中转文件，不重复下载");
  assert.ok(fs.existsSync(t.staged?.[0].mediaFile as string));
  assert.match(await h.cmd(".saveplus task"), /#1 \[待处理\]/);
  assert.match(await h.cmd(".saveplus task show 1"), /中转目录/);
  assert.match(await h.cmd(".saveplus task retry 1"), /已重新排队/);
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("05 权限错误不自动重试，直接待处理并说明原因；规则不会被删除", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.failures.send.push(new SavePlusError("permission", "没有访问或发送权限（CHAT_WRITE_FORBIDDEN）"));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  assert.equal(h.task(1).status, "needs_attention");
  assert.equal(h.task(1).attempts, 0);
  assert.equal(h.data.rules.length, 1);
  assert.match(await h.cmd(".saveplus task show 1"), /CHAT_WRITE_FORBIDDEN/);
  await h.stop();
});

test("05 磁盘不足时不启动下载，暂停执行并在状态中显示；处理后 retry all 恢复", async () => {
  let free = 1000;
  const h = await createHarness({ diskFree: async () => free, options: { diskMarginBytes: 500 } });
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "photo", size: 4000 });
  await h.idle();
  assert.equal(h.task(1).status, "needs_attention");
  assert.equal(h.tg.stageCalls.length, 0);
  await h.emit("-1001", { id: 2, kind: "photo", size: 10 });
  await h.idle();
  assert.equal(h.task(2).status, "queued", "暂停期间新任务排队等待");
  assert.match(await h.cmd(".saveplus status"), /执行已暂停：磁盘空间不足/);
  free = 10 ** 9;
  assert.match(await h.cmd(".saveplus task retry all"), /已重新排队 1 个任务/);
  await h.idle();
  assert.deepEqual(
    h.data.tasks.map((t) => t.status),
    ["done", "done"]
  );
  await h.stop();
});

test("05 来源消息被删除时转为待处理，原因可见", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" });
  h.tg.deleteMessage("-1001", 2);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(h.task(2).status, "needs_attention");
  assert.match(h.task(2).lastError?.message ?? "", /来源消息 2 已不存在/);
  await h.stop();
});

test("10 发送中断导致结果不确定：保留文件，不自动重发；核对找到证据后补记成功并清理", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.deliverThenFail.push(new SavePlusError("uncertain", "发送过程中断，无法确认是否已发送：timeout", { maybeSent: true }));
  await h.emit("-1001", { id: 1, kind: "photo", text: "原文" });
  await h.idle();
  const t = h.task(1);
  assert.equal(t.status, "uncertain");
  assert.equal(h.tg.stagedSends().length, 1);
  assert.ok(fs.existsSync(t.staged?.[0].mediaFile as string));
  assert.match(await h.cmd(".saveplus task retry 1"), /结果不确定：请先执行 task check 1/);
  assert.match(await h.cmd(".saveplus task check 1"), /已在目标中找到对应消息/);
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.task(1).result?.via, "check");
  assert.equal(h.tg.stagedSends().length, 1, "核对不会再次发送");
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("10 核对找不到证据时保持不确定；用户明确 resend 后才重新发送", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.failures.send.push(new SavePlusError("uncertain", "服务器返回内部错误，无法确认是否已发送（RPC_CALL_FAIL）", { maybeSent: true }));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  assert.match(await h.cmd(".saveplus task check 1"), /未在目标中找到可靠证据（匹配 0\/1）/);
  assert.equal(h.task(1).status, "uncertain");
  assert.match(await h.cmd(".saveplus task resend 1"), /将重新发送/);
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("10 成功后写入成功记录失败：不清理、不重发，存储恢复后补写并清理", async () => {
  const h = await createHarness({ options: { backoffBaseMs: 60_000 } });
  await addDefaultRule(h);
  const dataFile = path.join(h.dataDir, "data.json");
  h.clock.autoAdvanceMaxMs = 30_000;
  h.tg.beforeSendResolve = () => {
    fs.chmodSync(h.dataDir, 0o500);
  };
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 50));
  const t = h.data.tasks[0];
  assert.equal(t.status, "cleanup_pending");
  assert.ok(fs.existsSync(t.staged?.[0].mediaFile as string), "成功记录未落盘前不得删除中转文件");
  assert.ok(!JSON.parse(fs.readFileSync(dataFile, "utf8")).tasks[0].result, "磁盘上尚无成功记录");
  h.tg.beforeSendResolve = undefined;
  fs.chmodSync(h.dataDir, 0o755);
  // 存储恢复后，到达退避时间即自动补写成功记录并清理。
  h.clock.advance(60_000);
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.stagedSends().length, 1);
  const disk = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(Object.keys(disk.successes).length, 1);
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("10 清理中转文件失败：保持“已成功·待清理”，只重试清理不重新上传", async () => {
  const h = await createHarness({ options: { backoffBaseMs: 1000 } });
  await addDefaultRule(h);
  h.tg.beforeSendResolve = () => {
    fs.chmodSync(h.stagingDir, 0o500);
  };
  await h.emit("-1001", { id: 1, kind: "photo" });
  await new Promise((r) => setTimeout(r, 80));
  h.tg.beforeSendResolve = undefined;
  // 清理以指数退避重试，耗尽后停在待清理，等待人工处理。
  await h.idle();
  const t = h.task(1);
  assert.equal(t.status, "cleanup_pending");
  assert.match(t.lastError?.message ?? "", /清理中转文件失败/);
  assert.match(await h.cmd(".saveplus status"), /已成功·待清理 1/);
  fs.chmodSync(h.stagingDir, 0o755);
  assert.match(await h.cmd(".saveplus task retry 1"), /已重新排队/);
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.stagedSends().length, 1);
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("10 取消任务释放保存权并删除中转文件；已成功的任务不能取消", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.failures.send.push(new SavePlusError("permission", "没有访问或发送权限"));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" });
  await h.idle();
  assert.equal(h.task(1).status, "needs_attention");
  assert.ok(h.listStaging().includes("task_1"));
  assert.match(await h.cmd(".saveplus task cancel 1"), /已取消，中转文件已删除/);
  assert.ok(!h.listStaging().includes("task_1"));
  assert.match(await h.cmd(".saveplus task cancel 2"), /不能取消/);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  assert.equal(h.data.tasks.filter((t) => t.memberIds[0] === 1 && t.status === "done").length, 1);
  await h.stop();
});
