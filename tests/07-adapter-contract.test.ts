import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { Api, errors as tgErrors, helpers } from "teleproto";
import {
  TeleprotoPort,
  classifyError,
  entitiesFromJson,
  entitiesToJson,
  type StagedItem,
} from "../saveplus";
import { makeRoot } from "./helpers/harness";

const B = (n: number | string) => helpers.returnBigInt(n);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

function coverPhoto(id: number): Api.Photo {
  return new Api.Photo({
    id: B(id),
    accessHash: B(id + 1),
    fileReference: Buffer.from(`fr${id}`),
    date: 1,
    dcId: 4,
    sizes: [
      new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 2, 3]) }),
      new Api.PhotoSize({ type: "m", w: 320, h: 180, size: 1000 }),
      new Api.PhotoSizeProgressive({ type: "y", w: 1280, h: 720, sizes: [100, 2000, 9000] }),
    ],
  });
}

function videoDoc(id: number, opts: { thumbs?: Api.TypePhotoSize[]; attrs?: Api.TypeDocumentAttribute[]; mime?: string; size?: number } = {}) {
  return new Api.Document({
    id: B(id),
    accessHash: B(id + 1),
    fileReference: Buffer.from(`d${id}`),
    date: 1,
    mimeType: opts.mime ?? "video/mp4",
    size: B(opts.size ?? 5000),
    dcId: 2,
    thumbs: opts.thumbs ?? [
      new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 2]) }),
      new Api.PhotoSize({ type: "m", w: 320, h: 180, size: 900 }),
    ],
    attributes: opts.attrs ?? [
      new Api.DocumentAttributeVideo({ duration: 12.5, w: 1920, h: 1080, supportsStreaming: true }),
      new Api.DocumentAttributeFilename({ fileName: "clip.mp4" }),
    ],
  });
}

function message(id: number, media: Api.TypeMessageMedia | undefined, text = "", groupedId?: string): Api.Message {
  return new Api.Message({
    id,
    peerId: new Api.PeerChannel({ channelId: B(1001) }),
    date: 1700000000,
    message: text,
    media,
    groupedId: groupedId ? B(groupedId) : undefined,
    entities: text ? [new Api.MessageEntityBold({ offset: 0, length: Math.min(2, text.length) })] : undefined,
  });
}

/** 记录调用、按真实 TL 形状应答的 TelegramClient 替身。 */
class RecordingClient {
  calls: Array<{ name: string; arg: any; opts?: any }> = [];
  uploads: string[] = [];
  private n = 0;
  responseHasCover = true;
  dropMessageIdUpdate = false;
  shortDownload = false;
  entities = new Map<string, any>();

  async getMe() {
    return new Api.User({ id: B(1000), self: true, firstName: "me" });
  }
  async getEntity(q: any) {
    const key = String(q);
    const e = this.entities.get(key);
    if (!e) throw new Error(`Could not find the input entity for ${key}`);
    return e;
  }
  async getDialogs() {
    return [];
  }
  async getInputEntity() {
    return new Api.InputPeerChannel({ channelId: B(2002), accessHash: B(5) });
  }
  async getMessages(_e: any, params: any) {
    this.calls.push({ name: "getMessages", arg: params });
    return [];
  }
  async downloadMedia(raw: Api.Message, opts: any) {
    this.calls.push({ name: "downloadMedia", arg: raw.id, opts });
    const doc = (raw.media as Api.MessageMediaDocument).document as Api.Document;
    const size = Number(doc.size) - (this.shortDownload ? 10 : 0);
    fs.writeFileSync(opts.outputFile, Buffer.alloc(size, 1));
    return opts.outputFile;
  }
  async downloadFile(location: any, opts: any) {
    this.calls.push({ name: "downloadFile", arg: location, opts });
    fs.writeFileSync(opts.outputFile, JPEG);
    return opts.outputFile;
  }
  async uploadFile({ file }: any) {
    this.uploads.push(file.name);
    return new Api.InputFile({ id: B(++this.n), parts: 1, name: file.name, md5Checksum: "" });
  }
  async invoke(req: any) {
    this.calls.push({ name: req.className, arg: req });
    if (req instanceof Api.messages.UploadMedia) {
      const m = req.media;
      if (m instanceof Api.InputMediaUploadedPhoto) {
        return new Api.MessageMediaPhoto({ photo: coverPhoto(9000 + ++this.n) });
      }
      return new Api.MessageMediaDocument({
        document: videoDoc(8000 + ++this.n),
        videoCover: (m as Api.InputMediaUploadedDocument).videoCover ? coverPhoto(7000 + this.n) : undefined,
      });
    }
    if (req instanceof Api.messages.SendMedia || req instanceof Api.messages.SendMultiMedia) {
      const randoms: any[] = req instanceof Api.messages.SendMedia ? [req.randomId] : req.multiMedia.map((x: any) => x.randomId);
      const updates: any[] = [];
      randoms.forEach((r, i) => {
        const id = 600 + i;
        if (!this.dropMessageIdUpdate) updates.push(new Api.UpdateMessageID({ id, randomId: r }));
        const media = new Api.MessageMediaDocument({
          document: videoDoc(100 + i),
          videoCover: this.responseHasCover ? coverPhoto(300 + i) : undefined,
        });
        updates.push(new Api.UpdateNewChannelMessage({ message: message(id, media), pts: 1, ptsCount: 1 }));
      });
      return new Api.Updates({ updates, users: [], chats: [], date: 1, seq: 0 });
    }
    throw new Error(`unexpected ${req.className}`);
  }
}

