import type { ModelSelection, ProviderSaveInput, ProviderView } from "../../../../../shared/agent";
import type { RuntimeSession, RuntimeSessionDescriptor } from "./agent-runtime";

/** A Run holds this immutable configuration binding, never SDK objects or credentials. */
export interface PreparedModel {
  selection: ModelSelection;
  configVersion: string;
  openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession>;
}
export interface ModelCatalog {
  listProviders(): Promise<ProviderView[]>;
  saveProvider(input: ProviderSaveInput): Promise<void>;
  removeProvider(providerId: string): Promise<void>;
  prepareModel(selection: ModelSelection): Promise<PreparedModel>;
}
