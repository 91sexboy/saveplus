import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPlugin } from "@utils/pluginBase";
import { setPrefixes } from "@utils/pluginManager";
import { addDefaultRule, createHarness } from "./helpers/harness";
import defaultPlugin, { messageLink, parseMessageLink, SavePlusError } from "../saveplus";

test("01 默认导出可被宿主校验，只注册 saveplus 命令，帮助随宿主前缀生成", () => {
  assert.equal(isValidPlugin(defaultPlugin), true);
  assert.deepEqual(Object.keys(defaultPlugin.cmdHandlers), ["saveplus"]);
  assert.equal(defaultPlugin.name, "saveplus");
  assert.equal(defaultPlugin.listenMessageHandlerIgnoreEdited, true);
  setPrefixes(["!", "！"]);
  try {
    const help = (defaultPlugin.description as () => string)();
    assert.match(help, /<code>!saveplus rule add 来源 目标<\/code>/);
    assert.doesNotMatch(help, /\.saveplus/);
  } finally {
    setPrefixes([".", "。", "$"]);
  }
});

test("01 无参数无回复时显示帮助；help/h 同样显示帮助", async () => {
  const h = await createHarness();
  assert.match(await h.cmd(".saveplus"), /SavePlus — 保存、在线监视与本地中转/);
  assert.match(await h.cmd(".saveplus help"), /手动补漏/);
  assert.match(await h.cmd("。saveplus h"), /在线监视/);
  await h.stop();
});

test("01 回复消息保存到默认收藏夹（原生转发）", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "777", title: "当前群", kind: "group" });
  h.tg.addMessage("777", { id: 42, kind: "text", text: "hello" });
  const out = await h.cmd(".saveplus", { chat: "777", reply: 42 });
  assert.match(out, /保存完成/);
  const fwd = h.tg.sent.find((s) => s.op === "forward");
  assert.ok(fwd);
  assert.equal(fwd.target.peerId, "1000");
  assert.deepEqual(fwd.ids, [42]);
  assert.equal(fwd.sourceChatId, "777");
  await h.stop();
});

test("01 回复保存支持临时目标且不改变默认目标", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "777", title: "当前群", kind: "group" });
  h.tg.addMessage("777", { id: 8, kind: "photo" });
  await h.cmd(".saveplus @dstchan", { chat: "777", reply: 8 });
  assert.equal(h.tg.sent[0].target.peerId, "-1002");
  assert.match(await h.cmd(".saveplus target"), /<code>me<\/code>/);
  await h.stop();
});

test("01 公开与私有消息链接保存；设置的默认目标持久化到重启之后", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 10, kind: "text", text: "pub" });
  h.tg.addMessage("-1009", { id: 11, kind: "text", text: "priv" });
  assert.match(await h.cmd(".saveplus to @backup"), /默认目标已设为：<b>备份群<\/b>/);
  await h.restart();
  assert.match(await h.cmd(".saveplus target"), /-1003/);
  await h.cmd(".saveplus https://t.me/srcchan/10");
  await h.cmd(".saveplus t.me/c/9/11");
  const fwds = h.tg.sent.filter((s) => s.op === "forward");
  assert.deepEqual(
    fwds.map((f) => [f.sourceChatId, f.ids, f.target.peerId]),
    [
      ["-1001", [10], "-1003"],
      ["-1009", [11], "-1003"],
    ]
  );
  await h.stop();
});

test("01 不可访问的来源、不可写的目标和非法参数给出准确原因", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1005", title: "只读频道", canSend: false, sendBlockReason: "账号不是该频道可发帖的管理员" }, "@readonly");
  assert.match(await h.cmd(".saveplus to @readonly"), /只读频道.*不可发送：账号不是该频道可发帖的管理员/);
  assert.match(await h.cmd(".saveplus to @nobody_here"), /找不到会话/);
  assert.match(await h.cmd(".saveplus https://t.me/nochan1/5"), /无法访问 @nochan1/);
  assert.match(await h.cmd(".saveplus https://t.me/srcchan/5?comment=9"), /暂不支持评论区消息链接/);
  assert.match(await h.cmd(".saveplus https://t.me/srcchan/404"), /没有可保存的消息[\s\S]*消息不存在或无法读取/);
  assert.equal(h.tg.sent.length, 0);
  await h.stop();
});

test("01 普通手动保存不受监视规则的过滤与成功去重影响", async () => {
  const h = await createHarness();
  const rule = await addDefaultRule(h);
  await h.cmd(`.saveplus rule bl ${rule} add 广告`);
  h.tg.addMessage("-1001", { id: 3, kind: "text", text: "这是广告" });
  await h.cmd(".saveplus https://t.me/srcchan/3 @dstchan");
  await h.cmd(".saveplus https://t.me/srcchan/3 @dstchan");
  assert.equal(h.tg.sent.filter((s) => s.op === "forward").length, 2);
  assert.equal(Object.keys(h.data.successes).length, 0);
  await h.stop();
});

test("02 多链接跨来源批量保存，链接后的临时目标生效且不修改默认目标", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "text", text: "a" });
  h.tg.addMessage("-1001", { id: 2, kind: "text", text: "b" });
  h.tg.addMessage("-1009", { id: 7, kind: "photo" });
  const out = await h.cmd(".saveplus https://t.me/srcchan/1 https://t.me/c/9/7 t.me/srcchan/2 @dstchan");
  assert.match(out, /成功：3 个保存单位（3 条消息）/);
  assert.deepEqual(
    h.tg.sent.map((s) => [s.sourceChatId, s.ids?.[0], s.target.peerId]),
    [
      ["-1001", 1, "-1002"],
      ["-1001", 2, "-1002"],
      ["-1009", 7, "-1002"],
    ]
  );
  assert.match(await h.cmd(".saveplus target"), /<code>me<\/code>/);
  await h.stop();
});