function port(client: RecordingClient) {
  return new TeleprotoPort(client as never);
}

test("07 消息分类：具体类型先于普通文件判断，视频封面来源被识别", () => {
  const p = port(new RecordingClient());
  const doc = (attrs: Api.TypeDocumentAttribute[], thumbs?: Api.TypePhotoSize[]) =>
    message(1, new Api.MessageMediaDocument({ document: videoDoc(1, { attrs, thumbs }) }));
  const kind = (m: Api.Message) => p.toSourceMessage(m)?.kind;
  const video = new Api.DocumentAttributeVideo({ duration: 3, w: 10, h: 10 });
  assert.equal(kind(doc([video])), "video");
  assert.equal(kind(doc([new Api.DocumentAttributeVideo({ duration: 3, w: 10, h: 10, roundMessage: true })])), "video");
  assert.equal(kind(doc([video, new Api.DocumentAttributeAnimated()])), "animation");
  assert.equal(kind(doc([new Api.DocumentAttributeSticker({ alt: "😀", stickerset: new Api.InputStickerSetEmpty() })])), "sticker");
  assert.equal(kind(doc([new Api.DocumentAttributeAudio({ duration: 4, voice: true })])), "voice");
  assert.equal(kind(doc([new Api.DocumentAttributeAudio({ duration: 4, title: "t" })])), "audio");
  assert.equal(kind(doc([new Api.DocumentAttributeFilename({ fileName: "a.pdf" })])), "document");
  assert.equal(kind(message(1, new Api.MessageMediaPhoto({ photo: coverPhoto(1) }))), "photo");
  assert.equal(kind(message(1, undefined, "hi")), "text");
  const preview = p.toSourceMessage(message(1, new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: B(1) }) }), "see"));
  assert.equal(preview?.kind, "text");
  assert.equal(preview?.webPreview, true);
  const poll = p.toSourceMessage(message(1, new Api.MessageMediaDice({ value: 3, emoticon: "🎲" })));
  assert.equal(poll?.kind, "other");
  assert.equal(poll?.reuploadable, false);
  assert.equal(p.toSourceMessage(new Api.MessageService({ id: 1, peerId: new Api.PeerChannel({ channelId: B(1) }), date: 1, action: new Api.MessageActionEmpty() })), null);

  const withCover = p.toSourceMessage(message(1, new Api.MessageMediaDocument({ document: videoDoc(1), videoCover: coverPhoto(5) })));
  assert.equal(withCover?.cover, "custom");
  assert.equal(withCover?.chatId, "-1001001");
  assert.equal(p.toSourceMessage(doc([video]))?.cover, "thumb");
  assert.equal(p.toSourceMessage(doc([video], [new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1]) })]))?.cover, "stripped");
  assert.equal(p.toSourceMessage(doc([video], []))?.cover, "none");
});

