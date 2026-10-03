import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Api, helpers } from "teleproto";
import { GenerationContext } from "@utils/generationContext";
import { isValidPlugin } from "@utils/pluginBase";
import { setGlobalClient } from "@utils/runtimeManager";
import { addDefaultRule, createHarness, FakeClock, makeRoot } from "./helpers/harness";
import { createSavePlusPlugin, helpText, RateLimiter } from "../saveplus";

const B = (n: number | string) => helpers.returnBigInt(n);

test("13 交付物是单文件插件，只依赖宿主提供的模块与 Node 内置模块", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "saveplus.ts"), "utf8");
  const imports = Array.from(src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)).map((m) => m[1]);
  const allowed = new Set([
    "@utils/pluginBase",
    "@utils/pluginManager",
    "@utils/runtimeManager",
    "@utils/pathHelpers",
    "@utils/htmlEscape",
    "teleproto",
    "teleproto/client/uploads",
    "lowdb/node",
    "fs",
    "fs/promises",
    "path",
    "vm",
    "crypto",
  ]);
  assert.deepEqual(imports.filter((i) => !allowed.has(i)), []);
  assert.doesNotMatch(src, /require\(/);
  assert.doesNotMatch(src, /loadPlugins\(/);
  assert.match(src, /export default new SavePlusPlugin\(\)/);
});

test("13 帮助覆盖全部入口，说明暂停语义、封面要求与离线补漏方式", () => {
  const help = helpText();
  for (const sub of ["to 目标", "target", "source on|off", "rule add", "rule list", "rule target", "rule pause|resume", "rule del", "rule type", "rule bl", "rule wl", "fill 规则ID", "status", "task retry", "task check", "task resend", "task cancel", "rule mode ID relay|forward", "rule hide|silent|edited", "backup 来源 目标", "backup status ID", "backup pause|resume|cancel", "stats", "export", "import shift", "--hide"]) {
    assert.ok(help.includes(sub), `帮助缺少 ${sub}`);
  }
  assert.match(help, /暂停只停止接收新消息，已排队任务继续执行/);
  assert.match(help, /携带来源视频封面上传/);
  assert.match(help, /不自动扫描离线历史/);
});

test("05 限速器：最小间隔、每分钟上限与服务端冷却取最严格者", async () => {
  const clock = new FakeClock();
  const rl = new RateLimiter(clock, 4000, 3);
  const start = clock.now();
  const marks: number[] = [];
  for (let i = 0; i < 4; i++) {
    await rl.acquire();
    marks.push(clock.now() - start);
  }
  assert.deepEqual(marks, [0, 4000, 8000, 60_000]);
  rl.applyCooldown(90_000);
  const before = clock.now();
  await rl.acquire();
  assert.ok(clock.now() - before >= 90_000);
});

test("13 压力：大量并发事件与相册只由一个执行者依次处理，每条恰好投递一次，数据文件始终有效", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  let active = 0;
  let peak = 0;
  const original = h.tg.sendStaged.bind(h.tg);
  h.tg.sendStaged = async (target, items) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    try {
      return await original(target, items);
    } finally {
      active--;
    }
  };
  const singles = Array.from({ length: 150 }, (_, i) => h.emit("-1001", { id: i + 1, kind: i % 3 ? "photo" : "text", text: `#${i}` }));
  const albums = Array.from({ length: 10 }, (_, g) =>
    h.emitAlbum("-1001", [0, 1, 2].map((k) => ({ id: 1000 + g * 3 + k, kind: "photo" as const, groupedId: `g${g}` })))
  );
  const dup = Array.from({ length: 50 }, (_, i) => h.emit("-1001", { id: (i % 150) + 1, kind: "photo" }));
  await Promise.all([...singles, ...albums, ...dup]);
  await h.idle();
  assert.equal(peak, 1, "同一时间只有一个上传");
  const sentIds = h.tg.stagedSends().flatMap((s) => s.items?.map((i) => i.messageId) ?? []);
  assert.equal(sentIds.length, 180);
  assert.equal(new Set(sentIds).size, 180);
  const disk = JSON.parse(fs.readFileSync(path.join(h.dataDir, "data.json"), "utf8"));
  assert.equal(Object.keys(disk.successes).length, 180);
  assert.deepEqual(h.listStaging(), []);
  await h.stop();
});

