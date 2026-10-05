import type { AgentBridgeApi } from "./agent/api";

export interface MoziApi {
  agent: AgentBridgeApi;
}

declare global {
  interface Window {
    // Absent in browser-only preview builds.
    mozi?: MoziApi;
  }
}
