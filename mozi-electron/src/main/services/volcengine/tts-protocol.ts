import { TextDecoder, TextEncoder } from "node:util";
import { gunzipSync } from "node:zlib";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const EMPTY_JSON_BYTES = utf8Encoder.encode("{}");
/** Gzip 解压后的单帧负载上限（10 MiB），对齐 WebSocket `maxPayload`，防止异常压缩包耗尽主进程内存。 */
const MAX_DECOMPRESSED_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 火山引擎 V3 语音网关二进制协议事件码定义。
 * 裁剪自火山引擎官方双向流式 TTS TypeScript Demo (`protocols.ts`)。
 */
export enum EventType {
  None = 0,

  // 连接级事件 (1-99)：不包含 sessionId，下行 50/51/52 携带 connectId
  StartConnection = 1,
  FinishConnection = 2,
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,

  // 会话级事件 (100-199)：绑定单轮合成 sessionId
  StartSession = 100,
  CancelSession = 101,
  FinishSession = 102,
  SessionStarted = 150,
  SessionCanceled = 151,
  SessionFinished = 152,
  SessionFailed = 153,
  UsageResponse = 154,

  // 数据与 TTS 合成事件 (200-399)：绑定 sessionId
  TaskRequest = 200,
  UpdateConfig = 201,
  AudioMuted = 250,
  SayHello = 300,
  TTSSentenceStart = 350,
  TTSSentenceEnd = 351,
  TTSResponse = 352,
  TTSSubtitle = 353,
  TTSEnded = 359,
}

/** 二进制帧消息类型（Header Byte 1 高 4 位）。 */
export enum MsgType {
  Invalid = 0,
  /** 客户端上行完整请求（JSON 控制帧与文本帧）。 */
  FullClientRequest = 0b0001,
  /** 客户端上行纯音频帧（ASR 等场景）。 */
  AudioOnlyClient = 0b0010,
  /** 服务端下行完整响应（JSON 事件与元数据帧）。 */
  FullServerResponse = 0b1001,
  /** 服务端下行纯音频响应（Payload 即为裸 PCM/MP3 音频流）。 */
  AudioOnlyServer = 0b1011,
  FrontEndResultServer = 0b1100,
  /** 服务端下行错误响应帧（携带 4 字节 uint32 errorCode）。 */
  Error = 0b1111,
}

/** 消息特征标志位（Header Byte 1 低 4 位）。 */
export enum MsgTypeFlagBits {
  NoSeq = 0,
  /** 携带正数 4B int32 sequence 序号。 */
  PositiveSeq = 0b0001,
  LastNoSeq = 0b0010,
  /** 尾包且携带负数 4B int32 sequence 序号。 */
  NegativeSeq = 0b0011,
  /** 携带 4B int32 EventType 事件号（双向流式 TTS 标准模式）。 */
  WithEvent = 0b0100,
}

/** 协议版本号（Header Byte 0 高 4 位，固定 v1 = 1）。 */
export enum VersionBits {
  Version1 = 1,
  Version2 = 2,
  Version3 = 3,
  Version4 = 4,
}

/** 基础帧头长度倍数（Header Byte 0 低 4 位，实际字节数 = 4 * HeaderSizeBits）。 */
export enum HeaderSizeBits {
  HeaderSize4 = 1,
  HeaderSize8 = 2,
  HeaderSize12 = 3,
  HeaderSize16 = 4,
}

/** 负载序列化格式（Header Byte 2 高 4 位）。 */
export enum SerializationBits {
  /** 原始二进制字节流（用于 PCM/MP3 音频块）。 */
  Raw = 0,
  /** UTF-8 JSON 文本（用于控制信令与文本请求）。 */
  JSON = 0b0001,
  Thrift = 0b0011,
  Custom = 0b1111,
}

/** 负载压缩算法（Header Byte 2 低 4 位）。 */
export enum CompressionBits {
  None = 0,
  Gzip = 0b0001,
  Custom = 0b1111,
}

export interface VolcProtocolMessage {
  version: VersionBits;
  headerSize: HeaderSizeBits;
  type: MsgType;
  flag: MsgTypeFlagBits;
  serialization: SerializationBits;
  compression: CompressionBits;
  event?: EventType;
  sessionId?: string;
  connectId?: string;
  sequence?: number;
  errorCode?: number;
  payload: Uint8Array;
}

/** 创建一条协议消息的默认骨架（v1、4 字节头、JSON、不压缩）。 */
export function createMessage(
  msgType: MsgType,
  flag: MsgTypeFlagBits,
): VolcProtocolMessage {
  return {
    version: VersionBits.Version1,
    headerSize: HeaderSizeBits.HeaderSize4,
    type: msgType,
    flag,
    serialization: SerializationBits.JSON,
    compression: CompressionBits.None,
    payload: new Uint8Array(0),
  };
}