test("02 闭区间保存包含两端、反向输入按升序处理、跳过空洞，尾随临时目标生效", async () => {
  const h = await createHarness();
  for (const id of [20, 21, 23, 25]) h.tg.addMessage("-1001", { id, kind: "text", text: `m${id}` });
  const out = await h.cmd(".saveplus https://t.me/srcchan/25|https://t.me/srcchan/20 @dstchan");
  assert.deepEqual(
    h.tg.sent.map((s) => s.ids?.[0]),
    [20, 21, 23, 25]
  );
  assert.ok(h.tg.sent.every((s) => s.target.peerId === "-1002"));
  assert.match(out, /成功：4 个保存单位/);
  assert.match(out, /区间内 2 个消息 ID 不存在或无法读取/);
  assert.match(await h.cmd(".saveplus https://t.me/srcchan/1|https://t.me/c/9/5"), /必须属于同一会话/);
  await h.stop();
});

test("02 混合有效与无效输入时逐项反馈，部分失败不冒充全部成功", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "text", text: "ok" });
  h.tg.addMessage("-1001", { id: 2, kind: "text", text: "boom" });
  h.tg.failures.forward.push(() => undefined, new SavePlusError("permission", "没有访问或发送权限（CHAT_WRITE_FORBIDDEN）"));
  const out = await h.cmd(".saveplus https://t.me/srcchan/1 https://t.me/srcchan/2 https://t.me/srcchan/3 @dstchan");
  assert.match(out, /部分保存完成/);
  assert.match(out, /成功：1 个保存单位/);
  assert.match(out, /失败：1/);
  assert.match(out, /CHAT_WRITE_FORBIDDEN/);
  assert.match(out, /消息不存在或无法读取：https:\/\/t\.me\/srcchan\/3/);
  assert.match(await h.cmd(".saveplus https://t.me/srcchan/1 bogus @dstchan"), /无法识别的参数：bogus/);
  await h.stop();
});

test("02 来源说明：单条、批量、范围三种格式，私有链接不带负号，HTML 已转义", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1004", title: "<b>坏</b>&标题" }, "@weird");
  h.tg.addMessage("-1009", { id: 5, kind: "text", text: "p" });
  h.tg.addMessage("-1004", { id: 6, kind: "text", text: "w" });
  for (const id of [30, 31]) h.tg.addMessage("-1001", { id, kind: "text", text: `${id}` });
  assert.match(await h.cmd(".saveplus source on"), /来源说明已开启/);
  assert.match(await h.cmd(".saveplus source"), /已开启/);

  await h.cmd(".saveplus https://t.me/c/9/5 @dstchan");
  let note = h.tg.sent.filter((s) => s.op === "text" && s.html).pop();
  assert.ok(note);
  assert.match(note.text as string, /href="https:\/\/t\.me\/c\/9\/5"/);
  assert.equal(note.replyTo, h.tg.sent.find((s) => s.op === "forward")?.resultIds[0]);

  await h.cmd(".saveplus https://t.me/c/9/5 t.me/weird/6 @dstchan");
  note = h.tg.sent.filter((s) => s.op === "text" && s.html).pop();
  assert.match(note?.text as string, /批量保存来源/);
  assert.match(note?.text as string, /&lt;b&gt;坏&lt;\/b&gt;&amp;标题/);

  await h.cmd(".saveplus t.me/srcchan/30|t.me/srcchan/31 @dstchan");
  note = h.tg.sent.filter((s) => s.op === "text" && s.html).pop();
  assert.match(note?.text as string, /范围保存来源[\s\S]*srcchan\/30[\s\S]*srcchan\/31/);
  await h.stop();
});

test("02 来源说明发送失败不撤销已确认的保存", async () => {
  const h = await createHarness();
  h.tg.addMessage("-1001", { id: 1, kind: "text", text: "x" });
  await h.cmd(".saveplus source on");
  h.tg.failures.text.push(new SavePlusError("permission", "没有访问或发送权限（CHAT_SEND_PLAIN_FORBIDDEN）"));
  const out = await h.cmd(".saveplus https://t.me/srcchan/1 @dstchan");
  assert.match(out, /✅ <b>保存完成<\/b>/);
  assert.match(out, /来源说明发送失败/);
  assert.equal(h.tg.sent.filter((s) => s.op === "forward").length, 1);
  await h.stop();
});

test("02 链接解析与来源链接生成", () => {
  assert.deepEqual(parseMessageLink("https://t.me/c/1234567/89"), { chatRef: "-1001234567", messageId: 89, raw: "https://t.me/c/1234567/89" });
  assert.deepEqual(parseMessageLink("t.me/c/1234567/12/89?single"), { chatRef: "-1001234567", messageId: 89, raw: "t.me/c/1234567/12/89?single" });
  assert.deepEqual(parseMessageLink("t.me/somechan/3/77"), { chatRef: "@somechan", messageId: 77, raw: "t.me/somechan/3/77" });
  assert.ok("error" in (parseMessageLink("https://t.me/+abcdef/1") as object));
  assert.equal(parseMessageLink("hello"), null);
  assert.equal(messageLink("-1001234567", 5), "https://t.me/c/1234567/5");
  assert.equal(messageLink("-1001234567", 5, "pub"), "https://t.me/pub/5");
});
