import { test } from "node:test";
import assert from "node:assert/strict";
import { addDefaultRule, createHarness } from "./helpers/harness";

test("12 手动补漏沿用规则的过滤与目标，统计各类结果；不会自动触发", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.cmd(`.saveplus rule bl ${id} add 广告`);
  h.tg.addMessage("-1001", { id: 1, kind: "photo", text: "正常" });
  h.tg.addMessage("-1001", { id: 2, kind: "photo", text: "广告" });
  h.tg.addMessage("-1001", { id: 4, kind: "video", cover: "thumb" });
  await h.idle();
  assert.equal(h.data.tasks.length, 0, "离线期间的消息不会被自动补抓");
  const out = await h.cmd(`.saveplus fill ${id} https://t.me/srcchan/1|https://t.me/srcchan/5`);
  assert.match(out, /补漏规划完成/);
  assert.match(out, /读取到 3 条，2 个 ID 不存在或无法读取/);
  assert.match(out, /已加入队列：2 个保存单位/);
  assert.match(out, /过滤跳过：1/);
  assert.match(out, /命中黑名单关键词「广告」×1/);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => [s.items?.[0].messageId, s.target.peerId]), [
    [1, "-1002"],
    [4, "-1002"],
  ]);
  assert.ok(h.data.tasks.every((t) => t.kind === "backfill"));
  await h.stop();
});

test("12 与在线监视重叠的消息不会重复发送；成功记录在重启后仍然有效", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.idle();
  await h.restart();
  h.tg.addMessage("-1001", { id: 2, kind: "photo" });
  const out = await h.cmd(`.saveplus fill ${id} 1-2`);
  assert.match(out, /已加入队列：1 个保存单位/);
  assert.match(out, /已保存跳过：1/);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1, 2]);
  await h.stop();
});

test("12 监视与补漏并发时由在途协调避免重复", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo" });
  const out = await h.cmd(`.saveplus fill ${id} 1|1`);
  assert.match(out, /进行中跳过：1/);
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});

test("12 force 忽略成功记录强制重存，但仍遵守过滤", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "photo", text: "ok" });
  await h.emit("-1001", { id: 2, kind: "photo", text: "广告" });
  await h.idle();
  await h.cmd(`.saveplus rule bl ${id} add 广告`);
  const out = await h.cmd(`.saveplus fill ${id} 1|2 force`);
  assert.match(out, /已启用 force/);
  assert.match(out, /已加入队列：1 个保存单位/);
  assert.match(out, /过滤跳过：1/);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1, 2, 1]);
  await h.stop();
});

test("12 区间边缘跨出范围的相册默认不纳入并给出提示；expand 时整组纳入", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  for (const m of [9, 10, 11]) h.tg.addMessage("-1001", { id: m, kind: "photo", groupedId: "edge" });
  h.tg.addMessage("-1001", { id: 12, kind: "photo" });
  const out = await h.cmd(`.saveplus fill ${id} 10|12`);
  assert.match(out, /跨出区间边缘的相册未纳入（9–11）/);
  assert.match(out, /已加入队列：1 个保存单位/);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.map((i) => i.messageId)), [[12]]);
  const out2 = await h.cmd(`.saveplus fill ${id} 10|12 expand`);
  assert.match(out2, /已加入队列：1 个保存单位/);
  assert.match(out2, /已保存跳过：1/);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends()[1].items?.map((i) => i.messageId), [9, 10, 11]);
  await h.stop();
});

test("12 相册部分成员已保存：转为待处理，显式整组强制重存后整组发送", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  h.tg.addMessage("-1001", { id: 1, kind: "photo", groupedId: "g" });
  await h.cmd(`.saveplus fill ${id} 1|1`);
  await h.idle();
  h.tg.addMessage("-1001", { id: 2, kind: "photo", groupedId: "g" });
  const out = await h.cmd(`.saveplus fill ${id} 1|2`);
  assert.match(out, /待处理：1/);
  const t = h.data.tasks[h.data.tasks.length - 1];
  assert.equal(t.status, "needs_attention");
  assert.equal(t.lastError?.code, "partially_saved");
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1, "不会盲目重发或拆组发送");
  await h.cmd(`.saveplus task retry ${t.id} force`);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends()[1].items?.map((i) => i.messageId), [1, 2]);
  await h.stop();
});

test("12 参数校验：规则不存在、链接不属于规则来源、范围过大、格式错误", async () => {
  const h = await createHarness({ options: { maxRangeSpan: 100 } });
  const id = await addDefaultRule(h);
  assert.match(await h.cmd(".saveplus fill 9 1|2"), /规则 9 不存在/);
  assert.match(await h.cmd(`.saveplus fill ${id} t.me/c/9/1|t.me/c/9/5`), /不属于规则 #1 的来源/);
  assert.match(await h.cmd(`.saveplus fill ${id} 1|500`), /范围过大（500 条），单次上限 100 条/);
  assert.match(await h.cmd(`.saveplus fill ${id} 1`), /范围格式/);
  assert.match(await h.cmd(`.saveplus fill ${id} 1|2 now`), /未知参数：now/);
  assert.equal(h.data.tasks.length, 0);
  await h.stop();
});

test("12 暂停的规则仍可手动补漏并提示", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.cmd(`.saveplus rule pause ${id}`);
  h.tg.addMessage("-1001", { id: 3, kind: "photo" });
  assert.match(await h.cmd(`.saveplus fill ${id} 3|3`), /规则当前已暂停；补漏任务仍会执行/);
  await h.idle();
  assert.equal(h.tg.stagedSends().length, 1);
  await h.stop();
});
