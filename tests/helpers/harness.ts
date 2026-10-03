import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { TelegramClient } from "teleproto";
import { GenerationContext } from "@utils/generationContext";
import {
  createSavePlusPlugin,
  SavePlusError,
  type Clock,
  type CoverKind,
  type DbShape,
  type EntityJson,
  type MediaKind,
  type PeerInfo,
  type PeerTarget,
  type SavePlusOptions,
  type SavePlusPlugin,
  type SentResult,
  type SourceMessage,
  type StagedItem,
  type TelegramPort,
} from "../../saveplus";

export class FakeClock implements Clock {
  t = Date.UTC(2026, 9, 1, 0, 0, 0);
  /** 超过该时长的等待不会自动推进，需调用 advance()（默认全部自动推进）。 */
  autoAdvanceMaxMs = Number.POSITIVE_INFINITY;
  private blocked: Array<{ until: number; resolve: () => void }> = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    if (ms > this.autoAdvanceMaxMs) {
      await new Promise<void>((resolve) => {
        const entry = { until: this.t + ms, resolve };
        this.blocked.push(entry);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    this.t += Math.max(0, ms);
    await new Promise((r) => setImmediate(r));
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.blocked.filter((b) => b.until <= this.t);
    this.blocked = this.blocked.filter((b) => b.until > this.t);
    for (const b of due) b.resolve();
  }
}

export interface FakeMsgInit {
  id: number;
  /** "service" 表示系统消息：读取历史时会出现，但不能保存。 */
  kind?: MediaKind | "service";
  editDate?: number;
  text?: string;
  /** 消息带内联按钮。 */
  buttons?: boolean;
  groupedId?: string;
  cover?: CoverKind;
  size?: number;
  out?: boolean;
  noforwards?: boolean;
  reuploadable?: boolean;
  unsupportedReason?: string;
  fileName?: string;
  entities?: EntityJson[];
  webPreview?: boolean;
}

export interface FakeRaw extends FakeMsgInit {
  __fake: true;
  chatId: string;
  date: number;
}

type Injected = SavePlusError | Error | ((ctx: unknown) => SavePlusError | Error | undefined);

export interface SendRecord {
  op: "forward" | "text" | "staged";
  target: PeerTarget;
  silent?: boolean;
  dropAuthor?: boolean;
  sourceChatId?: string;
  ids?: number[];
  text?: string;
  html?: boolean;
  replyTo?: number;
  items?: StagedItem[];
  /** 发送时每个中转文件（媒体／封面／缩略图）是否存在。 */
  filesExisted?: boolean;
  resultIds: number[];
}

/** 可注入故障的 Telegram 替身：stageMedia 会真实写出媒体与封面文件。 */
export class FakeTelegram implements TelegramPort {
  self = "1000";
  peers = new Map<string, PeerInfo>();
  aliases = new Map<string, string>();
  messages = new Map<string, Map<number, FakeRaw>>();
  sent: SendRecord[] = [];
  outbox = new Map<string, SourceMessage[]>();
  nextTargetId = 5000;
  failures: { stage: Injected[]; send: Injected[]; forward: Injected[]; text: Injected[]; read: Injected[] } = {
    stage: [],
    send: [],
    forward: [],
    text: [],
    read: [],
  };
  /** 发送请求“已送达但响应丢失”：记录送达后再抛出。 */
  deliverThenFail: SavePlusError[] = [];
  forwardDeliverThenFail: SavePlusError[] = [];
  beforeSendResolve?: (items: StagedItem[]) => Promise<void> | void;
  stageCalls: number[] = [];
  sendWarnings: string[][] = [];
  /** 下载中途停住（模拟大文件下载），收到中止信号时抛错。 */
  stageGate?: Promise<void>;
  readCalls = 0;
  sendGate?: Promise<void>;

  constructor(readonly clock: Clock) {
    this.addPeer({ peerId: this.self, title: "收藏夹", kind: "self" }, "me");
  }

  addPeer(info: Partial<PeerInfo> & { peerId: string; title: string }, ...aliases: string[]): PeerInfo {
    const full: PeerInfo = { kind: "channel", canSend: true, noforwards: false, ...info };
    this.peers.set(full.peerId, full);
    for (const a of aliases) this.aliases.set(a, full.peerId);
    if (full.username) this.aliases.set(`@${full.username}`, full.peerId);
    return full;
  }

  addMessage(chatId: string, init: FakeMsgInit): FakeRaw {
    const raw: FakeRaw = {
      kind: "photo",
      text: "",
      __fake: true,
      chatId,
      date: Math.floor(this.clock.now() / 1000),
      ...init,
    };
    if (!this.messages.has(chatId)) this.messages.set(chatId, new Map());
    (this.messages.get(chatId) as Map<number, FakeRaw>).set(init.id, raw);
    return raw;
  }

  deleteMessage(chatId: string, id: number): void {
    this.messages.get(chatId)?.delete(id);
  }

  private take(list: Injected[], ctx: unknown): void {
    if (!list.length) return;
    const next = list.shift() as Injected;
    const err = typeof next === "function" ? next(ctx) : next;
    if (err) throw err;
  }

  async selfId(): Promise<string> {
    return this.self;
  }

  async resolvePeer(ref: string): Promise<PeerInfo> {
    const id = this.aliases.get(ref) ?? ref;
    const info = this.peers.get(id);
    if (!info) throw new SavePlusError("not_found", `找不到会话 ${ref}`);
    return { ...info };
  }

  chatIdCalls = 0;
  convertCalls = 0;
  chatIdOf(raw: unknown): string | null {
    this.chatIdCalls++;
    const r = raw as FakeRaw;
    return r && r.__fake === true ? r.chatId : null;
  }

  toSourceMessage(raw: unknown): SourceMessage | null {
    this.convertCalls++;
    const r = raw as FakeRaw;
    if (!r || r.__fake !== true || r.kind === "service") return null;
    const kind = (r.kind ?? "photo") as MediaKind;
    return {
      chatId: r.chatId,
      id: r.id,
      date: r.date,
      editDate: r.editDate,
      out: Boolean(r.out),
      groupedId: r.groupedId,
      kind,
      text: r.text ?? "",
      entities: r.entities ?? [],
      fileName: r.fileName,
      mimeType: kind === "photo" ? "image/jpeg" : "application/octet-stream",
      size: kind === "text" ? undefined : r.size ?? 2048,
      cover: kind === "video" || kind === "animation" ? r.cover ?? "custom" : undefined,
      reuploadable: r.reuploadable ?? kind !== "other",
      unsupportedReason: r.unsupportedReason,
      webPreview: Boolean(r.webPreview),
      noforwards: Boolean(r.noforwards),
      hasButtons: Boolean(r.buttons),
      raw: r,
    };
  }

  async getMessages(chatId: string, ids: number[]): Promise<Map<number, SourceMessage>> {
    this.readCalls++;
    this.take(this.failures.read, { chatId, ids });
    const out = new Map<number, SourceMessage>();
    const chat = this.messages.get(chatId);
    for (const id of ids) {
      const raw = chat?.get(id);
      if (raw) out.set(id, this.toSourceMessage(raw) as SourceMessage);
    }
    return out;
  }

  private deliver(target: PeerTarget, msgs: Array<Partial<SourceMessage>>): number[] {
    const list = this.outbox.get(target.peerId) ?? [];
    const ids: number[] = [];
    for (const m of msgs) {
      const id = this.nextTargetId++;
      ids.push(id);
      list.push({
        chatId: target.peerId,
        id,
        date: Math.floor(this.clock.now() / 1000),
        out: true,
        kind: m.kind ?? "text",
        text: m.text ?? "",
        entities: [],
        size: m.size,
        reuploadable: true,
        webPreview: false,
        noforwards: false,
        hasButtons: false,
        raw: null,
      });
    }
    this.outbox.set(target.peerId, list);
    return ids;
  }

  async forwardMessages(
    target: PeerTarget,
    sourceChatId: string,
    ids: number[],
    opts: { dropAuthor?: boolean; silent?: boolean } = {}
  ): Promise<number[]> {
    this.take(this.failures.forward, { target, sourceChatId, ids });
    const src = this.peers.get(sourceChatId);
    const raws = ids.map((id) => this.messages.get(sourceChatId)?.get(id));
    if (src?.noforwards || raws.some((r) => r?.noforwards)) {
      throw new SavePlusError("forward_restricted", "来源禁止转发（受保护内容）");
    }
    const resultIds = this.deliver(
      target,
      raws.map((r) => ({ kind: r?.kind === "service" ? "other" : r?.kind, text: r?.text }))
    );
    this.sent.push({ op: "forward", target, sourceChatId, ids, resultIds, dropAuthor: opts.dropAuthor, silent: opts.silent });
    const late = this.forwardDeliverThenFail.shift();
    if (late) throw late;
    return resultIds;
  }

  async sendText(
    target: PeerTarget,
    text: string,
    _entities: EntityJson[],
    opts: { html?: boolean; replyTo?: number; silent?: boolean } = {}
  ): Promise<number> {
    this.take(this.failures.text, { target, text });
    const [id] = this.deliver(target, [{ kind: "text", text }]);
    this.sent.push({ op: "text", target, text, html: opts.html, replyTo: opts.replyTo, silent: opts.silent, resultIds: [id] });
    return id;
  }

  async stageMedia(message: SourceMessage, dir: string, signal?: AbortSignal): Promise<StagedItem> {
    this.stageCalls.push(message.id);
    this.take(this.failures.stage, message);
    if (this.stageGate && message.kind !== "text") {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, `m${message.id}_partial.bin.part`), Buffer.alloc(4096));
      await Promise.race([
        this.stageGate,
        new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new Error("download aborted"));
          signal?.addEventListener("abort", () => reject(new Error("download aborted")), { once: true });
        }),
      ]);
    }
    const item: StagedItem = {
      messageId: message.id,
      kind: message.kind,
      text: message.text,
      entities: message.entities,
      attributes: {},
    };
    if (message.kind === "text") return item;
    if (!message.reuploadable) throw new SavePlusError("unsupported", message.unsupportedReason || "不支持");
    await fsp.mkdir(dir, { recursive: true });
    const name = message.fileName ?? (message.kind === "photo" ? "photo.jpg" : `${message.kind}.bin`);
    const file = path.join(dir, `m${message.id}_${name}`);
    await fsp.writeFile(file, Buffer.alloc(message.size ?? 2048, 7));
    item.mediaFile = file;
    item.size = message.size ?? 2048;
    item.mimeType = message.mimeType;
    if (message.kind === "video" || message.kind === "animation") {
      item.attributes = { video: { duration: 12, w: 1280, h: 720, supportsStreaming: true } };
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      if (message.cover === "custom") {
        item.coverKind = "custom";
        item.coverFile = path.join(dir, `c${message.id}.jpg`);
        await fsp.writeFile(item.coverFile, jpeg);
        item.thumbFile = path.join(dir, `t${message.id}.jpg`);
        await fsp.writeFile(item.thumbFile, jpeg);
      } else if (message.cover === "thumb") {
        item.coverKind = "thumb";
        item.thumbFile = path.join(dir, `t${message.id}.jpg`);
        await fsp.writeFile(item.thumbFile, jpeg);
      } else {
        item.coverKind = message.cover ?? "none";
      }
    }
    return item;
  }

  async sendStaged(target: PeerTarget, items: StagedItem[], opts: { silent?: boolean } = {}): Promise<SentResult> {
    if (this.sendGate) await this.sendGate;
    this.take(this.failures.send, { target, items });
    const files = items.flatMap((it) => [it.mediaFile, it.coverFile, it.thumbFile].filter(Boolean) as string[]);
    const filesExisted = files.every((f) => fs.existsSync(f));
    const resultIds = this.deliver(
      target,
      items.map((it) => ({ kind: it.kind, text: it.text, size: it.size }))
    );
    this.sent.push({ op: "staged", target, items: JSON.parse(JSON.stringify(items)), filesExisted, resultIds, silent: opts.silent });
    if (this.beforeSendResolve) await this.beforeSendResolve(items);
    const late = this.deliverThenFail.shift();
    if (late) throw late;
    return { messageIds: resultIds, warnings: this.sendWarnings.shift() ?? [] };
  }

  historyCalls: Array<{ chatId: string; ascending: boolean; afterId?: number; beforeId?: number }> = [];

  async getHistory(
    chatId: string,
    opts: { ascending: boolean; afterId?: number; beforeId?: number; limit: number }
  ): Promise<{ messages: SourceMessage[]; rawIds: number[] }> {
    this.historyCalls.push({ chatId, ascending: opts.ascending, afterId: opts.afterId, beforeId: opts.beforeId });
    this.take(this.failures.read, { chatId, opts });
    const all = Array.from(this.messages.get(chatId)?.values() ?? []).sort((a, b) => a.id - b.id);
    const page = opts.ascending
      ? all.filter((m) => m.id > (opts.afterId ?? 0)).slice(0, opts.limit)
      : all
          .filter((m) => !opts.beforeId || m.id < opts.beforeId)
          .reverse()
          .slice(0, opts.limit);
    const messages = page.map((m) => this.toSourceMessage(m)).filter((m): m is SourceMessage => Boolean(m));
    return { messages, rawIds: page.map((m) => m.id) };
  }

  async findRecentOwn(target: PeerTarget, sinceUnix: number, limit: number): Promise<SourceMessage[]> {
    return (this.outbox.get(target.peerId) ?? []).filter((m) => m.date >= sinceUnix).slice(-limit);
  }

  stagedSends(): SendRecord[] {
    return this.sent.filter((s) => s.op === "staged");
  }
}

