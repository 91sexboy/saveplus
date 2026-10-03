import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDefaultRule, createHarness, type Harness } from "./helpers/harness";
import { SavePlusError } from "../saveplus";

const flood = (seconds: number) => new SavePlusError("flood", `FLOOD_WAIT_${seconds}`, { transient: true, seconds });

function sentIds(h: Harness): number[] {
  return h.tg.sent.flatMap((s) => (s.op === "staged" ? s.items?.map((i) => i.messageId) ?? [] : s.op === "forward" ? s.ids ?? [] : []));
}

test("14 规则选项：创建时可带类型与 shift 风格选项，之后可逐项开关", async () => {
  const h = await createHarness();
  const out = await h.cmd(".saveplus rule add @srcchan @dstchan photo video silent hide_author handle_edited forward");
  assert.match(out, /原生转发（隐藏发送者） · 静音 · 编辑后再存一份/);
  assert.match(out, /过滤：图片、视频/);
  const r = h.data.rules[0];
  assert.deepEqual([r.mode, r.hideAuthor, r.silent, r.handleEdited], ["forward", true, true, true]);
  assert.match(await h.cmd(".saveplus rule mode 1 relay"), /本地中转（下载后重新上传，保留来源封面）/);
  assert.match(await h.cmd(".saveplus rule silent 1 off"), /静音发送：关闭/);
  assert.match(await h.cmd(".saveplus rule hide 1 on"), /当前为本地中转/);
  assert.match(await h.cmd(".saveplus rule edited 1 off"), /编辑后再存一份：关闭/);
  assert.match(await h.cmd(".saveplus rule show 1"), /投递：本地中转/);
  assert.match(await h.cmd(".saveplus rule add @backup @dstchan turbo"), /未知选项：turbo/);
  await h.stop();
});

test("14 静音：本地中转与原生转发都按规则静音发送", async () => {
  const h = await createHarness();
  await h.cmd(".saveplus rule add @srcchan @dstchan silent");
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  assert.equal(h.tg.stagedSends()[0].silent, true);
  await h.cmd(".saveplus rule mode 1 forward");
  await h.emit("-1001", { id: 2, kind: "photo" });
  await h.idle();
  const fwd = h.tg.sent.find((s) => s.op === "forward");
  assert.equal(fwd?.silent, true);
  await h.stop();
});

test("14 原生转发模式：不下载直接转发，可隐藏发送者，相册一次转发；成功记录与去重照常", async () => {
  const h = await createHarness();
  await h.cmd(".saveplus rule add @srcchan @dstchan forward hide");
  await h.emit("-1001", { id: 1, kind: "video", cover: "none" });
  await h.emitAlbum("-1001", [
    { id: 10, kind: "photo", groupedId: "g" },
    { id: 11, kind: "photo", groupedId: "g" },
  ]);
  await h.idle();
  await h.emit("-1001", { id: 1, kind: "video", cover: "none" });
  await h.idle();
  const fwds = h.tg.sent.filter((s) => s.op === "forward");
  assert.deepEqual(fwds.map((f) => [f.ids, f.dropAuthor]), [
    [[1], true],
    [[10, 11], true],
  ]);
  assert.equal(h.tg.stageCalls.length, 0, "原生转发不下载");
  assert.deepEqual(h.listStaging(), []);
  assert.equal(Object.keys(h.data.successes).length, 3);
  await h.stop();
});

test("14 原生转发遇到受保护来源时自动改为本地中转，并记录说明", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1007", title: "保护频道" }, "@locked");
  await h.cmd(".saveplus rule add @locked @dstchan forward");
  await h.emit("-1007", { id: 1, kind: "photo", noforwards: true });
  h.tg.failures.forward.push(new SavePlusError("forward_restricted", "来源禁止转发（受保护内容）"));
  await h.emit("-1007", { id: 2, kind: "video", cover: "custom" });
  await h.idle();
  assert.equal(h.tg.sent.filter((s) => s.op === "forward").length, 0);
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1, 2]);
  assert.equal(h.tg.stagedSends()[1].items?.[0].coverKind, "custom", "回退后仍保留来源封面");
  assert.match(await h.cmd(".saveplus task show 2"), /来源禁止转发，已改为本地中转/);
  await h.stop();
});

