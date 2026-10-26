import type { ModelRuntime, AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, WebMode } from "../../../../../shared/agent";

/** Pi-specific runtime configuration shared by the adapter's subsystems. */
export interface PiConfig {
  dataDir: string;
  cwd: string;
  provider?: string;
  modelId?: string;
}

/** Model runtime snapshot passed from provider preparation into session creation. */
export type PiModelBinding = {
  configureAgent?(agent: AgentSession["agent"], visualBrowser: boolean): void;
  runtime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  version: string;
  thinkingLevel?: ThinkingLevel;
  webMode?: WebMode;
};