test("07 中转视频：按尺寸类型下载最大静态自定义封面与文档缩略图，不改动来源 thumbs 顺序", async () => {
  const root = await makeRoot();
  const client = new RecordingClient();
  const p = port(client);
  const doc = videoDoc(21);
  const thumbsBefore = doc.thumbs?.map((t) => t.className);
  const raw = message(50, new Api.MessageMediaDocument({ document: doc, video: true, videoCover: coverPhoto(11), videoTimestamp: 3 }), "标题");
  const item = await p.stageMedia(p.toSourceMessage(raw)!, root);
  const downloads = client.calls.filter((c) => c.name === "downloadFile");
  const coverDl = downloads.find((c) => c.arg instanceof Api.InputPhotoFileLocation);
  const thumbDl = downloads.find((c) => c.arg instanceof Api.InputDocumentFileLocation);
  assert.equal(coverDl?.arg.thumbSize, "y", "应选择 1280x720 的最大静态尺寸，而不是模糊预览");
  assert.equal(String(coverDl?.opts.fileSize), "9000");
  assert.equal(String(coverDl?.arg.id), "11");
  assert.equal(thumbDl?.arg.thumbSize, "m");
  assert.deepEqual(doc.thumbs?.map((t) => t.className), thumbsBefore);
  assert.equal(item.coverKind, "custom");
  assert.equal(item.videoTimestamp, 3);
  assert.ok(fs.existsSync(item.coverFile!));
  assert.ok(fs.existsSync(item.thumbFile!));
  assert.equal(fs.statSync(item.mediaFile!).size, 5000);
  assert.equal(path.dirname(item.mediaFile!), root);
  assert.deepEqual(item.attributes.video, {
    duration: 12.5,
    w: 1920,
    h: 1080,
    supportsStreaming: true,
    roundMessage: undefined,
    nosound: undefined,
    preloadPrefixSize: undefined,
    videoStartTs: undefined,
    videoCodec: undefined,
  });
  assert.equal(item.attributes.fileName, "clip.mp4");
  assert.equal(item.text, "标题");
  assert.deepEqual(item.entities, [{ c: "MessageEntityBold", offset: 0, length: 2 }]);

  client.shortDownload = true;
  await assert.rejects(p.stageMedia(p.toSourceMessage(message(51, new Api.MessageMediaDocument({ document: videoDoc(31) })))!, root), (e: any) => {
    assert.equal(e.code, "network");
    assert.equal(e.transient, true);
    assert.match(e.message, /下载不完整/);
    return true;
  });
});

test("07 没有静态缩略图的视频不会冒充封面；只有模糊预览时标记为 stripped", async () => {
  const root = await makeRoot();
  const client = new RecordingClient();
  const p = port(client);
  const raw = message(60, new Api.MessageMediaDocument({ document: videoDoc(41, { thumbs: [new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1]) })] }) }));
  const item = await p.stageMedia(p.toSourceMessage(raw)!, root);
  assert.equal(item.coverKind, "stripped");
  assert.equal(item.thumbFile, undefined);
  assert.equal(client.calls.filter((c) => c.name === "downloadFile").length, 0);
});

function stagedVideo(root: string, id: number, cover: "custom" | "thumb"): StagedItem {
  const media = path.join(root, `m${id}_clip.mp4`);
  fs.writeFileSync(media, Buffer.alloc(100, 1));
  const thumb = path.join(root, `t${id}.jpg`);
  fs.writeFileSync(thumb, JPEG);
  const item: StagedItem = {
    messageId: id,
    kind: "video",
    text: `视频${id}`,
    entities: [{ c: "MessageEntityItalic", offset: 0, length: 2 }],
    mediaFile: media,
    mimeType: "video/mp4",
    size: 100,
    attributes: { fileName: "clip.mp4", video: { duration: 12.5, w: 1920, h: 1080, supportsStreaming: true } },
    thumbFile: thumb,
    coverKind: cover,
  };
  if (cover === "custom") {
    item.coverFile = path.join(root, `c${id}.jpg`);
    fs.writeFileSync(item.coverFile, JPEG);
    item.videoTimestamp = 2;
  }
  return item;
}