export const FAST_OPTIONS: Partial<SavePlusOptions> = {
  minIntervalMs: 0,
  maxPerMinute: 10_000,
  manualMinIntervalMs: 0,
  manualMaxPerMinute: 10_000,
  albumDebounceMs: 100,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  diskMarginBytes: 0,
  stopTimeoutMs: 2000,
};

export interface CommandOptions {
  chat?: string;
  reply?: number;
  /** 前若干次编辑命令消息时抛错（例如消息已被删除）。 */
  failEdits?: number;
}

const tmpRoot = path.join(__dirname, "..", "..", ".test-tmp");

export async function makeRoot(): Promise<string> {
  await fsp.mkdir(tmpRoot, { recursive: true });
  return fsp.mkdtemp(path.join(tmpRoot, "case-"));
}

export class Harness {
  plugin!: SavePlusPlugin;
  lifecycle!: GenerationContext;
  generation = 0;
  edits: string[] = [];

  constructor(
    readonly root: string,
    readonly tg: FakeTelegram,
    readonly clock: FakeClock,
    readonly options: Partial<SavePlusOptions>,
    readonly diskFree?: (dir: string) => Promise<number | undefined>
  ) {}

  get dataDir(): string {
    return path.join(this.root, "assets", "saveplus");
  }
  get tempDir(): string {
    return path.join(this.root, "temp", "saveplus");
  }
  get stagingDir(): string {
    return path.join(this.tempDir, "staging");
  }
  get archiveDir(): string {
    return path.join(this.dataDir, "archive");
  }

