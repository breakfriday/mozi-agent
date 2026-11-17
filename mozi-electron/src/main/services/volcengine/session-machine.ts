/**
 * 会话状态机：集中管理“连接状态、远端会话槽位、待启动业务流”，并决定下一步动作。
 *
 * 核心边界与不变量：
 * 1. 纯计算无副作用：不直接操作 WebSocket 或定时器，输入 `MachineEvent`，返回 `MachineEffect[]`。
 * 2. 区分“业务流终结”与“远端会话释放”：
 *    - `pendingStream`：等待连接就绪或上一轮远端会话释放的业务流（最多 1 条，后发覆盖）；
 *    - `remoteSession`：正在占用火山单连接的远端会话（火山单连接严禁并发 Session）；
 *    - 取消时业务流立即产出 `cancelled` 终态，而 `remoteSession` 转入 `draining` 等待服务端 `151/152/153` 后才释放槽位。
 * 3. 终态唯一性：每条被接纳的流在移除前至多一次、且在非销毁正常终结路径上必有一次终态输出（`completed | cancelled | failed`）。
 */
import {
  classifyServerFailure,
  extractErrorMessage,
  extractUsageTextWords,
  MAX_BUFFERED_TEXT_CHARS,
  MAX_TEXT_CHUNK_CHARS,
  splitTextByCodePoints,
  type SessionParams,
} from "./payload";
import {
  decodeJsonPayload,
  EventType,
  MsgType,
  type VolcProtocolMessage,
} from "./tts-protocol";
import {
  VolcengineTtsError,
  type VolcengineAudioFormat,
  type VolcengineSampleRate,
  type VolcengineTtsDiagnostic,
} from "./types";

/** 由状态机申请、由执行器实际计时的定时器。 */
export type TimerName = "sessionStart" | "sessionFinish" | "cancelDrain" | "idle";

/** 新建一条合成流所需的静态信息。 */
export interface NewStream {
  streamId: string;
  /** 发给火山服务端的会话 ID，每轮合成唯一。 */
  volcSessionId: string;
  params: SessionParams;
}

/** 状态机的全部输入事件。 */
export type MachineEvent =
  // 外部指令
  | { type: "stream.start"; stream: NewStream }
  | { type: "stream.write"; streamId: string; text: string }
  | { type: "stream.finish"; streamId: string }
  | { type: "stream.cancel"; streamId: string }
  | { type: "stream.cancelAll" }
  | { type: "config.handshakeChanged" }
  | { type: "dispose" }
  // 连接产出
  | { type: "connection.ready"; connectId?: string; logId?: string }
  | { type: "connection.frame"; message: VolcProtocolMessage }
  | { type: "connection.closed"; error?: VolcengineTtsError }
  // 定时器到期
  | { type: "timer.fired"; timer: TimerName; streamId?: string };

/** 通知调用方的业务结果。 */
export type StreamOutput =
  | { type: "started"; streamId: string; volcSessionId: string; logId?: string }
  | {
      type: "audio";
      streamId: string;
      chunk: Uint8Array;
      format: VolcengineAudioFormat;
      sampleRate: VolcengineSampleRate;
    }
  | { type: "sentenceStart"; streamId: string; text?: string }
  | { type: "sentenceEnd"; streamId: string; text?: string }
  | { type: "completed"; streamId: string; audioBytes: number; textWords?: number; logId?: string }
  | { type: "cancelled"; streamId: string }
  | { type: "failed"; streamId: string; error: VolcengineTtsError };

/** 状态机产出的待执行语义动作。 */
export type MachineEffect =
  | { type: "connection.open" }
  | { type: "connection.close"; graceful: boolean }
  | { type: "session.start"; volcSessionId: string; params: SessionParams }
  | { type: "session.task"; volcSessionId: string; params: SessionParams; text: string }
  | { type: "session.finish"; volcSessionId: string }
  | { type: "session.cancel"; volcSessionId: string }
  | { type: "timer.start"; timer: TimerName; streamId?: string }
  | { type: "timer.clear"; timer: TimerName }
  | { type: "output"; output: StreamOutput }
  | { type: "diagnostic"; diagnostic: VolcengineTtsDiagnostic };

