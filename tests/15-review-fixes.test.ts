import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { setPrefixes } from "@utils/pluginManager";
import { addDefaultRule, createHarness, FakeClock } from "./helpers/harness";
import { helpText, parseMessageLink, parseTargetSpec, RateLimiter, SavePlusError } from "../saveplus";

const flood = (seconds: number) => new SavePlusError("flood", `FLOOD_WAIT_${seconds}`, { transient: true, seconds });

test("修复：以 100 开头的私有会话 ID 不再被截断", async () => {
  assert.deepEqual(parseMessageLink("https://t.me/c/1006503122/5"), { chatRef: "-1001006503122", messageId: 5, raw: "https://t.me/c/1006503122/5" });
  assert.equal((parseMessageLink("t.me/c/-1001234567/8") as { chatRef: string }).chatRef, "-1001234567");
  assert.deepEqual(parseTargetSpec("t.me/c/1006503122"), { kind: "peer", ref: "-1001006503122", topicId: undefined });
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1001006503122", title: "老频道" });
  h.tg.addMessage("-1001006503122", { id: 5, kind: "text", text: "x" });
  assert.match(await h.cmd(".saveplus https://t.me/c/1006503122/5 @dstchan"), /保存完成/);
  await h.stop();
});

test("修复：手动保存遇到长时间限流时立即停止，剩余项目说明未执行，并让后台一起冷却", async () => {
  const h = await createHarness();
  for (const id of [1, 2, 3]) h.tg.addMessage("-1001", { id, kind: "text", text: `${id}` });
  h.tg.failures.forward.push(flood(600));
  const t0 = h.clock.now();
  const out = await h.cmd(".saveplus t.me/srcchan/1 t.me/srcchan/2 t.me/srcchan/3 @dstchan");
  assert.ok(h.clock.now() - t0 < 600_000, "命令不会等待 600 秒");
  assert.match(out, /触发 Telegram 限流，需要等待 600 秒/);
  assert.match(out, /未执行：触发 Telegram 限流/);
  assert.match(out, /因限流停止，剩余项目未发送/);
  assert.equal(h.tg.sent.length, 0);
  assert.ok(h.engine.limiter.cooldownRemainingMs > 500_000, "监视、补漏与备份也一起冷却");
  assert.match(await h.cmd(".saveplus t.me/srcchan/1 @dstchan"), /账号正在 Telegram 限流冷却中，还需等待 \d+ 秒/);
  await h.stop();
});

test("修复：备份完成数持久计数，不受已结束任务裁剪影响", async () => {
  const h = await createHarness({ options: { keepFinishedTasks: 3, backupPageSize: 5 } });
  for (let i = 1; i <= 12; i++) h.tg.addMessage("-1001", { id: i, kind: "photo" });
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await h.idle();
  assert.ok(h.data.tasks.length <= 3);
  assert.match(await h.cmd(".saveplus backup list"), /已全部完成\] 来源频道 → 目标频道（正序，已保存 12）/);
  assert.match(await h.cmd(".saveplus backup status 1"), /任务：完成 12/);
  await h.stop();
});

test("修复：原生转发任务结果不确定时也能核对", async () => {
  const h = await createHarness();
  await h.cmd(".saveplus rule add @srcchan @dstchan forward");
  h.tg.forwardDeliverThenFail.push(new SavePlusError("uncertain", "转发结果无法逐条确认", { maybeSent: true }));
  await h.emit("-1001", { id: 1, kind: "photo", text: "原帖" });
  await h.idle();
  assert.equal(h.task(1).status, "uncertain");
  assert.match(await h.cmd(".saveplus task check 1"), /已在目标中找到对应消息/);
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.sent.filter((s) => s.op === "forward").length, 1);
  await h.stop();
});

test("修复：只忽略本插件的命令消息，以前缀字符开头的普通帖子照常保存", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "text", text: ".NET 9 发布", out: true });
  await h.emit("-1001", { id: 2, kind: "text", text: ".saveplus status", out: true });
  await h.emit("-1001", { id: 3, kind: "text", text: "。saveplus", out: true });
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1]);
  await h.stop();
});

test("修复：已取消的任务即使被执行者取到也不会发送", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" });
  await new Promise((r) => setTimeout(r, 20));
  const second = h.task(2);
  assert.match(await h.cmd(".saveplus task cancel 2"), /已取消/);
  await h.engine.processTask(second);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(second.status, "cancelled");
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1]);
  await h.stop();
});

test("修复：进度提示失败（命令消息已删除）不会中止补漏", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  h.tg.addMessage("-1001", { id: 1, kind: "photo" });
  const out = await h.cmd(`.saveplus fill ${id} 1|1`, { failEdits: 1 });
  assert.match(out, /已加入队列：1/);
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("修复：3 秒间隔按消息条数计算，相册发出后按成员数等待", async () => {
  const h = await createHarness({ options: { minIntervalMs: 3000, maxPerMinute: 20 } });
  await addDefaultRule(h);
  const stamps: number[] = [];
  h.tg.beforeSendResolve = () => void stamps.push(h.clock.now());
  await h.emitAlbum("-1001", [1, 2, 3].map((id) => ({ id, kind: "photo" as const, groupedId: "g" })));
  await h.idle();
  await h.emit("-1001", { id: 4, kind: "photo" });
  await h.idle();
  assert.ok(stamps[1] - stamps[0] >= 9000, `相册 3 条后应等待 9 秒，实际 ${stamps[1] - stamps[0]}ms`);

  const clock = new FakeClock();
  const rl = new RateLimiter(clock, 1000, 5);
  const t0 = clock.now();
  await rl.acquire(undefined, 4);
  await rl.acquire(undefined, 1);
  assert.equal(clock.now() - t0, 4000);
  await rl.acquire(undefined, 2);
  assert.equal(clock.now() - t0, 60_000, "每分钟上限按条数计算");
  await h.stop();
});

test("修复：可查看单个备份的每日统计", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "photo" });
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await h.idle();
  assert.match(await h.cmd(".saveplus stats backup 1"), /备份 #1（来源频道 → 目标频道） 保存统计<\/b>\n\d{4}-\d{2}-\d{2}：1 单位／1 条/);
  assert.match(await h.cmd(".saveplus stats backup 9"), /备份 9 不存在/);
  await h.stop();
});

test("修复：启动与裁剪后清扫无主的中转目录，未结束任务的中转文件保留", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "video", cover: "none" });
  await h.idle();
  assert.equal(h.task(1).status, "needs_attention");
  fs.mkdirSync(path.join(h.stagingDir, "task_999"), { recursive: true });
  fs.writeFileSync(path.join(h.stagingDir, "task_999", "leftover.bin"), "x");
  fs.mkdirSync(path.join(h.stagingDir, "notes"), { recursive: true });
  await h.restart();
  assert.deepEqual(h.listStaging().sort(), ["notes", "task_1"]);
  await h.stop();
});

test("修复：帮助中的命令前缀经过转义；任务列表区分备份与编辑版", async () => {
  setPrefixes(["<"]);
  try {
    const help = helpText();
    assert.match(help, /<code>&lt;saveplus rule add/);
    assert.doesNotMatch(help, /<code><saveplus/);
  } finally {
    setPrefixes([".", "。", "$"]);
  }
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "video", cover: "none" });
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await h.idle();
  assert.match(await h.cmd(".saveplus task"), /#1 \[待处理\] 备份#1 来源频道:1/);
  await h.stop();
});
