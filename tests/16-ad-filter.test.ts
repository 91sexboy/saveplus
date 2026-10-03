import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, helpers } from "teleproto";
import { addDefaultRule, createHarness } from "./helpers/harness";
import { adReason, defaultFilter, evaluateFilter, TeleprotoPort, type EntityJson } from "../saveplus";

const emoji = (n: number): EntityJson[] => Array.from({ length: n }, (_, i) => ({ c: "MessageEntityCustomEmoji", offset: i, length: 1, documentId: String(100 + i) }));

test("广告特征：内联按钮、隐藏链接、自定义表情达到 5 个", () => {
  assert.equal(adReason({ hasButtons: true, entities: [] }), "包含内联按钮");
  assert.equal(adReason({ hasButtons: false, entities: [{ c: "MessageEntityTextUrl", offset: 0, length: 3, url: "https://t.me/x" }] }), "文案包含隐藏链接");
  assert.equal(adReason({ hasButtons: false, entities: emoji(5) }), "自定义表情过多（5 个）");
  assert.equal(adReason({ hasButtons: false, entities: emoji(4) }), null);
  // 本次不包含“文案含可见链接”这类规则
  assert.equal(adReason({ hasButtons: false, entities: [{ c: "MessageEntityUrl", offset: 0, length: 10 }] }), null);
});

test("广告过滤默认关闭；开启后先于黑白名单判断，白名单不能绕过", () => {
  const unit = { kinds: ["photo" as const], text: "新番更新", ads: [{ hasButtons: true, entities: [] }] };
  assert.equal(evaluateFilter(defaultFilter(), unit).pass, true);
  const on = { ...defaultFilter(), ads: true, whitelist: { enabled: true, patterns: ["新番"] } };
  assert.deepEqual(evaluateFilter(on, unit), { pass: false, reason: "疑似广告：包含内联按钮" });
  assert.equal(evaluateFilter(on, { ...unit, ads: [{ hasButtons: false, entities: emoji(2) }] }).pass, true);
});

test("通过命令开启广告过滤：带按钮、隐藏链接、表情刷屏的消息不保存，原因可查", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  assert.match(await h.cmd(`.saveplus rule ad ${id} on`), /广告过滤：开启/);
  assert.match(await h.cmd(`.saveplus rule show ${id}`), /广告过滤：已开启/);
  await h.emit("-1001", { id: 1, kind: "photo", text: "正常" });
  await h.emit("-1001", { id: 2, kind: "photo", text: "点按钮", buttons: true });
  await h.emit("-1001", { id: 3, kind: "photo", text: "点这里", entities: [{ c: "MessageEntityTextUrl", offset: 0, length: 3, url: "https://t.me/+abc" }] });
  await h.emit("-1001", { id: 4, kind: "photo", text: "★★★★★", entities: emoji(6) });
  await h.emit("-1001", { id: 5, kind: "photo", text: "可见链接 https://example.com" });
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1, 5]);
  assert.equal(h.tg.stageCalls.includes(2), false, "被过滤的消息不下载");
  const status = await h.cmd(".saveplus status");
  assert.match(status, /消息 2：疑似广告：包含内联按钮/);
  assert.match(status, /消息 3：疑似广告：文案包含隐藏链接/);
  assert.match(status, /消息 4：疑似广告：自定义表情过多（6 个）/);
  assert.match(await h.cmd(`.saveplus rule ad ${id} off`), /广告过滤：关闭/);
  await h.emit("-1001", { id: 6, kind: "photo", buttons: true });
  await h.idle();
  assert.equal(h.tg.stagedSends().at(-1)?.items?.[0].messageId, 6);
  await h.stop();
});

test("相册中任一成员命中广告特征时整组跳过；创建规则时可直接开启", async () => {
  const h = await createHarness();
  assert.match(await h.cmd(".saveplus rule add @srcchan @dstchan ad"), /广告过滤已开启/);
  await h.emitAlbum("-1001", [
    { id: 10, kind: "photo", groupedId: "g" },
    { id: 11, kind: "photo", groupedId: "g", buttons: true },
  ]);
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 0);
  assert.match(await h.cmd(".saveplus status"), /消息 10,11：疑似广告：包含内联按钮/);
  await h.stop();
});

test("补漏、沿用规则过滤的备份与规则导出导入都带上广告过滤", async () => {
  const h = await createHarness();
  await h.cmd(".saveplus rule add @srcchan @dstchan ad");
  h.tg.addMessage("-1001", { id: 1, kind: "photo" });
  h.tg.addMessage("-1001", { id: 2, kind: "photo", buttons: true });
  assert.match(await h.cmd(".saveplus fill 1 1|2"), /已加入队列：1[\s\S]*疑似广告：包含内联按钮×1/);
  await h.idle();
  await h.cmd(".saveplus backup @srcchan @backup");
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => [s.target.peerId, s.items?.[0].messageId]), [
    ["-1002", 1],
    ["-1003", 1],
  ]);
  const b64 = /<code>([A-Za-z0-9+/=]+)<\/code>/.exec(await h.cmd(".saveplus export"))?.[1] as string;
  await h.stop();
  const h2 = await createHarness();
  await h2.cmd(`.saveplus import\n${b64}`);
  assert.equal(h2.data.rules[0].filter.ads, true);
  await h2.stop();
});

test("适配层：带按钮的消息被识别", () => {
  const port = new TeleprotoPort({} as never);
  const B = helpers.returnBigInt;
  const base = { id: 1, peerId: new Api.PeerChannel({ channelId: B(1) }), date: 1, message: "x" };
  const withButtons = new Api.Message({
    ...base,
    replyMarkup: new Api.ReplyInlineMarkup({ rows: [] }),
  });
  assert.equal(port.toSourceMessage(withButtons)?.hasButtons, true);
  assert.equal(port.toSourceMessage(new Api.Message(base))?.hasButtons, false);
});
