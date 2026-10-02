import { test } from "node:test";
import assert from "node:assert/strict";
import { addDefaultRule, createHarness } from "./helpers/harness";
import { defaultFilter, evaluateFilter, validateRegex, type FilterConfig } from "../saveplus";

const unit = (text: string, kinds = ["photo"] as const) => ({ kinds: [...kinds], text });

test("09 过滤真值表：类型符合 ＋ 黑名单否决 ＋ 白名单（启用时至少命中一条）", () => {
  const f = (patch: Partial<FilterConfig>): FilterConfig => ({ ...defaultFilter(), ...patch });
  const wl = (patterns: string[], enabled = true) => ({ enabled, patterns });
  assert.equal(evaluateFilter(f({}), unit("任意")).pass, true);
  assert.equal(evaluateFilter(f({ types: ["video"] }), unit("x", ["photo"])).pass, false);
  assert.equal(evaluateFilter(f({ types: ["video", "photo"] }), unit("x", ["photo"])).pass, true);
  // 黑名单：大小写不敏感的包含匹配
  assert.equal(evaluateFilter(f({ blacklist: ["AD"] }), unit("buy ad now")).pass, false);
  assert.equal(evaluateFilter(f({ blacklist: ["广告"] }), unit("")).pass, true, "无文案时黑名单不命中");
  // 白名单：多条之间为 OR
  assert.equal(evaluateFilter(f({ whitelist: wl(["^新番", "完结"]) }), unit("本季完结")).pass, true);
  assert.equal(evaluateFilter(f({ whitelist: wl(["^新番"]) }), unit("旧番")).pass, false);
  assert.equal(evaluateFilter(f({ whitelist: wl(["NEW"]) }), unit("brand new")).pass, true, "白名单大小写不敏感");
  // 关闭的白名单不生效
  assert.equal(evaluateFilter(f({ whitelist: wl(["^新番"], false) }), unit("旧番")).pass, true);
  // 同时启用：命中白名单也不能绕过黑名单
  const both = evaluateFilter(f({ blacklist: ["广告"], whitelist: wl(["新番"]) }), unit("新番 广告"));
  assert.deepEqual(both, { pass: false, reason: "命中黑名单关键词「广告」" });
  // 白名单命中仍需类型符合
  assert.equal(evaluateFilter(f({ types: ["video"], whitelist: wl(["新番"]) }), unit("新番", ["photo"])).pass, false);
  // 白名单启用但没有文字
  assert.deepEqual(evaluateFilter(f({ whitelist: wl(["新番"]) }), unit("")), { pass: false, reason: "白名单已启用，但消息没有可匹配的文字" });
  // 白名单启用但为空：不放行
  assert.equal(evaluateFilter(f({ whitelist: wl([]) }), unit("任何")).pass, false);
});

test("09 正则在配置时校验：语法错误、过长与嵌套量词被拒绝，超时按未命中处理", () => {
  assert.match(validateRegex("(") ?? "", /正则语法错误/);
  assert.match(validateRegex("a".repeat(301)) ?? "", /过长/);
  assert.match(validateRegex("(a+)+$") ?? "", /嵌套量词/);
  assert.match(validateRegex("(\\w*)*x") ?? "", /嵌套量词/);
  assert.equal(validateRegex("新番 第\\d+集"), null);
  // 即便绕过配置校验，运行期也有超时保护。
  const evil = { ...defaultFilter(), whitelist: { enabled: true, patterns: ["^(a|a?)+$"] } };
  const started = Date.now();
  const res = evaluateFilter(evil, unit(`${"a".repeat(40)}b`));
  assert.equal(res.pass, false);
  assert.ok(Date.now() - started < 2000);
});

test("09 通过命令配置类型与黑白名单；被过滤的消息不进入上传，跳过原因可查", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  assert.match(await h.cmd(`.saveplus rule type ${id} 视频 photo`), /类型：视频、图片/);
  assert.match(await h.cmd(`.saveplus rule type ${id} mp3`), /未知类型：mp3/);
  assert.match(await h.cmd(`.saveplus rule bl ${id} add 广告 推广`), /<code>广告<\/code> <code>推广<\/code>/);
  assert.match(await h.cmd(`.saveplus rule wl ${id} on`), /白名单为空/);
  assert.match(await h.cmd(`.saveplus rule wl ${id} add 第\\s*\\d+ 集`), /1\. <code>第\\s\*\\d\+ 集<\/code>/);
  assert.match(await h.cmd(`.saveplus rule wl ${id} add (a+)+`), /嵌套量词/);
  assert.match(await h.cmd(`.saveplus rule wl ${id} on`), /已启用/);

  await h.emit("-1001", { id: 1, kind: "photo", text: "第 3 集" });
  await h.emit("-1001", { id: 2, kind: "photo", text: "第 4 集 广告" });
  await h.emit("-1001", { id: 3, kind: "document", text: "第 5 集" });
  await h.emit("-1001", { id: 4, kind: "video", cover: "thumb", text: "预告" });
  await h.emit("-1001", { id: 5, kind: "video", cover: "thumb", text: "第12 集" });
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1, 5]);
  assert.equal(h.tg.stageCalls.includes(2), false, "被过滤的消息不会下载");
  const status = await h.cmd(".saveplus status");
  assert.match(status, /消息 4：未命中任何白名单正则/);
  assert.match(status, /消息 3：类型「文件」不在允许范围内/);
  assert.match(status, /消息 2：命中黑名单关键词「广告」/);

  assert.match(await h.cmd(`.saveplus rule bl ${id} del 广告`), /<code>推广<\/code>/);
  assert.match(await h.cmd(`.saveplus rule wl ${id} del 1`), /未启用/);
  const show = await h.cmd(`.saveplus rule show ${id}`);
  assert.match(show, /类型：视频、图片/);
  await h.stop();
});

test("09 已排队任务固定接收时的过滤与目标快照；之后修改规则只影响新消息", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 1, kind: "photo", text: "普通" });
  await h.emit("-1001", { id: 2, kind: "photo", text: "普通" });
  await h.cmd(`.saveplus rule bl ${id} add 普通`);
  await h.emit("-1001", { id: 3, kind: "photo", text: "普通" });
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.deepEqual(h.tg.stagedSends().map((s) => s.items?.[0].messageId), [1, 2]);
  assert.deepEqual(h.task(2).filter.blacklist, []);
  await h.stop();
});

test("09 普通手动保存不套用监视过滤", async () => {
  const h = await createHarness();
  const id = await addDefaultRule(h);
  await h.cmd(`.saveplus rule type ${id} video`);
  h.tg.addMessage("-1001", { id: 7, kind: "photo", text: "图" });
  assert.match(await h.cmd(".saveplus t.me/srcchan/7 @dstchan"), /保存完成/);
  await h.stop();
});
