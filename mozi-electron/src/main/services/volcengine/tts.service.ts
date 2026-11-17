/**
 * 火山引擎双向流式 TTS 服务门面。
 *
 * 外部只需要：
 *   const stream = service.startStream(options, handlers);
 *   stream.write(text); stream.finish(); / stream.cancel();
 *
 * 内部分工：
 * - `SessionMachine`（脑）：纯状态推进，产出语义化 `MachineEffect`
 * - 本类（手）：执行语义动作——编码二进制帧、操作连接、管理定时器、派发回调
 * - `VolcConnection`（请求底座）：管理单条 WebSocket 握手与收发
 */
import { randomUUID } from "node:crypto";
import { createDefaultWebSocket, VolcConnection } from "./connection";
import {
  buildAuthHeaders,
  buildSessionParams,
  buildStartSessionPayload,
  buildTaskRequestPayload,
  handshakeFingerprint,
  resolveEndpoint,
  type SessionParams,
} from "./payload";
import {
  SessionMachine,
  type MachineEffect,
  type MachineEvent,
  type StreamOutput,
  type TimerName,
} from "./session-machine";
import {
  encodeCancelSessionFrame,
  encodeFinishSessionFrame,
  encodeStartSessionFrame,
  encodeTaskRequestFrame,
} from "./tts-protocol";
import {
  DEFAULT_TTS_TIMEOUTS,
  toTtsError,
  VolcengineTtsError,
  type VolcengineTtsConfig,
  type VolcengineTtsDependencies,
  type VolcengineTtsDiagnostic,
  type VolcengineTtsStream,
  type VolcengineTtsStreamHandlers,
  type VolcengineTtsStreamOptions,
  type VolcengineTtsTimeouts,
  type VolcWebSocketLike,
} from "./types";

/** `sessionKey → section_id` 映射最多保留的条数，超出后按 LRU 淘汰最久未使用的条目。 */
const MAX_SECTION_IDS = 128;

export class VolcengineTtsService {
  private config: VolcengineTtsConfig;
  private readonly createSocket: (
    url: string,
    headers: Record<string, string>,
  ) => VolcWebSocketLike;
  private readonly timeouts: VolcengineTtsTimeouts;
  private readonly onDiagnostic?: (diagnostic: VolcengineTtsDiagnostic) => void;

  private readonly machine = new SessionMachine();
  private readonly handlers = new Map<string, VolcengineTtsStreamHandlers>();
  private readonly timers = new Map<TimerName, ReturnType<typeof setTimeout>>();
  private readonly sectionIds = new Map<string, string>();
  private connection?: VolcConnection;
  private disposed = false;

  /** 等待交给状态机处理的事件队列，详见 `drainEventQueue()`。 */
  private readonly eventQueue: MachineEvent[] = [];
  private draining = false;

  constructor(
    config: VolcengineTtsConfig = {},
    deps: VolcengineTtsDependencies = {},
  ) {
    this.config = { ...config };
    this.createSocket = deps.createWebSocket ?? createDefaultWebSocket;
    this.timeouts = { ...DEFAULT_TTS_TIMEOUTS, ...deps.timeouts };
    this.onDiagnostic = deps.onDiagnostic;
  }

  /** 更新配置：只改音色、语速等会话参数时保留现有热连接；改动密钥、端点、资源 ID 时自动轮转连接。 */
  configure(patch: Partial<VolcengineTtsConfig>): void {
    if (this.disposed) return;
    const before = handshakeFingerprint(this.config);
    this.config = { ...this.config, ...patch };
    if (handshakeFingerprint(this.config) !== before) {
      this.dispatch({ type: "config.handshakeChanged" });
    }
  }

  /** 开始一条流式合成，同步返回句柄；尚未结束的旧流会被自动抢占取消。 */
  startStream(
    options: VolcengineTtsStreamOptions = {},
    handlers: VolcengineTtsStreamHandlers,
  ): VolcengineTtsStream {
    const streamId = randomUUID();
    if (this.disposed) {
      return this.rejectStream(
        streamId,
        handlers,
        new VolcengineTtsError("NETWORK_ERROR", "语音合成服务已关闭。"),
      );
    }

    let params: SessionParams;
    try {
      // 提前校验端点、密钥与会话参数，配置不合法时立即通过 onError 告知调用方
      resolveEndpoint(this.config);
      buildAuthHeaders(this.config, streamId);
      const sectionId = options.sessionKey
        ? this.sectionIdFor(options.sessionKey)
        : undefined;
      params = buildSessionParams(this.config, options, sectionId);
    } catch (err) {
      return this.rejectStream(
        streamId,
        handlers,
        toTtsError(err, "INVALID_ARGUMENT"),
      );
    }

    this.handlers.set(streamId, handlers);
    this.dispatch({
      type: "stream.start",
      stream: { streamId, volcSessionId: randomUUID(), params },
    });

    const machine = this.machine;
    return {
      id: streamId,
      get active(): boolean {
        return machine.isStreamActive(streamId);
      },
      write: (text) => this.dispatch({ type: "stream.write", streamId, text }),
      finish: () => this.dispatch({ type: "stream.finish", streamId }),
      cancel: () => this.dispatch({ type: "stream.cancel", streamId }),
    };
  }