/**
 * 连接状态：
 * - `disconnected`：无活跃连接（或旧连接已逻辑脱离、正在后台关闭）
 * - `connecting`：握手中，等待 `ConnectionStarted(50)`
 * - `ready`：连接可用，可承载远端会话
 */
type ConnectionPhase = "disconnected" | "connecting" | "ready";

/**
 * 远端会话阶段（对应单连接上唯一运行的火山 Session）：
 * - `starting`：已发 `StartSession(100)`，等待 `SessionStarted(150)`
 * - `streaming`：已收到 `150`，边发文本边收音频
 * - `finishing`：已发 `FinishSession(102)`，等待剩余音频与 `SessionFinished(152)`
 * - `draining`：本地业务流已终结（取消或本地中止），等待服务端回传 `151/152/153` 释放连接槽位；期间音频一律丢弃
 */
type RemoteSessionPhase = "starting" | "streaming" | "finishing" | "draining";

/** 尚未占用远端连接的待启动业务流。 */
interface PendingStream extends NewStream {
  bufferedText: string[];
  bufferedChars: number;
  /** 是否写入过非空文本；从未写入就结束的流本地直接完成，不占用远端会话。 */
  hasText: boolean;
  finishRequested: boolean;
}

/** 正在占用远端连接的会话状态。 */
interface RemoteSession extends NewStream {
  phase: RemoteSessionPhase;
  /** 等待 `SessionStarted(150)` 期间暂存的增量文本。 */
  bufferedText: string[];
  bufferedChars: number;
  finishRequested: boolean;
  /** `draining` 阶段是否已向服务端发出 `CancelSession(101)`（`starting` 期间被取消时需等 `150` 到达后补发）。 */
  cancelSent: boolean;
  audioBytes: number;
  textWords?: number;
}

/** 这些错误换新连接重试也不会成功，待启动流应直接失败。 */
const NON_RETRYABLE_CODES = new Set(["UNCONFIGURED", "INVALID_ARGUMENT", "AUTH_FAILED", "QUOTA_EXCEEDED"]);

export class SessionMachine {
  private connection: ConnectionPhase = "disconnected";
  /** 当前连接的握手 `X-Tt-Logid`，用于排障追踪。 */
  private logId?: string;
  /** 握手配置已变更：当前连接空闲后需重建。 */
  private connectionStale = false;
  private disposed = false;
  /** 当前占用火山单连接槽位的远端会话。 */
  private remoteSession?: RemoteSession;
  /** 等待启动的下一条业务流（单槽位，后发覆盖）。 */
  private pendingStream?: PendingStream;

  private effects: MachineEffect[] = [];

  handle(event: MachineEvent): MachineEffect[] {
    this.effects = [];
    if (!this.disposed) this.applyEvent(event);
    const result = this.effects;
    this.effects = [];
    return result;
  }

  /** 业务流是否仍处于有效未终结状态（待启动或远端运行中，且未进入排空）。 */
  isStreamActive(streamId: string): boolean {
    if (this.pendingStream?.streamId === streamId) return true;
    return this.remoteSession?.streamId === streamId && this.remoteSession.phase !== "draining";
  }

  private applyEvent(event: MachineEvent): void {
    switch (event.type) {
      case "stream.start":
        return this.onStreamStart(event.stream);
      case "stream.write":
        return this.onStreamWrite(event.streamId, event.text);
      case "stream.finish":
        return this.onStreamFinish(event.streamId);
      case "stream.cancel":
        return this.onStreamCancel(event.streamId);
      case "stream.cancelAll":
        return this.cancelAll();
      case "config.handshakeChanged":
        return this.onHandshakeChanged();
      case "dispose":
        return this.onDispose();
      case "connection.ready":
        return this.onConnectionReady(event.connectId, event.logId);
      case "connection.frame":
        return this.onFrame(event.message);
      case "connection.closed":
        return this.onConnectionClosed(event.error);
      case "timer.fired":
        return this.onTimerFired(event.timer, event.streamId);
    }
  }