export function marshalMessage(msg: VolcProtocolMessage): Uint8Array {
  const buffers: Uint8Array[] = [];

  const headerSize = 4 * msg.headerSize;
  const header = new Uint8Array(headerSize);
  header[0] = (msg.version << 4) | msg.headerSize;
  header[1] = (msg.type << 4) | msg.flag;
  header[2] = (msg.serialization << 4) | msg.compression;
  buffers.push(header);

  for (const writer of getWriters(msg)) {
    const chunk = writer(msg);
    if (chunk) buffers.push(chunk);
  }

  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.byteLength;
  }
  return result;
}

export function unmarshalMessage(data: Uint8Array): VolcProtocolMessage {
  if (data.byteLength < 4) {
    throw new Error(`Volcengine frame too short: expected >= 4 bytes, got ${data.byteLength}`);
  }

  const versionAndHeaderSize = data[0];
  const typeAndFlag = data[1];
  const serializationAndCompression = data[2];

  const msg: VolcProtocolMessage = {
    version: (versionAndHeaderSize >> 4) as VersionBits,
    headerSize: (versionAndHeaderSize & 0x0f) as HeaderSizeBits,
    type: (typeAndFlag >> 4) as MsgType,
    flag: (typeAndFlag & 0x0f) as MsgTypeFlagBits,
    serialization: (serializationAndCompression >> 4) as SerializationBits,
    compression: (serializationAndCompression & 0x0f) as CompressionBits,
    payload: new Uint8Array(0),
  };

  let offset = 4 * msg.headerSize;
  if (offset < 4 || offset > data.byteLength) {
    throw new Error(`Invalid Volcengine header size: ${offset} bytes (frame=${data.byteLength})`);
  }

  for (const reader of getReaders(msg)) {
    offset = reader(msg, data, offset);
  }

  if (msg.compression === CompressionBits.Gzip && msg.payload.byteLength > 0) {
    msg.payload = new Uint8Array(
      gunzipSync(msg.payload, { maxOutputLength: MAX_DECOMPRESSED_PAYLOAD_BYTES }),
    );
  }

  return msg;
}

export function decodeJsonPayload<T = Record<string, unknown>>(msg: VolcProtocolMessage): T | undefined {
  if (msg.payload.byteLength === 0) return undefined;
  const text = utf8Decoder.decode(msg.payload).trim();
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

export function encodeStartConnectionFrame(): Uint8Array {
  const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  msg.event = EventType.StartConnection;
  msg.payload = EMPTY_JSON_BYTES;
  return marshalMessage(msg);
}

export function encodeFinishConnectionFrame(): Uint8Array {
  const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  msg.event = EventType.FinishConnection;
  msg.payload = EMPTY_JSON_BYTES;
  return marshalMessage(msg);
}

export function encodeStartSessionFrame(
  sessionId: string,
  payload: Record<string, unknown>,
): Uint8Array {
  const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  msg.event = EventType.StartSession;
  msg.sessionId = sessionId;
  msg.payload = utf8Encoder.encode(JSON.stringify(payload));
  return marshalMessage(msg);
}

export function encodeTaskRequestFrame(
  sessionId: string,
  payload: Record<string, unknown>,
): Uint8Array {
  const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  msg.event = EventType.TaskRequest;
  msg.sessionId = sessionId;
  msg.payload = utf8Encoder.encode(JSON.stringify(payload));
  return marshalMessage(msg);
}

export function encodeFinishSessionFrame(sessionId: string): Uint8Array {
  const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  msg.event = EventType.FinishSession;
  msg.sessionId = sessionId;
  msg.payload = EMPTY_JSON_BYTES;
  return marshalMessage(msg);
}

export function encodeCancelSessionFrame(sessionId: string): Uint8Array {
  const msg = createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
  msg.event = EventType.CancelSession;
  msg.sessionId = sessionId;
  msg.payload = EMPTY_JSON_BYTES;
  return marshalMessage(msg);
}

function getWriters(
  msg: VolcProtocolMessage,
): Array<(msg: VolcProtocolMessage) => Uint8Array | null> {
  const writers: Array<(msg: VolcProtocolMessage) => Uint8Array | null> = [];

  switch (msg.type) {
    case MsgType.AudioOnlyClient:
    case MsgType.AudioOnlyServer:
    case MsgType.FrontEndResultServer:
    case MsgType.FullClientRequest:
    case MsgType.FullServerResponse:
      if (msg.flag === MsgTypeFlagBits.PositiveSeq || msg.flag === MsgTypeFlagBits.NegativeSeq) {
        writers.push(writeSequence);
      }
      break;
    case MsgType.Error:
      writers.push(writeErrorCode);
      break;
    default:
      throw new Error(`Unsupported Volcengine message type: ${msg.type}`);
  }

  if (msg.flag === MsgTypeFlagBits.WithEvent) {
    writers.push(writeEvent, writeSessionId, writeConnectId);
  }

  writers.push(writePayload);
  return writers;
}

function getReaders(
  msg: VolcProtocolMessage,
): Array<(msg: VolcProtocolMessage, data: Uint8Array, offset: number) => number> {
  const readers: Array<(msg: VolcProtocolMessage, data: Uint8Array, offset: number) => number> = [];

  switch (msg.type) {
    case MsgType.AudioOnlyClient:
    case MsgType.AudioOnlyServer:
    case MsgType.FrontEndResultServer:
    case MsgType.FullClientRequest:
    case MsgType.FullServerResponse:
      if (msg.flag === MsgTypeFlagBits.PositiveSeq || msg.flag === MsgTypeFlagBits.NegativeSeq) {
        readers.push(readSequence);
      }
      break;
    case MsgType.Error:
      readers.push(readErrorCode);
      break;
    default:
      throw new Error(`Unsupported Volcengine message type: ${msg.type}`);
  }

  if (msg.flag === MsgTypeFlagBits.WithEvent) {
    readers.push(readEvent, readSessionId, readConnectId);
  }

  readers.push(readPayload);
  return readers;
}

function isConnectionEvent(event: EventType): boolean {
  return (
    event === EventType.StartConnection ||
    event === EventType.FinishConnection ||
    event === EventType.ConnectionStarted ||
    event === EventType.ConnectionFailed ||
    event === EventType.ConnectionFinished
  );
}

function writeEvent(msg: VolcProtocolMessage): Uint8Array | null {
  if (msg.event === undefined) return null;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, msg.event, false);
  return new Uint8Array(buf);
}

