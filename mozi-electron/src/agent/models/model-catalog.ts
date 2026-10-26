import type { ModelSelection, ProviderSaveInput, ProviderView } from "../../../../shared/agent";
import type { RuntimeSession, RuntimeSessionDescriptor } from "../runtime/agent-runtime";

/** A Run holds this immutable configuration binding, never SDK objects or credentials. */
export interface PreparedModel {
  selection: ModelSelection;
  configVersion: string;
  openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession>;
}
export interface ModelCatalog {
  refreshProviderModels?(providerId: string): Promise<void>;
  auth?: {
    start(providerId: string): import("../../../../shared/agent").ProviderAuthState;
    status(providerId: string): import("../../../../shared/agent").ProviderAuthState;
    submit(input: import("../../../../shared/agent").ParamsOf<"provider.auth.submit">): import("../../../../shared/agent").ProviderAuthState;
    cancel(providerId: string, loginId: string): import("../../../../shared/agent").ProviderAuthState;
    open(providerId: string, loginId: string): import("../../../../shared/agent").ProviderAuthState;
    logout(providerId: string): Promise<void>;
  };
  listProviders(): Promise<ProviderView[]>;
  saveProvider(input: ProviderSaveInput): Promise<void>;
  removeProvider(providerId: string): Promise<void>;
  prepareModel(selection: ModelSelection): Promise<PreparedModel>;
}