  // ================= 外部指令 =================

  private onStreamStart(stream: NewStream): void {
    // 后发抢占：取消待启动流与正在运行的远端会话
    this.cancelAll();
    this.pendingStream = {
      ...stream,
      bufferedText: [],
      bufferedChars: 0,
      hasText: false,
      finishRequested: false,
    };
    this.pushEffect({ type: "timer.clear", timer: "idle" });

    // 提前预热连接，使 TLS 握手与等待模型首字吐出的时间重叠
    if (this.connection === "disconnected") {
      this.openConnection();
    } else if (this.connection === "ready" && this.connectionStale && !this.remoteSession) {
      this.closeConnection(true);
      this.openConnection();
    }
  }

  private onStreamWrite(streamId: string, text: string): void {
    if (!text) return;

    if (this.pendingStream?.streamId === streamId) {
      const pending = this.pendingStream;
      if (pending.finishRequested) return;
      if (pending.bufferedChars + text.length > MAX_BUFFERED_TEXT_CHARS) {
        this.pendingStream = undefined;
        this.pushEffect({
          type: "output",
          output: {
            type: "failed",
            streamId,
            error: new VolcengineTtsError(
              "INVALID_ARGUMENT",
              `单次语音合成待发送缓冲文本超过上限（${MAX_BUFFERED_TEXT_CHARS} 字符）。`,
              { logId: this.logId },
            ),
          },
        });
        this.scheduleIdle();
        return;
      }
      pending.bufferedText.push(text);
      pending.bufferedChars += text.length;
      pending.hasText = true;
      this.promotePendingStream();
      return;
    }

    if (this.remoteSession?.streamId === streamId) {
      const session = this.remoteSession;
      if (session.phase === "draining" || session.finishRequested) return;

      if (session.phase === "streaming" && this.connection === "ready") {
        this.sendText(session, text);
        return;
      }

      if (session.phase === "starting") {
        if (session.bufferedChars + text.length > MAX_BUFFERED_TEXT_CHARS) {
          this.pushEffect({
            type: "output",
            output: {
              type: "failed",
              streamId,
              error: new VolcengineTtsError(
                "INVALID_ARGUMENT",
                `单次语音合成待发送缓冲文本超过上限（${MAX_BUFFERED_TEXT_CHARS} 字符）。`,
                { logId: this.logId },
              ),
            },
          });
          this.drainRemoteSession();
          return;
        }
        session.bufferedText.push(text);
        session.bufferedChars += text.length;
      }
    }
  }

  private onStreamFinish(streamId: string): void {
    if (this.pendingStream?.streamId === streamId) {
      const pending = this.pendingStream;
      if (pending.finishRequested) return;
      pending.finishRequested = true;

      // 从未写入有效文字（例如整条回复都是代码块）：本地短路完成，不发起远端会话
      if (!pending.hasText) {
        this.pendingStream = undefined;
        this.pushEffect({
          type: "output",
          output: { type: "completed", streamId, audioBytes: 0, textWords: 0, logId: this.logId },
        });
        this.scheduleIdle();
        return;
      }

      this.promotePendingStream();
      return;
    }

    if (this.remoteSession?.streamId === streamId) {
      const session = this.remoteSession;
      if (session.phase === "draining" || session.finishRequested) return;
      session.finishRequested = true;

      if (session.phase === "streaming" && this.connection === "ready") {
        this.flushBufferedText(session);
        this.sendFinishSession(session);
      }
    }
  }

  private onStreamCancel(streamId: string): void {
    if (this.pendingStream?.streamId === streamId) {
      this.cancelPendingStream();
      this.scheduleIdle();
    } else if (this.remoteSession?.streamId === streamId && this.remoteSession.phase !== "draining") {
      this.cancelRemoteSession();
    }
  }

  private onHandshakeChanged(): void {
    if (this.connection === "disconnected") return;
    if (!this.remoteSession && !this.pendingStream) {
      this.closeConnection(true);
    } else {
      // 有会话或待启动流在使用连接：待当前会话释放后再轮转连接
      this.connectionStale = true;
    }
  }