test("10 清理只删除属于该任务、位于中转根目录内的目录", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  h.tg.addMessage("-1001", { id: 1, kind: "photo" });
  await h.cmd(".saveplus t.me/srcchan/1 local");
  const archived = path.join(h.archiveDir, "-1001", "msg_1_photo.jpg");
  assert.ok(fs.existsSync(archived));
  let release!: () => void;
  h.tg.sendGate = new Promise<void>((r) => (release = r));
  await h.emit("-1001", { id: 2, kind: "photo" });
  await new Promise((r) => setTimeout(r, 20));
  // 模拟损坏或被篡改的任务数据：中转目录指向永久归档。
  h.data.tasks[0].stagingDir = path.join(h.archiveDir, "-1001");
  release();
  h.tg.sendGate = undefined;
  await h.idle();
  assert.equal(h.task(1).status, "cleanup_pending");
  assert.match(h.task(1).lastError?.message ?? "", /拒绝清理不属于任务的目录/);
  assert.ok(fs.existsSync(archived), "永久归档不受影响");
  await h.stop();
});

test("06 卸载与重启不删除失败任务的中转文件、成功记录与本地归档", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emit("-1001", { id: 1, kind: "photo" });
  await h.emit("-1001", { id: 2, kind: "video", cover: "none" });
  h.tg.addMessage("-1001", { id: 3, kind: "photo" });
  await h.cmd(".saveplus t.me/srcchan/3 local");
  await h.idle();
  const staged = h.task(2).staged?.[0].mediaFile as string;
  await h.stop();
  assert.ok(fs.existsSync(staged));
  await h.start();
  assert.equal(h.task(2).status, "needs_attention");
  assert.equal(Object.keys(h.data.successes).length, 1);
  assert.ok(fs.existsSync(path.join(h.archiveDir, "-1001", "msg_3_photo.jpg")));
  await h.stop();
});

test("11 乱序到达的相册成员按原顺序发送；回复相册任一成员时整组保存", async () => {
  const h = await createHarness();
  await addDefaultRule(h);
  await h.emitAlbum("-1001", [
    { id: 12, kind: "photo", groupedId: "g" },
    { id: 10, kind: "photo", groupedId: "g", text: "首" },
    { id: 11, kind: "photo", groupedId: "g" },
  ]);
  await h.idle();
  assert.deepEqual(h.tg.stagedSends()[0].items?.map((i) => i.messageId), [10, 11, 12]);
  h.tg.addPeer({ peerId: "777", title: "当前群", kind: "group" });
  for (const id of [40, 41]) h.tg.addMessage("777", { id, kind: "photo", groupedId: "r" });
  await h.cmd(".saveplus @dstchan", { chat: "777", reply: 41 });
  assert.deepEqual(h.tg.sent.find((s) => s.op === "forward")?.ids, [40, 41]);
  await h.stop();
});

