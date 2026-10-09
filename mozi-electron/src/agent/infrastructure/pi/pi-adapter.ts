import type { AgentRuntime, RuntimeHistoryMessage, RuntimeSession, RuntimeSessionDescriptor, RuntimeSessionInfo } from "../../application/ports/agent-runtime";
import { PiNativeHistory } from "./native-history";
import { PiSessionFactory, type PiConfig } from "./session-factory";
import type { ModelSelection, ProviderSaveInput } from "../../../../../shared/agent";
import type { ModelCatalog, PreparedModel } from "../../application/ports/model-catalog";
import { PiProviderManager, type PiModelBinding } from "./provider-manager";
import { PiExecution } from "./execution";

/** Application-facing runtime adapter; all SDK types stay inside this directory. */
export class PiAdapter implements AgentRuntime, ModelCatalog {
  private readonly providers: PiProviderManager;
  private readonly history: PiNativeHistory;
  private readonly factory: PiSessionFactory;
  constructor(config: PiConfig) {
    this.providers = new PiProviderManager(config);
    this.history = new PiNativeHistory(config);
    this.factory = new PiSessionFactory(config);
  }
  listProviders() { return this.providers.listProviders(); }
  saveProvider(input: ProviderSaveInput) { return this.providers.saveProvider(input); }
  removeProvider(providerId: string) { return this.providers.removeProvider(providerId); }
  async prepareModel(selection: ModelSelection): Promise<PreparedModel> {
    const binding = await this.providers.prepare(selection);
    return { selection: { ...selection }, configVersion: binding.version, openSession: descriptor => this.openExecution(descriptor, binding) };
  }
  setSessionName(descriptor: RuntimeSessionDescriptor, name: string): void { this.history.setSessionName(descriptor, name); }
  createSession(): Promise<RuntimeSessionDescriptor> { return this.history.createSession(); }
  listSessions(): Promise<RuntimeSessionInfo[]> { return this.history.listSessions(); }
  readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]> { return this.history.readHistory(descriptor); }
  async openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession> {
    return this.openExecution(descriptor);
  }
  private async openExecution(descriptor: RuntimeSessionDescriptor, binding?: PiModelBinding): Promise<RuntimeSession> {
    const manager = this.history.acquire(descriptor);
    try {
      const session = await this.factory.create(manager, descriptor, binding);
      return new PiExecution(session, manager, () => this.history.release(descriptor));
    } catch (error) { this.history.release(descriptor); throw error; }
  }
  dispose(): void { /* RunService releases every execution; ModelRuntime has no dispose API. */ }
}
