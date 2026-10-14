import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../../../../shared/agent";

/** Pi-specific runtime configuration shared by the adapter's subsystems. */
export interface PiConfig {
  dataDir: string;
  cwd: string;
  piDir: string;
  provider?: string;
  modelId?: string;
}

/** Model runtime snapshot passed from provider preparation into session creation. */
export type PiModelBinding = {
  runtime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  version: string;
  thinkingLevel?: ThinkingLevel;
};
