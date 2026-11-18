const WORKLET_PROCESSOR_NAME = "mozi-tts-pcm-processor";

const WORKLET_SOURCE = `
class MoziTtsPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.utteranceId = "";
    this.chunks = [];
    this.chunkOffset = 0;
    this.networkDone = false;
    this.drainedSent = false;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "reset") {
        this.utteranceId = msg.utteranceId || "";
        this.chunks = [];
        this.chunkOffset = 0;
        this.networkDone = false;
        this.drainedSent = false;
        return;
      }

      if (msg.type === "clear") {
        this.utteranceId = "";
        this.chunks = [];
        this.chunkOffset = 0;
        this.networkDone = false;
        this.drainedSent = false;
        return;
      }

      if (msg.utteranceId !== this.utteranceId) return;

      if (msg.type === "push" && msg.samples instanceof Float32Array && msg.samples.length > 0) {
        this.chunks.push(msg.samples);
        return;
      }

      if (msg.type === "finish") {
        this.networkDone = true;
        if (this.chunks.length === 0 && !this.drainedSent && this.utteranceId) {
          this.drainedSent = true;
          this.port.postMessage({ type: "drained", utteranceId: this.utteranceId });
        }
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel0 = output[0];
    const frameCount = channel0.length;
    let written = 0;

    while (written < frameCount && this.chunks.length > 0) {
      const head = this.chunks[0];
      const available = head.length - this.chunkOffset;
      const toCopy = Math.min(available, frameCount - written);
      channel0.set(head.subarray(this.chunkOffset, this.chunkOffset + toCopy), written);
      written += toCopy;
      this.chunkOffset += toCopy;
      if (this.chunkOffset >= head.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }

    if (written < frameCount) {
      channel0.fill(0, written);
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel0);
    }

    if (this.networkDone && this.chunks.length === 0 && !this.drainedSent && this.utteranceId) {
      this.drainedSent = true;
      this.port.postMessage({ type: "drained", utteranceId: this.utteranceId });
    }

    return true;
  }
}

registerProcessor("${WORKLET_PROCESSOR_NAME}", MoziTtsPcmProcessor);
`;

export interface TtsAudioPlayerCallbacks {
  onDrained?: (utteranceId: string) => void;
}

/**
 * 基于 `AudioWorklet` 的零间隙 16-bit 小端 PCM 流式播放器。
 * - 移除直播追帧丢包上限，确保超实时合成语音完整播完不吞字；
 * - 支持 `< 1ms` 音频线程瞬时清空队列（`clearImmediate`）；
 * - 二次校验 `utteranceId`，丢弃切换瞬间滞留在 IPC 管道中的旧音频包。
 */
export class TtsAudioPlayer {
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private workletUrl: string | null = null;
  private initPromise: Promise<void> | null = null;
  private currentSampleRate = 24000;
  private volumeGain = 1;

  private activeUtteranceId: string | null = null;
  private carryByte: number | null = null;
  private pendingSamples: Float32Array[] = [];
  private pendingFinish = false;
  private readonly callbacks: TtsAudioPlayerCallbacks;

  constructor(callbacks: TtsAudioPlayerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** 为新一轮播报准备音频上下文并重置队列（建议在用户点击或开始播报瞬间调用）。 */
  async prepare(utteranceId: string, sampleRate = 24000): Promise<void> {
    this.activeUtteranceId = utteranceId;
    this.carryByte = null;
    this.pendingSamples = [];
    this.pendingFinish = false;

    await this.ensureContext(sampleRate);
    if (this.activeUtteranceId !== utteranceId) return;

    if (this.audioCtx?.state === "suspended") {
      await this.audioCtx.resume();
    }
    this.workletNode?.port.postMessage({ type: "reset", utteranceId });

    for (const samples of this.pendingSamples) {
      this.workletNode?.port.postMessage({ type: "push", utteranceId, samples }, [samples.buffer]);
    }
    this.pendingSamples = [];

    if (this.pendingFinish) {
      this.pendingFinish = false;
      this.workletNode?.port.postMessage({ type: "finish", utteranceId });
    }
  }

  /** 推入一帧 `pcm_s16le` 字节流；不匹配当前 `utteranceId` 时静默丢弃。 */
  pushPcm16Le(utteranceId: string, pcmBytes: Uint8Array, sampleRate = 24000): void {
    if (!utteranceId || utteranceId !== this.activeUtteranceId || pcmBytes.byteLength === 0) return;

    let bytes = pcmBytes;
    if (this.carryByte !== null) {
      const merged = new Uint8Array(1 + pcmBytes.byteLength);
      merged[0] = this.carryByte;
      merged.set(pcmBytes, 1);
      bytes = merged;
      this.carryByte = null;
    }

    const usableLength = bytes.byteLength & ~1;
    if (bytes.byteLength % 2 === 1) {
      this.carryByte = bytes[bytes.byteLength - 1];
    }
    if (usableLength === 0) return;

    const sampleCount = usableLength >> 1;
    const samples = new Float32Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, usableLength);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }

    if (this.workletNode && this.currentSampleRate === sampleRate) {
      this.workletNode.port.postMessage({ type: "push", utteranceId, samples }, [samples.buffer]);
    } else {
      this.pendingSamples.push(samples);
      void this.ensureContext(sampleRate);
    }
  }

  /** 通知播放器云端音频帧已全部发送完毕，待 Worklet 消费完最后一帧采样后回调 `onDrained`。 */
  markNetworkFinished(utteranceId: string): void {
    if (!utteranceId || utteranceId !== this.activeUtteranceId) return;
    this.carryByte = null;
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "finish", utteranceId });
    } else {
      this.pendingFinish = true;
    }
  }

  /** `< 1ms` 瞬时清空音频播放队列，无需销毁重建 `AudioContext`。 */
  clearImmediate(): void {
    this.activeUtteranceId = null;
    this.carryByte = null;
    this.pendingSamples = [];
    this.pendingFinish = false;
    this.workletNode?.port.postMessage({ type: "clear" });
  }

  /** 设置本地播放增益（`0.0 ~ 2.0`，默认 `1.0`），播放途中实时平滑生效。 */
  setVolume(gain: number): void {
    if (!Number.isFinite(gain)) return;
    const clamped = Math.max(0, Math.min(2, gain));
    this.volumeGain = clamped;
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.setTargetAtTime(clamped, this.audioCtx.currentTime, 0.015);
    } else if (this.gainNode) {
      this.gainNode.gain.value = clamped;
    }
  }

  /** 读取当前输出波形 RMS 电平（`0..1`），可用于 UI 动态声波指示。 */
  getOutputLevel(): number {
    if (!this.analyserNode || !this.analyserBuffer || this.audioCtx?.state !== "running") return 0;
    this.analyserNode.getFloatTimeDomainData(this.analyserBuffer);
    let sumSquares = 0;
    for (let i = 0; i < this.analyserBuffer.length; i++) {
      const v = this.analyserBuffer[i];
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / this.analyserBuffer.length);
    return Math.min(1, rms * 3.2);
  }

  dispose(): void {
    this.clearImmediate();
    this.workletNode?.disconnect();
    this.gainNode?.disconnect();
    this.analyserNode?.disconnect();
    this.workletNode = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.analyserBuffer = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    this.initPromise = null;
  }

  private async ensureContext(sampleRate: number): Promise<void> {
    const validRate = [8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)
      ? sampleRate
      : 24000;

    if (this.audioCtx && this.workletNode && this.currentSampleRate === validRate) {
      return;
    }
    if (this.initPromise && this.currentSampleRate === validRate) {
      return this.initPromise;
    }

    if (this.audioCtx) {
      this.workletNode?.disconnect();
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
      this.workletNode = null;
    }

    this.currentSampleRate = validRate;
    this.initPromise = (async () => {
      const ctx = new AudioContext({ sampleRate: validRate });
      if (!this.workletUrl) {
        const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
        this.workletUrl = URL.createObjectURL(blob);
      }
      await ctx.audioWorklet.addModule(this.workletUrl);

      const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const gain = ctx.createGain();
      gain.gain.value = this.volumeGain;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;

      node.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);

      node.port.onmessage = (ev: MessageEvent<{ type?: string; utteranceId?: string }>) => {
        if (ev.data?.type === "drained" && ev.data.utteranceId) {
          if (this.activeUtteranceId === ev.data.utteranceId) {
            this.activeUtteranceId = null;
          }
          this.callbacks.onDrained?.(ev.data.utteranceId);
        }
      };

      this.audioCtx = ctx;
      this.workletNode = node;
      this.gainNode = gain;
      this.analyserNode = analyser;
      this.analyserBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }
}