  async start(): Promise<void> {
    this.plugin = createSavePlusPlugin({
      createPort: () => this.tg,
      getClient: async () => ({}) as TelegramClient,
      clock: this.clock,
      dataDir: this.dataDir,
      tempDir: this.tempDir,
      options: this.options,
      diskFree: this.diskFree,
      log: () => undefined,
    });
    this.generation++;
    this.lifecycle = new GenerationContext(this.generation);
    await this.plugin.setup({ generation: this.generation, signal: this.lifecycle.signal, lifecycle: this.lifecycle });
  }

  /** 模拟宿主卸载：abort generation → cleanup → drain。 */
  async stop(): Promise<void> {
    this.lifecycle.abort("test unload");
    await this.plugin.cleanup();
    await this.lifecycle.drain(3000);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  get engine() {
    const e = this.plugin.runtime.engine;
    if (!e) throw new Error("engine not running");
    return e;
  }

  get data(): DbShape {
    return this.engine.store.data;
  }

  async idle(): Promise<void> {
    await this.engine.whenIdle();
  }

  async cmd(text: string, opts: CommandOptions = {}): Promise<string> {
    const edits: string[] = [];
    let failures = opts.failEdits ?? 0;
    const msg = {
      message: text,
      chatId: opts.chat ?? "777",
      replyTo: opts.reply !== undefined ? { replyToMsgId: opts.reply } : undefined,
      edit: async (p: { text: string }) => {
        if (failures > 0) {
          failures--;
          throw Object.assign(new Error("MESSAGE_ID_INVALID"), { errorMessage: "MESSAGE_ID_INVALID" });
        }
        edits.push(p.text);
        this.edits.push(p.text);
      },
    };
    await this.plugin.cmdHandlers.saveplus(msg as never);
    return edits[edits.length - 1] ?? "";
  }

  /** 来源中出现新消息并投递监听事件。 */
  async emit(chatId: string, init: FakeMsgInit, opts: { edited?: boolean } = {}): Promise<FakeRaw> {
    const raw = this.tg.addMessage(chatId, init);
    await this.plugin.listenMessageHandler?.(raw as never, opts.edited ? { isEdited: true } : undefined);
    return raw;
  }

  /** 同一相册成员连续到达（不在成员之间等待），模拟宿主逐条投递。 */
  async emitAlbum(chatId: string, members: FakeMsgInit[]): Promise<void> {
    const pending = members.map((m) => {
      const raw = this.tg.addMessage(chatId, m);
      return this.plugin.listenMessageHandler?.(raw as never);
    });
    await Promise.all(pending);
  }

  task(id: number) {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`task ${id} missing`);
    return t;
  }

