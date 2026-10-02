import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { addDefaultRule, createHarness } from "./helpers/harness";

test("04 规则增查改、暂停恢复与删除，配置在重启后保留", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  assert.match(await h.cmd(".saveplus rule list"), /#1 ▶️ <b>来源频道<\/b> → <b>目标频道<\/b>/);
  assert.match(await h.cmd(".saveplus rule add @srcchan @backup"), /该来源已有规则 #1/);
  assert.match(await h.cmd(".saveplus rule add @dstchan @dstchan"), /来源与目标不能相同/);
  assert.match(await h.cmd(".saveplus rule add @srcchan local"), /目标必须是频道、群组或收藏夹/);
  assert.match(await h.cmd(`.saveplus rule target ${id} @backup|12`), /备份群 · 话题 12/);
  assert.match(await h.cmd(`.saveplus rule pause ${id}`), /不再接收新消息，已排队的任务继续执行/);
  await h.restart();
  const show = await h.cmd(`.saveplus rule show ${id}`);
  assert.match(show, /#1 ⏸/);
  assert.match(show, /备份群 · 话题 12/);
  assert.match(await h.cmd(`.saveplus rule resume ${id}`), /已恢复规则 1/);
  assert.match(await h.cmd(`.saveplus rule del ${id}`), /已删除规则 #1/);
  assert.match(await h.cmd(".saveplus rule list"), /暂无监视规则/);
  assert.match(await h.cmd(".saveplus rule show 9"), /规则 9 不存在/);
  await h.stop();
});

test("04 在线监视图片：持久入队 → 下载中转 → 上传时文件存在 → 记成功 → 清理中转", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 100, kind: "photo", text: "新图" });
  await h.idle();
  const sends = h.tg.stagedSends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].target.peerId, "-1002");
  assert.equal(sends[0].filesExisted, true);
  assert.equal(sends[0].items?.[0].text, "新图");
  const t = h.task(1);
  assert.equal(t.status, "done");
  assert.deepEqual(t.result?.messageIds, sends[0].resultIds);
  assert.deepEqual(h.listStaging(), []);
  assert.equal(Object.keys(h.data.successes).length, 1);
  // 监视路径不使用原生转发。
  assert.equal(h.tg.sent.filter((s) => s.op === "forward").length, 0);
  await h.stop();
});

test("04 只处理已配置来源的新消息：其他会话、编辑事件、暂停的规则都不产生任务", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.emit("-1009", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" }, { edited: true });
  await h.cmd(`.saveplus rule pause ${id}`);
  await h.emit("-1001", { id: 3, kind: "photo" });
  await h.idle();
  assert.equal(h.data.tasks.length, 0);
  assert.equal(h.tg.readCalls, 0, "启动和事件处理都不应主动读取历史");
  await h.stop();
});

test("04 重复事件与并发相同消息只投递一次；不同目标不会被误判为重复", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  const raw = h.tg.addMessage("-1001", { id: 7, kind: "photo" });
  await Promise.all([h.plugin.listenMessageHandler?.(raw as never), h.plugin.listenMessageHandler?.(raw as never)]);
  await h.idle();
  await h.plugin.listenMessageHandler?.(raw as never);
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  assert.match(await h.cmd(".saveplus status"), /已成功保存到该目标|已有任务/);

  await h.cmd(".saveplus rule target 1 @backup");
  await h.plugin.listenMessageHandler?.(raw as never);
  await h.idle();
  assert.deepEqual(
    h.tg.stagedSends().map((s) => s.target.peerId),
    ["-1002", "-1003"]
  );
  await h.stop();
});

test("04 修改目标不改变已排队任务；暂停后旧任务继续；删除规则不删除未完成任务", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "photo" });
  await new Promise((r) => setImmediate(r));
  await h.cmd(`.saveplus rule target ${id} @backup`);
  await h.cmd(`.saveplus rule pause ${id}`);
  await h.emit("-1001", { id: 3, kind: "photo" });
  assert.match(await h.cmd(`.saveplus rule del ${id}`), /仍有 \d 个未完成任务会按原快照执行/);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.deepEqual(
    h.tg.stagedSends().map((s) => [s.items?.[0].messageId, s.target.peerId]),
    [
      [1, "-1002"],
      [2, "-1002"],
    ]
  );
  assert.equal(h.data.tasks.filter((t) => t.status === "done").length, 2);
  await h.stop();
});

test("04 插件自己发到目标的消息与命令消息不会被当作新来源消息", async () => {
  const h = await createHarness();
  h.tg.addPeer({ peerId: "-1006", title: "中转站" }, "@relay");
  await h.cmd(".saveplus rule add @srcchan @relay");
  await h.cmd(".saveplus rule add @relay @dstchan");
  h.tg.beforeSendResolve = async (items) => {
    // 目标中出现自己发出的新消息，宿主会把它当作新消息事件投递。
    if (items[0].messageId === 1) {
      const id = h.tg.nextTargetId - 1;
      await h.plugin.listenMessageHandler?.(h.tg.addMessage("-1006", { id, kind: "photo", out: true }) as never);
    }
  };
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  await h.emit("-1006", { id: 99, kind: "text", text: ".saveplus status", out: true });
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("04 文字消息自动保存直接发送文字，不创建中转文件", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 5, kind: "text", text: "公告" });
  await h.idle();
  const s = h.tg.stagedSends()[0];
  assert.equal(s.items?.[0].mediaFile, undefined);
  assert.equal(h.task(1).status, "done");
  assert.ok(!fs.existsSync(path.join(h.stagingDir, "task_1")));
  await h.stop();
});
