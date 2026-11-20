import { create } from "zustand";
import { stripCodeBlocks } from "../agent/speechProjection";
import { bridgeApi } from "../runtime/bridge";
import { TtsAudioPlayer } from "../runtime/ttsAudioPlayer";

const AUTO_SPEAK_STORAGE_KEY = "mozi:tts-auto-speak";

function readInitialAutoSpeak(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_SPEAK_STORAGE_KEY) === "true";
}

function createUtteranceId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `utt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 将长文本按自然句末标点拆分为短句，使首帧 TaskRequest 保持短小以降低长文首包延迟。 */
function splitIntoSentences(text: string): string[] {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu);
  if (!parts) return text.trim() ? [text] : [];
  return parts.map((s) => s.trim()).filter(Boolean);
}

interface TtsStoreState {
  autoSpeak: boolean;
  /** 当前正在发声的目标键（自动流式为 `run:...`，单条点读为对应 `messageKey`）。 */
  speakingKey: string | null;
  errorMessage: string | null;
  setAutoSpeak: (enabled: boolean) => void;
  toggleAutoSpeak: () => void;
  clearError: () => void;
  startRunStream: (streamKey: string, sessionId: string) => void;
  appendDelta: (streamKey: string, text: string) => void;
  finishRunStream: (streamKey: string) => void;
  speakMessage: (targetKey: string, rawMarkdown: string, sessionId?: string) => void;
  stop: () => void;
}

let sharedPlayer: TtsAudioPlayer | null = null;
let ipcSubscribed = false;
let currentUtteranceId = "";
let currentStreamKey = "";

export const useTtsStore = create<TtsStoreState>((set, get) => {
  const ensureRuntimeBound = (): TtsAudioPlayer | null => {
    const api = bridgeApi.tts;
    if (!api || typeof window === "undefined") return null;

    if (!sharedPlayer) {
      sharedPlayer = new TtsAudioPlayer({
        onDrained: (drainedId) => {
          if (currentUtteranceId !== drainedId) return;
          currentUtteranceId = "";
          currentStreamKey = "";
          set({ speakingKey: null });
        },
      });
    }

    if (!ipcSubscribed) {
      ipcSubscribed = true;
      api.onEvent((event) => {
        if (event.utteranceId && event.utteranceId !== currentUtteranceId) return;

        switch (event.type) {
          case "audio":
            sharedPlayer?.pushPcm16Le(event.utteranceId, event.pcm, event.sampleRate);
            break;
          case "finished":
            sharedPlayer?.markNetworkFinished(event.utteranceId);
            if (event.audioBytes === 0 && currentUtteranceId === event.utteranceId) {
              currentUtteranceId = "";
              currentStreamKey = "";
              set({ speakingKey: null });
            }
            break;
          case "cancelled":
            sharedPlayer?.clearImmediate();
            currentUtteranceId = "";
            currentStreamKey = "";
            set({ speakingKey: null });
            break;
          case "error": {
            sharedPlayer?.clearImmediate();
            currentUtteranceId = "";
            currentStreamKey = "";
            const shouldPauseAuto = event.code === "UNCONFIGURED" || event.code === "AUTH_FAILED";
            if (shouldPauseAuto && get().autoSpeak) {
              window.localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, "false");
            }
            set({
              speakingKey: null,
              ...(shouldPauseAuto ? { autoSpeak: false } : {}),
              errorMessage: event.message,
            });
            break;
          }
        }
      });
    }

    return sharedPlayer;
  };

  return {
    autoSpeak: readInitialAutoSpeak(),
    speakingKey: null,
    errorMessage: null,

    setAutoSpeak: (enabled) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, String(enabled));
      }
      set({ autoSpeak: enabled, ...(enabled ? { errorMessage: null } : {}) });
      if (!enabled && currentStreamKey.startsWith("run:")) {
        get().stop();
      }
    },

    toggleAutoSpeak: () => {
      get().setAutoSpeak(!get().autoSpeak);
    },

    clearError: () => set({ errorMessage: null }),

    startRunStream: (streamKey, sessionId) => {
      const api = bridgeApi.tts;
      const player = ensureRuntimeBound();
      if (!api || !player) return;

      const utteranceId = createUtteranceId();
      currentUtteranceId = utteranceId;
      currentStreamKey = streamKey;
      set({ speakingKey: streamKey, errorMessage: null });

      void player.prepare(utteranceId, 24000);
      api.sendCommand({
        type: "start",
        utteranceId,
        ...(sessionId ? { sessionKey: sessionId } : {}),
      });
    },

    appendDelta: (streamKey, text) => {
      const api = bridgeApi.tts;
      if (!api || !text || currentStreamKey !== streamKey || !currentUtteranceId) return;
      api.sendCommand({ type: "delta", utteranceId: currentUtteranceId, text });
    },

    finishRunStream: (streamKey) => {
      const api = bridgeApi.tts;
      if (!api || currentStreamKey !== streamKey || !currentUtteranceId) return;
      api.sendCommand({ type: "finish", utteranceId: currentUtteranceId });
    },

    speakMessage: (targetKey, rawMarkdown, sessionId) => {
      if (get().speakingKey === targetKey) {
        get().stop();
        return;
      }

      const cleaned = stripCodeBlocks(rawMarkdown);
      if (!cleaned) return;

      const api = bridgeApi.tts;
      const player = ensureRuntimeBound();
      if (!api || !player) return;

      const utteranceId = createUtteranceId();
      currentUtteranceId = utteranceId;
      currentStreamKey = targetKey;
      set({ speakingKey: targetKey, errorMessage: null });

      void player.prepare(utteranceId, 24000);
      api.sendCommand({
        type: "start",
        utteranceId,
        ...(sessionId ? { sessionKey: sessionId } : {}),
      });
      for (const sentence of splitIntoSentences(cleaned)) {
        api.sendCommand({ type: "delta", utteranceId, text: sentence });
      }
      api.sendCommand({ type: "finish", utteranceId });
    },

    stop: () => {
      const prevId = currentUtteranceId;
      currentUtteranceId = "";
      currentStreamKey = "";
      sharedPlayer?.clearImmediate();
      if (prevId) {
        bridgeApi.tts?.sendCommand({ type: "cancel", utteranceId: prevId });
      } else {
        bridgeApi.tts?.sendCommand({ type: "cancel" });
      }
      if (get().speakingKey !== null) {
        set({ speakingKey: null });
      }
    },
  };
});
