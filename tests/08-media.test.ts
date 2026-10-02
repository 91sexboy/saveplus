import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDefaultRule, createHarness } from "./helpers/harness";
import { SavePlusError } from "../saveplus";

test("07 监视视频：自定义封面随视频一同中转上传，成功后连同封面一起清理", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "video", cover: "custom", text: "片段" });
  await h.idle();
  const s = h.tg.stagedSends()[0];
  assert.equal(s.items?.[0].coverKind, "custom");
  assert.ok(s.items?.[0].coverFile);
  assert.equal(s.filesExisted, true, "上传时视频、封面与缩略图都在本地");
  assert.equal(h.task(1).status, "done");
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("07 没有自定义封面时使用来源静态缩略图", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "video", cover: "thumb" });
  await h.idle();
  const it = h.tg.stagedSends()[0].items?.[0];
  assert.equal(it?.coverKind, "thumb");
  assert.ok(it?.thumbFile);
  assert.equal(it?.coverFile, undefined);
  await h.stop();
});

test("07 来源封面无法获取时不投递、不替换封面，保留中转文件；显式 nocover 才放行", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "video", cover: "none" });
  await h.emit("-1001", { id: 2, kind: "video", cover: "stripped" });
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 0);
  assert.equal(h.task(1).status, "needs_attention");
  assert.equal(h.task(1).lastError?.code, "cover_unavailable");
  assert.match(h.task(1).lastError?.message ?? "", /没有可获取的来源封面；已保留中转文件/);
  assert.match(h.task(2).lastError?.message ?? "", /只有模糊预览/);
  assert.ok(fs.existsSync(h.task(1).staged?.[0].mediaFile as string));
  assert.match(await h.cmd(".saveplus task retry 1"), /已重新排队/);
  await h.idle();
  assert.equal(h.task(1).status, "needs_attention", "普通重试仍坚持封面要求");
  await h.cmd(".saveplus task retry 1 nocover");
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.equal(h.tg.stagedSends().length, 1);
  assert.equal(h.tg.stageCalls.filter((id) => id === 1).length, 1, "复用已下载的中转文件");
  await h.stop();
});

test("07 目标响应未体现封面时记录警告供核对，但不重复上传", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.sendWarnings.push(["消息 5000 的响应中未包含自定义封面，请在客户端核对封面"]);
  await h.emit("-1001", { id: 1, kind: "video", cover: "custom" });
  await h.idle();
  assert.equal(h.task(1).status, "done");
  assert.match(await h.cmd(".saveplus task show 1"), /⚠️ 消息 5000 的响应中未包含自定义封面/);
  await h.stop();
});

test("08 监视各类媒体均走本地中转：文件、语音、音频、贴纸、动画", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  const kinds = ["document", "voice", "audio", "sticker", "animation"] as const;
  for (const [i, kind] of kinds.entries()) {
    await h.emit("-1001", { id: i + 1, kind, cover: kind === "animation" ? "thumb" : undefined });
  }
  await h.idle();
  assert.deepEqual(
    h.tg.stagedSends().map((s) => s.items?.[0].kind),
    [...kinds]
  );
  assert.ok(h.data.tasks.every((t) => t.status === "done"));
  await h.stop();
});

test("08 监视遇到不能重新上传的特殊消息：明确待处理，不冒充成功", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "other", reuploadable: false, unsupportedReason: "不支持重新上传的消息类型（MessageMediaPoll）" });
  await h.idle();
  assert.equal(h.task(1).status, "needs_attention");
  assert.equal(h.task(1).lastError?.code, "unsupported");
  await h.stop();
});

test("08 普通手动保存遇受保护来源：文字复制、媒体下载重传，临时文件随即删除", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1007", title: "保护频道", noforwards: true }, "@locked");
  h.tg.addMessage("-1007", { id: 1, kind: "text", text: "受保护文字", entities: [{ c: "MessageEntityBold", offset: 0, length: 3 }] });
  h.tg.addMessage("-1007", { id: 2, kind: "video", cover: "custom", text: "受保护视频" });
  const out = await h.cmd(".saveplus t.me/locked/1 t.me/locked/2 @dstchan");
  assert.match(out, /保存完成/);
  assert.equal(h.tg.sent.filter((s) => s.op === "forward").length, 0, "已知受保护的来源不浪费一次转发");
  const text = h.tg.sent.find((s) => s.op === "text");
  assert.equal(text?.text, "受保护文字");
  const media = h.tg.stagedSends()[0];
  assert.equal(media.items?.[0].coverKind, "custom");
  assert.equal(media.filesExisted, true);
  assert.deepEqual(fs.readdirSync(path.join(h.tempDir, "manual")), []);
  await h.stop();
});

test("08 转发被拒绝（CHAT_FORWARDS_RESTRICTED）时自动改为复制；无封面的视频以警告说明", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 9, kind: "video", cover: "none" });
  h.tg.failures.forward.push(new SavePlusError("forward_restricted", "来源禁止转发（受保护内容）"));
  const out = await h.cmd(".saveplus t.me/srcchan/9 @dstchan");
  assert.match(out, /保存完成/);
  assert.match(out, /视频 9 无法获取来源封面，已按普通上传发送/);
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("08 手动复制时不能重新上传的消息明确失败", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1007", title: "保护频道", noforwards: true }, "@locked");
  h.tg.addMessage("-1007", { id: 3, kind: "other", reuploadable: false, unsupportedReason: "不支持重新上传的消息类型（MessageMediaGeo）" });
  const out = await h.cmd(".saveplus t.me/locked/3 @dstchan");
  assert.match(out, /保存失败/);
  assert.match(out, /MessageMediaGeo/);
  await h.stop();
});
