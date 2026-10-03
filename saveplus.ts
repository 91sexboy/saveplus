/**
 * SavePlus — TeleBox 插件
 *
 * 在保留 save 插件手动保存能力（回复／链接／批量／闭区间／默认与临时目标／收藏夹／
 * 来源说明／本地归档）的基础上，提供：
 *   - 在线监视：只处理宿主投递的新消息事件，不主动扫描离线历史；默认不跟随编辑（可按规则开启“编辑后再存一份”）；
 *   - 监视过滤：消息类型 + 关键词黑名单 + 正则白名单共同生效，相册整组过滤；
 *   - 本地中转：下载到本地 → 携带来源视频封面上传 → 确认成功并持久记录 → 清理中转副本；
 *   - 成功去重：同一来源消息向同一目标成功保存后，监视与手动补漏默认跳过；
 *   - 手动补漏：按指定监视规则与消息范围补齐离线缺口，可显式强制重存；
 *   - 持久任务：失败、待处理、结果不确定的任务及中转文件都会保留，可查询、重试；
 *   - 搬自 shift：整个历史备份、原生转发与隐藏发送者、静音、统计、规则导出导入（含导入 shift 规则）。
 *
 * 依赖宿主：@utils/pluginBase、@utils/pluginManager、@utils/runtimeManager、
 *           @utils/pathHelpers、@utils/htmlEscape，以及宿主自带的 teleproto 与 lowdb。
 */

import { Plugin } from "@utils/pluginBase";
import type { PluginRuntimeContext } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/runtimeManager";
import { createDirectoryInAssets, createDirectoryInTemp } from "@utils/pathHelpers";
import { htmlEscape } from "@utils/htmlEscape";
import { Api, TelegramClient, errors as tgErrors, helpers as tgHelpers, utils as tgUtils } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { JSONFilePreset } from "lowdb/node";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vm from "vm";
import { randomBytes } from "crypto";

// ════════════════════════════════════════════════════════════════════════════
// 常量与基础类型
// ════════════════════════════════════════════════════════════════════════════

const PLUGIN_NAME = "saveplus";
const DB_VERSION = 1;

export type MediaKind =
  | "text"
  | "photo"
  | "video"
  | "animation"
  | "sticker"
  | "voice"
  | "audio"
  | "document"
  | "other";

export const FILTER_KINDS: MediaKind[] = [
  "text",
  "photo",
  "video",
  "animation",
  "sticker",
  "voice",
  "audio",
  "document",
];

const KIND_LABEL: Record<MediaKind, string> = {
  text: "文字",
  photo: "图片",
  video: "视频",
  animation: "动画",
  sticker: "贴纸",
  voice: "语音",
  audio: "音频",
  document: "文件",
  other: "其他",
};

const KIND_ALIASES: Record<string, MediaKind> = {
  text: "text",
  文字: "text",
  photo: "photo",
  图片: "photo",
  video: "video",
  视频: "video",
  animation: "animation",
  gif: "animation",
  动画: "animation",
  sticker: "sticker",
  贴纸: "sticker",
  voice: "voice",
  语音: "voice",
  audio: "audio",
  音频: "audio",
  document: "document",
  file: "document",
  文件: "document",
};

export interface SavePlusOptions {
  /** 监视、补漏与备份：相邻两次发送的最小间隔（毫秒）。 */
  minIntervalMs: number;
  /** 监视、补漏与备份：60 秒滑动窗口内的最大发送次数（相册计 1 次）。 */
  maxPerMinute: number;
  /** 普通手动保存的发送间隔与每分钟上限（沿用 save 的节奏，不受上面的固定间隔约束）。 */
  manualMinIntervalMs: number;
  manualMaxPerMinute: number;
  /** 相册成员聚合的静默窗口（毫秒），以最后一个成员到达时间计。 */
  albumDebounceMs: number;
  /** 瞬时错误的自动重试次数上限，超过后转为待处理。 */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 连续限流的自动等待次数上限，超过后转为待处理。 */
  maxFloodWaits: number;
  /** 单次手动补漏或范围保存允许的最大消息跨度。 */
  maxRangeSpan: number;
  /** 保留的已结束任务数量（成功保存记录不受影响）。 */
  keepFinishedTasks: number;
  /** 下载前要求保留的额外磁盘空间（字节）。 */
  diskMarginBytes: number;
  /** 发现相册成员时向区间外探查的消息数。 */
  albumProbeSpan: number;
  /** cleanup 时等待在途步骤结束的最长时间（毫秒）。 */
  stopTimeoutMs: number;
  /** 读取来源历史的最小间隔（毫秒）与每分钟上限。 */
  readMinIntervalMs: number;
  readMaxPerMinute: number;
  /** 整个历史备份：每页读取条数，以及单个备份允许同时排队的任务数上限。 */
  backupPageSize: number;
  backupBacklog: number;
  /** 手动补漏读取时，单次可等待的最长限流时间（秒）；更长则提示稍后重试。 */
  fillMaxFloodWaitSeconds: number;
  /** 保存统计保留的天数。 */
  statsRetentionDays: number;
}

export const DEFAULT_OPTIONS: SavePlusOptions = {
  // 固定 3 秒一条（每分钟 20 条），不随成功提速。
  minIntervalMs: 3000,
  maxPerMinute: 20,
  manualMinIntervalMs: 500,
  manualMaxPerMinute: 120,
  albumDebounceMs: 1500,
  maxAttempts: 5,
  backoffBaseMs: 30_000,
  backoffMaxMs: 30 * 60_000,
  maxFloodWaits: 30,
  maxRangeSpan: 5000,
  keepFinishedTasks: 300,
  diskMarginBytes: 64 * 1024 * 1024,
  albumProbeSpan: 20,
  stopTimeoutMs: 15_000,
  readMinIntervalMs: 1000,
  readMaxPerMinute: 30,
  backupPageSize: 100,
  backupBacklog: 30,
  fillMaxFloodWaitSeconds: 300,
  statsRetentionDays: 30,
};

export type ErrorCode =
  | "flood"
  | "forward_restricted"
  | "permission"
  | "not_found"
  | "invalid"
  | "unsupported"
  | "cover_unavailable"
  | "disk_full"
  | "network"
  | "file_reference"
  | "rpc"
  | "uncertain"
  | "store_write"
  | "stopped"
  | "internal";

/** 统一的可分类错误。transient 表示可以自动重试；maybeSent 表示请求可能已被服务器执行。 */
export class SavePlusError extends Error {
  readonly code: ErrorCode;
  readonly transient: boolean;
  readonly seconds?: number;
  readonly maybeSent: boolean;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { transient?: boolean; seconds?: number; maybeSent?: boolean } = {}
  ) {
    super(message);
    this.name = "SavePlusError";
    this.code = code;
    this.transient = opts.transient ?? false;
    this.seconds = opts.seconds;
    this.maybeSent = opts.maybeSent ?? false;
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function errorText(e: unknown): string {
  const err = e as { errorMessage?: string; message?: string } | undefined;
  return err?.errorMessage || err?.message || String(e);
}

// ════════════════════════════════════════════════════════════════════════════
// 时钟、互斥与限速
// ════════════════════════════════════════════════════════════════════════════

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        signal?.removeEventListener("abort", done);
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class RateLimiter {
  private sendTimes: number[] = [];
  /** 下一次允许发送的时间：上一次发送时间 + 间隔 × 上一次发送的消息条数。 */
  private nextAllowedAt = 0;
  private cooldownUntil = 0;
  private readonly mutex = new Mutex();
  constructor(
    private readonly clock: Clock,
    private readonly minIntervalMs: number,
    private readonly maxPerMinute: number
  ) {}

  applyCooldown(ms: number): void {
    const until = this.clock.now() + ms;
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.clock.now());
  }

  /** 获取发送配额；weight 为本次一次性发出的消息条数（相册按成员数计），间隔按条数累计。 */
  acquire(signal?: AbortSignal, weight = 1): Promise<void> {
    const count = Math.max(1, Math.floor(weight));
    return this.mutex.run(async () => {
      for (;;) {
        if (signal?.aborted) throw new SavePlusError("stopped", "插件正在停止");
        const now = this.clock.now();
        this.sendTimes = this.sendTimes.filter((t) => now - t < 60_000);
        let wait = Math.max(0, this.cooldownUntil - now, this.nextAllowedAt - now);
        const need = Math.min(count, this.maxPerMinute);
        if (this.sendTimes.length + need > this.maxPerMinute) {
          const oldest = this.sendTimes[this.sendTimes.length + need - this.maxPerMinute - 1];
          wait = Math.max(wait, 60_000 - (now - oldest));
        }
        if (wait <= 0) break;
        await this.clock.sleep(wait, signal);
      }
      const mark = this.clock.now();
      for (let i = 0; i < count; i++) this.sendTimes.push(mark);
      this.nextAllowedAt = mark + this.minIntervalMs * count;
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 过滤规则
// ════════════════════════════════════════════════════════════════════════════

export interface FilterConfig {
  types: MediaKind[] | "all";
  blacklist: string[];
  whitelist: { enabled: boolean; patterns: string[] };
  /** 广告过滤：带内联按钮、隐藏链接或自定义表情刷屏的消息不保存（默认关闭）。 */
  ads?: boolean;
}

export function defaultFilter(): FilterConfig {
  return { types: "all", blacklist: [], whitelist: { enabled: false, patterns: [] }, ads: false };
}

/** 自定义表情达到该数量视为刷屏广告。 */
export const CUSTOM_EMOJI_AD_THRESHOLD = 5;

/** 单条消息的广告特征（用于广告过滤）。 */
export interface AdSignals {
  hasButtons: boolean;
  entities: EntityJson[];
}

/** 返回广告判定原因；不是广告时返回 null。判断内联按钮、隐藏链接与自定义表情刷屏。 */
export function adReason(m: AdSignals): string | null {
  if (m.hasButtons) return "包含内联按钮";
  if (m.entities.some((en) => en.c === "MessageEntityTextUrl")) return "文案包含隐藏链接";
  const emoji = m.entities.filter((en) => en.c === "MessageEntityCustomEmoji").length;
  if (emoji >= CUSTOM_EMOJI_AD_THRESHOLD) return `自定义表情过多（${emoji} 个）`;
  return null;
}

const REGEX_MAX_LENGTH = 300;
const REGEX_TIMEOUT_MS = 50;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;

/** 校验白名单正则：语法合法、长度受限、拒绝明显的嵌套量词（灾难性回溯风险）。 */
export function validateRegex(pattern: string): string | null {
  if (!pattern.trim()) return "正则表达式不能为空";
  if (pattern.length > REGEX_MAX_LENGTH) return `正则表达式过长（上限 ${REGEX_MAX_LENGTH} 字符）`;
  try {
    new RegExp(pattern, "iu");
  } catch (e) {
    return `正则语法错误：${asError(e).message}`;
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return "正则包含嵌套量词（例如 (a+)+），可能导致匹配卡死，请改写";
  }
  return null;
}

const regexContext = vm.createContext({});

/** 在 vm 中带超时执行正则匹配，防止异常表达式阻塞宿主事件循环。 */
function safeRegexTest(pattern: string, text: string): boolean | "timeout" | "invalid" {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "iu");
  } catch {
    return "invalid";
  }
  try {
    const sandbox = regexContext as Record<string, unknown>;
    sandbox.re = re;
    sandbox.input = text;
    return Boolean(vm.runInContext("re.test(input)", regexContext, { timeout: REGEX_TIMEOUT_MS }));
  } catch {
    return "timeout";
  } finally {
    const sandbox = regexContext as Record<string, unknown>;
    delete sandbox.re;
    delete sandbox.input;
  }
}

export type FilterVerdict = { pass: true } | { pass: false; reason: string };

/** 过滤判定所需的保存单位信息；ads 为各成员的广告特征。 */
export interface FilterUnit {
  kinds: MediaKind[];
  text: string;
  ads?: AdSignals[];
}

/** 由单条消息或整组相册构造过滤判定所需的信息。 */
export function filterUnitOf(members: SourceMessage[]): FilterUnit {
  return {
    kinds: members.map((m) => m.kind),
    text: members.map((m) => m.text).filter(Boolean).join("\n"),
    ads: members.map((m) => ({ hasButtons: m.hasButtons, entities: m.entities })),
  };
}

/**
 * 判定一个保存单位（单条消息或整组相册）是否通过监视过滤：
 * 类型符合 + 未命中广告特征（开启时）+ 未命中黑名单 + （白名单关闭 或 至少命中一条）。
 */
export function evaluateFilter(filter: FilterConfig, unit: FilterUnit): FilterVerdict {
  if (filter.types !== "all") {
    const allowed = new Set(filter.types);
    const bad = unit.kinds.find((k) => !allowed.has(k));
    if (bad) return { pass: false, reason: `类型「${KIND_LABEL[bad]}」不在允许范围内` };
  }
  if (filter.ads) {
    for (const sig of unit.ads ?? []) {
      const reason = adReason(sig);
      if (reason) return { pass: false, reason: `疑似广告：${reason}` };
    }
  }
  const text = unit.text.slice(0, 16_384);
  const lower = text.toLowerCase();
  for (const word of filter.blacklist) {
    if (word && lower.includes(word.toLowerCase())) {
      return { pass: false, reason: `命中黑名单关键词「${word}」` };
    }
  }
  if (filter.whitelist.enabled) {
    if (!text.trim()) return { pass: false, reason: "白名单已启用，但消息没有可匹配的文字" };
    let timedOut = false;
    for (const pattern of filter.whitelist.patterns) {
      const r = safeRegexTest(pattern, text);
      if (r === true) return { pass: true };
      if (r === "timeout") timedOut = true;
    }
    return {
      pass: false,
      reason: timedOut ? "白名单正则匹配超时，按未命中处理" : "未命中任何白名单正则",
    };
  }
  return { pass: true };
}

function describeFilter(filter: FilterConfig): string {
  const types =
    filter.types === "all" ? "全部" : filter.types.map((k) => KIND_LABEL[k]).join("、") || "（无）";
  const bl = filter.blacklist.length ? filter.blacklist.map((w) => `「${w}」`).join(" ") : "（无）";
  const wl = filter.whitelist.patterns.length
    ? filter.whitelist.patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")
    : "（无）";
  const ads = filter.ads ? `已开启（按钮、隐藏链接、自定义表情≥${CUSTOM_EMOJI_AD_THRESHOLD}）` : "关闭";
  return `类型：${types}\n广告过滤：${ads}\n黑名单：${bl}\n白名单：${filter.whitelist.enabled ? "已启用" : "未启用"}\n${wl}`;
}

// ════════════════════════════════════════════════════════════════════════════
// 链接、目标与参数解析
// ════════════════════════════════════════════════════════════════════════════

export interface MessageLink {
  /** 规范化的会话引用：公开用户名为 "@name"，私有会话为带标记的 "-100…" ID。 */
  chatRef: string;
  messageId: number;
  raw: string;
}

/** 解析 t.me 消息链接，支持公开、私有（/c/）与话题内消息链接；评论链接明确拒绝。 */
export function parseMessageLink(raw: string): MessageLink | { error: string } | null {
  const text = raw.trim();
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(.+)$/i.exec(text);
  if (!m) return null;
  const [pathPart, query = ""] = m[1].split("?", 2);
  if (/(^|&)(comment|thread)=/i.test(query)) {
    return { error: `暂不支持评论区消息链接：${raw}` };
  }
  const segs = pathPart.split("/").filter(Boolean);
  if (segs[0] === "c") {
    if (segs.length < 3 || segs.length > 4) return { error: `无法识别的私有消息链接：${raw}` };
    // /c/ 链接中的是内部 ID；只去掉显式写出的 "-100" 标记，不能误删以 100 开头的真实 ID。
    const internal = segs[1].replace(/^-100/, "");
    const id = Number(segs[segs.length - 1]);
    if (!/^\d+$/.test(internal) || !Number.isSafeInteger(id) || id <= 0) {
      return { error: `无法识别的私有消息链接：${raw}` };
    }
    return { chatRef: `-100${internal}`, messageId: id, raw };
  }
  if (segs.length < 2 || segs.length > 3) return { error: `无法识别的消息链接：${raw}` };
  if (["s", "joinchat", "+", "addstickers", "addemoji", "share"].includes(segs[0]) || segs[0].startsWith("+")) {
    return { error: `这不是消息链接：${raw}` };
  }
  const id = Number(segs[segs.length - 1]);
  if (!/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(segs[0]) || !Number.isSafeInteger(id) || id <= 0) {
    return { error: `无法识别的消息链接：${raw}` };
  }
  return { chatRef: `@${segs[0]}`, messageId: id, raw };
}

export function looksLikeLink(token: string): boolean {
  return /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(token);
}

/** 目标引用：本地归档、收藏夹、当前会话或某个会话（可带话题 ID）。 */
export type TargetSpec =
  | { kind: "local" }
  | { kind: "peer"; ref: string; topicId?: number };

/** 解析目标参数：me / local / here / @username / t.me 链接 / 数字 ID，可附加 “|话题ID”。 */
export function parseTargetSpec(raw: string, currentChatId?: string): TargetSpec | { error: string } {
  const value = raw.trim();
  if (!value) return { error: "目标不能为空" };
  if (/^local$/i.test(value)) return { kind: "local" };
  const [base, topicRaw] = value.split("|", 2);
  let topicId: number | undefined;
  if (topicRaw !== undefined) {
    topicId = Number(topicRaw);
    if (!Number.isSafeInteger(topicId) || topicId <= 0) return { error: `话题 ID 无效：${topicRaw}` };
  }
  let ref: string;
  if (/^me$/i.test(base)) ref = "me";
  else if (/^here$/i.test(base)) {
    if (!currentChatId) return { error: "无法确定当前会话" };
    ref = currentChatId;
  } else if (/^-?\d+$/.test(base)) ref = base;
  else if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(base)) ref = base;
  else if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(base)) ref = `@${base}`;
  else {
    const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(c\/)?([A-Za-z0-9_]+)\/?$/i.exec(base);
    if (!m) return { error: `无法识别的目标：${raw}` };
    ref = m[1] ? `-100${m[2].replace(/^-100/, "")}` : `@${m[2]}`;
  }
  return { kind: "peer", ref, topicId };
}

/** 生成可点击的来源消息链接；私有频道使用 /c/ 内部 ID（不带 -100 与负号）。 */
export function messageLink(chatId: string, messageId: number, username?: string): string {
  if (username) return `https://t.me/${username}/${messageId}`;
  const internal = chatId.startsWith("-100") ? chatId.slice(4) : chatId.replace(/^-/, "");
  return `https://t.me/c/${internal}/${messageId}`;
}

function parseIdList(raw: string): number[] | null {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!ids.length || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) return null;
  return Array.from(new Set(ids));
}

function compactRanges(ids: number[]): Array<[number, number]> {
  const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const id of sorted) {
    const last = out[out.length - 1];
    if (last && id === last[1] + 1) last[1] = id;
    else out.push([id, id]);
  }
  return out;
}

function sanitizeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 0; i < 10_000; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${stem}_${i}${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}_${randomBytes(4).toString("hex")}${ext}`);
}

function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "未知大小";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ════════════════════════════════════════════════════════════════════════════
// 持久化（lowdb）
// ════════════════════════════════════════════════════════════════════════════

export interface PeerTarget {
  peerId: string;
  title: string;
  topicId?: number;
  isSelf?: boolean;
}

/** 投递方式：本地中转（下载后重新上传，保留来源封面）或原生转发。 */
export type DeliveryMode = "relay" | "forward";

/** 规则的投递选项；缺省值由 deliveryOf 统一给出。 */
export interface DeliveryOptions {
  /** 投递方式，默认本地中转。 */
  mode?: DeliveryMode;
  /** 原生转发时隐藏“转发自”。 */
  hideAuthor?: boolean;
  /** 静音发送。 */
  silent?: boolean;
  /** 来源编辑后再保存一份新版（默认关闭）。 */
  handleEdited?: boolean;
}

export function deliveryOf(o: DeliveryOptions): Required<DeliveryOptions> {
  return {
    mode: o.mode ?? "relay",
    hideAuthor: Boolean(o.hideAuthor),
    silent: Boolean(o.silent),
    handleEdited: Boolean(o.handleEdited),
  };
}

export interface RuleRecord extends DeliveryOptions {
  id: number;
  sourceChatId: string;
  sourceTitle: string;
  target: PeerTarget;
  enabled: boolean;
  filter: FilterConfig;
  createdAt: number;
  updatedAt: number;
  /** 最后收到的来源新消息（在线监视心跳；持久化按分钟节流，停止时补写最新值）。 */
  lastSeen?: RuleMark;
  /** 最后一次成功保存（监视或补漏）。 */
  lastSaved?: RuleMark;
}

/** 某个时刻对应的来源消息。 */
export interface RuleMark {
  at: number;
  messageId: number;
}

/** 一次保存所依据的配置快照：来自监视规则或整个历史备份。 */
export interface SaveSpec {
  ruleId: number;
  jobId?: number;
  sourceChatId: string;
  sourceTitle: string;
  target: PeerTarget;
  filter: FilterConfig;
  mode: DeliveryMode;
  hideAuthor: boolean;
  silent: boolean;
}

export function specFromRule(r: RuleRecord): SaveSpec {
  const { mode, hideAuthor, silent } = deliveryOf(r);
  return { ruleId: r.id, sourceChatId: r.sourceChatId, sourceTitle: r.sourceTitle, target: r.target, filter: r.filter, mode, hideAuthor, silent };
}

export type BackupStatus = "running" | "paused" | "planned" | "cancelled" | "error";

/** 整个历史备份：按页读取来源历史并为每个保存单位创建任务，游标持久化以便续传。 */
export interface BackupJob {
  id: number;
  sourceChatId: string;
  sourceTitle: string;
  target: PeerTarget;
  filter: FilterConfig;
  /** 过滤来源：沿用该来源的监视规则，或不过滤。 */
  filterFrom: "rule" | "none";
  order: "asc" | "desc";
  mode: DeliveryMode;
  hideAuthor: boolean;
  force: boolean;
  status: BackupStatus;
  /** 正序：已读到的最大消息 ID；倒序：下一页读取 ID 小于此值的消息（0 表示从最新开始）。 */
  cursor: number;
  counts: { scanned: number; queued: number; filtered: number; saved: number; claimed: number; attention: number; done: number };
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  lastError?: { message: string; at: number };
}

export type TaskStatus =
  | "queued"
  | "running"
  | "sending"
  | "retry_wait"
  | "needs_attention"
  | "uncertain"
  | "cleanup_pending"
  | "done"
  | "skipped"
  | "cancelled";

/** 仍占用“同一来源消息 → 同一目标”保存权的状态（用于在途协调）。 */
const CLAIMING_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "queued",
  "running",
  "sending",
  "retry_wait",
  "needs_attention",
  "uncertain",
]);

const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "skipped", "cancelled"]);

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "处理中",
  sending: "发送中",
  retry_wait: "等待重试",
  needs_attention: "待处理",
  uncertain: "结果不确定",
  cleanup_pending: "已成功·待清理",
  done: "已完成",
  skipped: "已跳过",
  cancelled: "已取消",
};

export interface EntityJson {
  c: string;
  [key: string]: string | number | boolean | undefined;
}

export interface AttributesJson {
  fileName?: string;
  video?: {
    duration: number;
    w: number;
    h: number;
    supportsStreaming?: boolean;
    roundMessage?: boolean;
    nosound?: boolean;
    preloadPrefixSize?: number;
    videoStartTs?: number;
    videoCodec?: string;
  };
  audio?: { duration: number; voice?: boolean; title?: string; performer?: string; waveform?: string };
  imageSize?: { w: number; h: number };
  animated?: boolean;
  sticker?: { alt: string };
}

export type CoverKind = "custom" | "thumb" | "stripped" | "none";

export interface StagedItem {
  messageId: number;
  kind: MediaKind;
  text: string;
  entities: EntityJson[];
  /** 纯文字消息没有媒体文件。 */
  mediaFile?: string;
  mimeType?: string;
  size?: number;
  attributes: AttributesJson;
  /** 视频封面来源：自定义封面 / 静态缩略图 / 仅模糊预览 / 无。 */
  coverKind?: CoverKind;
  /** 自定义视频封面图片（作为 videoCover 上传）。 */
  coverFile?: string;
  /** 文档静态缩略图（作为 thumb 上传）。 */
  thumbFile?: string;
  videoTimestamp?: number;
  spoiler?: boolean;
  webPreview?: boolean;
}

export interface TaskRecord {
  id: number;
  kind: "monitor" | "backfill" | "backup";
  ruleId: number;
  jobId?: number;
  mode?: DeliveryMode;
  hideAuthor?: boolean;
  silent?: boolean;
  /** 来源编辑版本（编辑时间）；用于“编辑后再存一份”的去重。 */
  editVersion?: number;
  /** 原生转发被来源保护拒绝后，改为本地中转。 */
  relayFallback?: boolean;
  accountId: string;
  sourceChatId: string;
  sourceTitle: string;
  target: PeerTarget;
  filter: FilterConfig;
  groupedId?: string;
  memberIds: number[];
  status: TaskStatus;
  force: boolean;
  allowNoCover: boolean;
  attempts: number;
  floodWaits: number;
  nextAttemptAt?: number;
  createdAt: number;
  updatedAt: number;
  lastError?: { code: string; message: string; at: number };
  stagingDir?: string;
  staged?: StagedItem[];
  sendStartedAt?: number;
  result?: { messageIds: number[]; confirmedAt: number; via: "response" | "check" | "manual" };
  warnings?: string[];
  cleanupAttempts?: number;
}

export interface SuccessRecord {
  taskId: number;
  targetMessageId?: number;
  at: number;
}

export interface SkipRecord {
  at: number;
  ruleId: number;
  jobId?: number;
  sourceChatId: string;
  messageIds: number[];
  reason: string;
}

export interface DbShape {
  version: number;
  accountId?: string;
  settings: { defaultTarget: string; showSource: boolean };
  rules: RuleRecord[];
  nextRuleId: number;
  tasks: TaskRecord[];
  nextTaskId: number;
  successes: Record<string, SuccessRecord>;
  recentSkips: SkipRecord[];
  hold: { reason: string; at: number } | null;
  /** 保存统计：日期 → 范围（rule:ID / backup:ID）→ 计数。 */
  stats: Record<string, Record<string, { units: number; messages: number }>>;
  backups: BackupJob[];
  nextBackupId: number;
}

function emptyDb(): DbShape {
  return {
    version: DB_VERSION,
    settings: { defaultTarget: "me", showSource: false },
    rules: [],
    nextRuleId: 1,
    tasks: [],
    nextTaskId: 1,
    successes: {},
    recentSkips: [],
    hold: null,
    stats: {},
    backups: [],
    nextBackupId: 1,
  };
}

function normalizeDb(raw: Partial<DbShape> | undefined): DbShape {
  const base = emptyDb();
  const d = { ...base, ...(raw || {}) } as DbShape;
  d.settings = { ...base.settings, ...(raw?.settings || {}) };
  d.rules = Array.isArray(d.rules) ? d.rules : [];
  d.tasks = Array.isArray(d.tasks) ? d.tasks : [];
  d.successes = d.successes && typeof d.successes === "object" ? d.successes : {};
  d.recentSkips = Array.isArray(d.recentSkips) ? d.recentSkips : [];
  d.hold = d.hold ?? null;
  d.stats = d.stats && typeof d.stats === "object" ? d.stats : {};
  d.backups = Array.isArray(d.backups) ? d.backups : [];
  d.nextBackupId = Math.max(d.nextBackupId || 1, ...d.backups.map((b) => b.id + 1), 1);
  for (const b of d.backups) {
    if (typeof b.counts.done !== "number") {
      b.counts.done = d.tasks.filter((t) => t.jobId === b.id && t.status === "done").length;
    }
  }
  d.nextRuleId = Math.max(d.nextRuleId || 1, ...d.rules.map((r) => r.id + 1), 1);
  d.nextTaskId = Math.max(d.nextTaskId || 1, ...d.tasks.map((t) => t.id + 1), 1);
  for (const r of d.rules) {
    r.filter = { ...defaultFilter(), ...(r.filter || {}) };
    const wl: Partial<FilterConfig["whitelist"]> = r.filter.whitelist || {};
    r.filter.whitelist = { enabled: Boolean(wl.enabled), patterns: Array.isArray(wl.patterns) ? wl.patterns : [] };
  }
  d.version = DB_VERSION;
  return d;
}

/** lowdb 存储：所有修改串行执行并立即写盘；写盘失败抛出 store_write，且关闭后拒绝写入。 */
export class Store {
  private readonly mutex = new Mutex();
  private closed = false;
  private constructor(private readonly db: { data: DbShape; write(): Promise<void> }) {}

  static async open(file: string): Promise<Store> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const db = await JSONFilePreset<DbShape>(file, emptyDb());
    db.data = normalizeDb(db.data);
    const store = new Store(db);
    await store.flush();
    return store;
  }

  get data(): DbShape {
    return this.db.data;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  update<T>(fn: (d: DbShape) => T): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) throw new SavePlusError("stopped", "存储已关闭");
      const result = fn(this.db.data);
      await this.writeNow();
      return result;
    });
  }

  flush(): Promise<void> {
    return this.mutex.run(async () => {
      if (this.closed) throw new SavePlusError("stopped", "存储已关闭");
      await this.writeNow();
    });
  }

  private async writeNow(): Promise<void> {
    try {
      await this.db.write();
    } catch (e) {
      throw new SavePlusError("store_write", `写入任务数据失败：${asError(e).message}`, { transient: true });
    }
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      this.closed = true;
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Telegram 适配层
// ════════════════════════════════════════════════════════════════════════════

export interface PeerInfo {
  peerId: string;
  title: string;
  kind: "self" | "user" | "group" | "channel";
  username?: string;
  canSend: boolean;
  sendBlockReason?: string;
  noforwards: boolean;
}

/** 与具体 SDK 无关的来源消息描述；raw 为适配层专用句柄。 */
export interface SourceMessage {
  chatId: string;
  id: number;
  date: number;
  /** 最后一次编辑时间（未编辑为 undefined）。 */
  editDate?: number;
  out: boolean;
  groupedId?: string;
  kind: MediaKind;
  text: string;
  entities: EntityJson[];
  fileName?: string;
  mimeType?: string;
  size?: number;
  /** 视频／动画的封面来源。 */
  cover?: CoverKind;
  /** 是否能下载后重新上传（投票、位置等特殊消息不能）。 */
  reuploadable: boolean;
  unsupportedReason?: string;
  webPreview: boolean;
  noforwards: boolean;
  /** 消息带按钮（用于广告过滤）。 */
  hasButtons: boolean;
  raw: unknown;
}

export interface SentResult {
  messageIds: number[];
  warnings: string[];
}

export interface SendOptions {
  topicId?: number;
  silent?: boolean;
}

/** 外部 Telegram 访问的唯一 seam：生产环境由 TeleprotoPort 实现，测试中可替换。 */
export interface TelegramPort {
  selfId(): Promise<string>;
  resolvePeer(ref: string): Promise<PeerInfo>;
  toSourceMessage(raw: unknown): SourceMessage | null;
  /** 只取消息所在会话 ID（用于在完整转换前快速判断是否有对应规则）。 */
  chatIdOf?(raw: unknown): string | null;
  getMessages(chatId: string, ids: number[]): Promise<Map<number, SourceMessage>>;
  forwardMessages(
    target: PeerTarget,
    sourceChatId: string,
    ids: number[],
    opts?: { dropAuthor?: boolean; silent?: boolean }
  ): Promise<number[]>;
  sendText(
    target: PeerTarget,
    text: string,
    entities: EntityJson[],
    opts?: { html?: boolean; replyTo?: number; linkPreview?: boolean; silent?: boolean }
  ): Promise<number>;
  /**
   * 按方向读取一页来源历史（含系统消息）。正序返回 ID 大于 afterId 的消息，倒序返回 ID 小于 beforeId 的消息
   * （beforeId 为 0 表示从最新开始）。rawIds 为本页全部原始消息（含系统消息）按读取顺序的 ID，为空表示没有更多消息。
   */
  getHistory(
    chatId: string,
    opts: { ascending: boolean; afterId?: number; beforeId?: number; limit: number }
  ): Promise<{ messages: SourceMessage[]; rawIds: number[] }>;
  /** 下载媒体（及封面／缩略图）到 dir，返回可持久化的中转清单项。 */
  stageMedia(message: SourceMessage, dir: string, signal?: AbortSignal): Promise<StagedItem>;
  /** 上传并发送中转内容；单条或整组相册，返回逐项确认的目标消息 ID。 */
  sendStaged(target: PeerTarget, items: StagedItem[], opts?: SendOptions): Promise<SentResult>;
  /** 读取目标中自己最近发送的消息，用于核对结果不确定的任务。 */
  findRecentOwn(target: PeerTarget, sinceUnix: number, limit: number): Promise<SourceMessage[]>;
}

type Phase = "read" | "prepare" | "send";

const PERMISSION_ERRORS =
  /^(CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHAT_SEND_[A-Z_]*FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_RESTRICTED|CHAT_GUEST_SEND_FORBIDDEN|USER_IS_BLOCKED|USER_PRIVACY_RESTRICTED|PEER_ID_INVALID|CHANNEL_INVALID|CHAT_ID_INVALID|INPUT_USER_DEACTIVATED|USER_DEACTIVATED|RIGHT_FORBIDDEN|TOPIC_CLOSED|TOPIC_DELETED|CHANNEL_PUBLIC_GROUP_NA|CHAT_FORBIDDEN|USER_NOT_PARTICIPANT|SEND_AS_PEER_INVALID|PREMIUM_ACCOUNT_REQUIRED|ALLOW_PAYMENT_REQUIRED)/;

/** 把 SDK、网络与文件系统错误归一化为 SavePlusError。phase 为 send 时网络类错误视为“可能已发送”。 */
export function classifyError(e: unknown, phase: Phase): SavePlusError {
  if (e instanceof SavePlusError) return e;
  const err = e as { code?: unknown; errorMessage?: unknown; seconds?: unknown; message?: unknown };
  if (err && (err.code === "ENOSPC" || err.code === "EDQUOT")) {
    return new SavePlusError("disk_full", "磁盘空间不足");
  }
  if (e instanceof tgErrors.FloodWaitError || e instanceof tgErrors.SlowModeWaitError) {
    return new SavePlusError("flood", errorText(e), { transient: true, seconds: Number((e as { seconds: number }).seconds) || 1 });
  }
  const rpcName = typeof err?.errorMessage === "string" ? err.errorMessage : "";
  if (rpcName) {
    const waitMatch = /^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT|FLOOD_TEST_PHONE_WAIT)_(\d+)/.exec(rpcName);
    if (waitMatch || (typeof err.seconds === "number" && /FLOOD|SLOWMODE/.test(rpcName))) {
      const seconds = waitMatch ? Number(waitMatch[1]) : Number(err.seconds);
      return new SavePlusError("flood", rpcName, { transient: true, seconds: seconds || 1 });
    }
    if (rpcName === "CHAT_FORWARDS_RESTRICTED") {
      return new SavePlusError("forward_restricted", "来源禁止转发（受保护内容）");
    }
    if (/^FILE_REFERENCE_/.test(rpcName)) {
      return new SavePlusError("file_reference", "媒体文件引用已过期，需要重新读取来源消息", { transient: true });
    }
    if (PERMISSION_ERRORS.test(rpcName)) {
      return new SavePlusError("permission", `没有访问或发送权限（${rpcName}）`);
    }
    if (/^(MESSAGE_ID_INVALID|MSG_ID_INVALID|MESSAGE_IDS_EMPTY)/.test(rpcName)) {
      return new SavePlusError("not_found", `来源消息不存在（${rpcName}）`);
    }
    const code = typeof err.code === "number" ? err.code : 0;
    if (code >= 500 || code === -503 || /TIMEOUT|INTERNAL|RPC_CALL_FAIL|RPC_MCGET_FAIL|WORKER_BUSY/.test(rpcName)) {
      if (phase === "send") {
        return new SavePlusError("uncertain", `服务器返回内部错误，无法确认是否已发送（${rpcName}）`, { maybeSent: true });
      }
      return new SavePlusError("network", `服务器暂时不可用（${rpcName}）`, { transient: true });
    }
    return new SavePlusError("rpc", `Telegram 拒绝请求：${rpcName}`);
  }
  const text = errorText(e);
  if (phase === "send") {
    return new SavePlusError("uncertain", `发送过程中断，无法确认是否已发送：${text}`, { maybeSent: true });
  }
  return new SavePlusError("network", `网络或客户端错误：${text}`, { transient: true });
}

function bigToString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

export function entitiesToJson(list: unknown): EntityJson[] {
  if (!Array.isArray(list)) return [];
  const out: EntityJson[] = [];
  for (const e of list) {
    const ent = e as { className?: string; offset?: number; length?: number } & Record<string, unknown>;
    if (!ent?.className || typeof ent.offset !== "number" || typeof ent.length !== "number") continue;
    if (ent.className === "MessageEntityMentionName" || ent.className === "InputMessageEntityMentionName") {
      // 需要对方的 InputUser 才能重建，降级为纯文字。
      continue;
    }
    const json: EntityJson = { c: ent.className, offset: ent.offset, length: ent.length };
    for (const key of ["url", "language", "collapsed"] as const) {
      const v = ent[key];
      if (typeof v === "string" || typeof v === "boolean") json[key] = v;
    }
    const doc = bigToString(ent.documentId);
    if (doc) json.documentId = doc;
    out.push(json);
  }
  return out;
}

export function entitiesFromJson(list: EntityJson[] | undefined): Api.TypeMessageEntity[] {
  const out: Api.TypeMessageEntity[] = [];
  for (const e of list || []) {
    const Ctor = (Api as unknown as Record<string, new (args: Record<string, unknown>) => Api.TypeMessageEntity>)[e.c];
    if (typeof Ctor !== "function" || !e.c.startsWith("MessageEntity")) continue;
    const args: Record<string, unknown> = { offset: e.offset, length: e.length };
    if (e.url !== undefined) args.url = e.url;
    if (e.language !== undefined) args.language = e.language;
    if (e.collapsed !== undefined) args.collapsed = e.collapsed;
    if (e.documentId !== undefined) args.documentId = tgHelpers.returnBigInt(String(e.documentId));
    try {
      out.push(new Ctor(args));
    } catch {
      /* 跳过无法重建的实体 */
    }
  }
  return out;
}

function attributesToJson(attrs: Api.TypeDocumentAttribute[] | undefined): AttributesJson {
  const out: AttributesJson = {};
  for (const a of attrs || []) {
    if (a instanceof Api.DocumentAttributeFilename) out.fileName = a.fileName;
    else if (a instanceof Api.DocumentAttributeVideo) {
      out.video = {
        duration: a.duration,
        w: a.w,
        h: a.h,
        supportsStreaming: a.supportsStreaming || undefined,
        roundMessage: a.roundMessage || undefined,
        nosound: a.nosound || undefined,
        preloadPrefixSize: a.preloadPrefixSize,
        videoStartTs: a.videoStartTs,
        videoCodec: a.videoCodec,
      };
    } else if (a instanceof Api.DocumentAttributeAudio) {
      out.audio = {
        duration: a.duration,
        voice: a.voice || undefined,
        title: a.title,
        performer: a.performer,
        waveform: a.waveform ? Buffer.from(a.waveform).toString("base64") : undefined,
      };
    } else if (a instanceof Api.DocumentAttributeImageSize) out.imageSize = { w: a.w, h: a.h };
    else if (a instanceof Api.DocumentAttributeAnimated) out.animated = true;
    else if (a instanceof Api.DocumentAttributeSticker) out.sticker = { alt: a.alt };
  }
  return out;
}

export function attributesFromJson(json: AttributesJson): Api.TypeDocumentAttribute[] {
  const out: Api.TypeDocumentAttribute[] = [];
  if (json.fileName) out.push(new Api.DocumentAttributeFilename({ fileName: json.fileName }));
  if (json.video) {
    out.push(
      new Api.DocumentAttributeVideo({
        duration: json.video.duration,
        w: json.video.w,
        h: json.video.h,
        supportsStreaming: json.video.supportsStreaming,
        roundMessage: json.video.roundMessage,
        nosound: json.video.nosound,
        preloadPrefixSize: json.video.preloadPrefixSize,
        videoStartTs: json.video.videoStartTs,
        videoCodec: json.video.videoCodec,
      })
    );
  }
  if (json.audio) {
    out.push(
      new Api.DocumentAttributeAudio({
        duration: json.audio.duration,
        voice: json.audio.voice,
        title: json.audio.title,
        performer: json.audio.performer,
        waveform: json.audio.waveform ? Buffer.from(json.audio.waveform, "base64") : undefined,
      })
    );
  }
  if (json.imageSize) out.push(new Api.DocumentAttributeImageSize(json.imageSize));
  if (json.animated) out.push(new Api.DocumentAttributeAnimated());
  if (json.sticker) {
    out.push(new Api.DocumentAttributeSticker({ alt: json.sticker.alt, stickerset: new Api.InputStickerSetEmpty() }));
  }
  return out;
}

type StaticSize = Api.PhotoSize | Api.PhotoSizeProgressive | Api.PhotoCachedSize;

/** 选择分辨率最高的静态尺寸；模糊预览（stripped）与路径轮廓不算可用封面。 */
function bestStaticSize(sizes: Api.TypePhotoSize[] | undefined): StaticSize | undefined {
  let best: StaticSize | undefined;
  for (const s of sizes || []) {
    if (!(s instanceof Api.PhotoSize || s instanceof Api.PhotoSizeProgressive || s instanceof Api.PhotoCachedSize)) {
      continue;
    }
    if (!best || s.w * s.h > best.w * best.h) best = s;
  }
  return best;
}

function hasStrippedOnly(sizes: Api.TypePhotoSize[] | undefined): boolean {
  return (sizes || []).some((s) => s instanceof Api.PhotoStrippedSize) && !bestStaticSize(sizes);
}

function sizeBytes(s: StaticSize): number {
  if (s instanceof Api.PhotoSizeProgressive) return Math.max(...s.sizes);
  if (s instanceof Api.PhotoCachedSize) return s.bytes.length;
  return s.size;
}

function classifyDocument(doc: Api.Document): MediaKind {
  const attrs = doc.attributes || [];
  if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) return "sticker";
  if (attrs.some((a) => a instanceof Api.DocumentAttributeAnimated)) return "animation";
  if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo)) return "video";
  const audio = attrs.find((a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio);
  if (audio) return audio.voice ? "voice" : "audio";
  return "document";
}

const MIME_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "image/webp": ".webp",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "application/x-tgsticker": ".tgs",
};

function isJpeg(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(3);
      fs.readSync(fd, buf, 0, 3, 0);
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 基于 teleproto 的生产适配层。 */
export class TeleprotoPort implements TelegramPort {
  private warmed = false;
  constructor(private readonly client: TelegramClient) {}

  async selfId(): Promise<string> {
    try {
      const me = await this.client.getMe();
      return me.id.toString();
    } catch (e) {
      throw classifyError(e, "read");
    }
  }

  private async entity(ref: string): Promise<Api.TypeUser | Api.TypeChat> {
    const query = /^-?\d+$/.test(ref) ? tgHelpers.returnBigInt(ref) : ref;
    try {
      return (await this.client.getEntity(query as never)) as Api.TypeUser | Api.TypeChat;
    } catch (first) {
      if (typeof query !== "string" && !this.warmed) {
        // 数字 ID 依赖会话实体缓存；预热一次对话列表后重试。
        this.warmed = true;
        try {
          await this.client.getDialogs({ limit: 200 });
          return (await this.client.getEntity(query as never)) as Api.TypeUser | Api.TypeChat;
        } catch (second) {
          throw this.entityError(ref, second);
        }
      }
      throw this.entityError(ref, first);
    }
  }

  private entityError(ref: string, e: unknown): SavePlusError {
    const c = classifyError(e, "read");
    if (c.code === "network" && /Could not find|Cannot find any entity|No user has|Invalid object/i.test(errorText(e))) {
      return new SavePlusError("not_found", `找不到会话 ${ref}（账号未加入或 ID 无效）`);
    }
    return c;
  }

  async resolvePeer(ref: string): Promise<PeerInfo> {
    const e = await this.entity(ref);
    const peerId = tgUtils.getPeerId(e as never);
    if (e instanceof Api.User) {
      const title = [e.firstName, e.lastName].filter(Boolean).join(" ") || e.username || peerId;
      return {
        peerId,
        title: e.self ? "收藏夹" : title,
        kind: e.self ? "self" : "user",
        username: e.username,
        canSend: !e.deleted,
        sendBlockReason: e.deleted ? "该账号已注销" : undefined,
        noforwards: false,
      };
    }
    if (e instanceof Api.Chat) {
      let reason: string | undefined;
      const privileged = Boolean(e.creator || e.adminRights);
      if (e.deactivated) reason = "群组已停用";
      else if (e.left) reason = "账号已退出该群组";
      else if (!privileged && (e.defaultBannedRights?.sendMessages || e.defaultBannedRights?.sendMedia)) {
        reason = "群组禁止成员发送消息或媒体";
      }
      return { peerId, title: e.title, kind: "group", canSend: !reason, sendBlockReason: reason, noforwards: Boolean(e.noforwards) };
    }
    if (e instanceof Api.Channel) {
      let reason: string | undefined;
      const privileged = Boolean(e.creator || e.adminRights);
      if (e.broadcast) {
        if (!(e.creator || e.adminRights?.postMessages)) reason = "账号不是该频道可发帖的管理员";
      } else if (e.left) reason = "账号未加入该群组";
      else if (e.bannedRights?.sendMessages || e.bannedRights?.sendMedia || e.bannedRights?.viewMessages) {
        reason = "账号在该群组被限制发送";
      } else if (!privileged && (e.defaultBannedRights?.sendMessages || e.defaultBannedRights?.sendMedia)) {
        reason = "群组禁止成员发送消息或媒体";
      }
      return {
        peerId,
        title: e.title,
        kind: e.broadcast ? "channel" : "group",
        username: e.username,
        canSend: !reason,
        sendBlockReason: reason,
        noforwards: Boolean(e.noforwards),
      };
    }
    const title = (e as { title?: string }).title || peerId;
    return { peerId, title, kind: "group", canSend: false, sendBlockReason: "会话不可访问", noforwards: false };
  }

  chatIdOf(raw: unknown): string | null {
    if (!(raw instanceof Api.Message)) return null;
    return raw.chatId?.toString() ?? tgUtils.getPeerId(raw.peerId as never);
  }

  toSourceMessage(raw: unknown): SourceMessage | null {
    if (!(raw instanceof Api.Message)) return null;
    const m = raw;
    const chatId = m.chatId?.toString() ?? tgUtils.getPeerId(m.peerId as never);
    const base: SourceMessage = {
      chatId,
      id: m.id,
      date: m.date,
      editDate: m.editDate || undefined,
      out: Boolean(m.out),
      groupedId: m.groupedId ? m.groupedId.toString() : undefined,
      kind: "text",
      text: m.message || "",
      entities: entitiesToJson(m.entities),
      reuploadable: true,
      webPreview: false,
      noforwards: Boolean(m.noforwards),
      hasButtons: Boolean(m.replyMarkup),
      raw: m,
    };
    const media = m.media;
    if (!media || media instanceof Api.MessageMediaEmpty) {
      if (!base.text) {
        base.kind = "other";
        base.reuploadable = false;
        base.unsupportedReason = "空消息";
      }
      return base;
    }
    if (media instanceof Api.MessageMediaWebPage) {
      base.webPreview = true;
      return base;
    }
    if (media instanceof Api.MessageMediaPhoto) {
      if (media.photo instanceof Api.Photo) {
        const best = bestStaticSize(media.photo.sizes);
        return { ...base, kind: "photo", mimeType: "image/jpeg", size: best ? sizeBytes(best) : undefined };
      }
      return { ...base, kind: "other", reuploadable: false, unsupportedReason: "图片已过期或不可用" };
    }
    if (media instanceof Api.MessageMediaDocument) {
      const doc = media.document;
      if (!(doc instanceof Api.Document)) {
        return { ...base, kind: "other", reuploadable: false, unsupportedReason: "文件已过期或不可用" };
      }
      const kind = classifyDocument(doc);
      const attrs = attributesToJson(doc.attributes);
      const msg: SourceMessage = {
        ...base,
        kind,
        fileName: attrs.fileName,
        mimeType: doc.mimeType,
        size: Number(doc.size),
      };
      if (kind === "video" || kind === "animation") {
        if (media.videoCover instanceof Api.Photo) msg.cover = "custom";
        else if (bestStaticSize(doc.thumbs)) msg.cover = "thumb";
        else if (hasStrippedOnly(doc.thumbs)) msg.cover = "stripped";
        else msg.cover = "none";
      }
      return msg;
    }
    const name = (media as { className?: string }).className || "未知";
    return { ...base, kind: "other", reuploadable: false, unsupportedReason: `不支持重新上传的消息类型（${name}）` };
  }

  async getMessages(chatId: string, ids: number[]): Promise<Map<number, SourceMessage>> {
    const out = new Map<number, SourceMessage>();
    if (!ids.length) return out;
    const entity = await this.entity(chatId);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      let list: unknown[];
      try {
        list = await this.client.getMessages(entity as never, { ids: chunk });
      } catch (e) {
        throw classifyError(e, "read");
      }
      for (const item of list) {
        const msg = this.toSourceMessage(item);
        if (msg) out.set(msg.id, msg);
      }
    }
    return out;
  }

  private replyFor(target: PeerTarget, replyTo?: number): Api.TypeInputReplyTo | undefined {
    if (!target.topicId && !replyTo) return undefined;
    return new Api.InputReplyToMessage({
      replyToMsgId: replyTo ?? (target.topicId as number),
      topMsgId: target.topicId,
    });
  }

  async forwardMessages(
    target: PeerTarget,
    sourceChatId: string,
    ids: number[],
    opts: { dropAuthor?: boolean; silent?: boolean } = {}
  ): Promise<number[]> {
    const to = await this.entity(target.peerId);
    const from = await this.entity(sourceChatId);
    try {
      const res = await this.client.forwardMessages(to as never, {
        messages: ids,
        fromPeer: from as never,
        dropAuthor: opts.dropAuthor,
        silent: opts.silent,
        topMsgId: target.topicId,
      });
      const outIds = (res || []).filter(Boolean).map((m) => m.id);
      if (outIds.length !== ids.length) {
        throw new SavePlusError("uncertain", `转发结果无法逐条确认（${outIds.length}/${ids.length}）`, { maybeSent: true });
      }
      return outIds;
    } catch (e) {
      throw classifyError(e, "send");
    }
  }

  async sendText(
    target: PeerTarget,
    text: string,
    entities: EntityJson[],
    opts: { html?: boolean; replyTo?: number; linkPreview?: boolean; silent?: boolean } = {}
  ): Promise<number> {
    const to = await this.entity(target.peerId);
    try {
      const sent = await this.client.sendMessage(to as never, {
        message: text,
        parseMode: opts.html ? "html" : undefined,
        formattingEntities: opts.html ? undefined : entitiesFromJson(entities),
        linkPreview: opts.linkPreview ?? true,
        replyTo: this.replyFor(target, opts.replyTo),
        silent: opts.silent,
      });
      if (!sent || typeof sent.id !== "number") {
        throw new SavePlusError("uncertain", "发送结果缺少消息 ID", { maybeSent: true });
      }
      return sent.id;
    } catch (e) {
      throw classifyError(e, "send");
    }
  }

  private async downloadPhotoSize(photo: Api.Photo, file: string, signal?: AbortSignal): Promise<boolean> {
    const size = bestStaticSize(photo.sizes);
    if (!size) return false;
    if (size instanceof Api.PhotoCachedSize) {
      await fsp.writeFile(file, Buffer.from(size.bytes));
    } else {
      await this.client.downloadFile(
        new Api.InputPhotoFileLocation({
          id: photo.id,
          accessHash: photo.accessHash,
          fileReference: photo.fileReference,
          thumbSize: size.type,
        }),
        { outputFile: file, fileSize: tgHelpers.returnBigInt(sizeBytes(size)), dcId: photo.dcId, signal }
      );
    }
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  }

  private async downloadDocThumb(doc: Api.Document, file: string, signal?: AbortSignal): Promise<boolean> {
    const size = bestStaticSize(doc.thumbs);
    if (!size) return false;
    if (size instanceof Api.PhotoCachedSize) {
      await fsp.writeFile(file, Buffer.from(size.bytes));
    } else {
      await this.client.downloadFile(
        new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: size.type,
        }),
        { outputFile: file, fileSize: tgHelpers.returnBigInt(sizeBytes(size)), dcId: doc.dcId, signal }
      );
    }
    return fs.existsSync(file) && fs.statSync(file).size > 0 && isJpeg(file);
  }

  async stageMedia(message: SourceMessage, dir: string, signal?: AbortSignal): Promise<StagedItem> {
    const raw = message.raw;
    const item: StagedItem = {
      messageId: message.id,
      kind: message.kind,
      text: message.text,
      entities: message.entities,
      attributes: {},
      webPreview: message.webPreview || undefined,
    };
    if (message.kind === "text") return item;
    if (!message.reuploadable || !(raw instanceof Api.Message)) {
      throw new SavePlusError("unsupported", message.unsupportedReason || "该消息不能重新上传");
    }
    await fsp.mkdir(dir, { recursive: true });
    const media = raw.media;
    try {
      if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
        const file = path.join(dir, `m${message.id}_photo.jpg`);
        const ok = await this.downloadPhotoSize(media.photo, file, signal);
        if (!ok) throw new SavePlusError("network", "图片下载结果为空", { transient: true });
        item.mediaFile = file;
        item.mimeType = "image/jpeg";
        item.size = fs.statSync(file).size;
        item.spoiler = media.spoiler || undefined;
        return item;
      }
      if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
        throw new SavePlusError("unsupported", "该消息不包含可下载的媒体");
      }
      const doc = media.document;
      const attrs = attributesToJson(doc.attributes);
      const ext = path.extname(attrs.fileName || "") || MIME_EXT[doc.mimeType] || ".bin";
      const name = sanitizeFileName(attrs.fileName || `${message.kind}${ext}`, `${message.kind}${ext}`);
      const file = path.join(dir, `m${message.id}_${name}`);
      const expected = Number(doc.size);
      await this.resumableDownload(raw, file, expected, signal);
      const actual = fs.statSync(file).size;
      item.mediaFile = file;
      item.mimeType = doc.mimeType;
      item.size = actual;
      item.attributes = attrs;
      item.spoiler = media.spoiler || undefined;
      const thumbFile = path.join(dir, `t${message.id}.jpg`);
      if (await this.downloadDocThumb(doc, thumbFile, signal)) item.thumbFile = thumbFile;
      if (message.kind === "video" || message.kind === "animation") {
        if (media.videoCover instanceof Api.Photo) {
          const coverFile = path.join(dir, `c${message.id}.jpg`);
          if (await this.downloadPhotoSize(media.videoCover, coverFile, signal)) {
            item.coverKind = "custom";
            item.coverFile = coverFile;
            item.videoTimestamp = media.videoTimestamp;
          } else {
            item.coverKind = "stripped";
          }
        } else if (item.thumbFile) item.coverKind = "thumb";
        else item.coverKind = hasStrippedOnly(doc.thumbs) ? "stripped" : "none";
      }
      return item;
    } catch (e) {
      throw classifyError(e, "read");
    }
  }

  /** 分段下载的块大小（服务器上限 1 MB，须为 4096 的倍数）。 */
  static readonly DOWNLOAD_CHUNK = 1024 * 1024;

  /**
   * 可续传下载：先写入 “文件名.part”，按整块继续上次的进度；下载完整后改名为正式文件。
   * 失败时保留 .part（位于任务中转目录内），下一次重试或重启后从断点继续。
   */
  private async resumableDownload(raw: Api.Message, file: string, expected: number, signal?: AbortSignal): Promise<void> {
    const known = Number.isFinite(expected) && expected > 0;
    if (known && fs.existsSync(file) && fs.statSync(file).size === expected) return;
    const chunk = TeleprotoPort.DOWNLOAD_CHUNK;
    const part = `${file}.part`;
    let offset = 0;
    if (fs.existsSync(part)) {
      const have = fs.statSync(part).size;
      offset = Math.floor(have / chunk) * chunk;
      if (known && offset > expected) offset = 0;
      if (offset !== have) await fsp.truncate(part, offset);
    }
    const handle = await fsp.open(part, offset > 0 ? "r+" : "w");
    let pos = offset;
    try {
      for await (const bytes of this.client.iterDownload(raw, {
        offset: tgHelpers.returnBigInt(offset),
        requestSize: chunk,
        signal,
      })) {
        await handle.write(bytes, 0, bytes.length, pos);
        pos += bytes.length;
      }
    } catch (e) {
      const c = classifyError(e, "read");
      const progress = known ? `已下载 ${formatBytes(pos)}／${formatBytes(expected)}` : `已下载 ${formatBytes(pos)}`;
      throw new SavePlusError(c.code, `${c.message}（${progress}，重试时从断点继续）`, {
        transient: c.transient,
        seconds: c.seconds,
      });
    } finally {
      await handle.close();
    }
    if (known && pos !== expected) {
      throw new SavePlusError("network", `媒体下载不完整（${pos}/${expected} 字节），重试时从断点继续`, { transient: true });
    }
    await fsp.rename(part, file);
  }

  private async uploadLocal(file: string, workers = 4): Promise<Api.TypeInputFile> {
    const stat = fs.statSync(file);
    return this.client.uploadFile({ file: new CustomFile(path.basename(file), stat.size, file), workers });
  }

  private async uploadCover(peer: Api.TypeInputPeer, file: string): Promise<Api.TypeInputPhoto> {
    const uploaded = await this.uploadLocal(file, 1);
    const media = await this.client.invoke(
      new Api.messages.UploadMedia({ peer, media: new Api.InputMediaUploadedPhoto({ file: uploaded }) })
    );
    if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
      return tgUtils.getInputPhoto(media.photo);
    }
    throw new SavePlusError("cover_unavailable", "封面图片上传后未得到可用图片");
  }

  /** 构造上传媒体：保留视频属性、静态缩略图与自定义封面（逐项独立，不共用）。 */
  private async buildUploaded(
    peer: Api.TypeInputPeer,
    it: StagedItem
  ): Promise<{ media: Api.TypeInputMedia; cover?: Api.TypeInputPhoto }> {
    if (!it.mediaFile) throw new SavePlusError("internal", "中转清单缺少媒体文件");
    const file = await this.uploadLocal(it.mediaFile);
    if (it.kind === "photo") {
      return { media: new Api.InputMediaUploadedPhoto({ file, spoiler: it.spoiler }) };
    }
    const thumb = it.thumbFile && fs.existsSync(it.thumbFile) ? await this.uploadLocal(it.thumbFile, 1) : undefined;
    const cover = it.coverKind === "custom" && it.coverFile ? await this.uploadCover(peer, it.coverFile) : undefined;
    const attributes = attributesFromJson(it.attributes);
    if (!it.attributes.fileName) {
      attributes.push(new Api.DocumentAttributeFilename({ fileName: path.basename(it.mediaFile).replace(/^m\d+_/, "") }));
    }
    const media = new Api.InputMediaUploadedDocument({
      file,
      thumb,
      mimeType: it.mimeType || "application/octet-stream",
      attributes,
      forceFile: it.kind === "document" ? true : undefined,
      nosoundVideo: it.kind === "video" && it.attributes.video?.nosound ? true : undefined,
      spoiler: it.spoiler,
      videoCover: cover,
      videoTimestamp: cover ? it.videoTimestamp : undefined,
    });
    return { media, cover };
  }

  private extractSent(res: unknown, randomIds: Api.long[]): { ids: number[]; messages: Map<number, Api.Message> } {
    const messages = new Map<number, Api.Message>();
    if (res instanceof Api.UpdateShortSentMessage && randomIds.length === 1) {
      return { ids: [res.id], messages };
    }
    const updates: unknown[] =
      res instanceof Api.Updates || res instanceof Api.UpdatesCombined
        ? res.updates
        : res instanceof Api.UpdateShort
          ? [res.update]
          : [];
    const byRandom = new Map<string, number>();
    for (const u of updates) {
      if (u instanceof Api.UpdateMessageID && u.randomId !== undefined) byRandom.set(u.randomId.toString(), u.id);
      if ((u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) && u.message instanceof Api.Message) {
        messages.set(u.message.id, u.message);
      }
    }
    const ids = randomIds.map((r) => byRandom.get(r.toString()));
    if (ids.some((id) => id === undefined)) {
      throw new SavePlusError("uncertain", "服务器响应中无法逐项确认已发送的消息", { maybeSent: true });
    }
    return { ids: ids as number[], messages };
  }

  private verifyCovers(items: StagedItem[], ids: number[], messages: Map<number, Api.Message>): string[] {
    const warnings: string[] = [];
    items.forEach((it, i) => {
      const sent = messages.get(ids[i]);
      if (!sent || !(it.kind === "video" || it.kind === "animation")) return;
      const media = sent.media;
      if (!(media instanceof Api.MessageMediaDocument)) return;
      if (it.coverKind === "custom" && !(media.videoCover instanceof Api.Photo)) {
        warnings.push(`消息 ${ids[i]} 的响应中未包含自定义封面，请在客户端核对封面`);
      }
      if (it.coverKind === "thumb" && media.document instanceof Api.Document && !bestStaticSize(media.document.thumbs)) {
        warnings.push(`消息 ${ids[i]} 的响应中未包含缩略图，请在客户端核对封面`);
      }
    });
    return warnings;
  }

  async sendStaged(target: PeerTarget, items: StagedItem[], opts: SendOptions = {}): Promise<SentResult> {
    if (!items.length) throw new SavePlusError("internal", "没有可发送的内容");
    const entity = await this.entity(target.peerId);
    let peer: Api.TypeInputPeer;
    try {
      peer = await this.client.getInputEntity(entity as never);
    } catch (e) {
      throw classifyError(e, "read");
    }
    const replyTo = this.replyFor(target);
    if (items.length === 1 && !items[0].mediaFile) {
      const id = await this.sendText(target, items[0].text, items[0].entities, {
        linkPreview: Boolean(items[0].webPreview),
        silent: opts.silent,
      });
      return { messageIds: [id], warnings: [] };
    }
    if (items.some((it) => !it.mediaFile)) {
      throw new SavePlusError("invalid", "相册中包含无法作为媒体发送的成员");
    }
    let prepared: Array<{ media: Api.TypeInputMedia; cover?: Api.TypeInputPhoto }>;
    try {
      prepared = [];
      for (const it of items) prepared.push(await this.buildUploaded(peer, it));
    } catch (e) {
      throw classifyError(e, "prepare");
    }
    if (items.length === 1) {
      const randomId = tgHelpers.generateRandomLong();
      let res: unknown;
      try {
        res = await this.client.invoke(
          new Api.messages.SendMedia({
            peer,
            media: prepared[0].media,
            message: items[0].text,
            entities: entitiesFromJson(items[0].entities),
            randomId,
            replyTo,
            silent: opts.silent,
          })
        );
      } catch (e) {
        throw classifyError(e, "send");
      }
      const { ids, messages } = this.extractSent(res, [randomId]);
      return { messageIds: ids, warnings: this.verifyCovers(items, ids, messages) };
    }
    // 相册：逐成员上传后转为已存在媒体，再一次性 SendMultiMedia，保证每个视频绑定自己的封面。
    const multi: Api.InputSingleMedia[] = [];
    const randomIds: Api.long[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const uploaded = await this.client.invoke(new Api.messages.UploadMedia({ peer, media: prepared[i].media }));
        let input: Api.TypeInputMedia;
        if (uploaded instanceof Api.MessageMediaPhoto && uploaded.photo instanceof Api.Photo) {
          input = new Api.InputMediaPhoto({ id: tgUtils.getInputPhoto(uploaded.photo), spoiler: it.spoiler });
        } else if (uploaded instanceof Api.MessageMediaDocument && uploaded.document instanceof Api.Document) {
          const cover =
            prepared[i].cover ?? (uploaded.videoCover instanceof Api.Photo ? tgUtils.getInputPhoto(uploaded.videoCover) : undefined);
          input = new Api.InputMediaDocument({
            id: tgUtils.getInputDocument(uploaded.document) as Api.TypeInputDocument,
            spoiler: it.spoiler,
            videoCover: cover,
            videoTimestamp: cover ? it.videoTimestamp : undefined,
          });
        } else {
          throw new SavePlusError("rpc", "相册成员上传后未得到可用媒体");
        }
        const randomId = tgHelpers.generateRandomLong();
        randomIds.push(randomId);
        multi.push(
          new Api.InputSingleMedia({ media: input, randomId, message: it.text, entities: entitiesFromJson(it.entities) })
        );
      }
    } catch (e) {
      throw classifyError(e, "prepare");
    }
    let res: unknown;
    try {
      res = await this.client.invoke(new Api.messages.SendMultiMedia({ peer, multiMedia: multi, replyTo, silent: opts.silent }));
    } catch (e) {
      throw classifyError(e, "send");
    }
    const { ids, messages } = this.extractSent(res, randomIds);
    return { messageIds: ids, warnings: this.verifyCovers(items, ids, messages) };
  }

  async getHistory(
    chatId: string,
    opts: { ascending: boolean; afterId?: number; beforeId?: number; limit: number }
  ): Promise<{ messages: SourceMessage[]; rawIds: number[] }> {
    const entity = await this.entity(chatId);
    let list: unknown[];
    try {
      list = await this.client.getMessages(
        entity as never,
        opts.ascending
          ? { limit: opts.limit, reverse: true, offsetId: opts.afterId ?? 0 }
          : { limit: opts.limit, offsetId: opts.beforeId ?? 0 }
      );
    } catch (e) {
      throw classifyError(e, "read");
    }
    const raw = list.filter((m) => m && typeof (m as { id?: unknown }).id === "number") as Array<{ id: number }>;
    const messages = raw
      .map((m) => this.toSourceMessage(m))
      .filter((m): m is SourceMessage => Boolean(m));
    return { messages, rawIds: raw.map((m) => m.id) };
  }

  async findRecentOwn(target: PeerTarget, sinceUnix: number, limit: number): Promise<SourceMessage[]> {
    const entity = await this.entity(target.peerId);
    let list: unknown[];
    try {
      list = await this.client.getMessages(entity as never, { limit });
    } catch (e) {
      throw classifyError(e, "read");
    }
    return list
      .map((m) => this.toSourceMessage(m))
      .filter((m): m is SourceMessage => Boolean(m && m.out && m.date >= sinceUnix));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 保存编排引擎
// ════════════════════════════════════════════════════════════════════════════

export interface EngineDirs {
  /** 本地中转根目录（每个任务一个 task_<id> 子目录，成功后删除）。 */
  staging: string;
  /** 普通手动保存的临时下载目录。 */
  manual: string;
  /** 纯本地归档目录（永久保留，不受中转清理影响）。 */
  archive: string;
  /** 插件持久数据目录（assets/saveplus）。 */
  data: string;
}

export interface EngineDeps {
  port: TelegramPort;
  store: Store;
  clock: Clock;
  dirs: EngineDirs;
  options: SavePlusOptions;
  /** 返回目录所在磁盘的可用字节数；未知时返回 undefined。 */
  diskFree?: (dir: string) => Promise<number | undefined>;
  log?: (message: string, error?: unknown) => void;
}

export interface AdmitResult {
  outcome: "queued" | "skipped" | "attention";
  category?: "filtered" | "saved" | "claimed" | "partial" | "late";
  reason?: string;
  taskId?: number;
}

interface AlbumBuffer {
  key: string;
  ruleId: number;
  chatId: string;
  groupedId: string;
  members: Map<number, SourceMessage>;
  version: number;
  /** 编辑事件聚合时为最大编辑时间。 */
  editVersion?: number;
}

async function defaultDiskFree(dir: string): Promise<number | undefined> {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

export function successKey(
  accountId: string,
  chatId: string,
  messageId: number,
  target: PeerTarget,
  editVersion?: number
): string {
  return `${accountId}|${chatId}|${messageId}|${target.peerId}${target.topicId ? `#${target.topicId}` : ""}${
    editVersion ? `@e${editVersion}` : ""
  }`;
}

/** 本地日期（YYYY-MM-DD），用于保存统计。 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** 时长：不足 1 分钟、N 分钟、N 小时 M 分、N 天 M 小时。 */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 60_000);
  if (total < 1) return "不到 1 分钟";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

/** 最后收到消息的持久化间隔：内存中实时更新，避免每条来源消息都写一次存储。 */
const SEEN_PERSIST_MS = 60_000;

function targetLabel(t: PeerTarget): string {
  return `${t.title}${t.topicId ? ` · 话题 ${t.topicId}` : ""}`;
}

export class Engine {
  accountId = "";
  readonly limiter: RateLimiter;
  /** 读取来源历史的独立限速（不占用发送配额）。 */
  readonly readLimiter: RateLimiter;
  /** 普通手动保存的独立发送限速。 */
  readonly manualLimiter: RateLimiter;
  private planner: Promise<void> | null = null;
  private plannerWake: (() => void) | null = null;
  private plannerWaiting = false;
  private stopped = false;
  private started = false;
  private readonly abort = new AbortController();
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private busy = false;
  private intake = 0;
  private readonly albums = new Map<string, AlbumBuffer>();
  private readonly flushedAlbums = new Map<string, number>();
  private readonly ownSent = new Map<string, number>();
  private readonly inflightTargets = new Map<string, number>();
  private readonly diskFree: (dir: string) => Promise<number | undefined>;
  private stoppedResolve: (() => void) | null = null;
  /** 正在执行的任务及其中止控制（用于取消处理中的任务）。 */
  private current: { id: number; controller: AbortController } | null = null;
  /** 已请求取消、但仍在处理或发送中的任务。 */
  private readonly cancelRequests = new Set<number>();
  /** 本次加载的启动时间。 */
  startedAt?: number;
  /** 各规则最后收到的来源新消息（实时值）与上次持久化时间。 */
  private readonly seen = new Map<number, RuleMark>();
  private readonly seenPersistedAt = new Map<number, number>();
  private readonly stoppedPromise = new Promise<void>((r) => {
    this.stoppedResolve = r;
  });

  constructor(readonly deps: EngineDeps) {
    this.limiter = new RateLimiter(deps.clock, deps.options.minIntervalMs, deps.options.maxPerMinute);
    this.readLimiter = new RateLimiter(deps.clock, deps.options.readMinIntervalMs, deps.options.readMaxPerMinute);
    this.manualLimiter = new RateLimiter(deps.clock, deps.options.manualMinIntervalMs, deps.options.manualMaxPerMinute);
    this.diskFree = deps.diskFree ?? defaultDiskFree;
  }

  get store(): Store {
    return this.deps.store;
  }
  get port(): TelegramPort {
    return this.deps.port;
  }
  get clock(): Clock {
    return this.deps.clock;
  }
  get options(): SavePlusOptions {
    return this.deps.options;
  }
  get isStopped(): boolean {
    return this.stopped;
  }

  private log(message: string, error?: unknown): void {
    (this.deps.log ?? ((m, e) => console.error(`[saveplus] ${m}`, e ?? "")))(message, error);
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await fsp.mkdir(this.deps.dirs.staging, { recursive: true });
    await fsp.mkdir(this.deps.dirs.manual, { recursive: true });
    const self = await this.port.selfId();
    this.accountId = self;
    const now = this.clock.now();
    this.startedAt = now;
    await this.store.update((d) => {
      d.accountId = self;
      for (const t of d.tasks) {
        if (t.status === "running") {
          t.status = "queued";
          t.updatedAt = now;
        } else if (t.status === "sending") {
          // 发送请求可能已被服务器执行：不得盲目重发。
          t.status = "uncertain";
          t.updatedAt = now;
          t.lastError = { code: "uncertain", message: "发送过程中插件被重启或重载，无法确认是否已发送", at: now };
        }
      }
    });
    await this.cleanupManualTemp();
    await this.sweepStaging();
    this.loop = this.runLoop();
    this.planner = this.runPlanner();
  }

  /** 停止接收与执行：先把尚在聚合的相册落盘为任务，再等待在途步骤结束，最后关闭存储。 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const key of Array.from(this.albums.keys())) {
      await this.flushAlbum(key).catch((e) => this.log("停止时保存相册任务失败", e));
    }
    this.stopped = true;
    this.abort.abort();
    this.wake?.();
    this.plannerWake?.();
    if (this.loop) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([this.loop.catch(() => undefined), this.planner?.catch(() => undefined)]),
        new Promise<void>((r) => {
          timer = setTimeout(r, this.options.stopTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    await this.persistSeen().catch((e) => this.log("保存最后收到的消息失败", e));
    await this.store.close();
    this.stoppedResolve?.();
  }

  /** 交给宿主跟踪的执行任务：循环结束或 stop() 完成（含超时放弃）即结算，挂起的网络请求不阻塞重载。 */
  get loopPromise(): Promise<void> | null {
    if (!this.loop) return null;
    const both = Promise.all([this.loop.catch(() => undefined), this.planner?.catch(() => undefined)]).then(() => undefined);
    return Promise.race([both, this.stoppedPromise]);
  }

  private notify(): void {
    this.wake?.();
  }

  /** 测试与诊断用：等待没有可立即执行的任务、相册聚合与事件处理。 */
  async whenIdle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((r) => setImmediate(r));
      const due = this.pickNext(this.clock.now());
      const scheduled = this.store.isClosed
        ? false
        : this.store.data.tasks.some((t) => t.status === "retry_wait" || (t.status === "cleanup_pending" && t.nextAttemptAt !== undefined && (t.cleanupAttempts ?? 0) < 10));
      const planning =
        !this.store.isClosed && !this.plannerWaiting && this.store.data.backups.some((b) => b.status === "running");
      if (!this.busy && this.intake === 0 && this.albums.size === 0 && !due && !planning && !(scheduled && !this.store.data.hold)) {
        return;
      }
      if (Date.now() > deadline) throw new Error("whenIdle timeout");
    }
  }

  // ── 监视入口 ──────────────────────────────────────────────────────────────

  ruleForChat(chatId: string): RuleRecord | undefined {
    return this.store.data.rules.find((r) => r.sourceChatId === chatId);
  }

  private isOwnEcho(m: SourceMessage): boolean {
    if (!m.out) return false;
    const now = this.clock.now();
    if (this.inflightTargets.has(m.chatId)) return true;
    const exp = this.ownSent.get(`${m.chatId}:${m.id}`);
    if (exp !== undefined && exp > now) return true;
    // 只忽略本插件的命令消息；以前缀字符开头的普通帖子（如 “.NET 9 发布”）照常处理。
    const text = m.text.toLowerCase();
    return safePrefixes().some((p) => {
      const head = `${p}${PLUGIN_NAME}`.toLowerCase();
      return text.startsWith(head) && (text.length === head.length || /\s/.test(text[head.length]));
    });
  }

  /** 在向某会话发送期间标记“发送中”，并登记发出的消息，防止目标同时是监视来源时回声中转。 */
  async withInflight<T>(target: PeerTarget, fn: () => Promise<T>, idsOf: (r: T) => number[]): Promise<T> {
    this.inflightTargets.set(target.peerId, (this.inflightTargets.get(target.peerId) ?? 0) + 1);
    try {
      const result = await fn();
      this.rememberSent(target, idsOf(result));
      return result;
    } finally {
      const n = (this.inflightTargets.get(target.peerId) ?? 1) - 1;
      if (n <= 0) this.inflightTargets.delete(target.peerId);
      else this.inflightTargets.set(target.peerId, n);
    }
  }

  private rememberSent(target: PeerTarget, ids: number[]): void {
    const exp = this.clock.now() + 60 * 60_000;
    for (const id of ids) this.ownSent.set(`${target.peerId}:${id}`, exp);
    if (this.ownSent.size > 5000) {
      const now = this.clock.now();
      for (const [k, v] of this.ownSent) if (v <= now || this.ownSent.size > 4000) this.ownSent.delete(k);
    }
  }

  /** 宿主 listenMessageHandler 的入口：处理新消息；编辑事件仅在规则开启“编辑后再存一份”时处理。 */
  async onMessage(raw: unknown, options?: { isEdited?: boolean }): Promise<void> {
    if (this.stopped || !this.started) return;
    const edited = Boolean(options?.isEdited);
    if (this.port.chatIdOf) {
      const quick = this.port.chatIdOf(raw);
      const r = quick ? this.ruleForChat(quick) : undefined;
      if (!r?.enabled || (edited && !r.handleEdited)) return;
    }
    const msg = this.port.toSourceMessage(raw);
    if (!msg) return;
    const rule = this.ruleForChat(msg.chatId);
    if (!rule || !rule.enabled) return;
    if (edited && (!rule.handleEdited || !msg.editDate)) return;
    if (this.isOwnEcho(msg)) return;
    if (!edited) this.noteSeen(rule, msg.id);
    const editVersion = edited ? msg.editDate : undefined;
    if (msg.groupedId) {
      this.bufferAlbum(rule, msg, editVersion);
      return;
    }
    this.intake++;
    try {
      await this.admitUnit(specFromRule(rule), [msg], { kind: "monitor", editVersion });
    } catch (e) {
      this.log(`处理来源消息 ${msg.chatId}/${msg.id} 失败`, e);
    } finally {
      this.intake--;
    }
  }

  /** 规则最后收到的来源新消息：优先取内存实时值，其次取持久化值。 */
  lastSeenOf(rule: RuleRecord): RuleMark | undefined {
    return this.seen.get(rule.id) ?? rule.lastSeen;
  }

  private noteSeen(rule: RuleRecord, messageId: number): void {
    const now = this.clock.now();
    const prev = this.seen.get(rule.id);
    this.seen.set(rule.id, { at: now, messageId: Math.max(messageId, prev?.messageId ?? 0) });
    if (now - (this.seenPersistedAt.get(rule.id) ?? 0) < SEEN_PERSIST_MS) return;
    this.seenPersistedAt.set(rule.id, now);
    this.persistSeen().catch((e) => this.log("保存最后收到的消息失败", e));
  }

  private async persistSeen(): Promise<void> {
    if (!this.seen.size || this.store.isClosed) return;
    await this.store.update((d) => {
      for (const r of d.rules) {
        const mark = this.seen.get(r.id);
        if (mark && mark.at >= (r.lastSeen?.at ?? 0)) r.lastSeen = { ...mark };
      }
    });
  }

  private bufferAlbum(rule: RuleRecord, msg: SourceMessage, editVersion?: number): void {
    const key = `${msg.chatId}:${msg.groupedId}${editVersion ? ":edit" : ""}`;
    let buf = this.albums.get(key);
    if (!buf) {
      if (!editVersion && this.flushedAlbums.has(key)) {
        this.intake++;
        this.admitLateMember(rule, key, msg)
          .catch((e) => this.log(`处理迟到的相册成员 ${msg.id} 失败`, e))
          .finally(() => this.intake--);
        return;
      }
      buf = { key, ruleId: rule.id, chatId: msg.chatId, groupedId: msg.groupedId as string, members: new Map(), version: 0 };
      this.albums.set(key, buf);
      void this.albumTimer(buf);
    }
    if (editVersion) buf.editVersion = Math.max(buf.editVersion ?? 0, editVersion);
    if (buf.members.has(msg.id) && !editVersion) return;
    buf.members.set(msg.id, msg);
    buf.version++;
  }

  private async albumTimer(buf: AlbumBuffer): Promise<void> {
    for (;;) {
      const seen = buf.version;
      await this.clock.sleep(this.options.albumDebounceMs, this.abort.signal);
      if (this.stopped || !this.albums.has(buf.key)) return;
      if (buf.version === seen) break;
    }
    await this.flushAlbum(buf.key).catch((e) => this.log(`保存相册任务失败`, e));
  }

  private async flushAlbum(key: string): Promise<void> {
    const buf = this.albums.get(key);
    if (!buf) return;
    this.albums.delete(key);
    this.intake++;
    try {
      const rule = this.store.data.rules.find((r) => r.id === buf.ruleId && r.enabled);
      if (!rule) return;
      const members = Array.from(buf.members.values()).sort((a, b) => a.id - b.id);
      const res = await this.admitUnit(specFromRule(rule), members, {
        kind: "monitor",
        groupedId: buf.groupedId,
        editVersion: buf.editVersion,
      });
      if (buf.editVersion) return;
      this.flushedAlbums.set(key, res.taskId ?? 0);
      if (this.flushedAlbums.size > 2000) {
        const first = this.flushedAlbums.keys().next().value;
        if (first !== undefined) this.flushedAlbums.delete(first);
      }
    } finally {
      this.intake--;
    }
  }

  /** 整组提交后才到达的相册成员：任务未开始发送则并入，否则转为待处理，不拆组发送。 */
  private async admitLateMember(rule: RuleRecord, key: string, msg: SourceMessage): Promise<void> {
    const taskId = this.flushedAlbums.get(key);
    const now = this.clock.now();
    const merged = await this.store.update((d) => {
      const t = taskId ? d.tasks.find((x) => x.id === taskId) : undefined;
      if (!t || t.memberIds.includes(msg.id)) return t ? "dup" : "none";
      if (t.status === "queued" || t.status === "retry_wait" || t.status === "needs_attention") {
        t.memberIds = Array.from(new Set([...t.memberIds, msg.id])).sort((a, b) => a - b);
        t.updatedAt = now;
        return "merged";
      }
      return "late";
    });
    if (merged === "merged" || merged === "dup") {
      this.notify();
      return;
    }
    if (merged === "none") {
      // 原相册未形成任务（被过滤或已保存），单独按整组语义处理该成员。
      await this.admitUnit(specFromRule(rule), [msg], { kind: "monitor", groupedId: msg.groupedId });
      return;
    }
    await this.admitUnit(specFromRule(rule), [msg], {
      kind: "monitor",
      groupedId: msg.groupedId,
      attention: { code: "late_album_member", message: `相册成员 ${msg.id} 在整组提交发送后才到达，未自动补发` },
    });
  }

  /**
   * 为一个保存单位创建持久任务：过滤 → 成功记录去重 → 在途协调 → 入队。
   * 在线监视、手动补漏与整个历史备份共用此路径。
   */
  async admitUnit(
    spec: SaveSpec,
    members: SourceMessage[],
    opts: {
      kind: "monitor" | "backfill" | "backup";
      groupedId?: string;
      force?: boolean;
      editVersion?: number;
      attention?: { code: string; message: string };
    }
  ): Promise<AdmitResult> {
    const rule = spec;
    const verdict = evaluateFilter(spec.filter, filterUnitOf(members));
    const ids = members.map((m) => m.id);
    const now = this.clock.now();
    if (!verdict.pass) {
      await this.recordSkip(spec, members[0].chatId, ids, verdict.reason);
      return { outcome: "skipped", category: "filtered", reason: verdict.reason };
    }
    const accountId = this.accountId;
    const result = await this.store.update((d): AdmitResult => {
      const keys = ids.map((id) => successKey(accountId, rule.sourceChatId, id, rule.target, opts.editVersion));
      const saved = keys.filter((k) => d.successes[k]);
      if (!opts.force && saved.length === keys.length) {
        return { outcome: "skipped", category: "saved", reason: "已成功保存到该目标" };
      }
      const holder = this.findClaim(d, keys);
      if (holder) {
        return { outcome: "skipped", category: "claimed", reason: `已有任务 #${holder.id} 正在处理`, taskId: holder.id };
      }
      let attention = opts.attention;
      if (!opts.force && saved.length > 0 && !attention) {
        attention = {
          code: "partially_saved",
          message: `相册中 ${saved.length}/${keys.length} 条已保存过；为避免拆组或重复，需要显式整组强制重存`,
        };
      }
      const task: TaskRecord = {
        id: d.nextTaskId++,
        kind: opts.kind,
        ruleId: spec.ruleId,
        jobId: spec.jobId,
        mode: spec.mode,
        hideAuthor: spec.hideAuthor || undefined,
        silent: spec.silent || undefined,
        editVersion: opts.editVersion,
        accountId,
        sourceChatId: rule.sourceChatId,
        sourceTitle: rule.sourceTitle,
        target: { ...rule.target },
        filter: JSON.parse(JSON.stringify(rule.filter)) as FilterConfig,
        groupedId: opts.groupedId,
        memberIds: [...ids].sort((a, b) => a - b),
        status: attention ? "needs_attention" : "queued",
        force: Boolean(opts.force),
        allowNoCover: false,
        attempts: 0,
        floodWaits: 0,
        createdAt: now,
        updatedAt: now,
        lastError: attention ? { ...attention, at: now } : undefined,
      };
      d.tasks.push(task);
      return {
        outcome: attention ? "attention" : "queued",
        category: attention ? (attention.code === "partially_saved" ? "partial" : "late") : undefined,
        taskId: task.id,
        reason: attention?.message,
      };
    });
    if (result.outcome === "skipped") {
      await this.recordSkip(spec, rule.sourceChatId, ids, result.reason || "已跳过").catch(() => undefined);
    }
    if (result.outcome === "queued") this.notify();
    return result;
  }

  private findClaim(d: DbShape, keys: string[]): TaskRecord | undefined {
    const wanted = new Set(keys);
    return d.tasks.find(
      (t) =>
        CLAIMING_STATUSES.has(t.status) &&
        t.memberIds.some((id) => wanted.has(successKey(t.accountId, t.sourceChatId, id, t.target, t.editVersion)))
    );
  }

  private async recordSkip(spec: SaveSpec, chatId: string, ids: number[], reason: string): Promise<void> {
    if (this.store.isClosed) return;
    await this.store.update((d) => {
      d.recentSkips.unshift({
        at: this.clock.now(),
        ruleId: spec.ruleId,
        jobId: spec.jobId,
        sourceChatId: chatId,
        messageIds: ids,
        reason,
      });
      d.recentSkips.length = Math.min(d.recentSkips.length, 50);
    });
  }

  // ── 后台执行 ──────────────────────────────────────────────────────────────

  /** 限流针对整个账号：后台任务与手动保存一起冷却。 */
  applyFloodCooldown(ms: number): void {
    this.limiter.applyCooldown(ms);
    this.manualLimiter.applyCooldown(ms);
  }

  get cooldownRemainingMs(): number {
    return Math.max(this.limiter.cooldownRemainingMs, this.manualLimiter.cooldownRemainingMs);
  }

  /** 正在等待限流结束的最早任务 ID：限流针对整个账号，排在它之后的任务也等待，以保持发送顺序。 */
  private floodBarrier(now: number): number | undefined {
    let barrier: number | undefined;
    for (const t of this.store.data.tasks) {
      if (t.status === "retry_wait" && t.lastError?.code === "flood" && (t.nextAttemptAt ?? 0) > now) {
        barrier = barrier === undefined ? t.id : Math.min(barrier, t.id);
      }
    }
    return barrier;
  }

  private pickNext(now: number): TaskRecord | undefined {
    if (this.store.isClosed) return undefined;
    const d = this.store.data;
    const held = Boolean(d.hold);
    const barrier = this.floodBarrier(now);
    let best: TaskRecord | undefined;
    for (const t of d.tasks) {
      if (barrier !== undefined && t.id > barrier && t.status !== "cleanup_pending") continue;
      const runnable =
        (!held && t.status === "queued") ||
        (!held && t.status === "retry_wait" && (t.nextAttemptAt ?? 0) <= now) ||
        (t.status === "cleanup_pending" && (t.cleanupAttempts ?? 0) < 10 && (t.nextAttemptAt ?? 0) <= now);
      if (runnable && (!best || t.id < best.id)) best = t;
    }
    return best;
  }

  private nextDueAt(): number | undefined {
    if (this.store.isClosed) return undefined;
    const d = this.store.data;
    let next: number | undefined;
    for (const t of d.tasks) {
      const timed =
        (t.status === "retry_wait" && !d.hold) || (t.status === "cleanup_pending" && (t.cleanupAttempts ?? 0) < 10);
      if (timed && t.nextAttemptAt !== undefined) next = next === undefined ? t.nextAttemptAt : Math.min(next, t.nextAttemptAt);
    }
    return next;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const task = this.pickNext(this.clock.now());
      if (!task) {
        const due = this.nextDueAt();
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            this.wake = null;
            resolve();
          };
          this.wake = done;
          if (due !== undefined) {
            this.clock.sleep(Math.max(0, due - this.clock.now()), this.abort.signal).then(done, done);
          }
        });
        continue;
      }
      this.busy = true;
      try {
        await this.processTask(task);
      } catch (e) {
        this.log(`任务 #${task.id} 处理异常`, e);
      } finally {
        this.busy = false;
        this.plannerWake?.();
      }
    }
  }

  private mutate(t: TaskRecord, fn: (t: TaskRecord) => void): Promise<void> {
    return this.store.update(() => {
      fn(t);
      t.updatedAt = this.clock.now();
    });
  }

  private stagingDirFor(t: TaskRecord): string {
    return path.join(this.deps.dirs.staging, `task_${t.id}`);
  }

  private async ensureDisk(dir: string, needed?: number): Promise<void> {
    const free = await this.diskFree(dir);
    if (free === undefined) return;
    const want = (needed ?? 0) + this.options.diskMarginBytes;
    if (free < want) {
      throw new SavePlusError("disk_full", `磁盘空间不足：可用 ${formatBytes(free)}，至少需要 ${formatBytes(want)}`);
    }
  }

  /** 补全监视相册中尚未收到事件的成员（仅追加真实属于该组的消息）。 */
  private async discoverAlbumMembers(t: TaskRecord, fresh: Map<number, SourceMessage>): Promise<boolean> {
    if (t.kind !== "monitor" || !t.groupedId) return false;
    const min = Math.min(...t.memberIds);
    const max = Math.max(...t.memberIds);
    const probe: number[] = [];
    for (let id = Math.max(1, min - this.options.albumProbeSpan); id <= max + this.options.albumProbeSpan; id++) {
      if (!t.memberIds.includes(id)) probe.push(id);
    }
    const extra = await this.port.getMessages(t.sourceChatId, probe);
    const found = Array.from(extra.values()).filter((m) => m.groupedId === t.groupedId);
    if (!found.length) return false;
    for (const m of found) fresh.set(m.id, m);
    await this.mutate(t, (x) => {
      x.memberIds = Array.from(new Set([...x.memberIds, ...found.map((m) => m.id)])).sort((a, b) => a - b);
    });
    return true;
  }

  async processTask(t: TaskRecord): Promise<void> {
    if (t.status === "cleanup_pending") {
      await this.cleanupTask(t);
      return;
    }
    // 每个任务独立的中止信号：插件停止或用户取消时中断下载与等待。
    const controller = new AbortController();
    const onStop = () => controller.abort();
    this.abort.signal.addEventListener("abort", onStop, { once: true });
    const signal = controller.signal;
    this.current = { id: t.id, controller };
    try {
      // 原子地认领任务：期间若已被取消或改变状态，则不执行。
      const claimed = await this.store.update(() => {
        if (t.status !== "queued" && t.status !== "retry_wait") return false;
        t.status = "running";
        t.nextAttemptAt = undefined;
        t.stagingDir = t.stagingDir ?? this.stagingDirFor(t);
        t.updatedAt = this.clock.now();
        return true;
      });
      if (!claimed) return;
      const before = t.memberIds.length;
      const fresh = await this.port.getMessages(t.sourceChatId, t.memberIds);
      const grown = await this.discoverAlbumMembers(t, fresh);
      if (grown || before !== t.memberIds.length) {
        const all = t.memberIds.map((id) => fresh.get(id)).filter((m): m is SourceMessage => Boolean(m));
        const verdict = evaluateFilter(t.filter, filterUnitOf(all));
        if (!verdict.pass) {
          await this.finishSkipped(t, `补全相册成员后不再满足过滤条件：${verdict.reason}`);
          return;
        }
      }
      // 再次核对成功记录（可能已由其他路径完成）。
      if (!t.force) {
        const keys = t.memberIds.map((id) => successKey(t.accountId, t.sourceChatId, id, t.target, t.editVersion));
        const saved = keys.filter((k) => this.store.data.successes[k]);
        if (saved.length === keys.length) {
          await this.finishSkipped(t, "已成功保存到该目标");
          return;
        }
        if (saved.length > 0) {
          throw new SavePlusError("invalid", `相册中 ${saved.length}/${keys.length} 条已保存过，需要显式整组强制重存`);
        }
      }
      const notes: string[] = [];
      if ((t.mode ?? "relay") === "forward" && !t.relayFallback) {
        // 原生转发：不下载；来源受保护时自动改为本地中转。
        const missing = t.memberIds.find((id) => !fresh.has(id));
        if (missing !== undefined) throw new SavePlusError("not_found", `来源消息 ${missing} 已不存在或无法读取`);
        const restricted = t.memberIds.some((id) => fresh.get(id)?.noforwards);
        if (!restricted) {
          await this.limiter.acquire(signal, t.memberIds.length);
          if (this.stopped) throw new SavePlusError("stopped", "插件正在停止");
          await this.markSending(t);
          try {
            const ids = await this.withInflight(
              t.target,
              () => this.port.forwardMessages(t.target, t.sourceChatId, t.memberIds, { dropAuthor: t.hideAuthor, silent: t.silent }),
              (r) => r
            );
            await this.confirmSuccess(t, ids, "response");
            await this.cleanupTask(t);
            return;
          } catch (err) {
            const c = classifyError(err, "send");
            if (c.code !== "forward_restricted") throw c;
          }
        }
        notes.push("来源禁止转发，已改为本地中转");
        await this.mutate(t, (x) => {
          x.relayFallback = true;
          x.status = "running";
        });
      }
      const items: StagedItem[] = [];
      for (const id of t.memberIds) {
        if (signal.aborted) throw new SavePlusError("stopped", "插件正在停止");
        const existing = t.staged?.find((s) => s.messageId === id);
        if (existing && (!existing.mediaFile || fs.existsSync(existing.mediaFile))) {
          items.push(existing);
          continue;
        }
        const m = fresh.get(id);
        if (!m) throw new SavePlusError("not_found", `来源消息 ${id} 已不存在或无法读取`);
        if (!m.reuploadable) throw new SavePlusError("unsupported", m.unsupportedReason || `消息 ${id} 不能重新上传`);
        if (t.memberIds.length > 1 && m.kind === "text") {
          throw new SavePlusError("invalid", `相册成员 ${id} 不含媒体，无法整组发送`);
        }
        if (m.kind !== "text") {
          await fsp.mkdir(t.stagingDir as string, { recursive: true });
          await this.ensureDisk(t.stagingDir as string, m.size);
        }
        const item = await this.port.stageMedia(m, t.stagingDir as string, signal);
        items.push(item);
        await this.mutate(t, (x) => {
          x.staged = [...(x.staged || []).filter((s) => s.messageId !== id), item];
        });
      }
      for (const it of items) {
        if ((it.kind === "video") && (it.coverKind === "none" || it.coverKind === "stripped") && !t.allowNoCover) {
          throw new SavePlusError(
            "cover_unavailable",
            it.coverKind === "stripped"
              ? `视频 ${it.messageId} 只有模糊预览，无法保留来源封面；已保留中转文件`
              : `视频 ${it.messageId} 没有可获取的来源封面；已保留中转文件`
          );
        }
      }
      await this.limiter.acquire(signal, items.length);
      if (this.stopped) throw new SavePlusError("stopped", "插件正在停止");
      await this.markSending(t);
      const sent = await this.withInflight(
        t.target,
        () => this.port.sendStaged(t.target, items, { topicId: t.target.topicId, silent: t.silent }),
        (r) => r.messageIds
      );
      await this.confirmSuccess(t, sent.messageIds, "response", [...notes, ...sent.warnings]);
      await this.cleanupTask(t);
    } catch (e) {
      await this.handleFailure(t, e);
    } finally {
      this.abort.signal.removeEventListener("abort", onStop);
      if (this.current?.id === t.id) this.current = null;
      this.cancelRequests.delete(t.id);
    }
  }

  /** 进入发送阶段；与取消请求在同一次写入中判定，已请求取消则不再发送。 */
  private async markSending(t: TaskRecord): Promise<void> {
    await this.store.update(() => {
      if (this.cancelRequests.has(t.id)) throw new SavePlusError("stopped", "任务已被取消");
      t.status = "sending";
      t.sendStartedAt = this.clock.now();
      t.updatedAt = this.clock.now();
    });
  }

  /** 把任务结束为“已取消”，并删除它的中转文件（含下载到一半的文件）。 */
  private async finishCancelled(t: TaskRecord): Promise<void> {
    await this.mutate(t, (x) => {
      x.status = "cancelled";
      x.lastError = { code: "cancelled", message: "已按用户要求取消", at: this.clock.now() };
    });
    await this.removeStaging(t).catch((e) => this.log(`删除任务 #${t.id} 的中转文件失败`, e));
    await this.mutate(t, (x) => {
      x.staged = undefined;
      x.stagingDir = undefined;
    });
  }

  /** 在一次持久写入中记录所有成员的成功保存记录，并把任务转为待清理。 */
  private async confirmSuccess(
    t: TaskRecord,
    messageIds: number[],
    via: "response" | "check" | "manual",
    warnings: string[] = []
  ): Promise<void> {
    if (this.stopped && this.store.isClosed) return;
    const now = this.clock.now();
    await this.store.update((d) => {
      t.memberIds.forEach((id, i) => {
        d.successes[successKey(t.accountId, t.sourceChatId, id, t.target, t.editVersion)] = {
          taskId: t.id,
          targetMessageId: messageIds[i],
          at: now,
        };
      });
      if (t.jobId) {
        const job = d.backups.find((b) => b.id === t.jobId);
        if (job) job.counts.done += 1;
      } else {
        const rule = d.rules.find((r) => r.id === t.ruleId);
        if (rule) rule.lastSaved = { at: now, messageId: Math.max(...t.memberIds) };
      }
      const day = dayKey(now);
      const scope = t.jobId ? `backup:${t.jobId}` : `rule:${t.ruleId}`;
      const bucket = (d.stats[day] ??= {});
      const counter = (bucket[scope] ??= { units: 0, messages: 0 });
      counter.units += 1;
      counter.messages += t.memberIds.length;
      const oldest = dayKey(now - this.options.statsRetentionDays * 86_400_000);
      for (const k of Object.keys(d.stats)) if (k < oldest) delete d.stats[k];
      t.status = "cleanup_pending";
      t.result = { messageIds, confirmedAt: now, via };
      t.warnings = warnings.length ? warnings : undefined;
      t.lastError = undefined;
      t.nextAttemptAt = undefined;
      t.updatedAt = now;
    });
  }

  /** 返回属于该任务、位于中转根目录内的中转目录；记录被篡改时拒绝。 */
  private ownedStagingDir(t: TaskRecord): string | undefined {
    const dir = t.stagingDir;
    if (!dir) return undefined;
    if (!isInside(this.deps.dirs.staging, dir) || path.basename(dir) !== `task_${t.id}`) {
      throw new SavePlusError("internal", `拒绝清理不属于任务的目录：${dir}`);
    }
    return dir;
  }

  /** 仅删除属于该任务、位于中转根目录内的文件；成功记录已持久化后才执行。 */
  private async cleanupTask(t: TaskRecord): Promise<void> {
    try {
      await this.store.flush();
      const dir = this.ownedStagingDir(t);
      if (dir) await fsp.rm(dir, { recursive: true, force: true });
      await this.mutate(t, (x) => {
        x.status = "done";
        x.staged = undefined;
        x.stagingDir = undefined;
        x.nextAttemptAt = undefined;
        x.cleanupAttempts = undefined;
      });
      await this.pruneFinished();
    } catch (e) {
      const err = classifyError(e, "read");
      if (err.code === "stopped") return;
      const attempts = (t.cleanupAttempts ?? 0) + 1;
      t.cleanupAttempts = attempts;
      t.nextAttemptAt = this.clock.now() + Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** (attempts - 1));
      t.lastError = { code: err.code, message: `清理中转文件失败：${err.message}`, at: this.clock.now() };
      await this.store.flush().catch(() => undefined);
    }
  }

  private async finishSkipped(t: TaskRecord, reason: string): Promise<void> {
    await this.removeStaging(t);
    await this.mutate(t, (x) => {
      x.status = "skipped";
      x.lastError = { code: "skipped", message: reason, at: this.clock.now() };
      x.staged = undefined;
      x.stagingDir = undefined;
    });
  }

  private async removeStaging(t: TaskRecord): Promise<void> {
    const dir = this.ownedStagingDir(t);
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }

  /**
   * 清扫中转根目录：删除没有任务记录或任务已结束的 task_* 目录（例如崩溃残留、已被裁剪的任务）。
   * 未结束任务（含待处理、结果不确定）的中转文件保留，供重试或核对。
   */
  async sweepStaging(): Promise<number> {
    const root = this.deps.dirs.staging;
    const keep = new Set(
      this.store.data.tasks.filter((t) => !FINISHED_STATUSES.has(t.status)).map((t) => `task_${t.id}`)
    );
    let removed = 0;
    let names: string[];
    try {
      names = await fsp.readdir(root);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!/^task_\d+$/.test(name) || keep.has(name)) continue;
      await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  private async handleFailure(t: TaskRecord, e: unknown): Promise<void> {
    const err = classifyError(e, "read");
    const now = this.clock.now();
    if (this.cancelRequests.has(t.id) && !this.store.isClosed && t.status !== "cleanup_pending") {
      this.cancelRequests.delete(t.id);
      // 发送结果无法确认时不能当作“未发送”，保持结果不确定，交给用户核对。
      if (err.code !== "uncertain") {
        await this.finishCancelled(t);
        return;
      }
    }
    if (err.code === "stopped" || (this.stopped && t.status === "running")) {
      if (!this.store.isClosed && t.status === "running") {
        await this.mutate(t, (x) => {
          x.status = "queued";
        }).catch(() => undefined);
      }
      return;
    }
    if (this.store.isClosed) return;
    if (t.status === "cleanup_pending") {
      // 已发送成功但持久化失败：绝不回退为重试，只安排再次写入与清理。
      t.cleanupAttempts = (t.cleanupAttempts ?? 0) + 1;
      t.nextAttemptAt = now + this.options.backoffBaseMs;
      t.lastError = { code: err.code, message: err.message, at: now };
      await this.store.flush().catch(() => undefined);
      return;
    }
    const apply = (x: TaskRecord) => {
      x.lastError = { code: err.code, message: err.message, at: now };
      switch (err.code) {
        case "flood": {
          const waitMs = ((err.seconds ?? 1) + 1) * 1000;
          this.applyFloodCooldown(waitMs);
          x.floodWaits += 1;
          if (x.floodWaits > this.options.maxFloodWaits) {
            x.status = "needs_attention";
          } else {
            x.status = "retry_wait";
            x.nextAttemptAt = now + waitMs;
          }
          break;
        }
        case "uncertain":
          x.status = "uncertain";
          break;
        case "disk_full":
          x.status = "needs_attention";
          break;
        default:
          if (err.transient) {
            x.attempts += 1;
            if (x.attempts >= this.options.maxAttempts) {
              x.status = "needs_attention";
              x.lastError.message = `${err.message}（已自动重试 ${x.attempts} 次）`;
            } else {
              x.status = "retry_wait";
              x.nextAttemptAt = now + Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * 2 ** (x.attempts - 1));
            }
          } else {
            x.status = "needs_attention";
          }
      }
    };
    try {
      await this.store.update((d) => {
        apply(t);
        t.updatedAt = now;
        if (err.code === "disk_full") d.hold = { reason: err.message, at: now };
      });
    } catch (writeError) {
      // 写盘失败时保持内存状态，等待下一次成功写入；sending 状态在重启后会被视为结果不确定。
      this.log(`任务 #${t.id} 状态写入失败`, writeError);
    }
  }

  private async pruneFinished(): Promise<void> {
    const keep = this.options.keepFinishedTasks;
    const finished = this.store.data.tasks.filter((t) => FINISHED_STATUSES.has(t.status));
    if (finished.length <= keep) return;
    const drop = new Set(finished.sort((a, b) => a.id - b.id).slice(0, finished.length - keep).map((t) => t.id));
    await this.store.update((d) => {
      d.tasks = d.tasks.filter((t) => !drop.has(t.id));
    });
    await this.sweepStaging();
  }

  private async cleanupManualTemp(): Promise<void> {
    try {
      for (const name of await fsp.readdir(this.deps.dirs.manual)) {
        if (name.startsWith("job_")) await fsp.rm(path.join(this.deps.dirs.manual, name), { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  // ── 读取来源历史（独立限速，识别长时间限流） ─────────────────────────────

  /**
   * 带读取限速执行一次读取；遇到限流按服务端秒数冷却后重试同一请求。
   * maxWaitSeconds 限制单次可接受的等待时间，超过时报错（不静默放弃）。
   */
  async readWithRetry<T>(fn: () => Promise<T>, opts: { maxWaitSeconds?: number; onWait?: (seconds: number) => Promise<void> } = {}): Promise<T> {
    let transient = 0;
    for (;;) {
      await this.readLimiter.acquire(this.abort.signal);
      try {
        return await fn();
      } catch (e) {
        const c = classifyError(e, "read");
        if (c.code === "flood") {
          const seconds = c.seconds ?? 1;
          if (opts.maxWaitSeconds !== undefined && seconds > opts.maxWaitSeconds) {
            throw new SavePlusError("flood", `读取被 Telegram 限流 ${seconds} 秒，请稍后再试`, { transient: true, seconds });
          }
          await opts.onWait?.(seconds);
          this.readLimiter.applyCooldown((seconds + 1) * 1000);
          continue;
        }
        if (c.transient && c.code !== "stopped" && transient < 3) {
          transient++;
          await this.clock.sleep(2000 * transient, this.abort.signal);
          if (this.abort.signal.aborted) throw new SavePlusError("stopped", "插件正在停止");
          continue;
        }
        throw c;
      }
    }
  }

  /** 按 100 条一组、受读取限速地读取指定消息。 */
  async readMessages(chatId: string, ids: number[], opts: { maxWaitSeconds?: number } = {}): Promise<Map<number, SourceMessage>> {
    const out = new Map<number, SourceMessage>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const got = await this.readWithRetry(() => this.port.getMessages(chatId, chunk), opts);
      for (const [id, m] of got) out.set(id, m);
    }
    return out;
  }

  // ── 整个历史备份 ──────────────────────────────────────────────────────────

  private specFromJob(job: BackupJob): SaveSpec {
    return {
      ruleId: 0,
      jobId: job.id,
      sourceChatId: job.sourceChatId,
      sourceTitle: job.sourceTitle,
      target: job.target,
      filter: job.filter,
      mode: job.mode,
      hideAuthor: job.hideAuthor,
      silent: false,
    };
  }

  /** 该备份尚在执行队列中的任务数（不含待处理），用于限制排队规模。 */
  backupBacklog(jobId: number): number {
    return this.store.data.tasks.filter(
      (t) =>
        t.jobId === jobId &&
        (t.status === "queued" || t.status === "running" || t.status === "sending" || t.status === "retry_wait")
    ).length;
  }

  private async runPlanner(): Promise<void> {
    while (!this.stopped) {
      const job = this.store.isClosed ? undefined : this.store.data.backups.find((b) => b.status === "running");
      if (!job || this.backupBacklog(job.id) >= this.options.backupBacklog || this.store.data.hold) {
        this.plannerWaiting = true;
        await new Promise<void>((resolve) => {
          this.plannerWake = () => {
            this.plannerWake = null;
            resolve();
          };
        });
        this.plannerWaiting = false;
        continue;
      }
      try {
        await this.planBackupPage(job);
      } catch (e) {
        const c = classifyError(e, "read");
        if (c.code === "stopped" || this.store.isClosed) return;
        await this.store
          .update(() => {
            job.status = "error";
            job.lastError = { message: c.message, at: this.clock.now() };
            job.updatedAt = this.clock.now();
          })
          .catch(() => undefined);
      }
    }
  }

  /** 读取一页历史并按保存单位入队；跨页的相册会退回游标，在下一页整组读取。 */
  private async planBackupPage(job: BackupJob): Promise<void> {
    const ascending = job.order === "asc";
    const limit = this.options.backupPageSize;
    const page = await this.readWithRetry(
      () =>
        this.port.getHistory(job.sourceChatId, {
          ascending,
          afterId: ascending ? job.cursor : undefined,
          beforeId: ascending ? undefined : job.cursor,
          limit,
        }),
      {
        onWait: async (seconds) => {
          await this.store.update(() => {
            job.lastError = { message: `读取被限流，等待 ${seconds} 秒后继续`, at: this.clock.now() };
          });
        },
      }
    );
    if (job.status !== "running") return;
    if (!page.rawIds.length) {
      await this.store.update(() => {
        job.status = "planned";
        job.finishedAt = this.clock.now();
        job.updatedAt = this.clock.now();
        job.lastError = undefined;
      });
      return;
    }
    // 按遍历顺序把连续的同组消息合成保存单位。
    const units: SourceMessage[][] = [];
    for (const m of page.messages) {
      const last = units[units.length - 1];
      if (m.groupedId && last && last[0].groupedId === m.groupedId) last.push(m);
      else units.push([m]);
    }
    const before = (u: SourceMessage[]) => {
      const ids = u.map((m) => m.id);
      return ascending ? Math.min(...ids) - 1 : Math.max(...ids) + 1;
    };
    let cursor = page.rawIds[page.rawIds.length - 1];
    const tail = units[units.length - 1];
    if (page.rawIds.length >= limit && tail?.[0].groupedId) {
      // 末尾相册可能延续到下一页：本页不入队，游标退回到该组之前。
      units.pop();
      cursor = before(tail);
    }
    const spec = this.specFromJob(job);
    const counts = { queued: 0, filtered: 0, saved: 0, claimed: 0, attention: 0 };
    for (const unit of units) {
      if (this.stopped || job.status !== "running") return;
      if (this.backupBacklog(job.id) >= this.options.backupBacklog) {
        // 排队已满：停在这个保存单位之前，等执行者消化后继续。
        cursor = before(unit);
        break;
      }
      const members = unit.slice().sort((a, b) => a.id - b.id);
      const res = await this.admitUnit(spec, members, { kind: "backup", groupedId: members[0].groupedId, force: job.force });
      if (res.outcome === "queued") counts.queued++;
      else if (res.outcome === "attention") counts.attention++;
      else if (res.category === "filtered") counts.filtered++;
      else if (res.category === "saved") counts.saved++;
      else counts.claimed++;
    }
    const scanned = page.rawIds.filter((id) => (ascending ? id <= cursor : id >= cursor)).length;
    await this.store.update(() => {
      job.cursor = cursor;
      job.counts.scanned += scanned;
      job.counts.queued += counts.queued;
      job.counts.filtered += counts.filtered;
      job.counts.saved += counts.saved;
      job.counts.claimed += counts.claimed;
      job.counts.attention += counts.attention;
      job.lastError = undefined;
      job.updatedAt = this.clock.now();
    });
  }

  async createBackup(input: Omit<BackupJob, "id" | "status" | "cursor" | "counts" | "createdAt" | "updatedAt">): Promise<BackupJob> {
    const now = this.clock.now();
    const job = await this.store.update((d) => {
      const dup = d.backups.find(
        (b) =>
          (b.status === "running" || b.status === "paused" || b.status === "error") &&
          b.sourceChatId === input.sourceChatId &&
          b.target.peerId === input.target.peerId &&
          b.target.topicId === input.target.topicId
      );
      if (dup) throw new SavePlusError("invalid", `已有未结束的备份 #${dup.id}（同一来源与目标），可用 backup resume ${dup.id} 继续`);
      const created: BackupJob = {
        ...input,
        id: d.nextBackupId++,
        status: "running",
        cursor: 0,
        counts: { scanned: 0, queued: 0, filtered: 0, saved: 0, claimed: 0, attention: 0, done: 0 },
        createdAt: now,
        updatedAt: now,
      };
      d.backups.push(created);
      return created;
    });
    this.plannerWake?.();
    return job;
  }

  getBackup(id: number): BackupJob | undefined {
    return this.store.data.backups.find((b) => b.id === id);
  }

  async setBackupState(id: number, action: "pause" | "resume" | "cancel"): Promise<BackupJob> {
    const job = this.getBackup(id);
    if (!job) throw new SavePlusError("invalid", `备份 #${id} 不存在`);
    const now = this.clock.now();
    if (action === "pause") {
      if (job.status !== "running") throw new SavePlusError("invalid", `备份 #${id} 当前不在运行`);
      await this.store.update(() => {
        job.status = "paused";
        job.updatedAt = now;
      });
    } else if (action === "resume") {
      if (job.status !== "paused" && job.status !== "error") throw new SavePlusError("invalid", `备份 #${id} 无需继续`);
      await this.store.update(() => {
        job.status = "running";
        job.lastError = undefined;
        job.updatedAt = now;
      });
      this.plannerWake?.();
    } else {
      if (job.status === "cancelled") throw new SavePlusError("invalid", `备份 #${id} 已取消`);
      await this.store.update(() => {
        job.status = "cancelled";
        job.finishedAt = now;
        job.updatedAt = now;
      });
      await this.cancelMany((t) => t.jobId === id);
    }
    return job;
  }

  // ── 任务操作（命令） ───────────────────────────────────────────────────────

  getTask(id: number): TaskRecord | undefined {
    return this.store.data.tasks.find((t) => t.id === id);
  }

  /** 重试：待处理／等待重试／待清理的任务立即重新执行；可选整组强制重存与接受无封面。 */
  async retryTask(id: number, flags: { force?: boolean; allowNoCover?: boolean } = {}): Promise<string> {
    const t = this.getTask(id);
    if (!t) throw new SavePlusError("invalid", `任务 #${id} 不存在`);
    if (t.status === "uncertain") {
      throw new SavePlusError("invalid", `任务 #${id} 结果不确定：请先执行 task check ${id} 核对，确认未发送后再用 task resend ${id}`);
    }
    if (!["needs_attention", "retry_wait", "cleanup_pending"].includes(t.status)) {
      throw new SavePlusError("invalid", `任务 #${id} 当前为「${STATUS_LABEL[t.status]}」，无需重试`);
    }
    await this.store.update((d) => {
      d.hold = null;
      if (t.status === "cleanup_pending") {
        t.cleanupAttempts = 0;
      } else {
        t.status = "queued";
        t.attempts = 0;
        t.floodWaits = 0;
      }
      if (flags.force) t.force = true;
      if (flags.allowNoCover) t.allowNoCover = true;
      t.nextAttemptAt = undefined;
      t.updatedAt = this.clock.now();
    });
    this.notify();
    return `任务 #${id} 已重新排队`;
  }

  async retryAll(): Promise<number> {
    let n = 0;
    await this.store.update((d) => {
      d.hold = null;
      for (const t of d.tasks) {
        if (t.status === "needs_attention" || t.status === "retry_wait") {
          t.status = "queued";
          t.attempts = 0;
          t.floodWaits = 0;
          t.nextAttemptAt = undefined;
          n++;
        } else if (t.status === "cleanup_pending") {
          t.cleanupAttempts = 0;
          t.nextAttemptAt = undefined;
          n++;
        }
      }
    });
    this.notify();
    return n;
  }

  /** 结果不确定的任务：用户确认未发送后，明确接受可能重复的风险再次发送。 */
  async resendTask(id: number): Promise<string> {
    const t = this.getTask(id);
    if (!t) throw new SavePlusError("invalid", `任务 #${id} 不存在`);
    if (t.status !== "uncertain") throw new SavePlusError("invalid", `任务 #${id} 不是「结果不确定」状态`);
    await this.mutate(t, (x) => {
      x.status = "queued";
      x.attempts = 0;
      x.lastError = undefined;
    });
    this.notify();
    return `任务 #${id} 将重新发送（若之前其实已发送，目标中会出现重复）`;
  }

  /**
   * 取消任务。排队、等待重试、待处理、结果不确定的任务立即取消并删除中转文件；
   * 处理中的任务中断下载后取消；发送中的任务因请求无法撤回，等本次发送结束：
   * 已发出则保留为已完成，失败则不再重试，无法确认时保持结果不确定。
   */
  async requestCancel(t: TaskRecord): Promise<"cancelled" | "stopping" | "after_send" | "final"> {
    const outcome = await this.store.update(() => {
      if (FINISHED_STATUSES.has(t.status) || t.status === "cleanup_pending") return "final" as const;
      if (t.status === "running" || t.status === "sending") {
        this.cancelRequests.add(t.id);
        if (t.status === "running" && this.current?.id === t.id) this.current.controller.abort();
        return t.status === "running" ? ("stopping" as const) : ("after_send" as const);
      }
      t.status = "cancelled";
      t.lastError = { code: "cancelled", message: "已按用户要求取消", at: this.clock.now() };
      t.updatedAt = this.clock.now();
      return "cancelled" as const;
    });
    if (outcome === "cancelled") {
      await this.removeStaging(t).catch((e) => this.log(`删除任务 #${t.id} 的中转文件失败`, e));
      await this.mutate(t, (x) => {
        x.staged = undefined;
        x.stagingDir = undefined;
      });
    }
    return outcome;
  }

  async cancelTask(id: number): Promise<string> {
    const t = this.getTask(id);
    if (!t) throw new SavePlusError("invalid", `任务 #${id} 不存在`);
    const outcome = await this.requestCancel(t);
    switch (outcome) {
      case "final":
        throw new SavePlusError("invalid", `任务 #${id} 当前为「${STATUS_LABEL[t.status]}」，不能取消`);
      case "stopping":
        return `正在停止任务 #${id}：中断下载后取消，并删除中转文件`;
      case "after_send":
        return `任务 #${id} 正在向目标发送，发送请求无法撤回：本次发送结束后停止（已发出则保留为已完成；失败则不再重试；无法确认时标为结果不确定）`;
      default:
        return `任务 #${id} 已取消，中转文件已删除`;
    }
  }

  /** 批量取消：返回各类结果的数量。 */
  async cancelMany(match: (t: TaskRecord) => boolean): Promise<{ cancelled: number; stopping: number; afterSend: number; matched: number }> {
    const targets = this.store.data.tasks.filter((t) => match(t) && !FINISHED_STATUSES.has(t.status) && t.status !== "cleanup_pending");
    const counts = { cancelled: 0, stopping: 0, afterSend: 0, matched: targets.length };
    for (const t of targets) {
      const outcome = await this.requestCancel(t);
      if (outcome === "cancelled") counts.cancelled++;
      else if (outcome === "stopping") counts.stopping++;
      else if (outcome === "after_send") counts.afterSend++;
    }
    return counts;
  }

  /** 核对结果不确定的任务：在目标中查找与中转内容一致的、本账号在发送后发出的消息。 */
  async checkTask(id: number): Promise<string> {
    const t = this.getTask(id);
    if (!t) throw new SavePlusError("invalid", `任务 #${id} 不存在`);
    if (t.status !== "uncertain") throw new SavePlusError("invalid", `任务 #${id} 不是「结果不确定」状态`);
    let items: Array<Pick<StagedItem, "messageId" | "kind" | "text" | "size">> = t.staged || [];
    if (items.length !== t.memberIds.length) {
      // 原生转发没有中转清单：按来源消息的内容核对。
      const src = await this.readMessages(t.sourceChatId, t.memberIds);
      if (t.memberIds.some((mid) => !src.has(mid))) {
        return `任务 #${id} 的来源消息已无法读取，无法核对；如确认未发送可执行 task resend ${id}`;
      }
      items = t.memberIds.map((mid) => {
        const m = src.get(mid) as SourceMessage;
        return { messageId: mid, kind: m.kind, text: m.text, size: m.size };
      });
    }
    const since = Math.floor((t.sendStartedAt ?? t.updatedAt) / 1000) - 5;
    const recent = (await this.port.findRecentOwn(t.target, since, 100)).sort((a, b) => a.id - b.id);
    // 已归属于其他任务的目标消息不能作为本任务的证据。
    const used = new Set<number>();
    for (const other of this.store.data.tasks) {
      if (other.id !== t.id && other.target.peerId === t.target.peerId) for (const id of other.result?.messageIds ?? []) used.add(id);
    }
    const matched: number[] = [];
    for (const it of items.slice().sort((a, b) => a.messageId - b.messageId)) {
      const hit = recent.find(
        (m) =>
          !used.has(m.id) &&
          m.kind === it.kind &&
          m.text.trim() === it.text.trim() &&
          (it.kind === "photo" || it.kind === "text" || !it.size || !m.size || m.size === it.size)
      );
      if (!hit) break;
      used.add(hit.id);
      matched.push(hit.id);
    }
    if (matched.length !== items.length) {
      return `任务 #${id} 未在目标中找到可靠证据（匹配 ${matched.length}/${items.length}），保持「结果不确定」。确认未发送后可执行 task resend ${id}`;
    }
    const groupOk = matched.every((v, i) => i === 0 || v > matched[i - 1]);
    if (!groupOk) return `任务 #${id} 匹配结果顺序不一致，保持「结果不确定」`;
    await this.confirmSuccess(t, matched, "check");
    await this.cleanupTask(t);
    return `任务 #${id} 已在目标中找到对应消息（${matched.join(", ")}），已补记成功并清理中转文件`;
  }
}

function safePrefixes(): string[] {
  try {
    return getPrefixes();
  } catch {
    return [".", "。", "$"];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 命令层：规则、补漏、手动保存、本地归档、状态
// ════════════════════════════════════════════════════════════════════════════

/** 命令消息所需的最小形状（Api.Message 满足）。 */
export interface CommandMessage {
  message?: string;
  chatId?: { toString(): string } | string | number;
  replyTo?: { replyToMsgId?: number; replyToTopId?: number; forumTopic?: boolean } | unknown;
  edit(params: { text: string; parseMode?: string; linkPreview?: boolean }): Promise<unknown>;
}

interface UnitResult {
  chatId: string;
  ids: number[];
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  targetIds?: number[];
  warnings?: string[];
}

interface ArchiveEntry {
  chatId: string;
  chatTitle: string;
  messageId: number;
  groupedId?: string;
  file: string;
  metadata: string;
}

function mainPrefix(): string {
  return safePrefixes()[0] ?? ".";
}

/** 带当前主前缀的命令名（未转义）。 */
function commandName(): string {
  return `${mainPrefix()}${PLUGIN_NAME}`;
}

export function helpText(): string {
  const c = htmlEscape(commandName());
  return `💾 <b>SavePlus — 保存、在线监视与本地中转</b>

<b>手动保存（兼容 save）</b>
• 回复消息发送 <code>${c}</code> [临时目标] — 保存被回复的消息（相册整组）
• <code>${c} 链接1 链接2 …</code> [临时目标] — 批量保存
• <code>${c} 起始链接|结束链接</code> [临时目标] — 同一来源闭区间保存
• 以上命令加 <code>--hide</code> — 原生转发时隐藏“转发自”
• <code>${c} to 目标</code> · <code>${c} target</code> — 设置／查看默认目标
• <code>${c} source on|off</code> · <code>${c} source</code> — 来源说明开关
目标：<code>me</code> 收藏夹、<code>local</code> 本地归档、<code>here</code> 当前会话、<code>@用户名</code>、会话 ID，可加 <code>|话题ID</code>
普通手动保存优先原生转发，受保护内容自动改为复制／下载重传；不套用监视过滤与去重。

<b>在线监视</b>（只处理新消息；默认不跟随编辑；不自动扫描离线历史）
• <code>${c} rule add 来源 目标 [选项…]</code> — 新建监视规则（一个来源一条）
  选项：类型名、<code>silent</code> 静音、<code>forward</code> 原生转发、<code>hide</code> 隐藏发送者、<code>edited</code> 编辑后再存一份、<code>ad</code> 广告过滤
• <code>${c} rule list</code> · <code>${c} rule show ID</code>
• <code>${c} rule target ID 目标</code> — 修改目标（只影响之后接收的消息）
• <code>${c} rule pause|resume ID[,ID]</code> — 暂停只停止接收新消息，已排队任务继续执行
• <code>${c} rule del ID</code> — 删除规则，未完成的任务保留可查
• <code>${c} rule mode ID relay|forward</code> — 本地中转（默认，保留封面）或原生转发（受保护来源自动改为中转）
• <code>${c} rule hide|silent|edited ID on|off</code> — 隐藏发送者／静音／编辑后再存一份
• <code>${c} rule type ID all|photo video …</code> — 类型：text photo video animation sticker voice audio document
• <code>${c} rule bl ID add|del 关键词…</code> · <code>${c} rule bl ID clear</code> — 黑名单（命中即排除）
• <code>${c} rule wl ID on|off</code> · <code>${c} rule wl ID add 正则</code> · <code>${c} rule wl ID del 序号</code> — 白名单
• <code>${c} rule ad ID on|off</code> — 广告过滤：带内联按钮、隐藏链接或自定义表情刷屏的消息不保存
过滤：类型符合 ＋ 未命中广告特征（开启时）＋ 未命中黑名单 ＋（白名单关闭或至少命中一条）。相册按整组判断。
默认<b>本地中转</b>：下载 → 携带来源视频封面上传 → 确认成功后删除中转文件；失败或封面无法保留时保留文件待处理。可按规则改为原生转发。

<b>手动补漏</b>（沿用规则的过滤、目标与成功去重）
• <code>${c} fill 规则ID 起始|结束</code> [expand] [force] — 起止可为消息链接或消息 ID
<code>expand</code> 允许把跨出区间边缘的相册整组纳入；<code>force</code> 忽略成功记录强制重存（仍遵守过滤与封面要求）

<b>整个历史备份</b>（不需要规则，可中断续传，已保存的自动跳过）
• <code>${c} backup 来源 目标</code> [desc] [forward] [hide] [nofilter] [force] — 默认正序（旧→新）、本地中转；来源有规则时沿用其过滤
• <code>${c} backup list</code> · <code>${c} backup status ID</code> · <code>${c} backup pause|resume|cancel ID</code>

<b>任务与状态</b>
• <code>${c} status</code> — 总览 · <code>${c} stats [规则ID|backup ID]</code> — 保存统计 · <code>${c} task</code> — 未完成任务 · <code>${c} task show ID</code>
• <code>${c} task retry ID|all</code> [force] [nocover] — 重试待处理任务（nocover：接受无来源封面）
• <code>${c} task check ID</code> — 核对“结果不确定”的任务 · <code>${c} task resend ID</code> — 确认未发送后重发
• <code>${c} task cancel ID[,ID…]</code> — 取消并删除中转文件；处理中的任务会中断下载，正在发送的等本次发送结束
• <code>${c} task cancel all</code> · <code>${c} task cancel rule 规则ID</code> · <code>${c} task cancel backup 备份ID</code> — 批量取消

<b>规则导出与导入</b>
• <code>${c} export</code> — 导出全部规则 · <code>${c} import</code> 换行粘贴 — 导入（同来源的规则会被更新）
• <code>${c} import shift</code> [forward] — 直接导入现有 shift 规则（已有同来源规则时跳过）`;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function stripCommand(text: string): string | null {
  for (const p of safePrefixes()) {
    if (!text.startsWith(p)) continue;
    const rest = text.slice(p.length);
    const m = new RegExp(`^${PLUGIN_NAME}(?:\\s+|$)`, "i").exec(rest);
    if (m) return rest.slice(m[0].length);
  }
  return null;
}

function chatIdOf(msg: CommandMessage): string | undefined {
  const v = msg.chatId;
  return v === undefined || v === null ? undefined : String(v);
}

function replyIdOf(msg: CommandMessage): number | undefined {
  const r = msg.replyTo as { replyToMsgId?: number; replyToTopId?: number; forumTopic?: boolean } | undefined;
  if (!r || typeof r.replyToMsgId !== "number") return undefined;
  if (r.forumTopic && !r.replyToTopId) return undefined;
  return r.replyToMsgId;
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as { code?: string }).code !== "EXDEV") throw err;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

interface RuleOptions extends DeliveryOptions {
  types?: FilterConfig["types"];
  ads?: boolean;
}

/** 解析规则选项（兼容 shift 的 silent / hide_author / handle_edited 写法）。 */
export function parseRuleOptions(tokens: string[]): RuleOptions {
  const out: RuleOptions = {};
  const kinds: MediaKind[] = [];
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (t === "silent") out.silent = true;
    else if (t === "forward") out.mode = "forward";
    else if (t === "relay") out.mode = "relay";
    else if (t === "hide" || t === "hide_author" || t === "--hide") out.hideAuthor = true;
    else if (t === "edited" || t === "handle_edited") out.handleEdited = true;
    else if (t === "ad" || t === "ads" || t === "noad") out.ads = true;
    else if (t === "all") out.types = "all";
    else if (KIND_ALIASES[t] ?? KIND_ALIASES[raw]) kinds.push((KIND_ALIASES[t] ?? KIND_ALIASES[raw]) as MediaKind);
    else throw new SavePlusError("invalid", `未知选项：${raw}`);
  }
  if (kinds.length && out.types !== "all") out.types = Array.from(new Set(kinds));
  return out;
}

function describeDelivery(o: DeliveryOptions): string {
  const r = deliveryOf(o);
  const parts = [r.mode === "forward" ? `原生转发${r.hideAuthor ? "（隐藏发送者）" : ""}` : "本地中转"];
  if (r.silent) parts.push("静音");
  if (r.handleEdited) parts.push("编辑后再存一份");
  return parts.join(" · ");
}

export class SavePlusCore {
  private readonly peerCache = new Map<string, PeerInfo>();

  constructor(readonly engine: Engine) {}

  private get store(): Store {
    return this.engine.store;
  }
  private get port(): TelegramPort {
    return this.engine.port;
  }
  private get dirs(): EngineDirs {
    return this.engine.deps.dirs;
  }

  private async reply(msg: CommandMessage, html: string): Promise<void> {
    let text = html;
    if (text.length > 4000) text = `${text.slice(0, 3900)}\n…（内容过长已截断）`;
    try {
      await msg.edit({ text, parseMode: "html", linkPreview: false });
    } catch (err) {
      if (!/MESSAGE_NOT_MODIFIED/.test(errorText(err))) throw err;
    }
  }

  private async peer(ref: string): Promise<PeerInfo> {
    const cached = this.peerCache.get(ref);
    if (cached) return cached;
    const info = await this.port.resolvePeer(ref);
    this.peerCache.set(ref, info);
    this.peerCache.set(info.peerId, info);
    return info;
  }

  /** 把目标参数解析为可发送的会话；监视规则不允许本地目标。 */
  async resolveTarget(spec: TargetSpec, opts: { forRule: boolean }): Promise<PeerTarget> {
    if (spec.kind === "local") {
      throw new SavePlusError("invalid", "监视与补漏的目标必须是频道、群组或收藏夹（本地归档仅用于普通手动保存）");
    }
    const info = await this.port.resolvePeer(spec.ref);
    if (!info.canSend) throw new SavePlusError("permission", `目标「${info.title}」不可发送：${info.sendBlockReason || "没有发送权限"}`);
    if (opts.forRule && info.kind === "user") {
      throw new SavePlusError("invalid", "监视目标需要是频道、群组或收藏夹");
    }
    return { peerId: info.peerId, title: info.title, topicId: spec.topicId, isSelf: info.kind === "self" || undefined };
  }

  // ── 入口 ────────────────────────────────────────────────────────────────

  async handle(msg: CommandMessage): Promise<void> {
    const raw = stripCommand(msg.message || "");
    if (raw === null) return;
    const tokens = tokenize(raw);
    const sub = tokens[0]?.toLowerCase();
    try {
      switch (sub) {
        case undefined:
          if (replyIdOf(msg) !== undefined) return await this.manualFromCommand(msg, []);
          return await this.reply(msg, helpText());
        case "help":
        case "h":
          return await this.reply(msg, helpText());
        case "to":
          return await this.setDefaultTarget(msg, tokens.slice(1));
        case "target":
          return await this.reply(msg, `🎯 当前默认目标：<code>${htmlEscape(this.store.data.settings.defaultTarget)}</code>`);
        case "source":
          return await this.sourceSetting(msg, tokens[1]);
        case "rule":
          return await this.ruleCommand(msg, raw);
        case "fill":
          return await this.fillCommand(msg, tokens.slice(1));
        case "task":
          return await this.taskCommand(msg, tokens.slice(1));
        case "status":
          return await this.reply(msg, this.statusText());
        case "stats":
          return await this.reply(msg, this.statsText(tokens.slice(1)));
        case "export":
          return await this.exportRules(msg);
        case "import":
          return await this.importCommand(msg, raw);
        case "backup":
          return await this.backupCommand(msg, tokens.slice(1));
        default:
          return await this.manualFromCommand(msg, tokens);
      }
    } catch (err) {
      const text = err instanceof SavePlusError ? err.message : errorText(err);
      await this.reply(msg, `❌ ${htmlEscape(text)}`).catch((replyErr) => this.engine.deps.log?.("回复命令失败", replyErr));
    }
  }

  private async setDefaultTarget(msg: CommandMessage, args: string[]): Promise<void> {
    if (args.length !== 1) throw new SavePlusError("invalid", `用法：${mainPrefix()}${PLUGIN_NAME} to 目标`);
    const spec = parseTargetSpec(args[0], chatIdOf(msg));
    if ("error" in spec) throw new SavePlusError("invalid", spec.error);
    let stored: string;
    let label: string;
    if (spec.kind === "local") {
      stored = "local";
      label = "本地归档";
    } else {
      const t = await this.resolveTarget(spec, { forRule: false });
      stored = `${spec.ref === "me" ? "me" : t.peerId}${t.topicId ? `|${t.topicId}` : ""}`;
      label = targetLabel(t);
    }
    await this.store.update((d) => {
      d.settings.defaultTarget = stored;
    });
    await this.reply(msg, `✅ 默认目标已设为：<b>${htmlEscape(label)}</b>（<code>${htmlEscape(stored)}</code>）`);
  }

  private async sourceSetting(msg: CommandMessage, arg?: string): Promise<void> {
    if (!arg) {
      return this.reply(msg, `🔗 来源说明：<b>${this.store.data.settings.showSource ? "已开启" : "已关闭"}</b>`);
    }
    const v = arg.toLowerCase();
    if (v !== "on" && v !== "off") throw new SavePlusError("invalid", "用法：source on|off");
    await this.store.update((d) => {
      d.settings.showSource = v === "on";
    });
    await this.reply(msg, `✅ 来源说明已${v === "on" ? "开启" : "关闭"}`);
  }

  // ── 规则 ────────────────────────────────────────────────────────────────

  private rule(idRaw: string | undefined): RuleRecord {
    const id = Number(idRaw);
    const r = this.store.data.rules.find((x) => x.id === id);
    if (!r) throw new SavePlusError("invalid", `规则 ${idRaw ?? ""} 不存在`);
    return r;
  }

  private async touchRule(r: RuleRecord, fn: (r: RuleRecord) => void): Promise<void> {
    await this.store.update(() => {
      fn(r);
      r.updatedAt = this.engine.clock.now();
    });
  }

  private ruleSummary(r: RuleRecord): string {
    return `#${r.id} ${r.enabled ? "▶️" : "⏸"} <b>${htmlEscape(r.sourceTitle)}</b> → <b>${htmlEscape(targetLabel(r.target))}</b>（${htmlEscape(describeDelivery(r))}）`;
  }

  private async ruleCommand(msg: CommandMessage, raw: string): Promise<void> {
    const tokens = tokenize(raw).slice(1);
    const op = tokens[0]?.toLowerCase();
    const c = commandName();
    switch (op) {
      case "add": {
        if (tokens.length < 3) throw new SavePlusError("invalid", `用法：${c} rule add 来源 目标 [选项…]`);
        const ropts = parseRuleOptions(tokens.slice(3));
        const srcSpec = parseTargetSpec(tokens[1], chatIdOf(msg));
        if ("error" in srcSpec || srcSpec.kind !== "peer" || srcSpec.topicId) {
          throw new SavePlusError("invalid", "来源需为 @用户名、会话 ID、t.me 链接或 here");
        }
        const source = await this.port.resolvePeer(srcSpec.ref);
        if (source.kind === "self") throw new SavePlusError("invalid", "不能监视收藏夹");
        const tSpec = parseTargetSpec(tokens[2], chatIdOf(msg));
        if ("error" in tSpec) throw new SavePlusError("invalid", tSpec.error);
        const target = await this.resolveTarget(tSpec, { forRule: true });
        if (target.peerId === source.peerId) throw new SavePlusError("invalid", "来源与目标不能相同");
        const now = this.engine.clock.now();
        const rule = await this.store.update((d) => {
          const exists = d.rules.find((r) => r.sourceChatId === source.peerId);
          if (exists) throw new SavePlusError("invalid", `该来源已有规则 #${exists.id}，请用 rule target 修改目标`);
          const r: RuleRecord = {
            id: d.nextRuleId++,
            sourceChatId: source.peerId,
            sourceTitle: source.title,
            target,
            enabled: true,
            filter: { ...defaultFilter(), types: ropts.types ?? "all", ads: Boolean(ropts.ads) },
            mode: ropts.mode ?? "relay",
            hideAuthor: ropts.hideAuthor || undefined,
            silent: ropts.silent || undefined,
            handleEdited: ropts.handleEdited || undefined,
            createdAt: now,
            updatedAt: now,
          };
          d.rules.push(r);
          return r;
        });
        const typeText =
          (rule.filter.types === "all" ? "全部类型" : rule.filter.types.map((k) => KIND_LABEL[k]).join("、")) +
          (rule.filter.ads ? "，广告过滤已开启" : "");
        const hint =
          rule.hideAuthor && rule.mode !== "forward" ? "\nℹ️ 本地中转本身不显示“转发自”，hide 仅在原生转发时生效" : "";
        return this.reply(msg, `✅ 已创建监视规则\n${this.ruleSummary(rule)}\n过滤：${typeText}，无黑白名单${hint}`);
      }
      case "list":
      case undefined: {
        const rules = this.store.data.rules;
        if (!rules.length) return this.reply(msg, `📋 暂无监视规则。使用 <code>${htmlEscape(c)} rule add 来源 目标</code> 创建`);
        return this.reply(msg, `📋 <b>监视规则</b>\n${rules.map((r) => this.ruleSummary(r)).join("\n")}`);
      }
      case "show": {
        const r = this.rule(tokens[1]);
        return this.reply(
          msg,
          `${this.ruleSummary(r)}\n投递：${htmlEscape(describeDelivery(r))}\n来源 ID：<code>${htmlEscape(r.sourceChatId)}</code>\n目标 ID：<code>${htmlEscape(r.target.peerId)}</code>\n<pre>${htmlEscape(describeFilter(r.filter))}</pre>`
        );
      }
      case "target": {
        const r = this.rule(tokens[1]);
        if (tokens.length !== 3) throw new SavePlusError("invalid", `用法：${c} rule target ID 目标`);
        const spec = parseTargetSpec(tokens[2], chatIdOf(msg));
        if ("error" in spec) throw new SavePlusError("invalid", spec.error);
        const target = await this.resolveTarget(spec, { forRule: true });
        if (target.peerId === r.sourceChatId) throw new SavePlusError("invalid", "来源与目标不能相同");
        await this.touchRule(r, (x) => {
          x.target = target;
        });
        return this.reply(msg, `✅ 规则 #${r.id} 的目标已改为 <b>${htmlEscape(targetLabel(target))}</b>（已排队的任务仍发往原目标）`);
      }
      case "pause":
      case "resume": {
        const ids = parseIdList(tokens[1] || "");
        if (!ids) throw new SavePlusError("invalid", `用法：${c} rule ${op} ID[,ID]`);
        const rules = ids.map((id) => this.rule(String(id)));
        await this.store.update(() => {
          for (const r of rules) {
            r.enabled = op === "resume";
            r.updatedAt = this.engine.clock.now();
          }
        });
        return this.reply(
          msg,
          op === "pause"
            ? `⏸ 已暂停规则 ${ids.join(", ")}：不再接收新消息，已排队的任务继续执行`
            : `▶️ 已恢复规则 ${ids.join(", ")}`
        );
      }
      case "del":
      case "delete":
      case "remove": {
        const r = this.rule(tokens[1]);
        await this.store.update((d) => {
          d.rules = d.rules.filter((x) => x.id !== r.id);
        });
        const open = this.store.data.tasks.filter((t) => t.ruleId === r.id && !FINISHED_STATUSES.has(t.status)).length;
        return this.reply(msg, `🗑 已删除规则 #${r.id}。${open ? `仍有 ${open} 个未完成任务会按原快照执行，可用 task 查看` : ""}`);
      }
      case "type":
      case "types": {
        const r = this.rule(tokens[1]);
        const values = tokens.slice(2).flatMap((v) => v.split(",")).filter(Boolean);
        if (!values.length) throw new SavePlusError("invalid", `用法：${c} rule type ID all|photo video …`);
        let types: FilterConfig["types"];
        if (values.length === 1 && values[0].toLowerCase() === "all") types = "all";
        else {
          const kinds = values.map((v) => KIND_ALIASES[v.toLowerCase()] ?? KIND_ALIASES[v]);
          const bad = values.filter((_, i) => !kinds[i]);
          if (bad.length) throw new SavePlusError("invalid", `未知类型：${bad.join(", ")}`);
          types = Array.from(new Set(kinds as MediaKind[]));
        }
        await this.touchRule(r, (x) => {
          x.filter.types = types;
        });
        return this.reply(msg, `✅ 规则 #${r.id} 类型：${types === "all" ? "全部" : types.map((k) => KIND_LABEL[k]).join("、")}`);
      }
      case "mode": {
        const r = this.rule(tokens[1]);
        const v = tokens[2]?.toLowerCase();
        if (v !== "relay" && v !== "forward") throw new SavePlusError("invalid", `用法：${c} rule mode ID relay|forward`);
        await this.touchRule(r, (x) => {
          x.mode = v;
        });
        const note = v === "forward" ? "；来源受保护时自动改为本地中转" : "（下载后重新上传，保留来源封面）";
        return this.reply(msg, `✅ 规则 #${r.id} 投递方式：${v === "forward" ? "原生转发" : "本地中转"}${note}`);
      }
      case "ad":
      case "ads": {
        const r = this.rule(tokens[1]);
        const v = tokens[2]?.toLowerCase();
        if (v !== "on" && v !== "off") throw new SavePlusError("invalid", `用法：${c} rule ad ID on|off`);
        await this.touchRule(r, (x) => {
          x.filter.ads = v === "on";
        });
        return this.reply(
          msg,
          `✅ 规则 #${r.id} 广告过滤：${v === "on" ? `开启（带内联按钮、隐藏链接或自定义表情≥${CUSTOM_EMOJI_AD_THRESHOLD} 个的消息不保存；相册任一条命中则整组跳过）` : "关闭"}`
        );
      }
      case "hide":
      case "silent":
      case "edited": {
        const r = this.rule(tokens[1]);
        const v = tokens[2]?.toLowerCase();
        if (v !== "on" && v !== "off") throw new SavePlusError("invalid", `用法：${c} rule ${op} ID on|off`);
        const on = v === "on";
        await this.touchRule(r, (x) => {
          if (op === "hide") x.hideAuthor = on || undefined;
          else if (op === "silent") x.silent = on || undefined;
          else x.handleEdited = on || undefined;
        });
        const label = op === "hide" ? "隐藏发送者" : op === "silent" ? "静音发送" : "编辑后再存一份";
        const hint =
          op === "hide" && on && deliveryOf(r).mode !== "forward"
            ? "\nℹ️ 当前为本地中转，本身不显示“转发自”；该选项在原生转发时生效"
            : op === "edited" && on
              ? "\nℹ️ 来源编辑后会再保存一份新版，目标中已有的旧版不会被修改"
              : "";
        return this.reply(msg, `✅ 规则 #${r.id} ${label}：${on ? "开启" : "关闭"}${hint}`);
      }
      case "bl":
      case "blacklist":
        return this.blacklistCommand(msg, tokens);
      case "wl":
      case "whitelist":
        return this.whitelistCommand(msg, raw, tokens);
      default:
        throw new SavePlusError("invalid", `未知的 rule 子命令：${tokens[0]}`);
    }
  }

  private async blacklistCommand(msg: CommandMessage, tokens: string[]): Promise<void> {
    const r = this.rule(tokens[1]);
    const action = tokens[2]?.toLowerCase();
    const words = tokens.slice(3);
    if (action === "add" && words.length) {
      await this.touchRule(r, (x) => {
        x.filter.blacklist = Array.from(new Set([...x.filter.blacklist, ...words]));
      });
    } else if (action === "del" && words.length) {
      const drop = new Set(words.map((w) => w.toLowerCase()));
      await this.touchRule(r, (x) => {
        x.filter.blacklist = x.filter.blacklist.filter((w) => !drop.has(w.toLowerCase()));
      });
    } else if (action === "clear") {
      await this.touchRule(r, (x) => {
        x.filter.blacklist = [];
      });
    } else if (action && action !== "list") {
      throw new SavePlusError("invalid", "用法：rule bl ID add|del 关键词… 或 rule bl ID clear");
    }
    const list = r.filter.blacklist;
    await this.reply(msg, `🚫 规则 #${r.id} 黑名单：${list.length ? list.map((w) => `<code>${htmlEscape(w)}</code>`).join(" ") : "（空）"}`);
  }

  private async whitelistCommand(msg: CommandMessage, raw: string, tokens: string[]): Promise<void> {
    const r = this.rule(tokens[1]);
    const action = tokens[2]?.toLowerCase();
    if (action === "on" || action === "off") {
      if (action === "on" && !r.filter.whitelist.patterns.length) {
        throw new SavePlusError("invalid", "白名单为空，请先用 rule wl ID add 正则 添加表达式");
      }
      await this.touchRule(r, (x) => {
        x.filter.whitelist.enabled = action === "on";
      });
    } else if (action === "add") {
      // 保留原文（含空格），不能按空白分词。
      const m = /^\s*rule\s+(?:wl|whitelist)\s+\S+\s+add\s+([\s\S]+)$/i.exec(raw);
      const pattern = m?.[1]?.trim() ?? "";
      const problem = validateRegex(pattern);
      if (problem) throw new SavePlusError("invalid", problem);
      await this.touchRule(r, (x) => {
        if (!x.filter.whitelist.patterns.includes(pattern)) x.filter.whitelist.patterns.push(pattern);
      });
    } else if (action === "del") {
      const idx = Number(tokens[3]);
      if (!Number.isInteger(idx) || idx < 1 || idx > r.filter.whitelist.patterns.length) {
        throw new SavePlusError("invalid", "请提供要删除的白名单序号");
      }
      await this.touchRule(r, (x) => {
        x.filter.whitelist.patterns.splice(idx - 1, 1);
        if (!x.filter.whitelist.patterns.length) x.filter.whitelist.enabled = false;
      });
    } else if (action === "clear") {
      await this.touchRule(r, (x) => {
        x.filter.whitelist = { enabled: false, patterns: [] };
      });
    } else if (action && action !== "list") {
      throw new SavePlusError("invalid", "用法：rule wl ID on|off|add 正则|del 序号|clear");
    }
    const wl = r.filter.whitelist;
    const list = wl.patterns.map((p, i) => `${i + 1}. <code>${htmlEscape(p)}</code>`).join("\n") || "（空）";
    await this.reply(msg, `✅ 规则 #${r.id} 白名单：<b>${wl.enabled ? "已启用" : "未启用"}</b>\n${list}`);
  }

  // ── 手动补漏 ────────────────────────────────────────────────────────────

  private async parseRangeBound(token: string, rule: RuleRecord): Promise<number> {
    if (/^\d+$/.test(token)) return Number(token);
    const link = parseMessageLink(token);
    if (!link || "error" in link) throw new SavePlusError("invalid", link && "error" in link ? link.error : `无法识别的起止：${token}`);
    const info = await this.peer(link.chatRef);
    if (info.peerId !== rule.sourceChatId) {
      throw new SavePlusError("invalid", `链接 ${token} 不属于规则 #${rule.id} 的来源「${rule.sourceTitle}」`);
    }
    return link.messageId;
  }

  private async fillCommand(msg: CommandMessage, args: string[]): Promise<void> {
    const c = commandName();
    if (args.length < 2) throw new SavePlusError("invalid", `用法：${c} fill 规则ID 起始|结束 [expand] [force]`);
    const rule = this.rule(args[0]);
    const flags = new Set(args.slice(2).map((a) => a.toLowerCase()));
    const unknown = Array.from(flags).filter((f) => f !== "expand" && f !== "force");
    if (unknown.length) throw new SavePlusError("invalid", `未知参数：${unknown.join(" ")}`);
    const bounds = args[1].includes("|") ? args[1].split("|") : args[1].split(/-(?=\d+$)/);
    if (bounds.length !== 2) throw new SavePlusError("invalid", "范围格式：起始|结束（链接或消息 ID）");
    const a = await this.parseRangeBound(bounds[0], rule);
    const b = await this.parseRangeBound(bounds[1], rule);
    await this.progress(msg, `⏳ 正在规划规则 #${rule.id} 的补漏范围 ${Math.min(a, b)}–${Math.max(a, b)}…`);
    const summary = await this.backfill(rule, a, b, { expand: flags.has("expand"), force: flags.has("force") });
    await this.reply(msg, summary);
  }

  async backfill(rule: RuleRecord, a: number, b: number, flags: { expand: boolean; force: boolean }): Promise<string> {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    const span = max - min + 1;
    if (span > this.engine.options.maxRangeSpan) {
      throw new SavePlusError("invalid", `范围过大（${span} 条），单次上限 ${this.engine.options.maxRangeSpan} 条，请分段补漏`);
    }
    const ids = Array.from({ length: span }, (_, i) => min + i);
    const readOpts = { maxWaitSeconds: this.engine.options.fillMaxFloodWaitSeconds };
    const fetched = await this.engine.readMessages(rule.sourceChatId, ids, readOpts);
    const singles: SourceMessage[] = [];
    const groups = new Map<string, SourceMessage[]>();
    for (const m of Array.from(fetched.values()).sort((x, y) => x.id - y.id)) {
      if (m.groupedId) groups.set(m.groupedId, [...(groups.get(m.groupedId) || []), m]);
      else singles.push(m);
    }
    const edgeExcluded: string[] = [];
    if (groups.size) {
      const probe = this.engine.options.albumProbeSpan;
      const outside: number[] = [];
      for (let id = Math.max(1, min - probe); id < min; id++) outside.push(id);
      for (let id = max + 1; id <= max + probe; id++) outside.push(id);
      const around = await this.engine.readMessages(rule.sourceChatId, outside, readOpts);
      for (const [gid, members] of groups) {
        const extra = Array.from(around.values()).filter((m) => m.groupedId === gid);
        if (!extra.length) continue;
        if (flags.expand) {
          groups.set(gid, [...members, ...extra].sort((x, y) => x.id - y.id));
        } else {
          groups.delete(gid);
          const all = [...members, ...extra].map((m) => m.id).sort((x, y) => x - y);
          edgeExcluded.push(`${all[0]}–${all[all.length - 1]}`);
        }
      }
    }
    const units: SourceMessage[][] = [...singles.map((m) => [m]), ...Array.from(groups.values())].sort(
      (x, y) => x[0].id - y[0].id
    );
    const count = { queued: 0, filtered: 0, saved: 0, claimed: 0, attention: 0 };
    const reasons = new Map<string, number>();
    for (const unit of units) {
      const res = await this.engine.admitUnit(specFromRule(rule), unit, {
        kind: "backfill",
        groupedId: unit[0].groupedId,
        force: flags.force,
      });
      if (res.outcome === "queued") count.queued++;
      else if (res.outcome === "attention") count.attention++;
      else if (res.category === "filtered") {
        count.filtered++;
        reasons.set(res.reason || "过滤", (reasons.get(res.reason || "过滤") ?? 0) + 1);
      } else if (res.category === "saved") count.saved++;
      else count.claimed++;
    }
    const missing = ids.filter((id) => !fetched.has(id)).length;
    const lines = [
      `📥 <b>补漏规划完成</b> · 规则 #${rule.id}（${htmlEscape(rule.sourceTitle)} → ${htmlEscape(targetLabel(rule.target))}）`,
      `范围：${min}–${max}（${span} 个 ID，读取到 ${fetched.size} 条，${missing} 个 ID 不存在或无法读取）`,
      `已加入队列：${count.queued} 个保存单位`,
      `已保存跳过：${count.saved} · 进行中跳过：${count.claimed} · 过滤跳过：${count.filtered} · 待处理：${count.attention}`,
    ];
    if (reasons.size) {
      lines.push(
        `过滤原因：${Array.from(reasons.entries())
          .slice(0, 5)
          .map(([r, n]) => `${htmlEscape(r)}×${n}`)
          .join("；")}`
      );
    }
    if (edgeExcluded.length) {
      lines.push(`⚠️ 跨出区间边缘的相册未纳入（${edgeExcluded.join("，")}）；如需整组保存，请加 <code>expand</code> 重新执行`);
    }
    if (flags.force) lines.push("⚠️ 已启用 force：忽略成功记录强制重存");
    if (!rule.enabled) lines.push("ℹ️ 规则当前已暂停；补漏任务仍会执行");
    lines.push(`进度可用 <code>${htmlEscape(commandName())} task</code> 查看`);
    return lines.join("\n");
  }

  // ── 普通手动保存 ─────────────────────────────────────────────────────────

  private async manualFromCommand(msg: CommandMessage, allTokens: string[]): Promise<void> {
    const current = chatIdOf(msg);
    const hideFlags = new Set(["--hide", "hide_author"]);
    const hideAuthor = allTokens.some((t) => hideFlags.has(t.toLowerCase()));
    const tokens = allTokens.filter((t) => !hideFlags.has(t.toLowerCase()));
    const links: MessageLink[] = [];
    let range: { a: MessageLink; b: MessageLink } | undefined;
    let target: TargetSpec | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.includes("|") && tok.split("|").every((part) => looksLikeLink(part))) {
        if (range || links.length) throw new SavePlusError("invalid", "范围保存一次只能指定一个“起始|结束”");
        const [ra, rb] = tok.split("|").map((part) => parseMessageLink(part));
        if (!ra || !rb || "error" in ra || "error" in rb) {
          throw new SavePlusError("invalid", (ra && "error" in ra && ra.error) || (rb && "error" in rb && rb.error) || "范围链接无效");
        }
        range = { a: ra, b: rb };
        continue;
      }
      if (looksLikeLink(tok)) {
        if (range) throw new SavePlusError("invalid", "范围保存不能与其他链接混用");
        const link = parseMessageLink(tok);
        if (!link || "error" in link) throw new SavePlusError("invalid", link && "error" in link ? link.error : `无法识别：${tok}`);
        links.push(link);
        continue;
      }
      if (i === tokens.length - 1) {
        const spec = parseTargetSpec(tok, current);
        if ("error" in spec) throw new SavePlusError("invalid", spec.error);
        target = spec;
        continue;
      }
      throw new SavePlusError("invalid", `无法识别的参数：${tok}`);
    }
    const replyId = replyIdOf(msg);
    if (!links.length && !range) {
      if (replyId === undefined || !current) {
        return this.reply(msg, helpText());
      }
    }
    if (!target) {
      const spec = parseTargetSpec(this.store.data.settings.defaultTarget, current);
      if ("error" in spec) throw new SavePlusError("invalid", `默认目标无效：${spec.error}`);
      target = spec;
    }
    await this.progress(msg, "⏳ 正在读取消息…");
    const units = await this.collectManualUnits({ links, range, reply: !links.length && !range ? { chatId: current as string, id: replyId as number } : undefined });
    if (!units.unitList.length) {
      return this.reply(msg, `❌ 没有可保存的消息${units.notes.length ? `\n${units.notes.map((n) => htmlEscape(n)).join("\n")}` : ""}`);
    }
    if (target.kind === "local") {
      return this.manualToLocal(msg, units.unitList, units.notes);
    }
    const peerTarget = await this.resolveTarget(target, { forRule: false });
    return this.manualToPeer(msg, peerTarget, units.unitList, units.notes, Boolean(range), hideAuthor);
  }

  /** 读取手动保存的消息并归为保存单位：回复与链接模式补全相册整组；范围模式按区间内成员成组。 */
  private async collectManualUnits(input: {
    links: MessageLink[];
    range?: { a: MessageLink; b: MessageLink };
    reply?: { chatId: string; id: number };
  }): Promise<{ unitList: Array<{ info: PeerInfo; members: SourceMessage[] }>; notes: string[] }> {
    const notes: string[] = [];
    const unitList: Array<{ info: PeerInfo; members: SourceMessage[] }> = [];
    const seen = new Set<string>();
    const probe = this.engine.options.albumProbeSpan;
    const pushUnit = (info: PeerInfo, members: SourceMessage[]) => {
      const key = members[0].groupedId ? `${info.peerId}:g${members[0].groupedId}` : `${info.peerId}:${members[0].id}`;
      if (seen.has(key)) return;
      seen.add(key);
      unitList.push({ info, members });
    };
    const expandAlbum = async (info: PeerInfo, m: SourceMessage): Promise<SourceMessage[]> => {
      if (!m.groupedId) return [m];
      const around: number[] = [];
      for (let id = Math.max(1, m.id - probe); id <= m.id + probe; id++) around.push(id);
      const near = await this.port.getMessages(info.peerId, around);
      const members = Array.from(near.values()).filter((x) => x.groupedId === m.groupedId);
      if (!members.some((x) => x.id === m.id)) members.push(m);
      return members.sort((x, y) => x.id - y.id);
    };
    if (input.reply) {
      const info = await this.peer(input.reply.chatId);
      const got = await this.port.getMessages(info.peerId, [input.reply.id]);
      const m = got.get(input.reply.id);
      if (!m) notes.push(`被回复的消息 ${input.reply.id} 无法读取`);
      else pushUnit(info, await expandAlbum(info, m));
    }
    if (input.links.length) {
      const byChat = new Map<string, MessageLink[]>();
      for (const l of input.links) byChat.set(l.chatRef, [...(byChat.get(l.chatRef) || []), l]);
      for (const [chatRef, list] of byChat) {
        let info: PeerInfo;
        try {
          info = await this.peer(chatRef);
        } catch (err) {
          notes.push(`无法访问 ${chatRef}：${classifyError(err, "read").message}`);
          continue;
        }
        const got = await this.port.getMessages(info.peerId, list.map((l) => l.messageId));
        for (const l of list) {
          const m = got.get(l.messageId);
          if (!m) {
            notes.push(`消息不存在或无法读取：${l.raw}`);
            continue;
          }
          pushUnit(info, await expandAlbum(info, m));
        }
      }
    }
    if (input.range) {
      const ia = await this.peer(input.range.a.chatRef);
      const ib = await this.peer(input.range.b.chatRef);
      if (ia.peerId !== ib.peerId) throw new SavePlusError("invalid", "范围保存的起止链接必须属于同一会话");
      const min = Math.min(input.range.a.messageId, input.range.b.messageId);
      const max = Math.max(input.range.a.messageId, input.range.b.messageId);
      const span = max - min + 1;
      if (span > this.engine.options.maxRangeSpan) {
        throw new SavePlusError("invalid", `范围过大（${span} 条），单次上限 ${this.engine.options.maxRangeSpan} 条`);
      }
      const got = await this.engine.readMessages(
        ia.peerId,
        Array.from({ length: span }, (_, i) => min + i),
        { maxWaitSeconds: this.engine.options.fillMaxFloodWaitSeconds }
      );
      const groups = new Map<string, SourceMessage[]>();
      const ordered: SourceMessage[][] = [];
      for (const m of Array.from(got.values()).sort((x, y) => x.id - y.id)) {
        if (!m.groupedId) {
          ordered.push([m]);
          continue;
        }
        const g = groups.get(m.groupedId);
        if (g) g.push(m);
        else {
          const list = [m];
          groups.set(m.groupedId, list);
          ordered.push(list);
        }
      }
      for (const members of ordered) pushUnit(ia, members);
      const missing = span - got.size;
      if (missing > 0) notes.push(`区间内 ${missing} 个消息 ID 不存在或无法读取，已跳过`);
    }
    return { unitList, notes };
  }

  /** 手动保存可以在命令中等待的最长限流时间（秒）；更长时停止本次保存并说明。 */
  private static readonly MANUAL_MAX_WAIT_SECONDS = 120;

  /**
   * 以手动保存的节奏发送；weight 为本次发出的消息条数。
   * 限流针对整个账号：任何限流都会让后台任务一起冷却；等待时间过长时直接报错，不让命令长时间挂起。
   */
  private async withFloodRetry<T>(
    fn: () => Promise<T>,
    target?: PeerTarget,
    idsOf?: (r: T) => number[],
    weight = 1
  ): Promise<T> {
    const maxWait = SavePlusCore.MANUAL_MAX_WAIT_SECONDS;
    for (let attempt = 0; ; attempt++) {
      const pending = Math.ceil(this.engine.manualLimiter.cooldownRemainingMs / 1000);
      if (pending > maxWait) {
        throw new SavePlusError("flood", `账号正在 Telegram 限流冷却中，还需等待 ${pending} 秒`, { seconds: pending });
      }
      await this.engine.manualLimiter.acquire(undefined, weight);
      try {
        if (target && idsOf) return await this.engine.withInflight(target, fn, idsOf);
        return await fn();
      } catch (err) {
        const c = classifyError(err, "send");
        if (c.code !== "flood") throw c;
        const seconds = c.seconds ?? 1;
        this.engine.applyFloodCooldown((seconds + 1) * 1000);
        if (attempt < 2 && seconds <= maxWait) continue;
        throw new SavePlusError("flood", `触发 Telegram 限流，需要等待 ${seconds} 秒`, { seconds });
      }
    }
  }

  /** 发送进度提示；失败（例如命令消息已被删除）不影响命令继续执行。 */
  private async progress(msg: CommandMessage, html: string): Promise<void> {
    await this.reply(msg, html).catch(() => undefined);
  }

  private async copyUnit(target: PeerTarget, members: SourceMessage[]): Promise<{ ids: number[]; warnings: string[] }> {
    if (members.some((m) => !m.reuploadable)) {
      const bad = members.find((m) => !m.reuploadable) as SourceMessage;
      throw new SavePlusError("unsupported", bad.unsupportedReason || "该消息不能复制");
    }
    if (members.length === 1 && members[0].kind === "text") {
      const m = members[0];
      const id = await this.withFloodRetry(
        () => this.port.sendText(target, m.text, m.entities, { linkPreview: m.webPreview }),
        target,
        (r) => [r],
        1
      );
      return { ids: [id], warnings: [] };
    }
    const job = path.join(this.dirs.manual, `job_${Date.now()}_${randomBytes(3).toString("hex")}`);
    try {
      const items: StagedItem[] = [];
      for (const m of members) items.push(await this.port.stageMedia(m, job));
      const warnings: string[] = [];
      for (const it of items) {
        if (it.kind === "video" && (it.coverKind === "none" || it.coverKind === "stripped")) {
          warnings.push(`视频 ${it.messageId} 无法获取来源封面，已按普通上传发送`);
        }
      }
      const sent = await this.withFloodRetry(
        () => this.port.sendStaged(target, items, { topicId: target.topicId }),
        target,
        (r) => r.messageIds,
        items.length
      );
      return { ids: sent.messageIds, warnings: [...warnings, ...sent.warnings] };
    } finally {
      await fsp.rm(job, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async manualToPeer(
    msg: CommandMessage,
    target: PeerTarget,
    units: Array<{ info: PeerInfo; members: SourceMessage[] }>,
    notes: string[],
    isRange: boolean,
    hideAuthor = false
  ): Promise<void> {
    const results: UnitResult[] = [];
    let lastProgress = 0;
    let floodStop: string | undefined;
    for (let i = 0; i < units.length; i++) {
      const { info, members } = units[i];
      const ids = members.map((m) => m.id);
      if (floodStop) {
        results.push({ chatId: info.peerId, ids, ok: false, reason: `未执行：${floodStop}` });
        continue;
      }
      const now = Date.now();
      if (now - lastProgress > 1500) {
        lastProgress = now;
        await this.progress(msg, `⏳ 正在保存 ${i + 1}/${units.length} → ${htmlEscape(targetLabel(target))}`);
      }
      try {
        let targetIds: number[];
        let warnings: string[] = [];
        const restricted = info.noforwards || members.some((m) => m.noforwards);
        if (!restricted) {
          try {
            targetIds = await this.withFloodRetry(
              () => this.port.forwardMessages(target, info.peerId, ids, { dropAuthor: hideAuthor }),
              target,
              (r) => r,
              ids.length
            );
          } catch (err) {
            if (classifyError(err, "send").code !== "forward_restricted") throw err;
            ({ ids: targetIds, warnings } = await this.copyUnit(target, members));
          }
        } else {
          ({ ids: targetIds, warnings } = await this.copyUnit(target, members));
        }
        results.push({ chatId: info.peerId, ids, ok: true, targetIds, warnings });
      } catch (err) {
        const c = classifyError(err, "send");
        results.push({ chatId: info.peerId, ids, ok: false, reason: c.message });
        if (c.code === "flood") floodStop = c.message;
      }
    }
    const ok = results.filter((r) => r.ok);
    if (floodStop) notes.push(`因限流停止，剩余项目未发送；${floodStop}，之后可重新执行`);
    if (this.store.data.settings.showSource && ok.length && !floodStop) {
      await this.sendSourceNote(target, ok, units, isRange).catch((err) => notes.push(`来源说明发送失败：${classifyError(err, "send").message}`));
    }
    await this.reply(msg, this.manualSummary(target, results, notes));
  }

  private manualSummary(target: PeerTarget, results: UnitResult[], notes: string[]): string {
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const msgCount = ok.reduce((n, r) => n + r.ids.length, 0);
    const lines = [
      failed.length ? (ok.length ? "⚠️ <b>部分保存完成</b>" : "❌ <b>保存失败</b>") : "✅ <b>保存完成</b>",
      `目标：${htmlEscape(targetLabel(target))}`,
      `成功：${ok.length} 个保存单位（${msgCount} 条消息）· 失败：${failed.length}`,
    ];
    for (const f of failed.slice(0, 10)) lines.push(`• ${f.ids.join(",")}：${htmlEscape(f.reason)}`);
    for (const r of ok) for (const w of r.warnings || []) lines.push(`⚠️ ${htmlEscape(w)}`);
    for (const n of notes) lines.push(`ℹ️ ${htmlEscape(n)}`);
    return lines.join("\n");
  }

  private async sendSourceNote(
    target: PeerTarget,
    ok: UnitResult[],
    units: Array<{ info: PeerInfo; members: SourceMessage[] }>,
    isRange: boolean
  ): Promise<void> {
    const infoOf = (chatId: string) => units.find((u) => u.info.peerId === chatId)?.info;
    const last = ok[ok.length - 1];
    const replyTo = last.targetIds?.[last.targetIds.length - 1];
    let html: string;
    if (ok.length === 1) {
      const info = infoOf(last.chatId);
      const id = last.ids[0];
      html =
        `🔗 <b>消息来源</b>\n\n📝 <a href="${htmlEscape(messageLink(last.chatId, id, info?.username))}">查看原消息</a>\n` +
        `👤 来源对话：<b>${htmlEscape(info?.title ?? last.chatId)}</b>\n#️⃣ 消息ID：<code>${last.ids.join(", ")}</code>`;
    } else if (isRange) {
      const info = infoOf(ok[0].chatId);
      const first = ok[0].ids[0];
      const end = last.ids[last.ids.length - 1];
      html =
        `🔗 <b>范围保存来源</b>\n\n👤 <b>${htmlEscape(info?.title ?? ok[0].chatId)}</b>\n` +
        `▶️ <a href="${htmlEscape(messageLink(ok[0].chatId, first, info?.username))}">起始消息 ${first}</a>\n` +
        `⏹ <a href="${htmlEscape(messageLink(ok[0].chatId, end, info?.username))}">结尾消息 ${end}</a>`;
    } else {
      const byChat = new Map<string, number[]>();
      for (const r of ok) byChat.set(r.chatId, [...(byChat.get(r.chatId) || []), ...r.ids]);
      const sections = Array.from(byChat.entries()).map(([chatId, ids]) => {
        const info = infoOf(chatId);
        const ranges = compactRanges(ids)
          .map(([s, t]) =>
            s === t
              ? `<a href="${htmlEscape(messageLink(chatId, s, info?.username))}">${s}</a>`
              : `<a href="${htmlEscape(messageLink(chatId, s, info?.username))}">${s}</a>–<a href="${htmlEscape(messageLink(chatId, t, info?.username))}">${t}</a>`
          )
          .join(", ");
        return `👤 <b>${htmlEscape(info?.title ?? chatId)}</b>（${new Set(ids).size} 条）：${ranges}`;
      });
      const body = sections.join("\n");
      html = `🔗 <b>批量保存来源</b>\n\n${body.length > 350 || sections.length > 6 ? `<blockquote expandable>${body}</blockquote>` : body}`;
    }
    await this.withFloodRetry(
      () => this.port.sendText(target, html, [], { html: true, replyTo, linkPreview: false }),
      target,
      (r) => [r],
      1
    );
  }

  // ── 纯本地归档 ───────────────────────────────────────────────────────────

  private async manualToLocal(
    msg: CommandMessage,
    units: Array<{ info: PeerInfo; members: SourceMessage[] }>,
    notes: string[]
  ): Promise<void> {
    const archive = this.dirs.archive;
    await fsp.mkdir(archive, { recursive: true });
    const entries: ArchiveEntry[] = [];
    let skipped = 0;
    const failures: string[] = [];
    let lastProgress = 0;
    const total = units.reduce((n, u) => n + u.members.length, 0);
    let done = 0;
    for (const { info, members } of units) {
      for (const m of members) {
        done++;
        if (Date.now() - lastProgress > 1500) {
          lastProgress = Date.now();
          await this.progress(msg, `⏳ 正在保存到本地 ${done}/${total}`);
        }
        if (m.kind === "text") {
          skipped++;
          continue;
        }
        if (!m.reuploadable) {
          failures.push(`${m.id}：${m.unsupportedReason || "不支持的消息类型"}`);
          continue;
        }
        const job = path.join(this.dirs.manual, `job_${Date.now()}_${randomBytes(3).toString("hex")}`);
        try {
          const freeCheckDir = archive;
          const free = await (this.engine.deps.diskFree ?? defaultDiskFree)(freeCheckDir);
          if (free !== undefined && free < (m.size ?? 0) + this.engine.options.diskMarginBytes) {
            throw new SavePlusError("disk_full", `磁盘空间不足（可用 ${formatBytes(free)}）`);
          }
          const item = await this.port.stageMedia(m, job);
          if (!item.mediaFile) throw new SavePlusError("unsupported", "没有可保存的媒体文件");
          const chatDir = path.join(archive, sanitizeFileName(info.peerId, "chat"));
          const dir = m.groupedId ? path.join(chatDir, `group_${sanitizeFileName(m.groupedId, "album")}`) : chatDir;
          if (!isInside(archive, dir)) throw new SavePlusError("internal", "归档路径越界");
          await fsp.mkdir(dir, { recursive: true });
          const original = path.basename(item.mediaFile).replace(/^m\d+_/, "");
          const dest = await uniquePath(dir, `msg_${m.id}_${sanitizeFileName(original, "media.bin")}`);
          if (!isInside(archive, dest)) throw new SavePlusError("internal", "归档路径越界");
          await moveFile(item.mediaFile, dest);
          const metaPath = `${dest}.json`;
          const meta = {
            savedAt: new Date().toISOString(),
            source: {
              chatId: info.peerId,
              chatTitle: info.title,
              messageId: m.id,
              groupedId: m.groupedId,
              link: messageLink(info.peerId, m.id, info.username),
              date: new Date(m.date * 1000).toISOString(),
            },
            media: {
              kind: m.kind,
              fileName: path.basename(dest),
              originalFileName: m.fileName,
              mimeType: item.mimeType,
              size: item.size,
              attributes: item.attributes,
            },
            caption: m.text,
          };
          await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
          entries.push({
            chatId: info.peerId,
            chatTitle: info.title,
            messageId: m.id,
            groupedId: m.groupedId,
            file: path.relative(archive, dest),
            metadata: path.relative(archive, metaPath),
          });
        } catch (err) {
          failures.push(`${m.id}：${classifyError(err, "read").message}`);
        } finally {
          await fsp.rm(job, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    let indexPath: string | undefined;
    if (entries.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      indexPath = await uniquePath(archive, `index_${stamp}.json`);
      const bySource = new Map<string, ArchiveEntry[]>();
      for (const en of entries) bySource.set(en.chatId, [...(bySource.get(en.chatId) || []), en]);
      const index = {
        createdAt: new Date().toISOString(),
        total: entries.length,
        sources: Array.from(bySource.entries()).map(([chatId, list]) => ({
          chatId,
          chatTitle: list[0].chatTitle,
          messages: list
            .sort((x, y) => x.messageId - y.messageId)
            .map((en) => ({ messageId: en.messageId, groupedId: en.groupedId, file: en.file, metadata: en.metadata })),
        })),
      };
      await fsp.writeFile(indexPath, JSON.stringify(index, null, 2));
    }
    const lines = [
      failures.length ? (entries.length ? "⚠️ <b>本地保存部分完成</b>" : "❌ <b>本地保存失败</b>") : "✅ <b>本地保存完成</b>",
      `目录：<code>${htmlEscape(archive)}</code>`,
      `已保存媒体：${entries.length} · 纯文字跳过：${skipped} · 失败：${failures.length}`,
    ];
    if (indexPath) lines.push(`索引：<code>${htmlEscape(path.basename(indexPath))}</code>`);
    for (const f of failures.slice(0, 10)) lines.push(`• ${htmlEscape(f)}`);
    for (const n of notes) lines.push(`ℹ️ ${htmlEscape(n)}`);
    await this.reply(msg, lines.join("\n"));
  }

  // ── 任务与状态 ───────────────────────────────────────────────────────────

  private taskLine(t: TaskRecord): string {
    const ids = compactRanges(t.memberIds)
      .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
      .join(",");
    const kind = t.kind === "backfill" ? "补漏" : t.kind === "backup" ? `备份#${t.jobId}` : t.editVersion ? "监视·编辑版" : "监视";
    const active = t.status === "queued" || t.status === "running" || t.status === "sending";
    const err =
      t.lastError && t.status !== "done"
        ? ` — ${active ? "上次失败：" : ""}${htmlEscape(t.lastError.message.slice(0, 120))}`
        : "";
    return `#${t.id} [${STATUS_LABEL[t.status]}] ${kind} ${htmlEscape(t.sourceTitle)}:${ids} → ${htmlEscape(targetLabel(t.target))}${err}`;
  }

  /** 列出任务中转目录里尚未下载完成的文件及已下载大小。 */
  private partialDownloads(t: TaskRecord): string | undefined {
    const dir = t.stagingDir;
    if (!dir || !fs.existsSync(dir)) return undefined;
    try {
      const parts = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".part"))
        .map((f) => {
          const id = /^m(\d+)_/.exec(f)?.[1];
          return `消息 ${id ?? "?"} 已下载 ${formatBytes(fs.statSync(path.join(dir, f)).size)}`;
        });
      return parts.length ? parts.join("，") : undefined;
    } catch {
      return undefined;
    }
  }

  /** task cancel ID | ID,ID… | all | rule 规则ID | backup 备份ID */
  private async cancelCommand(msg: CommandMessage, args: string[]): Promise<void> {
    const c = commandName();
    const scope = args[0]?.toLowerCase();
    const usage = `用法：${c} task cancel ID[,ID…] | all | rule 规则ID | backup 备份ID`;
    if (!scope) throw new SavePlusError("invalid", usage);
    if (/^\d+$/.test(scope)) {
      return this.reply(msg, `🛑 ${htmlEscape(await this.engine.cancelTask(Number(scope)))}`);
    }
    let match: (t: TaskRecord) => boolean;
    let label: string;
    if (scope === "all") {
      match = () => true;
      label = "全部未完成任务";
    } else if (scope === "rule") {
      const r = this.rule(args[1]);
      match = (t) => t.ruleId === r.id && !t.jobId;
      label = `规则 #${r.id} 的任务`;
    } else if (scope === "backup") {
      const b = this.engine.getBackup(Number(args[1]));
      if (!b) throw new SavePlusError("invalid", `备份 ${args[1] ?? ""} 不存在`);
      match = (t) => t.jobId === b.id;
      label = `备份 #${b.id} 的任务（备份本身仍会继续读取，如需停止请用 backup cancel ${b.id}）`;
    } else {
      const ids = parseIdList(scope);
      if (!ids) throw new SavePlusError("invalid", usage);
      const missing = ids.filter((id) => !this.engine.getTask(id));
      if (missing.length) throw new SavePlusError("invalid", `任务不存在：${missing.join(", ")}`);
      const wanted = new Set(ids);
      match = (t) => wanted.has(t.id);
      label = `任务 ${ids.join(", ")}`;
    }
    const r = await this.engine.cancelMany(match);
    if (!r.matched) return this.reply(msg, `📭 ${htmlEscape(label)}：没有可取消的任务`);
    const lines = [`🛑 <b>已处理取消</b>：${htmlEscape(label)}`, `已取消 ${r.cancelled} 个（中转文件已删除）`];
    if (r.stopping) lines.push(`正在停止 ${r.stopping} 个处理中的任务：中断下载后取消`);
    if (r.afterSend) lines.push(`${r.afterSend} 个正在发送：请求无法撤回，本次发送结束后停止（已发出则保留为已完成）`);
    return this.reply(msg, lines.join("\n"));
  }

  private async taskCommand(msg: CommandMessage, args: string[]): Promise<void> {
    const op = args[0]?.toLowerCase();
    const c = commandName();
    const idArg = () => {
      const id = Number(args[1]);
      if (!Number.isInteger(id) || id <= 0) throw new SavePlusError("invalid", "请提供任务 ID");
      return id;
    };
    switch (op) {
      case undefined:
      case "list": {
        const scope = args[1]?.toLowerCase();
        let tasks = this.store.data.tasks;
        if (scope === "all") tasks = tasks.slice(-30);
        else if (scope === "attention") tasks = tasks.filter((t) => t.status === "needs_attention");
        else if (scope === "uncertain") tasks = tasks.filter((t) => t.status === "uncertain");
        else tasks = tasks.filter((t) => !FINISHED_STATUSES.has(t.status));
        if (!tasks.length) return this.reply(msg, "📭 没有符合条件的任务");
        const shown = tasks.slice(-25);
        return this.reply(
          msg,
          `🗂 <b>任务</b>（显示 ${shown.length}/${tasks.length}）\n${shown.map((t) => this.taskLine(t)).join("\n")}\n\n<code>${htmlEscape(c)} task show ID</code> 查看详情`
        );
      }
      case "show": {
        const t = this.engine.getTask(idArg());
        if (!t) throw new SavePlusError("invalid", `任务 #${args[1]} 不存在`);
        const lines = [
          this.taskLine(t),
          `规则：#${t.ruleId} · 创建：${new Date(t.createdAt).toLocaleString()} · 更新：${new Date(t.updatedAt).toLocaleString()}`,
          `重试：${t.attempts} 次 · 限流等待：${t.floodWaits} 次${t.force ? " · 强制重存" : ""}${t.allowNoCover ? " · 接受无封面" : ""}`,
        ];
        const active = t.status === "queued" || t.status === "running" || t.status === "sending";
        if (t.nextAttemptAt && (t.status === "retry_wait" || t.status === "cleanup_pending")) {
          lines.push(`下次尝试：${new Date(t.nextAttemptAt).toLocaleString()}`);
        }
        const partial = this.partialDownloads(t);
        if (partial) lines.push(`正在下载：${partial}`);
        if (t.staged?.length) {
          lines.push(
            `中转文件：${t.staged
              .map((s) => `${s.messageId}(${KIND_LABEL[s.kind]}${s.coverKind ? `·封面:${s.coverKind}` : ""}${s.size ? `·${formatBytes(s.size)}` : ""})`)
              .join("，")}`
          );
          if (t.stagingDir) lines.push(`中转目录：<code>${htmlEscape(t.stagingDir)}</code>`);
        }
        if (t.result) lines.push(`目标消息：${t.result.messageIds.join(", ")}（确认方式：${t.result.via}）`);
        for (const w of t.warnings || []) lines.push(`⚠️ ${htmlEscape(w)}`);
        if (t.lastError) lines.push(`${active ? "上次失败原因" : "原因"}：${htmlEscape(t.lastError.message)}`);
        return this.reply(msg, lines.join("\n"));
      }
      case "retry": {
        const flags = new Set(args.slice(2).map((a) => a.toLowerCase()));
        if (args[1]?.toLowerCase() === "all") {
          const n = await this.engine.retryAll();
          return this.reply(msg, `🔁 已重新排队 ${n} 个任务`);
        }
        const text = await this.engine.retryTask(idArg(), { force: flags.has("force"), allowNoCover: flags.has("nocover") });
        return this.reply(msg, `🔁 ${htmlEscape(text)}`);
      }
      case "check":
        return this.reply(msg, `🔎 ${htmlEscape(await this.engine.checkTask(idArg()))}`);
      case "resend":
        return this.reply(msg, `📤 ${htmlEscape(await this.engine.resendTask(idArg()))}`);
      case "cancel":
        return this.cancelCommand(msg, args.slice(1));
      default:
        throw new SavePlusError("invalid", `未知的 task 子命令：${args[0]}`);
    }
  }

  // ── 统计 ────────────────────────────────────────────────────────────────

  statsText(args: string[] = []): string {
    const d = this.store.data;
    const now = this.engine.clock.now();
    const today = dayKey(now);
    const weekStart = dayKey(now - 6 * 86_400_000);
    const sum = (scope: string, from: string) => {
      let units = 0;
      let messages = 0;
      for (const [day, bucket] of Object.entries(d.stats)) {
        if (day < from) continue;
        const c = bucket[scope];
        if (c) {
          units += c.units;
          messages += c.messages;
        }
      }
      return { units, messages };
    };
    const fmt = (c: { units: number; messages: number }) => `${c.units} 单位／${c.messages} 条`;
    const daily = (scope: string, title: string) => {
      const days = Object.keys(d.stats)
        .filter((day) => d.stats[day][scope])
        .sort()
        .reverse()
        .slice(0, 14);
      const rows = days.map((day) => `${day}：${fmt(d.stats[day][scope])}`);
      return `📈 <b>${title} 保存统计</b>\n${rows.join("\n") || "暂无数据"}`;
    };
    if (args[0]?.toLowerCase() === "backup") {
      const b = this.engine.getBackup(Number(args[1]));
      if (!b) throw new SavePlusError("invalid", `备份 ${args[1] ?? ""} 不存在`);
      return daily(`backup:${b.id}`, `备份 #${b.id}（${htmlEscape(b.sourceTitle)} → ${htmlEscape(targetLabel(b.target))}）`);
    }
    const arg = args[0];
    if (arg) {
      const r = this.rule(arg);
      const scope = `rule:${r.id}`;
      const days = Object.keys(d.stats)
        .filter((day) => d.stats[day][scope])
        .sort()
        .reverse()
        .slice(0, 14);
      const rows = days.map((day) => `${day}：${fmt(d.stats[day][scope])}`);
      return `📈 <b>规则 #${r.id} 保存统计</b>（${htmlEscape(r.sourceTitle)} → ${htmlEscape(targetLabel(r.target))}）\n${rows.join("\n") || "暂无数据"}`;
    }
    const scopes = new Set<string>();
    for (const bucket of Object.values(d.stats)) for (const k of Object.keys(bucket)) scopes.add(k);
    if (!scopes.size) return "📈 暂无保存统计";
    const lines = [`📈 <b>保存统计</b>（今日／近 7 天／保留期内，保留 ${this.engine.options.statsRetentionDays} 天）`];
    const label = (scope: string) => {
      const [kind, id] = scope.split(":");
      if (kind === "backup") {
        const b = this.engine.getBackup(Number(id));
        return `备份 #${id}${b ? ` ${htmlEscape(b.sourceTitle)} → ${htmlEscape(targetLabel(b.target))}` : ""}`;
      }
      const r = d.rules.find((x) => x.id === Number(id));
      return `规则 #${id}${r ? ` ${htmlEscape(r.sourceTitle)} → ${htmlEscape(targetLabel(r.target))}` : "（已删除）"}`;
    };
    for (const scope of Array.from(scopes).sort()) {
      lines.push(`• ${label(scope)}：${fmt(sum(scope, today))}／${fmt(sum(scope, weekStart))}／${fmt(sum(scope, ""))}`);
    }
    return lines.join("\n");
  }

  // ── 规则导出与导入 ───────────────────────────────────────────────────────

  private async exportRules(msg: CommandMessage): Promise<void> {
    const rules = this.store.data.rules;
    if (!rules.length) return this.reply(msg, "📭 没有可导出的规则");
    const payload = {
      format: "saveplus-rules",
      version: 1,
      exportedAt: new Date(this.engine.clock.now()).toISOString(),
      rules: rules.map((r) => ({
        sourceChatId: r.sourceChatId,
        sourceTitle: r.sourceTitle,
        target: r.target,
        enabled: r.enabled,
        filter: r.filter,
        ...deliveryOf(r),
      })),
    };
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json, "utf8").toString("base64");
    const c = commandName();
    if (b64.length <= 3300) {
      return this.reply(
        msg,
        `📤 <b>规则配置</b>（${rules.length} 条）\n<code>${b64}</code>\n\n导入：发送 <code>${htmlEscape(c)} import</code>，换行后粘贴上面的内容`
      );
    }
    const dir = path.join(this.dirs.data, "exports");
    await fsp.mkdir(dir, { recursive: true });
    const file = await uniquePath(dir, `rules_${new Date(this.engine.clock.now()).toISOString().replace(/[:.]/g, "-")}.json`);
    await fsp.writeFile(file, JSON.stringify(payload, null, 2));
    return this.reply(msg, `📤 规则较多（${rules.length} 条），已导出到文件：\n<code>${htmlEscape(file)}</code>\n可将文件内容粘贴到 <code>${htmlEscape(c)} import</code> 后导入`);
  }

  private decodeImport(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) throw new SavePlusError("invalid", "请在 import 后换行粘贴导出的内容");
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      try {
        parsed = JSON.parse(Buffer.from(trimmed.replace(/\s+/g, ""), "base64").toString("utf8"));
      } catch {
        throw new SavePlusError("invalid", "无法识别导入内容：既不是 JSON，也不是 Base64 编码的 JSON");
      }
    }
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        /* 保持原样 */
      }
    }
    return parsed;
  }

  private async importCommand(msg: CommandMessage, raw: string): Promise<void> {
    const rest = raw.replace(/^\s*import\b/i, "");
    const [firstLine, ...more] = rest.split("\n");
    const flags = tokenize(firstLine).map((t) => t.toLowerCase());
    const fromShiftFile = flags[0] === "shift" && !more.join("").trim();
    const keepForward = flags.includes("forward");
    let data: unknown;
    let label: string;
    if (fromShiftFile) {
      // shift 的数据位于同一宿主 assets 目录下（只读）。
      const file = path.join(path.dirname(this.dirs.data), "shift", "shift_v2.json");
      let text: string;
      try {
        text = await fsp.readFile(file, "utf8");
      } catch {
        throw new SavePlusError("not_found", `未找到 shift 的规则数据：${file}`);
      }
      data = (JSON.parse(text) as { rules?: unknown }).rules;
      label = "shift 规则文件";
    } else {
      const payload = more.length ? more.join("\n") : flags.filter((f) => f !== "shift" && f !== "forward").join("");
      data = this.decodeImport(payload);
      label = "导入内容";
    }
    const candidates = this.importCandidates(data, { keepForward });
    await this.progress(msg, `⏳ 正在导入 ${candidates.list.length} 条规则（来自${label}）…`);
    const added: string[] = [];
    const updated: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const cand of candidates.list) {
      let source: PeerInfo;
      let target: PeerTarget;
      try {
        source = await this.port.resolvePeer(cand.sourceRef);
        target = await this.resolveTarget({ kind: "peer", ref: cand.targetRef, topicId: cand.topicId }, { forRule: true });
        if (target.peerId === source.peerId) throw new SavePlusError("invalid", "来源与目标相同");
      } catch (err) {
        failed.push(`${cand.sourceRef} → ${cand.targetRef}：${classifyError(err, "read").message}`);
        continue;
      }
      const now = this.engine.clock.now();
      const outcome = await this.store.update((d) => {
        const exists = d.rules.find((r) => r.sourceChatId === source.peerId);
        if (exists && candidates.format === "shift") return `skip:${exists.id}`;
        const fields = {
          sourceTitle: source.title,
          target,
          enabled: cand.enabled,
          filter: cand.filter,
          mode: cand.mode,
          hideAuthor: cand.hideAuthor || undefined,
          silent: cand.silent || undefined,
          handleEdited: cand.handleEdited || undefined,
          updatedAt: now,
        };
        if (exists) {
          Object.assign(exists, fields);
          return `update:${exists.id}`;
        }
        const r: RuleRecord = { id: d.nextRuleId++, sourceChatId: source.peerId, createdAt: now, ...fields };
        d.rules.push(r);
        return `add:${r.id}`;
      });
      const [kind, id] = outcome.split(":");
      const text = `#${id} ${source.title} → ${targetLabel(target)}`;
      if (kind === "add") added.push(text);
      else if (kind === "update") updated.push(text);
      else skipped.push(`${source.title}：已有规则 #${id}，未覆盖`);
    }
    const lines = [
      `📥 <b>导入完成</b>（${label}）`,
      `新增 ${added.length} · 更新 ${updated.length} · 跳过 ${skipped.length} · 失败 ${failed.length}`,
      ...added.map((t) => `➕ ${htmlEscape(t)}`),
      ...updated.map((t) => `♻️ ${htmlEscape(t)}`),
      ...skipped.map((t) => `⏭ ${htmlEscape(t)}`),
      ...failed.map((t) => `❌ ${htmlEscape(t)}`),
      ...candidates.notes.map((t) => `ℹ️ ${htmlEscape(t)}`),
    ];
    await this.reply(msg, lines.join("\n"));
  }

  /** 把 saveplus 导出或 shift 规则（导出内容或数据文件）转换为待导入规则。 */
  private importCandidates(
    data: unknown,
    opts: { keepForward: boolean }
  ): {
    format: "saveplus" | "shift";
    notes: string[];
    list: Array<
      Required<DeliveryOptions> & {
        sourceRef: string;
        targetRef: string;
        topicId?: number;
        enabled: boolean;
        filter: FilterConfig;
      }
    >;
  } {
    const notes: string[] = [];
    const cleanPatterns = (patterns: unknown, where: string): string[] => {
      const out: string[] = [];
      for (const p of Array.isArray(patterns) ? patterns : []) {
        if (typeof p !== "string") continue;
        const problem = validateRegex(p);
        if (problem) notes.push(`${where} 的白名单「${p}」未导入：${problem}`);
        else out.push(p);
      }
      return out;
    };
    const obj = data as Record<string, unknown> | null;
    if (obj && typeof obj === "object" && obj.format === "saveplus-rules" && Array.isArray(obj.rules)) {
      const list = (obj.rules as Array<Record<string, any>>).map((r) => {
        const types = r.filter?.types;
        const filter: FilterConfig = {
          types:
            types === "all" || !Array.isArray(types)
              ? "all"
              : (types.filter((k: string) => FILTER_KINDS.includes(k as MediaKind)) as MediaKind[]),
          blacklist: Array.isArray(r.filter?.blacklist) ? r.filter.blacklist.filter((w: unknown) => typeof w === "string") : [],
          whitelist: { enabled: false, patterns: cleanPatterns(r.filter?.whitelist?.patterns, String(r.sourceChatId)) },
          ads: Boolean(r.filter?.ads),
        };
        filter.whitelist.enabled = Boolean(r.filter?.whitelist?.enabled) && filter.whitelist.patterns.length > 0;
        return {
          sourceRef: String(r.sourceChatId),
          targetRef: r.target?.isSelf ? "me" : String(r.target?.peerId),
          topicId: typeof r.target?.topicId === "number" ? r.target.topicId : undefined,
          enabled: r.enabled !== false,
          filter,
          mode: (r.mode === "forward" ? "forward" : "relay") as DeliveryMode,
          hideAuthor: Boolean(r.hideAuthor),
          silent: Boolean(r.silent),
          handleEdited: Boolean(r.handleEdited),
        };
      });
      return { format: "saveplus", notes, list };
    }
    const looksShift =
      obj && typeof obj === "object" && Object.values(obj).every((v) => v && typeof v === "object" && "target_id" in (v as object));
    if (!looksShift || !Object.keys(obj as object).length) {
      throw new SavePlusError("invalid", "导入内容不是 saveplus 导出的规则，也不是 shift 规则");
    }
    let bothLists = false;
    const list = Object.entries(obj as Record<string, Record<string, any>>).map(([sourceId, rule]) => {
      const options: string[] = Array.isArray(rule.options) ? rule.options.map(String) : [];
      const kinds = options.map((o) => KIND_ALIASES[o.toLowerCase()]).filter(Boolean) as MediaKind[];
      const topic = options.find((o) => o.startsWith("replyTo:"));
      const topicId = topic ? Number(topic.slice("replyTo:".length)) : undefined;
      const patterns = cleanPatterns(rule.whitelistPatterns, sourceId);
      const blacklist: string[] = Array.isArray(rule.filters) ? rule.filters.filter((w: unknown) => typeof w === "string") : [];
      const wlOn = Boolean(rule.whitelistMode) && patterns.length > 0;
      if (wlOn && blacklist.length) bothLists = true;
      return {
        sourceRef: sourceId,
        targetRef: String(rule.target_id),
        topicId: topicId && Number.isSafeInteger(topicId) && topicId > 0 ? topicId : undefined,
        enabled: !rule.paused,
        filter: {
          types: options.includes("all") || !kinds.length ? ("all" as const) : Array.from(new Set(kinds)),
          blacklist,
          whitelist: { enabled: wlOn, patterns },
          ads: false,
        },
        mode: (opts.keepForward ? "forward" : "relay") as DeliveryMode,
        hideAuthor: options.includes("hide_author"),
        silent: options.includes("silent"),
        handleEdited: options.includes("handle_edited"),
      };
    });
    notes.push(
      opts.keepForward
        ? "已按 shift 的方式使用原生转发（来源受保护时自动改为本地中转）"
        : "导入后默认使用本地中转（保留来源封面）；如需与 shift 一样原生转发，可用 import shift forward 或 rule mode ID forward"
    );
    if (bothLists) notes.push("shift 启用白名单时会忽略黑名单；在 saveplus 中两者同时生效，请确认黑名单是否仍需要");
    return { format: "shift", notes, list };
  }

  // ── 整个历史备份 ─────────────────────────────────────────────────────────

  private backupLine(b: BackupJob): string {
    const state: Record<BackupStatus, string> = {
      running: "进行中",
      paused: "已暂停",
      planned: "历史已读完",
      cancelled: "已取消",
      error: "出错",
    };
    const tasks = this.store.data.tasks.filter((t) => t.jobId === b.id);
    const done = b.counts.done;
    const open = tasks.filter((t) => !FINISHED_STATUSES.has(t.status) && t.status !== "needs_attention" && t.status !== "uncertain").length;
    const extra = b.status === "planned" ? (open ? `，剩余 ${open} 个执行中` : "，已全部完成") : "";
    return `#${b.id} [${state[b.status]}${extra}] ${htmlEscape(b.sourceTitle)} → ${htmlEscape(targetLabel(b.target))}（${b.order === "asc" ? "正序" : "倒序"}，已保存 ${done}）`;
  }

  private async backupCommand(msg: CommandMessage, args: string[]): Promise<void> {
    const c = commandName();
    const sub = args[0]?.toLowerCase();
    if (!sub || sub === "list") {
      const jobs = this.store.data.backups.slice(-20);
      if (!jobs.length) return this.reply(msg, `📭 暂无备份。使用 <code>${htmlEscape(c)} backup 来源 目标</code> 创建`);
      return this.reply(msg, `🗄 <b>整个历史备份</b>\n${jobs.map((b) => this.backupLine(b)).join("\n")}`);
    }
    if (["status", "show", "pause", "resume", "cancel"].includes(sub)) {
      const id = Number(args[1]);
      if (!Number.isInteger(id) || id <= 0) throw new SavePlusError("invalid", "请提供备份 ID");
      if (sub === "status" || sub === "show") return this.reply(msg, this.backupStatus(id));
      const job = await this.engine.setBackupState(id, sub as "pause" | "resume" | "cancel");
      const text = {
        pause: "已暂停（已排队的任务会继续执行）",
        resume: "已继续",
        cancel: "已取消：未开始的任务与其中转文件已删除，处理中的任务中断下载后取消，正在发送的任务在本次发送结束后停止",
      }[
        sub as "pause" | "resume" | "cancel"
      ];
      return this.reply(msg, `✅ 备份 #${job.id} ${text}`);
    }
    const flagSet = new Set(["asc", "--asc", "desc", "--desc", "forward", "hide", "--hide", "hide_author", "nofilter", "--nofilter", "force"]);
    const positional = args.filter((a) => !flagSet.has(a.toLowerCase()));
    const flags = new Set(args.filter((a) => flagSet.has(a.toLowerCase())).map((a) => a.toLowerCase().replace(/^--/, "")));
    if (positional.length !== 2) {
      throw new SavePlusError("invalid", `用法：${c} backup 来源 目标 [asc|desc] [forward] [hide] [nofilter] [force]`);
    }
    if (flags.has("asc") && flags.has("desc")) throw new SavePlusError("invalid", "asc 与 desc 不能同时使用");
    const srcSpec = parseTargetSpec(positional[0], chatIdOf(msg));
    if ("error" in srcSpec || srcSpec.kind !== "peer" || srcSpec.topicId) {
      throw new SavePlusError("invalid", "来源需为 @用户名、会话 ID、t.me 链接或 here");
    }
    const source = await this.port.resolvePeer(srcSpec.ref);
    if (source.kind === "self") throw new SavePlusError("invalid", "不能备份收藏夹");
    const tSpec = parseTargetSpec(positional[1], chatIdOf(msg));
    if ("error" in tSpec) throw new SavePlusError("invalid", tSpec.error);
    const target = await this.resolveTarget(tSpec, { forRule: true });
    if (target.peerId === source.peerId) throw new SavePlusError("invalid", "来源与目标不能相同");
    const rule = this.engine.ruleForChat(source.peerId);
    const useRuleFilter = Boolean(rule) && !flags.has("nofilter");
    const job = await this.engine.createBackup({
      sourceChatId: source.peerId,
      sourceTitle: source.title,
      target,
      filter: useRuleFilter ? (JSON.parse(JSON.stringify((rule as RuleRecord).filter)) as FilterConfig) : defaultFilter(),
      filterFrom: useRuleFilter ? "rule" : "none",
      order: flags.has("desc") ? "desc" : "asc",
      mode: flags.has("forward") ? "forward" : "relay",
      hideAuthor: flags.has("hide") || flags.has("hide_author"),
      force: flags.has("force"),
    });
    const lines = [
      `🗄 <b>已创建备份 #${job.id}</b>`,
      `${htmlEscape(job.sourceTitle)} → ${htmlEscape(targetLabel(job.target))}`,
      `顺序：${job.order === "asc" ? "正序（旧→新，保持原始顺序）" : "倒序（新→旧）"}`,
      `投递：${describeDelivery(job)}`,
      `过滤：${useRuleFilter ? `沿用规则 #${(rule as RuleRecord).id} 的过滤` : rule ? "不过滤（nofilter）" : "不过滤（该来源没有监视规则）"}`,
      "已成功保存到该目标的消息会跳过，中断后会从断点继续",
      `进度：<code>${htmlEscape(c)} backup status ${job.id}</code>`,
    ];
    if (job.force) lines.push("⚠️ 已启用 force：忽略成功记录强制重存");
    if (job.hideAuthor && job.mode !== "forward") lines.push("ℹ️ 本地中转本身不显示“转发自”，hide 仅在原生转发时生效");
    return this.reply(msg, lines.join("\n"));
  }

  private backupStatus(id: number): string {
    const b = this.engine.getBackup(id);
    if (!b) throw new SavePlusError("invalid", `备份 #${id} 不存在`);
    const tasks = this.store.data.tasks.filter((t) => t.jobId === id);
    const by = (st: TaskStatus) => tasks.filter((t) => t.status === st).length;
    const pending = tasks.filter((t) => ["queued", "running", "sending", "retry_wait", "cleanup_pending"].includes(t.status)).length;
    const lines = [
      this.backupLine(b),
      `投递：${describeDelivery(b)} · 过滤：${b.filterFrom === "rule" ? "沿用规则" : "不过滤"}${b.force ? " · 强制重存" : ""}`,
      `已读取 ${b.counts.scanned} 条（游标 ${b.cursor || "起点"}）`,
      `入队 ${b.counts.queued} · 已保存跳过 ${b.counts.saved} · 进行中跳过 ${b.counts.claimed} · 过滤跳过 ${b.counts.filtered}`,
      `任务：完成 ${b.counts.done} · 执行中 ${pending} · 待处理 ${by("needs_attention")} · 结果不确定 ${by("uncertain")}`,
      `开始：${new Date(b.createdAt).toLocaleString()}${b.finishedAt ? ` · 读完：${new Date(b.finishedAt).toLocaleString()}` : ""}`,
    ];
    if (b.lastError) lines.push(`⚠️ ${htmlEscape(b.lastError.message)}`);
    if (by("needs_attention") || by("uncertain")) {
      lines.push(`待处理或不确定的任务可用 <code>${htmlEscape(commandName())} task</code> 查看`);
    }
    return lines.join("\n");
  }

  /** TeleBox 进程已运行的时长（插件重载不会重置）。 */
  processUptimeMs(): number {
    return process.uptime() * 1000;
  }

  statusText(): string {
    const d = this.store.data;
    const counts = new Map<TaskStatus, number>();
    for (const t of d.tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    const order: TaskStatus[] = ["queued", "running", "sending", "retry_wait", "needs_attention", "uncertain", "cleanup_pending"];
    const active = order.filter((s) => counts.get(s)).map((s) => `${STATUS_LABEL[s]} ${counts.get(s)}`);
    const enabled = d.rules.filter((r) => r.enabled).length;
    const now = this.engine.clock.now();
    const startedAt = this.engine.startedAt ?? now;
    const mark = (m: RuleMark | undefined) =>
      m
        ? `${new Date(m.at).toLocaleString()}（${now - m.at < 60_000 ? "刚刚" : `${formatDuration(now - m.at)}前`} · 消息 ${m.messageId}）`
        : "暂无记录";
    const lines = [
      "📊 <b>SavePlus 状态</b>",
      `运行时长：TeleBox 进程 ${formatDuration(this.processUptimeMs())} · 插件本次加载 ${formatDuration(now - startedAt)}`,
      `监视规则：${d.rules.length}（运行 ${enabled} · 暂停 ${d.rules.length - enabled}）`,
    ];
    for (const r of d.rules) {
      const seen = this.engine.lastSeenOf(r);
      const quiet = r.enabled && seen && seen.at < startedAt ? "；本次加载后尚未收到" : "";
      lines.push(
        this.ruleSummary(r),
        `　最后收到新消息：${mark(seen)}${quiet}`,
        `　最后成功保存：${mark(r.lastSaved)}`
      );
    }
    lines.push(
      `未完成任务：${active.length ? active.join(" · ") : "无"}`,
      `成功保存记录：${Object.keys(d.successes).length} 条`
    );
    const cooldown = this.engine.cooldownRemainingMs;
    if (cooldown > 0) lines.push(`⏳ 限流冷却中：剩余 ${Math.ceil(cooldown / 1000)} 秒`);
    if (d.hold) lines.push(`⛔ 执行已暂停：${htmlEscape(d.hold.reason)}（处理后用 task retry all 恢复）`);
    if (d.recentSkips.length) {
      lines.push("最近跳过：");
      for (const s of d.recentSkips.slice(0, 5)) {
        lines.push(`• ${s.jobId ? `备份 #${s.jobId}` : `规则 #${s.ruleId}`} 消息 ${s.messageIds.join(",")}：${htmlEscape(s.reason)}`);
      }
    }
    lines.push("在线监视只处理插件运行期间收到的新消息；停机或重载期间的缺口，请从“最后收到”的消息之后用 fill 手动补漏。");
    return lines.join("\n");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 插件
// ════════════════════════════════════════════════════════════════════════════

export interface SavePlusPluginOptions {
  /** 替换 Telegram 访问（测试用）；默认使用宿主客户端构造 TeleprotoPort。 */
  createPort?: (client: TelegramClient) => TelegramPort;
  getClient?: () => Promise<TelegramClient>;
  clock?: Clock;
  options?: Partial<SavePlusOptions>;
  /** 持久数据目录（默认宿主 assets/saveplus）。 */
  dataDir?: string;
  /** 临时与中转目录（默认宿主 temp/saveplus）。 */
  tempDir?: string;
  diskFree?: (dir: string) => Promise<number | undefined>;
  log?: (message: string, error?: unknown) => void;
}

export class SavePlusPlugin extends Plugin {
  name = PLUGIN_NAME;
  description = (): string => helpText();
  ignoreEdited = true;
  /** 接收编辑事件；只有开启“编辑后再存一份”的规则会处理。 */
  listenMessageHandlerIgnoreEdited = false;
  private engine: Engine | null = null;
  private core: SavePlusCore | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly config: SavePlusPluginOptions = {}) {
    super();
  }

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    saveplus: async (msg: Api.Message) => {
      if (this.starting) await this.starting.catch(() => undefined);
      const core = this.core;
      if (!core) {
        await msg.edit({ text: "❌ SavePlus 尚未初始化完成，请稍后重试或重载插件" });
        return;
      }
      await core.handle(msg as unknown as CommandMessage);
    },
  };

  listenMessageHandler = async (msg: Api.Message, options?: { isEdited?: boolean }): Promise<void> => {
    const engine = this.engine;
    if (!engine) return;
    await engine.onMessage(msg, options);
  };

  async setup(context?: PluginRuntimeContext): Promise<void> {
    if (this.engine) await this.cleanup();
    this.starting = this.init(context);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async init(context?: PluginRuntimeContext): Promise<void> {
    const dataDir = this.config.dataDir ?? createDirectoryInAssets(PLUGIN_NAME);
    const tempDir = this.config.tempDir ?? createDirectoryInTemp(PLUGIN_NAME);
    const client = await (this.config.getClient ?? getGlobalClient)();
    const port = this.config.createPort ? this.config.createPort(client) : new TeleprotoPort(client);
    const store = await Store.open(path.join(dataDir, "data.json"));
    const engine = new Engine({
      port,
      store,
      clock: this.config.clock ?? realClock,
      dirs: {
        staging: path.join(tempDir, "staging"),
        manual: path.join(tempDir, "manual"),
        archive: path.join(dataDir, "archive"),
        data: dataDir,
      },
      options: { ...DEFAULT_OPTIONS, ...(this.config.options || {}) },
      diskFree: this.config.diskFree,
      log: this.config.log,
    });
    try {
      await engine.start();
    } catch (err) {
      await store.close();
      throw err;
    }
    this.engine = engine;
    this.core = new SavePlusCore(engine);
    const loop = engine.loopPromise;
    if (loop && context?.lifecycle) context.lifecycle.trackTask(loop, { label: "saveplus:worker" });
  }

  async cleanup(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.core = null;
    if (engine) await engine.stop();
  }

  /** 测试与诊断用。 */
  get runtime(): { engine: Engine | null; core: SavePlusCore | null } {
    return { engine: this.engine, core: this.core };
  }
}

export function createSavePlusPlugin(options: SavePlusPluginOptions = {}): SavePlusPlugin {
  return new SavePlusPlugin(options);
}

export default new SavePlusPlugin();