test("07 单视频上传：携带缩略图、以上传后的 InputPhoto 作为 videoCover，并保留视频属性与文案实体", async () => {
  const root = await makeRoot();
  const client = new RecordingClient();
  client.entities.set("-1002002", new Api.Channel({ id: B(2002), title: "dst", photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true, creator: true }));
  const p = port(client);
  const res = await p.sendStaged({ peerId: "-1002002", title: "dst" }, [stagedVideo(root, 7, "custom")]);
  assert.deepEqual(res.messageIds, [600]);
  assert.deepEqual(res.warnings, []);
  const coverUpload = client.calls.find((c) => c.name === "messages.UploadMedia")?.arg;
  assert.ok(coverUpload.media instanceof Api.InputMediaUploadedPhoto);
  const send = client.calls.find((c) => c.name === "messages.SendMedia")?.arg as Api.messages.SendMedia;
  const media = send.media as Api.InputMediaUploadedDocument;
  assert.ok(media instanceof Api.InputMediaUploadedDocument);
  assert.ok(media.thumb, "应上传来源静态缩略图");
  assert.ok(media.videoCover instanceof Api.InputPhoto);
  assert.ok(Number(media.videoCover.id) > 9000, "videoCover 来自封面上传返回的图片");
  assert.equal(media.videoTimestamp, 2);
  const va = media.attributes.find((a) => a instanceof Api.DocumentAttributeVideo) as Api.DocumentAttributeVideo;
  assert.deepEqual([va.w, va.h, va.duration, va.supportsStreaming], [1920, 1080, 12.5, true]);
  assert.ok(media.attributes.some((a) => a instanceof Api.DocumentAttributeFilename && a.fileName === "clip.mp4"));
  assert.equal(send.message, "视频7");
  assert.ok(send.entities?.[0] instanceof Api.MessageEntityItalic);
  assert.deepEqual(client.uploads.sort(), ["c7.jpg", "m7_clip.mp4", "t7.jpg"]);

  client.responseHasCover = false;
  const warned = await p.sendStaged({ peerId: "-1002002", title: "dst" }, [stagedVideo(root, 8, "custom")]);
  assert.match(warned.warnings[0], /未包含自定义封面/);
});

test("07 相册：逐成员上传并各自绑定自己的封面，一次 SendMultiMedia 保持顺序与各自文案", async () => {
  const root = await makeRoot();
  const client = new RecordingClient();
  client.entities.set("-1002002", new Api.Channel({ id: B(2002), title: "dst", photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true, creator: true }));
  const p = port(client);
  const items = [stagedVideo(root, 1, "custom"), stagedVideo(root, 2, "custom"), stagedVideo(root, 3, "thumb")];
  const res = await p.sendStaged({ peerId: "-1002002", title: "dst" }, items);
  assert.deepEqual(res.messageIds, [600, 601, 602]);
  const multi = client.calls.find((c) => c.name === "messages.SendMultiMedia")?.arg as Api.messages.SendMultiMedia;
  assert.equal(multi.multiMedia.length, 3);
  const covers = multi.multiMedia.map((s) => (s.media as Api.InputMediaDocument).videoCover);
  assert.ok(covers[0] && covers[1]);
  assert.notEqual(String((covers[0] as Api.InputPhoto).id), String((covers[1] as Api.InputPhoto).id), "每个视频使用自己的封面");
  assert.equal(covers[2], undefined, "仅有缩略图的视频不凭空添加自定义封面");
  assert.deepEqual(multi.multiMedia.map((s) => s.message), ["视频1", "视频2", "视频3"]);
  assert.equal(client.calls.filter((c) => c.name === "messages.UploadMedia").length, 5, "2 张封面 + 3 个视频");
});

test("10 响应无法逐项确认已发送消息时报告结果不确定", async () => {
  const root = await makeRoot();
  const client = new RecordingClient();
  client.entities.set("-1002002", new Api.Channel({ id: B(2002), title: "dst", photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true, creator: true }));
  client.dropMessageIdUpdate = true;
  await assert.rejects(port(client).sendStaged({ peerId: "-1002002", title: "dst" }, [stagedVideo(root, 1, "thumb")]), (e: any) => {
    assert.equal(e.code, "uncertain");
    assert.equal(e.maybeSent, true);
    return true;
  });
});

