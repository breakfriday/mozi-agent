import { useAgentStore } from "../agent/agentStore";
import { useModelStore } from "../agent/modelStore";

// Return independent snapshots so console edits cannot mutate the live stores.
const storeDebug = {
  agent: {
    getState: () => structuredClone(useAgentStore.getState()),
  },
  model: {
    getState: () => structuredClone(useModelStore.getState()),
  },
};

declare global {
  interface Window {
    __MOZI_DEBUG__?: typeof storeDebug;
  }
}

window.__MOZI_DEBUG__ = storeDebug;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (window.__MOZI_DEBUG__ === storeDebug) delete window.__MOZI_DEBUG__;
  });
}