  listStaging(): string[] {
    if (!fs.existsSync(this.stagingDir)) return [];
    return fs.readdirSync(this.stagingDir);
  }
}

export async function createHarness(
  opts: {
    options?: Partial<SavePlusOptions>;
    diskFree?: (dir: string) => Promise<number | undefined>;
    setup?: (tg: FakeTelegram) => void;
  } = {}
): Promise<Harness> {
  const clock = new FakeClock();
  const tg = new FakeTelegram(clock);
  tg.addPeer({ peerId: "-1001", title: "来源频道", username: "srcchan" }, "@srcchan");
  tg.addPeer({ peerId: "-1002", title: "目标频道", username: "dstchan" }, "@dstchan");
  tg.addPeer({ peerId: "-1003", title: "备份群", kind: "group" }, "@backup");
  tg.addPeer({ peerId: "-1009", title: "私有来源" });
  opts.setup?.(tg);
  const h = new Harness(await makeRoot(), tg, clock, { ...FAST_OPTIONS, ...(opts.options || {}) }, opts.diskFree);
  await h.start();
  return h;
}

/** 创建一条把 @srcchan 的新消息中转到 @dstchan 的规则，返回规则 ID。 */
export async function addDefaultRule(h: Harness, extra?: string): Promise<number> {
  const out = await h.cmd(`.saveplus rule add @srcchan ${extra ?? "@dstchan"}`);
  const m = /#(\d+)/.exec(out);
  if (!m) throw new Error(`rule add failed: ${out}`);
  return Number(m[1]);
}