/** 生产接线：不注入替身端口，经宿主 getGlobalClient、宿主目录与真实 TeleprotoPort 完成一次监视中转。 */
class ProdLikeClient {
  sends: Api.messages.SendMedia[] = [];
  entities = new Map<string, unknown>([
    ["@srcchan", new Api.Channel({ id: B(1001), title: "来源频道", username: "srcchan", photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true })],
    ["@dstchan", new Api.Channel({ id: B(1002), title: "目标频道", username: "dstchan", photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true, creator: true })],
  ]);
  constructor() {
    this.entities.set("-1001001", this.entities.get("@srcchan"));
    this.entities.set("-1001002", this.entities.get("@dstchan"));
  }
  async getMe() {
    return new Api.User({ id: B(42), self: true, firstName: "me" });
  }
  async getEntity(q: unknown) {
    const e = this.entities.get(String(q));
    if (!e) throw new Error(`Could not find the input entity for ${String(q)}`);
    return e;
  }
  async getDialogs() {
    return [];
  }
  async getInputEntity() {
    return new Api.InputPeerChannel({ channelId: B(1002), accessHash: B(1) });
  }
  async getMessages(_e: unknown, p: { ids: number[] }) {
    return p.ids.map((id) => photoMessage(id));
  }
  async downloadFile(_loc: unknown, opts: { outputFile: string }) {
    fs.writeFileSync(opts.outputFile, Buffer.from([0xff, 0xd8, 0xff, 1]));
    return opts.outputFile;
  }
  async uploadFile({ file }: { file: { name: string } }) {
    return new Api.InputFile({ id: B(1), parts: 1, name: file.name, md5Checksum: "" });
  }
  async invoke(req: Api.messages.SendMedia) {
    this.sends.push(req);
    return new Api.Updates({ updates: [new Api.UpdateMessageID({ id: 900, randomId: req.randomId })], users: [], chats: [], date: 1, seq: 0 });
  }
}

function photoMessage(id: number): Api.Message {
  return new Api.Message({
    id,
    peerId: new Api.PeerChannel({ channelId: B(1001) }),
    date: 1700000000,
    message: "实拍",
    media: new Api.MessageMediaPhoto({
      photo: new Api.Photo({
        id: B(5),
        accessHash: B(6),
        fileReference: Buffer.from("x"),
        date: 1,
        dcId: 1,
        sizes: [new Api.PhotoSize({ type: "x", w: 800, h: 600, size: 4 })],
      }),
    }),
  });
}

test("13 生产接线：宿主客户端 + 宿主目录 + 真实适配层完成监视中转并清理", async () => {
  const root = await makeRoot();
  process.env.SAVEPLUS_HOST_ROOT = root;
  const client = new ProdLikeClient();
  setGlobalClient(client as never);
  try {
    const plugin = createSavePlusPlugin({ options: { minIntervalMs: 0, albumDebounceMs: 10 } });
    assert.equal(isValidPlugin(plugin), true);
    const lifecycle = new GenerationContext(1);
    await plugin.setup({ generation: 1, signal: lifecycle.signal, lifecycle });
    const edits: string[] = [];
    const cmd = async (text: string) => {
      await plugin.cmdHandlers.saveplus({ message: text, chatId: "1", edit: async (p: { text: string }) => void edits.push(p.text) } as never);
      return edits[edits.length - 1];
    };
    assert.match(await cmd(".saveplus rule add @srcchan @dstchan"), /已创建监视规则/);
    await plugin.listenMessageHandler?.(photoMessage(77));
    await plugin.runtime.engine?.whenIdle();
    assert.equal(client.sends.length, 1);
    assert.ok(client.sends[0].media instanceof Api.InputMediaUploadedPhoto);
    assert.equal(client.sends[0].message, "实拍");
    const data = JSON.parse(fs.readFileSync(path.join(root, "assets", "saveplus", "data.json"), "utf8"));
    assert.equal(data.accountId, "42");
    assert.equal(data.tasks[0].status, "done");
    assert.equal(Object.keys(data.successes)[0], "42|-1001001|77|-1001002");
    assert.deepEqual(fs.readdirSync(path.join(root, "temp", "saveplus", "staging")), []);
    lifecycle.abort("unload");
    await plugin.cleanup();
    assert.equal((await lifecycle.drain(2000)).completed, true);
  } finally {
    setGlobalClient(null);
    delete process.env.SAVEPLUS_HOST_ROOT;
  }
});
