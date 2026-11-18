import { bridgeApi } from "../runtime/bridge";
import { useTtsStore } from "../store/useTtsStore";
import { rememberAgentSession, useAgentStore } from "./agentStore";
import { createAgentActions } from "./createAgentActions";
import { createParticleProjection } from "./particleProjection";
import { composeProjections, createSpeechProjection } from "./speechProjection";

const particleProjection = createParticleProjection((content) => bridgeApi.projectParticles(content));
const speechProjection = createSpeechProjection({
  isAutoSpeakEnabled: () => useTtsStore.getState().autoSpeak,
  startRunStream: (streamKey, sessionId) => useTtsStore.getState().startRunStream(streamKey, sessionId),
  appendDelta: (streamKey, text) => useTtsStore.getState().appendDelta(streamKey, text),
  finishRunStream: (streamKey) => useTtsStore.getState().finishRunStream(streamKey),
  stop: () => useTtsStore.getState().stop(),
});

const projection = composeProjections(particleProjection, speechProjection);
export const agentActions = createAgentActions(bridgeApi.agent, useAgentStore, rememberAgentSession, projection);

if (import.meta.hot) import.meta.hot.dispose(() => agentActions.dispose());