  private onDispose(): void {
    if (this.pendingStream) this.cancelPendingStream();
    if (this.remoteSession && this.remoteSession.phase !== "draining") {
      this.pushEffect({
        type: "output",
        output: { type: "cancelled", streamId: this.remoteSession.streamId },
      });
    }
    this.clearSessionTimers();
    this.remoteSession = undefined;
    this.closeConnection(false);
    this.disposed = true;
  }

  // ================= 连接产出 =================

  private onConnectionReady(connectId: string | undefined, logId: string | undefined): void {
    this.connection = "ready";
    this.logId = logId;
    this.pushEffect({
      type: "diagnostic",
      diagnostic: { level: "info", name: "tts.connection.ready", detail: { connectId, logId } },
    });
    this.promotePendingStream();
    this.scheduleIdle();
  }

  private onConnectionClosed(error: VolcengineTtsError | undefined): void {
    this.connection = "disconnected";
    this.connectionStale = false;
    this.clearSessionTimers();
    this.pushEffect({ type: "timer.clear", timer: "idle" });
    if (error) {
      this.pushEffect({
        type: "diagnostic",
        diagnostic: {
          level: "warn",
          name: "tts.connection.failed",
          detail: { code: error.code, message: error.message, logId: error.logId ?? this.logId },
        },
      });
    }

    const interrupted = this.remoteSession;
    this.remoteSession = undefined;
    if (interrupted && interrupted.phase !== "draining") {
      const activeError =
        error ?? new VolcengineTtsError("NETWORK_ERROR", "语音连接已关闭。", { logId: this.logId });
      this.pushEffect({
        type: "output",
        output: { type: "failed", streamId: interrupted.streamId, error: activeError },
      });
    }

    if (!this.pendingStream) return;
    if (this.shouldRetryPending(error, interrupted)) {
      if (this.pendingStream.hasText) {
        this.promotePendingStream();
      } else {
        this.openConnection();
      }
    } else {
      const pending = this.pendingStream;
      this.pendingStream = undefined;
      this.pushEffect({ type: "output", output: { type: "failed", streamId: pending.streamId, error: error! } });
    }
  }

  /**
   * 连接断开时，待启动流是否应换一条新连接继续：
   * - 服务端正常关闭（无错误）：继续
   * - 断开前正有上一轮远端会话（例如抢占排空超时断连、或旧会话中途断网）且错误可重试：继续
   * - 其他情况（例如为该流自身建连就遇到鉴权失败/配额耗尽）：直接失败，避免死循环重连
   */
  private shouldRetryPending(
    error: VolcengineTtsError | undefined,
    interrupted: RemoteSession | undefined,
  ): boolean {
    if (!error) return true;
    return interrupted !== undefined && !NON_RETRYABLE_CODES.has(error.code);
  }

  private onFrame(message: VolcProtocolMessage): void {
    const session = this.remoteSession;
    if (!session) return;
    // 带 sessionId 的帧必须匹配当前远端会话；纯序号裸音频帧（无 sessionId）依赖单连接串行门控与阶段守卫隔离
    if (message.sessionId && message.sessionId !== session.volcSessionId) return;

    if (message.type === MsgType.AudioOnlyServer) {
      this.onAudio(session, message.payload);
      return;
    }
    if (message.type !== MsgType.FullServerResponse) return;

    switch (message.event) {
      case EventType.SessionStarted:
        return this.onSessionStarted(session);
      case EventType.TTSSentenceStart:
      case EventType.TTSSentenceEnd: {
        if (session.phase === "draining" || session.phase === "starting") return;
        if (session.phase === "finishing") {
          this.pushEffect({ type: "timer.start", timer: "sessionFinish", streamId: session.streamId });
        }
        const payload = safeJson(message);
        const text = typeof payload?.text === "string" ? payload.text : undefined;
        const type = message.event === EventType.TTSSentenceStart ? "sentenceStart" : "sentenceEnd";
        this.pushEffect({ type: "output", output: { type, streamId: session.streamId, text } });
        return;
      }
      case EventType.UsageResponse:
        session.textWords = extractUsageTextWords(safeJson(message)) ?? session.textWords;
        return;
      case EventType.SessionFinished:
        return this.onSessionFinished(session, safeJson(message));
      case EventType.SessionCanceled:
        return this.onSessionCanceled(session, safeJson(message));
      case EventType.SessionFailed:
        return this.onSessionFailed(session, safeJson(message));
    }
  }