  /** 一次性合成整段文字（例如音色试听、历史消息重听）。 */
  speak(
    text: string,
    options: VolcengineTtsStreamOptions = {},
    handlers: VolcengineTtsStreamHandlers,
  ): VolcengineTtsStream {
    const stream = this.startStream(options, handlers);
    stream.write(text);
    stream.finish();
    return stream;
  }

  /** 取消当前正在进行或待启动的合成流。 */
  cancelCurrent(): void {
    this.dispatch({ type: "stream.cancelAll" });
  }

  /** 释放全部资源：无论从外部还是从回调内部重入调用，均立即封口、通知未终结流取消并销毁底层连接与定时器。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventQueue.length = 0;

    const effects = this.machine.handle({ type: "dispose" });
    this.closeConnection(false);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    for (const effect of effects) {
      if (effect.type === "output") this.deliver(effect.output);
    }

    this.handlers.clear();
    this.sectionIds.clear();
  }

  // ================= 事件分发与动作执行 =================

  /**
   * 所有输入的唯一入口：外部调用、连接回调、定时器到期都从这里进入。
   */
  private dispatch(event: MachineEvent): void {
    if (this.disposed) return;
    this.eventQueue.push(event);
    if (!this.draining) this.drainEventQueue();
  }

  /**
   * 逐个处理排队的事件：交给状态机得到动作，再按顺序执行这些动作。
   * 调用方在 `onCancel` / `onAudio` / `onDiagnostic` 回调中同步重入调用公共方法时，
   * 新事件只会排到队尾；若回调中调用了 `dispose()`，当前批次剩余副作用立即中止，防止连接或定时器复活。
   */
  private drainEventQueue(): void {
    this.draining = true;
    try {
      while (!this.disposed && this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        for (const effect of this.machine.handle(event)) {
          if (this.disposed) break;
          this.runEffect(effect);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 执行状态机决定的语义动作。部分动作执行后，结果会作为新事件回到 `dispatch()`：
   * - `connection.open`  → `connection.ready` / `connection.frame` / `connection.closed`
   * - `session.*`        → 服务端响应经 `connection.frame` 回来
   * - `timer.start`      → `timer.fired`
   * - `output` / `diagnostic` → 调用方回调可能同步重入公共 API
   */
  private runEffect(effect: MachineEffect): void {
    if (this.disposed) return;
    switch (effect.type) {
      case "connection.open":
        return this.openConnection();
      case "connection.close":
        return this.closeConnection(effect.graceful);
      case "session.start":
        return this.connection?.send(
          encodeStartSessionFrame(effect.volcSessionId, buildStartSessionPayload(effect.params)),
        );
      case "session.task":
        return this.connection?.send(
          encodeTaskRequestFrame(
            effect.volcSessionId,
            buildTaskRequestPayload(effect.params, effect.text),
          ),
        );
      case "session.finish":
        return this.connection?.send(encodeFinishSessionFrame(effect.volcSessionId));
      case "session.cancel":
        return this.connection?.send(encodeCancelSessionFrame(effect.volcSessionId));
      case "timer.start":
        return this.startTimer(effect.timer, effect.streamId);
      case "timer.clear":
        return this.clearTimer(effect.timer);
      case "output":
        return this.deliver(effect.output);
      case "diagnostic":
        return this.report(effect.diagnostic);
    }
  }

  private openConnection(): void {
    this.closeConnection(false);
    let url: string;
    let headers: Record<string, string>;
    try {
      url = resolveEndpoint(this.config);
      headers = buildAuthHeaders(this.config, randomUUID());
    } catch (err) {
      this.dispatch({
        type: "connection.closed",
        error: toTtsError(err, "INVALID_ARGUMENT"),
      });
      return;
    }

    const connection: VolcConnection = new VolcConnection({
      url,
      headers,
      createSocket: this.createSocket,
      connectTimeoutMs: this.timeouts.connectMs,
      finishTimeoutMs: this.timeouts.finishConnectionMs,
      listener: {
        onReady: (info) => {
          if (this.connection === connection) {
            this.dispatch({ type: "connection.ready", ...info });
          }
        },
        onFrame: (message) => {
          if (this.connection === connection) {
            this.dispatch({ type: "connection.frame", message });
          }
        },
        onClosed: (error) => {
          if (this.connection !== connection) return;
          this.connection = undefined;
          this.dispatch({ type: "connection.closed", error });
        },
      },
    });
    this.connection = connection;
    connection.open();
  }

  private closeConnection(graceful: boolean): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.close(graceful);
  }

  private startTimer(timer: TimerName, streamId?: string): void {
    this.clearTimer(timer);
    const handle = setTimeout(() => {
      this.timers.delete(timer);
      this.dispatch({ type: "timer.fired", timer, streamId });
    }, this.timerDuration(timer));
    // 空闲保活定时器不应阻止进程退出
    if (timer === "idle") handle.unref?.();
    this.timers.set(timer, handle);
  }

  private clearTimer(timer: TimerName): void {
    const handle = this.timers.get(timer);
    if (handle === undefined) return;
    clearTimeout(handle);
    this.timers.delete(timer);
  }

  private timerDuration(timer: TimerName): number {
    switch (timer) {
      case "sessionStart":
        return this.timeouts.sessionStartMs;
      case "sessionFinish":
        return this.timeouts.sessionFinishMs;
      case "cancelDrain":
        return this.timeouts.cancelDrainMs;
      case "idle":
        return this.timeouts.idleKeepaliveMs;
    }
  }

  /** 把状态机的结果交给调用方注册的回调；终态投递前先移除注册记录。 */
  private deliver(output: StreamOutput): void {
    const handlers = this.handlers.get(output.streamId);
    if (!handlers) return;
    const { streamId } = output;
    if (
      output.type === "completed" ||
      output.type === "cancelled" ||
      output.type === "failed"
    ) {
      this.handlers.delete(streamId);
    }

    this.invokeSafely(() => {
      switch (output.type) {
        case "started":
          return handlers.onStarted?.({
            streamId,
            volcSessionId: output.volcSessionId,
            logId: output.logId,
          });
        case "audio":
          return handlers.onAudio(output.chunk, {
            streamId,
            format: output.format,
            sampleRate: output.sampleRate,
          });
        case "sentenceStart":
          return handlers.onSentenceStart?.({ streamId, text: output.text });
        case "sentenceEnd":
          return handlers.onSentenceEnd?.({ streamId, text: output.text });
        case "completed":
          return handlers.onComplete?.({
            streamId,
            audioBytes: output.audioBytes,
            textWords: output.textWords,
            logId: output.logId,
          });
        case "cancelled":
          return handlers.onCancel?.({ streamId });
        case "failed":
          return handlers.onError?.(output.error);
      }
    });
  }

  private report(diagnostic: VolcengineTtsDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      /* 诊断回调异常不影响合成流程 */
    }
  }

  /** 调用方回调抛出的异常不能打断状态推进，转为诊断信息。 */
  private invokeSafely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.report({
        level: "error",
        name: "tts.callback.failed",
        detail: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** 无法启动的流：返回一个无效句柄，并在微任务中回调错误。 */
  private rejectStream(
    streamId: string,
    handlers: VolcengineTtsStreamHandlers,
    error: VolcengineTtsError,
  ): VolcengineTtsStream {
    void Promise.resolve().then(() =>
      this.invokeSafely(() => handlers.onError?.(error)),
    );
    return {
      id: streamId,
      active: false,
      write() {},
      finish() {},
      cancel() {},
    };
  }

  /** 同一业务会话键在容量内映射到稳定 `section_id`，使多轮合成保持声学上下文连贯。 */
  private sectionIdFor(sessionKey: string): string {
    const existing = this.sectionIds.get(sessionKey);
    this.sectionIds.delete(sessionKey);
    const sectionId = existing ?? randomUUID();
    this.sectionIds.set(sessionKey, sectionId);
    if (this.sectionIds.size > MAX_SECTION_IDS) {
      const oldest = this.sectionIds.keys().next().value;
      if (oldest !== undefined) this.sectionIds.delete(oldest);
    }
    return sectionId;
  }
}
