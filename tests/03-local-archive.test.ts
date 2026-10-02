import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createHarness } from "./helpers/harness";
import { SavePlusError } from "../saveplus";

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("03 本地目标保存媒体文件、逐媒体 JSON 元数据与批次索引，纯文字明确跳过", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "photo", text: "图片说明" });
  h.tg.addMessage("-1001", { id: 2, kind: "text", text: "只有文字" });
  h.tg.addMessage("-1009", { id: 3, kind: "document", fileName: "report.pdf", size: 4096 });
  const out = await h.cmd(".saveplus https://t.me/srcchan/1 https://t.me/srcchan/2 https://t.me/c/9/3 local");
  assert.match(out, /本地保存完成/);
  assert.match(out, /已保存媒体：2 · 纯文字跳过：1 · 失败：0/);

  const photo = path.join(h.archiveDir, "-1001", "msg_1_photo.jpg");
  const doc = path.join(h.archiveDir, "-1009", "msg_3_report.pdf");
  assert.ok(fs.existsSync(photo));
  assert.equal(fs.statSync(doc).size, 4096);
  const meta = readJson(`${photo}.json`);
  assert.equal(meta.source.chatId, "-1001");
  assert.equal(meta.source.messageId, 1);
  assert.equal(meta.source.link, "https://t.me/srcchan/1");
  assert.equal(meta.caption, "图片说明");
  assert.equal(meta.media.kind, "photo");
  assert.ok(meta.savedAt);

  const indexes = fs.readdirSync(h.archiveDir).filter((f) => f.startsWith("index_"));
  assert.equal(indexes.length, 1);
  const index = readJson(path.join(h.archiveDir, indexes[0]));
  assert.equal(index.total, 2);
  assert.deepEqual(
    index.sources.map((s: any) => [s.chatId, s.messages.map((m: any) => m.messageId)]),
    [
      ["-1001", [1]],
      ["-1009", [3]],
    ]
  );
  assert.equal(index.sources[0].messages[0].file, path.join("-1001", "msg_1_photo.jpg"));
  // 归档不使用中转目录，也不产生自动保存成功记录。
  assert.deepEqual(h.listStaging(), []);
  assert.equal(Object.keys(h.data.successes).length, 0);
  assert.equal(fs.readdirSync(path.join(h.tempDir, "manual")).length, 0);
  await h.stop();
});

test("03 默认目标可设为本地；回复与区间保存都能归档；重复保存不覆盖已有文件", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "777", title: "当前群", kind: "group" });
  h.tg.addMessage("777", { id: 9, kind: "video", fileName: "clip.mp4", cover: "thumb" });
  for (const id of [40, 41]) h.tg.addMessage("-1001", { id, kind: "photo" });
  assert.match(await h.cmd(".saveplus to local"), /本地归档/);
  await h.cmd(".saveplus", { chat: "777", reply: 9 });
  await h.cmd(".saveplus", { chat: "777", reply: 9 });
  const dir = path.join(h.archiveDir, "777");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["msg_9_clip.mp4", "msg_9_clip.mp4.json", "msg_9_clip_1.mp4", "msg_9_clip_1.mp4.json"]);
  await h.cmd(".saveplus t.me/srcchan/41|t.me/srcchan/40");
  assert.ok(fs.existsSync(path.join(h.archiveDir, "-1001", "msg_40_photo.jpg")));
  assert.ok(fs.existsSync(path.join(h.archiveDir, "-1001", "msg_41_photo.jpg")));
  assert.equal(h.tg.sent.length, 0);
  await h.stop();
});

test("03 下载失败与磁盘不足计入失败，不留下半成品；文件名不能越界写出归档目录", async () => {
  let free = 10 ** 12;
  const h = await createHarness({ diskFree: async () => free, options: { diskMarginBytes: 1000 } });
  h.tg.addMessage("-1001", { id: 1, kind: "document", fileName: "../../escape.txt", size: 100 });
  h.tg.addMessage("-1001", { id: 2, kind: "photo" });
  h.tg.addMessage("-1001", { id: 3, kind: "photo", size: 5000 });
  h.tg.failures.stage.push(() => undefined, new SavePlusError("network", "媒体下载不完整（1/2048 字节）", { transient: true }));
  const out = await h.cmd(".saveplus t.me/srcchan/1 t.me/srcchan/2 local");
  assert.match(out, /部分完成/);
  assert.match(out, /失败：1/);
  assert.match(out, /媒体下载不完整/);
  const files = fs.readdirSync(path.join(h.archiveDir, "-1001"));
  assert.ok(files.every((f) => f.startsWith("msg_1_")));
  assert.ok(!fs.existsSync(path.join(h.root, "escape.txt")));
  free = 2000;
  assert.match(await h.cmd(".saveplus t.me/srcchan/3 local"), /磁盘空间不足/);
  assert.equal(fs.readdirSync(path.join(h.tempDir, "manual")).length, 0);
  await h.stop();
});

test("03 不能重新上传的特殊消息明确失败而不是静默跳过", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 5, kind: "other", reuploadable: false, unsupportedReason: "不支持重新上传的消息类型（MessageMediaPoll）" });
  const out = await h.cmd(".saveplus t.me/srcchan/5 local");
  assert.match(out, /本地保存失败/);
  assert.match(out, /MessageMediaPoll/);
  await h.stop();
});