  private onAudio(session: RemoteSession, chunk: Uint8Array): void {
    // 排空中或尚未收到 150 的会话音频一律丢弃，防止串音
    if (session.phase !== "streaming" && session.phase !== "finishing") return;
    if (chunk.byteLength === 0) return;
    if (session.phase === "finishing") {
      // 仍在持续收到尾段合成音频，续期收尾看门狗
      this.pushEffect({ type: "timer.start", timer: "sessionFinish", streamId: session.streamId });
    }
    session.audioBytes += chunk.byteLength;
    this.pushEffect({
      type: "output",
      output: {
        type: "audio",
        streamId: session.streamId,
        chunk,
        format: session.params.format,
        sampleRate: session.params.sampleRate,
      },
    });
  }

  private onSessionStarted(session: RemoteSession): void {
    if (session.phase === "draining") {
      // starting 阶段被抢占取消后迟到的 150：此时服务端会话已就绪，立即补发 CancelSession(101)
      if (!session.cancelSent && this.connection === "ready") {
        session.cancelSent = true;
        this.pushEffect({ type: "session.cancel", volcSessionId: session.volcSessionId });
        this.pushEffect({ type: "timer.start", timer: "cancelDrain", streamId: session.streamId });
      }
      return;
    }

    if (session.phase !== "starting") {
      this.pushEffect({
        type: "diagnostic",
        diagnostic: {
          level: "warn",
          name: "tts.session.unexpected_started",
          detail: { volcSessionId: session.volcSessionId, phase: session.phase, logId: this.logId },
        },
      });
      return;
    }

    this.pushEffect({ type: "timer.clear", timer: "sessionStart" });
    session.phase = "streaming";
    this.pushEffect({
      type: "output",
      output: {
        type: "started",
        streamId: session.streamId,
        volcSessionId: session.volcSessionId,
        logId: this.logId,
      },
    });
    this.flushBufferedText(session);
    if (session.finishRequested) this.sendFinishSession(session);
  }

  private onSessionFinished(session: RemoteSession, payload: Record<string, unknown> | undefined): void {
    if (session.phase !== "draining") {
      this.pushEffect({
        type: "output",
        output: {
          type: "completed",
          streamId: session.streamId,
          audioBytes: session.audioBytes,
          textWords: extractUsageTextWords(payload) ?? session.textWords,
          logId: this.logId,
        },
      });
    }
    this.releaseRemoteSession();
  }

  private onSessionCanceled(session: RemoteSession, payload: Record<string, unknown> | undefined): void {
    if (session.phase !== "draining") {
      // 本地并未发起取消却收到 151：按异常中止通知调用方，确保业务流必有终态回调
      const error = new VolcengineTtsError(
        "PROTOCOL_ERROR",
        extractErrorMessage(payload) || "语音合成会话被服务端意外取消。",
        { logId: this.logId },
      );
      this.pushEffect({
        type: "diagnostic",
        diagnostic: {
          level: "warn",
          name: "tts.session.unexpected_canceled",
          detail: { volcSessionId: session.volcSessionId, message: error.message, logId: this.logId },
        },
      });
      this.pushEffect({ type: "output", output: { type: "failed", streamId: session.streamId, error } });
    }
    this.releaseRemoteSession();
  }