test("14 编辑后再存一份：默认关闭；开启后每个编辑版本只保存一次，并沿用过滤", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "photo", text: "原文" });
  await h.idle();
  await h.emit("-1001", { id: 1, kind: "photo", text: "改过", editDate: 1700000100 }, { edited: true });
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1, "默认不跟随编辑");

  await h.cmd(`.saveplus rule edited ${id} on`);
  await h.cmd(`.saveplus rule bl ${id} add 广告`);
  await h.emit("-1001", { id: 1, kind: "photo", text: "改过", editDate: 1700000200 }, { edited: true });
  await h.emit("-1001", { id: 1, kind: "photo", text: "改过", editDate: 1700000200 }, { edited: true });
  await h.emit("-1001", { id: 1, kind: "photo", text: "改成广告", editDate: 1700000300 }, { edited: true });
  await h.emit("-1001", { id: 1, kind: "photo", text: "无编辑时间" }, { edited: true });
  await h.idle();
  // 原版一次，新版（1700000200）一次；重复的同版本事件、命中黑名单的版本、无编辑时间的事件都不保存。
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].text), ["原文", "改过"]);
  assert.equal(h.data.tasks.filter((t) => t.editVersion === 1700000200).length, 1);
  await h.stop();
});

test("14 编辑相册时整组再存一份", async () => {
  const h = await createHarness();
  await h.cmd(".saveplus rule add @srcchan @dstchan edited");
  await h.emitAlbum("-1001", [
    { id: 10, kind: "photo", groupedId: "g", text: "v1" },
    { id: 11, kind: "photo", groupedId: "g" },
  ]);
  await h.idle();
  await h.emit("-1001", { id: 10, kind: "photo", groupedId: "g", text: "v2", editDate: 1700000500 }, { edited: true });
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.map((i) => i.messageId)), [
    [10, 11],
    [10, 11],
  ]);
  await h.stop();
});

test("14 统计：按规则与备份分别计数，可查看单条规则的每日明细", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  assert.match(await h.cmd(".saveplus stats"), /暂无保存统计/);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emitAlbum("-1001", [
    { id: 10, kind: "photo", groupedId: "g" },
    { id: 11, kind: "photo", groupedId: "g" },
  ]);
  await h.idle();
  const all = await h.cmd(".saveplus stats");
  assert.match(all, /规则 #1 来源频道 → 目标频道：2 单位／3 条／2 单位／3 条／2 单位／3 条/);
  assert.match(await h.cmd(".saveplus stats 1"), /\d{4}-\d{2}-\d{2}：2 单位／3 条/);
  await h.stop();
});

test("14 导出与导入：在另一实例中重建规则；再次导入更新同来源规则", async () => {
  const h = await createHarness();
  await h.cmd(".saveplus rule add @srcchan @dstchan|5 photo silent forward hide");
  await h.cmd(".saveplus rule bl 1 add 广告");
  await h.cmd(".saveplus rule wl 1 add 第 \\d+ 集");
  await h.cmd(".saveplus rule wl 1 on");
  await h.cmd(".saveplus rule pause 1");
  const out = await h.cmd(".saveplus export");
  const b64 = /<code>([A-Za-z0-9+/=]+)<\/code>/.exec(out)?.[1] as string;
  assert.ok(b64);
  await h.stop();

  const h2 = await createHarness();
  const res = await h2.cmd(`.saveplus import\n${b64}`);
  assert.match(res, /新增 1 · 更新 0 · 跳过 0 · 失败 0/);
  const r = h2.data.rules[0];
  assert.deepEqual(
    [r.sourceChatId, r.target.peerId, r.target.topicId, r.enabled, r.mode, r.hideAuthor, r.silent, r.filter.types, r.filter.blacklist, r.filter.whitelist],
    ["-1001", "-1002", 5, false, "forward", true, true, ["photo"], ["广告"], { enabled: true, patterns: ["第 \\d+ 集"] }]
  );
  assert.match(await h2.cmd(`.saveplus import\n${b64}`), /新增 0 · 更新 1/);
  assert.match(await h2.cmd(".saveplus import\n不是有效内容"), /无法识别导入内容/);
  await h2.stop();
});