function writeSessionId(msg: VolcProtocolMessage): Uint8Array | null {
  if (msg.event === undefined || isConnectionEvent(msg.event)) return null;

  const idBytes = utf8Encoder.encode(msg.sessionId ?? "");
  const out = new Uint8Array(4 + idBytes.byteLength);
  new DataView(out.buffer).setUint32(0, idBytes.byteLength, false);
  out.set(idBytes, 4);
  return out;
}

function writeConnectId(msg: VolcProtocolMessage): Uint8Array | null {
  if (
    msg.event !== EventType.ConnectionStarted &&
    msg.event !== EventType.ConnectionFailed &&
    msg.event !== EventType.ConnectionFinished
  ) {
    return null;
  }
  const idBytes = utf8Encoder.encode(msg.connectId ?? "");
  const out = new Uint8Array(4 + idBytes.byteLength);
  new DataView(out.buffer).setUint32(0, idBytes.byteLength, false);
  out.set(idBytes, 4);
  return out;
}

function writeSequence(msg: VolcProtocolMessage): Uint8Array | null {
  if (msg.sequence === undefined) return null;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, msg.sequence, false);
  return new Uint8Array(buf);
}

function writeErrorCode(msg: VolcProtocolMessage): Uint8Array | null {
  if (msg.errorCode === undefined) return null;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, msg.errorCode, false);
  return new Uint8Array(buf);
}

function writePayload(msg: VolcProtocolMessage): Uint8Array {
  const out = new Uint8Array(4 + msg.payload.byteLength);
  new DataView(out.buffer).setUint32(0, msg.payload.byteLength, false);
  out.set(msg.payload, 4);
  return out;
}

function readEvent(msg: VolcProtocolMessage, data: Uint8Array, offset: number): number {
  if (offset + 4 > data.byteLength) throw new Error("Insufficient bytes for event");
  msg.event = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
  return offset + 4;
}

function readSessionId(msg: VolcProtocolMessage, data: Uint8Array, offset: number): number {
  if (msg.event === undefined || isConnectionEvent(msg.event)) return offset;
  if (offset + 4 > data.byteLength) throw new Error("Insufficient bytes for sessionId length");

  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  if (size > 0) {
    if (offset + size > data.byteLength) throw new Error("Insufficient bytes for sessionId");
    msg.sessionId = utf8Decoder.decode(data.subarray(offset, offset + size));
    offset += size;
  }
  return offset;
}

function readConnectId(msg: VolcProtocolMessage, data: Uint8Array, offset: number): number {
  if (
    msg.event !== EventType.ConnectionStarted &&
    msg.event !== EventType.ConnectionFailed &&
    msg.event !== EventType.ConnectionFinished
  ) {
    return offset;
  }
  if (offset + 4 > data.byteLength) throw new Error("Insufficient bytes for connectId length");

  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  if (size > 0) {
    if (offset + size > data.byteLength) throw new Error("Insufficient bytes for connectId");
    msg.connectId = utf8Decoder.decode(data.subarray(offset, offset + size));
    offset += size;
  }
  return offset;
}

function readSequence(msg: VolcProtocolMessage, data: Uint8Array, offset: number): number {
  if (offset + 4 > data.byteLength) throw new Error("Insufficient bytes for sequence");
  msg.sequence = new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
  return offset + 4;
}

function readErrorCode(msg: VolcProtocolMessage, data: Uint8Array, offset: number): number {
  if (offset + 4 > data.byteLength) throw new Error("Insufficient bytes for errorCode");
  msg.errorCode = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  return offset + 4;
}

function readPayload(msg: VolcProtocolMessage, data: Uint8Array, offset: number): number {
  if (offset + 4 > data.byteLength) throw new Error("Insufficient bytes for payload length");
  const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
  offset += 4;
  if (size > 0) {
    if (offset + size > data.byteLength) throw new Error("Insufficient bytes for payload");
    msg.payload = data.slice(offset, offset + size);
    offset += size;
  }
  return offset;
}