  private onSessionFailed(session: RemoteSession, payload: Record<string, unknown> | undefined): void {
    if (session.phase !== "draining") {
      const statusCode = typeof payload?.status_code === "number" ? payload.status_code : undefined;
      const error = classifyServerFailure(
        statusCode,
        extractErrorMessage(payload) || "语音合成会话失败。",
        this.logId,
      );
      this.pushEffect({
        type: "diagnostic",
        diagnostic: {
          level: "warn",
          name: "tts.session.failed",
          detail: {
            volcSessionId: session.volcSessionId,
            code: error.code,
            message: error.message,
            logId: this.logId,
          },
        },
      });
      this.pushEffect({ type: "output", output: { type: "failed", streamId: session.streamId, error } });
    }
    this.releaseRemoteSession();
  }

  // ================= 定时器到期 =================

  private onTimerFired(timer: TimerName, streamId: string | undefined): void {
    switch (timer) {
      case "sessionStart": {
        const session = this.remoteSession;
        if (!session || session.streamId !== streamId || session.phase !== "starting") return;
        this.clearSessionTimers();
        this.remoteSession = undefined;
        this.closeConnection(false);
        const error = new VolcengineTtsError("TIMEOUT", "等待火山语音会话启动超时。", { logId: this.logId });
        this.pushEffect({ type: "output", output: { type: "failed", streamId: session.streamId, error } });
        this.promotePendingStream();
        return;
      }
      case "sessionFinish": {
        const session = this.remoteSession;
        if (!session || session.streamId !== streamId || session.phase !== "finishing") return;
        this.pushEffect({
          type: "diagnostic",
          diagnostic: {
            level: "warn",
            name: "tts.session.finish_timeout",
            detail: { volcSessionId: session.volcSessionId, logId: this.logId },
          },
        });
        this.clearSessionTimers();
        this.remoteSession = undefined;
        this.closeConnection(false);
        const error = new VolcengineTtsError("TIMEOUT", "等待火山语音合成收尾完成超时。", { logId: this.logId });
        this.pushEffect({ type: "output", output: { type: "failed", streamId: session.streamId, error } });
        this.promotePendingStream();
        return;
      }
      case "cancelDrain": {
        const session = this.remoteSession;
        if (!session || session.streamId !== streamId || session.phase !== "draining") return;
        // 服务端迟迟不确认取消：销毁半死连接，换新连接继续执行待启动流
        this.pushEffect({
          type: "diagnostic",
          diagnostic: {
            level: "warn",
            name: "tts.session.cancel_timeout",
            detail: { volcSessionId: session.volcSessionId, logId: this.logId },
          },
        });
        this.clearSessionTimers();
        this.remoteSession = undefined;
        this.closeConnection(false);
        this.promotePendingStream();
        return;
      }
      case "idle":
        if (!this.remoteSession && !this.pendingStream && this.connection === "ready") {
          this.closeConnection(true);
        }
        return;
    }
  }

  // ================= 内部流程 =================

  /** 若连接空闲且待启动流已写入文本，将其提升为远端会话并发送 `StartSession(100)`。 */
  private promotePendingStream(): void {
    if (this.remoteSession) return;
    const next = this.pendingStream;
    // 尚未写入非空文本时不提前开远端会话，避免空会话占用与计费
    if (!next || !next.hasText) return;

    if (this.connection === "ready" && this.connectionStale) this.closeConnection(true);
    if (this.connection === "disconnected") {
      this.openConnection();
      return;
    }
    if (this.connection !== "ready") return;

    this.pendingStream = undefined;
    const session: RemoteSession = {
      streamId: next.streamId,
      volcSessionId: next.volcSessionId,
      params: next.params,
      phase: "starting",
      bufferedText: next.bufferedText,
      bufferedChars: next.bufferedChars,
      finishRequested: next.finishRequested,
      cancelSent: false,
      audioBytes: 0,
    };
    this.remoteSession = session;
    this.pushEffect({ type: "timer.clear", timer: "idle" });
    this.pushEffect({ type: "timer.start", timer: "sessionStart", streamId: session.streamId });
    this.pushEffect({
      type: "session.start",
      volcSessionId: session.volcSessionId,
      params: session.params,
    });
  }

  /** 远端会话收到终态帧（`151/152/153`），释放连接槽位并尝试启动下一条流。 */
  private releaseRemoteSession(): void {
    this.clearSessionTimers();
    this.remoteSession = undefined;
    if (this.connectionStale) this.closeConnection(true);
    this.promotePendingStream();
    this.scheduleIdle();
  }