test("14 直接导入现有 shift 规则：选项、黑白名单、话题、暂停逐项转换；无效项说明原因", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1004", title: "已有规则来源" }, "@hasrule");
  await h.cmd(".saveplus rule add @hasrule @dstchan");
  const shiftDir = path.join(h.root, "assets", "shift");
  fs.mkdirSync(shiftDir, { recursive: true });
  const rules = {
    "-1001": {
      target_id: -1003,
      options: ["photo", "video", "silent", "handle_edited", "hide_author", "replyTo:7"],
      target_type: "chat",
      paused: true,
      created_at: "2026-09-01T00:00:00Z",
      filters: ["广告"],
      whitelistMode: true,
      whitelistPatterns: ["新番", "(a+)+"],
    },
    "-1009": { target_id: -1999, options: ["all"], target_type: "chat", paused: false, created_at: "x", filters: [] },
    "-1004": { target_id: -1003, options: [], target_type: "chat", paused: false, created_at: "x", filters: [] },
  };
  fs.writeFileSync(path.join(shiftDir, "shift_v2.json"), JSON.stringify({ version: "2.0.0", rules, stats: {}, backups: {} }));
  const out = await h.cmd(".saveplus import shift");
  assert.match(out, /新增 1 · 更新 0 · 跳过 1 · 失败 1/);
  assert.match(out, /已有规则 #1，未覆盖/);
  assert.match(out, /-1999.*找不到会话/);
  assert.match(out, /白名单「\(a\+\)\+」未导入：正则包含嵌套量词/);
  assert.match(out, /两者同时生效/);
  assert.match(out, /导入后默认使用本地中转/);
  const r = h.data.rules.find((x) => x.sourceChatId === "-1001");
  assert.ok(r);
  assert.deepEqual(
    [r.target.peerId, r.target.topicId, r.enabled, r.mode, r.silent, r.handleEdited, r.hideAuthor, r.filter.types, r.filter.blacklist, r.filter.whitelist],
    ["-1003", 7, false, "relay", true, true, true, ["photo", "video"], ["广告"], { enabled: true, patterns: ["新番"] }]
  );
  // 粘贴 shift 导出的 Base64 并选择保留原生转发
  await h.cmd(".saveplus rule del 2");
  const b64 = Buffer.from(JSON.stringify({ "-1001": rules["-1001"] })).toString("base64");
  assert.match(await h.cmd(`.saveplus import shift forward\n${b64}`), /新增 1[\s\S]*原生转发/);
  assert.equal(h.data.rules.find((x) => x.sourceChatId === "-1001")?.mode, "forward");
  await h.stop();
});

test("14 手动保存加 --hide 时原生转发隐藏发送者", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "photo" });
  await h.cmd(".saveplus https://t.me/srcchan/1 @dstchan --hide");
  await h.cmd(".saveplus https://t.me/srcchan/1 hide_author @dstchan");
  await h.cmd(".saveplus https://t.me/srcchan/1 @dstchan");
  assert.deepEqual(h.tg.sent.filter((s) => s.op === "forward").map((s) => s.dropAuthor), [true, true, false]);
  await h.stop();
});

