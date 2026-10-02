import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDefaultRule, createHarness } from "./helpers/harness";

const album = (gid: string, start: number, kinds: Array<"photo" | "video">, captions: Record<number, string> = {}) =>
  kinds.map((kind, i) => ({
    id: start + i,
    kind,
    groupedId: gid,
    text: captions[i] ?? "",
    cover: kind === "video" ? (i % 2 ? "thumb" : "custom") : undefined,
  })) as Parameters<import("./helpers/harness").Harness["emitAlbum"]>[1];

test("11 相册整组中转：一次发送、保持顺序与各自文案，每个视频带自己的封面", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emitAlbum("-1001", album("g1", 10, ["photo", "video", "video"], { 0: "第一张", 2: "第三个" }));
  await h.idle();
  assert.equal(h.data.tasks.length, 1);
  const sends = h.tg.stagedSends();
  assert.equal(sends.length, 1);
  const items = sends[0].items ?? [];
  assert.deepEqual(items.map((i) => i.messageId), [10, 11, 12]);
  assert.deepEqual(items.map((i) => i.text), ["第一张", "", "第三个"]);
  assert.deepEqual(items.map((i) => i.coverKind), [undefined, "thumb", "custom"]);
  assert.notEqual(items[1].thumbFile, items[2].thumbFile);
  assert.equal(sends[0].filesExisted, true);
  assert.equal(Object.keys(h.data.successes).length, 3);
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("11 相册按整组文字判断白名单：只有首条带文案时整组通过", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.cmd(`.saveplus rule wl ${id} add 新番`);
  await h.cmd(`.saveplus rule wl ${id} on`);
  await h.emitAlbum("-1001", album("g1", 1, ["photo", "photo", "photo"], { 0: "新番更新" }));
  await h.idle();
  assert.equal(h.tg.stagedSends()[0].items?.length, 3);
  await h.stop();
});

test("11 任一成员类型不符或任一文案命中黑名单时整组跳过，不拆出部分成员", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.cmd(`.saveplus rule type ${id} photo`);
  await h.emitAlbum("-1001", album("g1", 1, ["photo", "video"]));
  await h.idle();
  await h.cmd(`.saveplus rule type ${id} all`);
  await h.cmd(`.saveplus rule bl ${id} add 广告`);
  await h.emitAlbum("-1001", album("g2", 10, ["photo", "photo"], { 1: "广告位" }));
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 0);
  assert.equal(h.tg.stageCalls.length, 0);
  const status = await h.cmd(".saveplus status");
  assert.match(status, /消息 1,2：类型「视频」不在允许范围内/);
  assert.match(status, /消息 10,11：命中黑名单关键词「广告」/);
  await h.stop();
});

test("11 重复投递的成员只计一次；整组提交后、发送前迟到的成员并入同一任务", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  const members = album("g1", 10, ["photo", "photo"]);
  await h.emitAlbum("-1001", [...members, members[0]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.task(2).memberIds, [10, 11]);
  await h.emit("-1001", { id: 12, kind: "photo", groupedId: "g1" });
  assert.deepEqual(h.task(2).memberIds, [10, 11, 12]);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.deepEqual(h.tg.stagedSends()[1].items?.map((i) => i.messageId), [10, 11, 12]);
  assert.equal(h.data.tasks.length, 2);
  await h.stop();
});

test("11 整组已发送后才到达的成员不会被单独补发，转为待处理", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emitAlbum("-1001", album("g1", 10, ["photo", "photo"]));
  await h.idle();
  await h.emit("-1001", { id: 12, kind: "photo", groupedId: "g1" });
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  const late = h.task(2);
  assert.equal(late.status, "needs_attention");
  assert.equal(late.lastError?.code, "late_album_member");
  await h.stop();
});

test("11 处理时发现成员被删除：整组待处理，不发送残缺相册", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emitAlbum("-1001", album("g1", 10, ["photo", "photo", "photo"]));
  await new Promise((r) => setTimeout(r, 20));
  h.tg.deleteMessage("-1001", 11);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1, "只有之前的单条消息被发送");
  assert.equal(h.task(2).status, "needs_attention");
  assert.match(h.task(2).lastError?.message ?? "", /来源消息 11 已不存在/);
  await h.stop();
});

test("11 只收到部分成员事件时，处理前补全真实属于该组的成员", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.addMessage("-1001", { id: 12, kind: "photo", groupedId: "g1" });
  h.tg.addMessage("-1001", { id: 13, kind: "photo", groupedId: "other" });
  await h.emitAlbum("-1001", album("g1", 10, ["photo", "photo"]));
  await h.idle();
  assert.deepEqual(h.tg.stagedSends()[0].items?.map((i) => i.messageId), [10, 11, 12]);
  await h.stop();
});

test("11 相册中有视频无法保留封面时整组待处理", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  const members = album("g1", 10, ["photo", "video"]);
  members[1].cover = "none";
  await h.emitAlbum("-1001", members);
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 0);
  assert.equal(h.task(1).lastError?.code, "cover_unavailable");
  await h.stop();
});

test("11 普通手动保存：链接或回复指向相册任一成员时整组一次转发", async () => {
  const h = await createHarness();
  for (const id of [20, 21, 22]) h.tg.addMessage("-1001", { id, kind: "photo", groupedId: "gx" });
  h.tg.addMessage("-1001", { id: 23, kind: "photo" });
  await h.cmd(".saveplus t.me/srcchan/21 t.me/srcchan/22 @dstchan");
  const fwd = h.tg.sent.filter((s) => s.op === "forward");
  assert.equal(fwd.length, 1, "同一相册的多个链接只保存一次");
  assert.deepEqual(fwd[0].ids, [20, 21, 22]);
  await h.stop();
});

test("11 本地归档保留相册分组目录，索引记录 groupedId", async () => {
  const h = await createHarness();
  for (const id of [30, 31]) h.tg.addMessage("-1001", { id, kind: "photo", groupedId: "777" });
  await h.cmd(".saveplus t.me/srcchan/30 local");
  const dir = path.join(h.archiveDir, "-1001", "group_777");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.endsWith(".json")).sort(), ["msg_30_photo.jpg", "msg_31_photo.jpg"]);
  const index = JSON.parse(fs.readFileSync(path.join(h.archiveDir, fs.readdirSync(h.archiveDir).find((f) => f.startsWith("index_"))!), "utf8"));
  assert.deepEqual(index.sources[0].messages.map((m: any) => [m.messageId, m.groupedId]), [
    [30, "777"],
    [31, "777"],
  ]);
  await h.stop();
});