  private cancelAll(): void {
    if (this.pendingStream) this.cancelPendingStream();
    if (this.remoteSession && this.remoteSession.phase !== "draining") {
      this.cancelRemoteSession();
    }
  }

  private cancelPendingStream(): void {
    const pending = this.pendingStream!;
    this.pendingStream = undefined;
    this.pushEffect({ type: "output", output: { type: "cancelled", streamId: pending.streamId } });
  }

  /** 取消正在运行的远端会话：立即向调用方发出 `cancelled`，随后将远端会话转入 `draining` 等待门控释放。 */
  private cancelRemoteSession(): void {
    const session = this.remoteSession!;
    this.pushEffect({ type: "output", output: { type: "cancelled", streamId: session.streamId } });
    this.drainRemoteSession();
  }

  /**
   * 将当前远端会话转入 `draining` 排空态（调用方在此之前已完成业务终态输出）。
   * - 已收到 `150` 的会话立即发送 `CancelSession(101)`；
   * - 仍处于 `starting` 的会话先记录待取消意图，待 `150` 到达时立即补发 `101`。
   */
  private drainRemoteSession(): void {
    const session = this.remoteSession!;
    const wasStarting = session.phase === "starting";
    this.pushEffect({ type: "timer.clear", timer: "sessionStart" });
    this.pushEffect({ type: "timer.clear", timer: "sessionFinish" });
    session.phase = "draining";
    session.bufferedText = [];
    session.bufferedChars = 0;

    if (this.connection !== "ready") {
      this.remoteSession = undefined;
      this.promotePendingStream();
      return;
    }

    if (wasStarting) {
      session.cancelSent = false;
    } else {
      session.cancelSent = true;
      this.pushEffect({ type: "session.cancel", volcSessionId: session.volcSessionId });
    }
    this.pushEffect({ type: "timer.start", timer: "cancelDrain", streamId: session.streamId });
  }

  private flushBufferedText(session: RemoteSession): void {
    if (session.bufferedText.length === 0) return;
    const text = session.bufferedText.join("");
    session.bufferedText = [];
    session.bufferedChars = 0;
    this.sendText(session, text);
  }

  private sendText(session: RemoteSession, text: string): void {
    for (const chunk of splitTextByCodePoints(text, MAX_TEXT_CHUNK_CHARS)) {
      this.pushEffect({
        type: "session.task",
        volcSessionId: session.volcSessionId,
        params: session.params,
        text: chunk,
      });
    }
  }

  private sendFinishSession(session: RemoteSession): void {
    session.phase = "finishing";
    this.pushEffect({ type: "session.finish", volcSessionId: session.volcSessionId });
    this.pushEffect({ type: "timer.start", timer: "sessionFinish", streamId: session.streamId });
  }

  private clearSessionTimers(): void {
    this.pushEffect({ type: "timer.clear", timer: "sessionStart" });
    this.pushEffect({ type: "timer.clear", timer: "sessionFinish" });
    this.pushEffect({ type: "timer.clear", timer: "cancelDrain" });
  }

  private scheduleIdle(): void {
    if (!this.remoteSession && !this.pendingStream && this.connection === "ready") {
      this.pushEffect({ type: "timer.start", timer: "idle" });
    }
  }

  private openConnection(): void {
    this.connection = "connecting";
    this.connectionStale = false;
    this.logId = undefined;
    this.pushEffect({ type: "connection.open" });
  }

  private closeConnection(graceful: boolean): void {
    this.connection = "disconnected";
    this.connectionStale = false;
    this.pushEffect({ type: "timer.clear", timer: "idle" });
    this.pushEffect({ type: "connection.close", graceful });
  }

  private pushEffect(effect: MachineEffect): void {
    this.effects.push(effect);
  }
}

function safeJson(message: VolcProtocolMessage): Record<string, unknown> | undefined {
  try {
    return decodeJsonPayload(message);
  } catch {
    return undefined;
  }
}