test("14 整个历史备份（正序）：跨页相册整组、跳过系统消息、排队规模受限、每条恰好一次", async () => {
  const h = await createHarness({ options: { backupPageSize: 100, backupBacklog: 8 } });
  for (let id = 1; id <= 250; id++) {
    if (id % 50 === 25) h.tg.addMessage("-1001", { id, kind: "service" });
    else if (id >= 99 && id <= 102) h.tg.addMessage("-1001", { id, kind: "photo", groupedId: "edge" });
    else h.tg.addMessage("-1001", { id, kind: id % 7 ? "photo" : "text", text: `#${id}` });
  }
  let peak = 0;
  h.tg.beforeSendResolve = () => {
    const backlog = h.data.tasks.filter((t) => t.jobId === 1 && ["queued", "running", "sending", "retry_wait"].includes(t.status)).length;
    peak = Math.max(peak, backlog);
  };
  const out = await h.cmd(".saveplus backup @srcchan @dstchan");
  assert.match(out, /已创建备份 #1/);
  assert.match(out, /正序（旧→新/);
  assert.match(out, /不过滤（该来源没有监视规则）/);
  await h.idle();
  const ids = sentIds(h);
  const expected = Array.from({ length: 250 }, (_, i) => i + 1).filter((i) => i % 50 !== 25);
  assert.deepEqual(ids, expected, "按原始顺序，每条恰好一次，系统消息跳过");
  const album = h.tg.stagedSends().find((s) => s.items?.[0].messageId === 99);
  assert.deepEqual(album?.items?.map((i) => i.messageId), [99, 100, 101, 102]);
  assert.ok(peak <= 8, `排队规模 ${peak} 超过上限`);
  const status = await h.cmd(".saveplus backup status 1");
  assert.match(status, /历史已读完，已全部完成/);
  assert.match(status, /已读取 250 条/);
  assert.match(await h.cmd(".saveplus stats"), /备份 #1 来源频道 → 目标频道/);
  await h.stop();
});

test("14 倒序备份沿用来源规则的过滤并跳过已保存的消息；nofilter 与 force 可选", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.cmd(`.saveplus rule bl ${id} add 广告`);
  for (let i = 1; i <= 6; i++) h.tg.addMessage("-1001", { id: i, kind: "photo", text: i === 3 ? "广告" : `m${i}` });
  await h.emit("-1001", { id: 7, kind: "photo", text: "m7" });
  await h.idle();
  const out = await h.cmd(".saveplus backup @srcchan @dstchan desc");
  assert.match(out, /沿用规则 #1 的过滤/);
  await h.idle();
  assert.deepEqual(sentIds(h), [7, 6, 5, 4, 2, 1]);
  assert.match(await h.cmd(".saveplus backup status 1"), /已保存跳过 1 · 进行中跳过 0 · 过滤跳过 1/);

  await h.cmd(".saveplus backup @srcchan @backup nofilter");
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().filter((s) => s.target.peerId === "-1003").map((s) => s.items?.[0].messageId), [1, 2, 3, 4, 5, 6, 7]);
  await h.cmd(".saveplus backup @srcchan @dstchan force");
  await h.idle();
  assert.equal(h.tg.stagedSends().filter((s) => s.target.peerId === "-1002").length, 6 + 6, "force 重存（仍遵守过滤）");
  await h.stop();
});

test("14 备份读取遇到长时间限流：按服务端秒数等待后继续，不跳过、不失败", async () => {
  const h = await createHarness({ options: { backupPageSize: 3 } });
  for (let i = 1; i <= 7; i++) h.tg.addMessage("-1001", { id: i, kind: "photo" });
  h.tg.failures.read.push(() => undefined, flood(1749));
  const t0 = h.clock.now();
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await h.idle();
  assert.deepEqual(sentIds(h), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(h.clock.now() - t0 >= 1750_000);
  assert.doesNotMatch(await h.cmd(".saveplus backup status 1"), /⚠️/);
  await h.stop();
});

test("14 备份中断后重启：从断点继续，已发送的不重复", async () => {
  const h = await createHarness({ options: { backupPageSize: 5, backupBacklog: 3, stopTimeoutMs: 200 } });
  for (let i = 1; i <= 20; i++) h.tg.addMessage("-1001", { id: i, kind: "photo" });
  let sends = 0;
  h.tg.beforeSendResolve = async () => {
    sends++;
    if (sends === 6) h.tg.sendGate = new Promise<void>(() => undefined);
  };
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await new Promise((r) => setTimeout(r, 100));
  await h.stop();
  h.tg.sendGate = undefined;
  h.tg.beforeSendResolve = undefined;
  await h.start();
  await h.idle();
  // 第 7 条在发送途中被中断：无法确认是否已发出，标为结果不确定，不自动重发；其余从断点继续。
  const pending = h.data.tasks.find((t) => t.memberIds[0] === 7);
  assert.equal(pending?.status, "uncertain");
  assert.deepEqual(sentIds(h), [1, 2, 3, 4, 5, 6, ...Array.from({ length: 13 }, (_, i) => i + 8)]);
  assert.match(await h.cmd(`.saveplus task check ${pending?.id}`), /未在目标中找到可靠证据/);
  await h.cmd(`.saveplus task resend ${pending?.id}`);
  await h.idle();
  const ids = sentIds(h);
  assert.deepEqual(Array.from(new Set(ids)).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(ids.length, 20, "没有重复发送");
  await h.stop();
});

test("14 备份暂停、继续与取消；同一来源与目标不能重复创建", async () => {
  const h = await createHarness({ options: { backupPageSize: 5, backupBacklog: 2 } });
  for (let i = 1; i <= 30; i++) h.tg.addMessage("-1001", { id: i, kind: "photo" });
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.cmd(".saveplus backup @srcchan @dstchan");
  await new Promise((r) => setTimeout(r, 30));
  assert.match(await h.cmd(".saveplus backup @srcchan @dstchan"), /已有未结束的备份 #1/);
  assert.match(await h.cmd(".saveplus backup pause 1"), /已暂停/);
  assert.match(await h.cmd(".saveplus backup resume 1"), /已继续/);
  assert.match(await h.cmd(".saveplus backup cancel 1"), /已取消/);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.ok(sentIds(h).length <= 2, "取消后不再发送新的备份任务");
  assert.match(await h.cmd(".saveplus backup list"), /#1 \[已取消\]/);
  await h.stop();
});

test("14 原生转发方式的备份：隐藏发送者", async () => {
  const h = await createHarness();
  for (let i = 1; i <= 3; i++) h.tg.addMessage("-1001", { id: i, kind: "photo" });
  await h.cmd(".saveplus backup @srcchan @dstchan --asc --hide forward");
  await h.idle();
  assert.deepEqual(h.tg.sent.map((s) => [s.op, s.ids, s.dropAuthor]), [
    ["forward", [1], true],
    ["forward", [2], true],
    ["forward", [3], true],
  ]);
  await h.stop();
});

test("12 手动补漏读取遇到限流：可接受范围内等待后完成，过长则提示稍后重试", async () => {
  const h = await createHarness({ options: { fillMaxFloodWaitSeconds: 300 } });
  const id = await addDefaultRule(h);
  h.tg.addMessage("-1001", { id: 1, kind: "photo" });
  h.tg.failures.read.push(flood(120));
  assert.match(await h.cmd(`.saveplus fill ${id} 1|1`), /已加入队列：1/);
  h.tg.failures.read.push(flood(1749));
  assert.match(await h.cmd(`.saveplus fill ${id} 1|1`), /读取被 Telegram 限流 1749 秒，请稍后再试/);
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});