test("05 错误分类：按类型识别限流秒数；发送阶段的网络与服务器内部错误视为可能已发送", () => {
  const flood = classifyError(new tgErrors.FloodWaitError({ request: undefined as never, capture: 42 } as never), "send");
  assert.equal(flood.code, "flood");
  assert.equal(flood.seconds, 42);
  const slow = classifyError(new tgErrors.SlowModeWaitError({ request: undefined as never, capture: 7 } as never), "send");
  assert.equal(slow.seconds, 7);
  const rpc = (msg: string, code: number) => new tgErrors.RPCError(msg, undefined as never, code);
  assert.equal(classifyError(rpc("CHAT_WRITE_FORBIDDEN", 403), "send").code, "permission");
  assert.equal(classifyError(rpc("CHAT_FORWARDS_RESTRICTED", 400), "send").code, "forward_restricted");
  assert.equal(classifyError(rpc("FILE_REFERENCE_EXPIRED", 400), "read").transient, true);
  assert.equal(classifyError(rpc("MEDIA_CAPTION_TOO_LONG", 400), "send").code, "rpc");
  assert.equal(classifyError(rpc("FLOOD_PREMIUM_WAIT_9", 420), "read").seconds, 9);
  const internal = classifyError(rpc("RPC_CALL_FAIL", 500), "send");
  assert.equal(internal.code, "uncertain");
  assert.equal(classifyError(rpc("RPC_CALL_FAIL", 500), "read").code, "network");
  assert.equal(classifyError(new Error("TIMEOUT"), "send").maybeSent, true);
  assert.equal(classifyError(new Error("socket hang up"), "read").transient, true);
  assert.equal(classifyError(Object.assign(new Error("no space"), { code: "ENOSPC" }), "read").code, "disk_full");
});

test("01 目标权限判定：频道需发帖管理员，群组受默认禁言限制，自己是收藏夹", async () => {
  const client = new RecordingClient();
  const ch = (extra: Record<string, unknown>) => new Api.Channel({ id: B(1), title: "c", photo: new Api.ChatPhotoEmpty(), date: 1, ...extra });
  client.entities.set("@plain", ch({ broadcast: true }));
  client.entities.set("@admin", ch({ broadcast: true, adminRights: new Api.ChatAdminRights({ postMessages: true }) }));
  client.entities.set("@muted", ch({ megagroup: true, defaultBannedRights: new Api.ChatBannedRights({ untilDate: 0, sendMedia: true }) }));
  client.entities.set("@open", ch({ megagroup: true }));
  client.entities.set("me", new Api.User({ id: B(1000), self: true, firstName: "me" }));
  const p = port(client);
  assert.equal((await p.resolvePeer("@plain")).canSend, false);
  assert.equal((await p.resolvePeer("@admin")).canSend, true);
  assert.equal((await p.resolvePeer("@muted")).canSend, false);
  assert.equal((await p.resolvePeer("@open")).kind, "group");
  assert.equal((await p.resolvePeer("@open")).canSend, true);
  assert.equal((await p.resolvePeer("me")).kind, "self");
  await assert.rejects(p.resolvePeer("@ghost"), (e: any) => e.code === "not_found");
});

test("08 文案实体可序列化并重建（无法重建的提及降级为纯文字）", () => {
  const json = entitiesToJson([
    new Api.MessageEntityTextUrl({ offset: 0, length: 3, url: "https://x.y" }),
    new Api.MessageEntityCustomEmoji({ offset: 3, length: 2, documentId: B("5368324170671202286") }),
    new Api.MessageEntityMentionName({ offset: 5, length: 2, userId: B(9) }),
    new Api.MessageEntityPre({ offset: 7, length: 4, language: "ts" }),
  ]);
  assert.deepEqual(json.map((j) => j.c), ["MessageEntityTextUrl", "MessageEntityCustomEmoji", "MessageEntityPre"]);
  const back = entitiesFromJson(JSON.parse(JSON.stringify(json)));
  assert.ok(back[0] instanceof Api.MessageEntityTextUrl && back[0].url === "https://x.y");
  assert.equal(String((back[1] as Api.MessageEntityCustomEmoji).documentId), "5368324170671202286");
  assert.equal((back[2] as Api.MessageEntityPre).language, "ts");
});
