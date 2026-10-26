import type {
  ModelRuntime,
  ProviderConfig,
  AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelSelection,
  ProviderSaveInput,
} from "../../../../../../shared/agent";
import type { PiModelBinding } from "../types";

export type SavedProvider = Omit<ProviderSaveInput, "providerId" | "apiKey">;
export type ProviderConfiguration = {
  providers: Record<string, SavedProvider>;
};
export type ProviderModel = PiModelBinding["model"];
export interface OAuthInteractionPolicy {
  prompt: { message: string; placeholder?: string };
  normalizeInput(value: string): string;
  successMessage: string;
  failureMessage(error: unknown): string;
}
/** Statically registered capability definition; no filesystem scanning or plugin lifecycle magic. */
export interface ProviderPlugin {
  readonly id: string;
  readonly name?: string;
  readonly source: "builtin" | "extension";
  readonly priority?: number;
  readonly authMethods: readonly ("api_key" | "oauth")[];
  readonly endpointLocked?: boolean;
  readonly settingsEditable?: boolean;
  readonly dynamicModels?: boolean;
  readonly customModelDefaults?: "first-model";
  readonly oauth?: OAuthInteractionPolicy;
  createConfig(context: {
    cwd: string;
    agentDir: string;
    onInvalidGrant(): void;
  }): ProviderConfig | Promise<ProviderConfig>;
  normalizeSettings?(settings: SavedProvider): SavedProvider;
  validateRuntime?(runtime: ModelRuntime): void;
  supportsWebTools?(model: ProviderModel): boolean;
  supportsWebExtractor?(model: ProviderModel): boolean;
  configureAgent?(agent: AgentSession["agent"], visualBrowser: boolean): void;
  prepareModel?(model: ProviderModel, selection: ModelSelection): ProviderModel;
}
