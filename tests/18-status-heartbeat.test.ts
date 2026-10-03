import { test } from "node:test";
import assert from "node:assert/strict";
import { addDefaultRule, createHarness } from "./helpers/harness";
import { formatDuration } from "../saveplus";

test("状态显示运行时长与每条规则最后收到、最后成功保存的消息", async () => {
  const h = await createHarness();
  await addDefaultRule(h, "@dstchan photo");
  let status = await h.cmd(".saveplus status");
  assert.match(status, /运行时长：TeleBox 进程 .+ · 插件本次加载 不到 1 分钟/);
  assert.match(status, /#1 ▶️[\s\S]*最后收到新消息：暂无记录\n　最后成功保存：暂无记录/);

  await h.emit("-1001", { id: 100, kind: "photo" });
  await h.idle();
  // 类型不符被过滤的消息也算“收到”，但不算“保存”。
  await h.emit("-1001", { id: 101, kind: "text", text: "文字" });
  await h.idle();
  status = await h.cmd(".saveplus status");
  assert.match(status, /最后收到新消息：.+消息 101）/);
  assert.match(status, /最后成功保存：.+消息 100）/);
  assert.doesNotMatch(status, /本次加载后尚未收到/);

  h.clock.advance(2 * 3_600_000 + 5 * 60_000);
  status = await h.cmd(".saveplus status");
  assert.match(status, /插件本次加载 2 小时 \d+ 分/);
  assert.match(status, /最后收到新消息：.+（2 小时 \d+ 分前 · 消息 101）/);
  await h.stop();
});

test("编辑事件、暂停的规则与其他会话不更新最后收到；重启后保留最新值并提示本次尚未收到", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 10, kind: "text", text: "一" });
  await h.emit("-1001", { id: 11, kind: "text", text: "二" });
  await h.idle();
  await h.emit("-1001", { id: 12, kind: "text", text: "改" }, { edited: true });
  await h.emit("-1009", { id: 50, kind: "text", text: "别处" });
  await h.cmd(".saveplus rule pause 1");
  await h.emit("-1001", { id: 13, kind: "text", text: "暂停中" });
  await h.idle();
  assert.match(await h.cmd(".saveplus status"), /最后收到新消息：.+消息 11）/);
  assert.equal(h.data.rules[0].lastSeen?.messageId, 10, "一分钟内只持久化第一次");

  // 持久化按分钟节流，但停止时补写最新值。
  await h.cmd(".saveplus rule resume 1");
  h.clock.advance(10 * 60_000);
  await h.restart();
  assert.equal(h.data.rules[0].lastSeen?.messageId, 11);
  assert.equal(h.data.rules[0].lastSaved?.messageId, 11);
  assert.match(await h.cmd(".saveplus status"), /消息 11）；本次加载后尚未收到/);
  await h.emit("-1001", { id: 14, kind: "text", text: "新" });
  await h.idle();
  assert.doesNotMatch(await h.cmd(".saveplus status"), /本次加载后尚未收到/);
  await h.stop();
});

test("补漏成功也更新最后成功保存；备份不影响规则的记录", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  for (const id of [5, 6]) h.tg.addMessage("-1001", { id, kind: "photo" });
  await h.cmd(".saveplus fill 1 5|6");
  await h.idle();
  assert.equal(h.data.rules[0].lastSaved?.messageId, 6);
  assert.equal(h.data.rules[0].lastSeen, undefined);
  h.tg.addMessage("-1001", { id: 7, kind: "photo" });
  assert.match(await h.cmd(".saveplus backup @srcchan @backup"), /备份 #1/);
  await h.idle();
  assert.equal(h.data.backups[0].counts.done, 3);
  assert.equal(h.data.rules[0].lastSaved?.messageId, 6);
  await h.stop();
});

test("时长格式", () => {
  assert.equal(formatDuration(30_000), "不到 1 分钟");
  assert.equal(formatDuration(5 * 60_000), "5 分钟");
  assert.equal(formatDuration(3 * 3_600_000 + 7 * 60_000), "3 小时 7 分");
  assert.equal(formatDuration(2 * 86_400_000 + 4 * 3_600_000), "2 天 4 小时");
});
