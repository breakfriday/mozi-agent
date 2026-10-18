import type { AgentRuntime, RuntimeHistoryMessage, RuntimeSession, RuntimeSessionDescriptor, RuntimeSessionInfo } from "../agent-runtime";
import { PiSessionStore } from "./sessions/session-store";
import { PiSessionFactory } from "./sessions/session-factory";
import type { PiConfig, PiModelBinding } from "./types";
import type { ModelSelection, ProviderSaveInput } from "../../../../../shared/agent";
import type { ModelCatalog, PreparedModel } from "../../models/model-catalog";
import { PiProviderManager } from "./providers/provider-manager";
import { PiExecution } from "./sessions/execution";
import type { BrowserCall } from "../../../../../shared/browser";

/** Application-facing runtime adapter; all SDK types stay inside this directory. */
export class PiAdapter implements AgentRuntime, ModelCatalog {
  private readonly providers: PiProviderManager;
  private readonly store: PiSessionStore;
  private readonly factory: PiSessionFactory;
  constructor(config: PiConfig, browser?: BrowserCall) {
    this.providers = new PiProviderManager(config, !!browser);
    this.store = new PiSessionStore(config);
    this.factory = new PiSessionFactory(config, browser);
  }
  listProviders() { return this.providers.listProviders(); }
  saveProvider(input: ProviderSaveInput) { return this.providers.saveProvider(input); }
  removeProvider(providerId: string) { return this.providers.removeProvider(providerId); }
  async prepareModel(selection: ModelSelection): Promise<PreparedModel> {
    const binding = await this.providers.prepare(selection);
    return { selection: { ...selection }, configVersion: binding.version, openSession: descriptor => this.openExecution(descriptor, binding) };
  }
  setSessionName(descriptor: RuntimeSessionDescriptor, name: string): void { this.store.setSessionName(descriptor, name); }
  deleteSession(descriptor: RuntimeSessionDescriptor): void { this.store.deleteSession(descriptor); }
  createSession(): Promise<RuntimeSessionDescriptor> { return this.store.createSession(); }
  listSessions(): Promise<RuntimeSessionInfo[]> { return this.store.listSessions(); }
  readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]> { return this.store.readHistory(descriptor); }
  readUsage(descriptor: RuntimeSessionDescriptor) { return this.store.readUsage(descriptor); }
  async openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession> {
    return this.openExecution(descriptor);
  }
  private async openExecution(descriptor: RuntimeSessionDescriptor, binding?: PiModelBinding): Promise<RuntimeSession> {
    // The adapter owns the reservation until creation succeeds; execution then owns release.
    const manager = this.store.acquire(descriptor);
    try {
      const session = await this.factory.create(manager, descriptor, binding);
      return new PiExecution(session, manager, () => this.store.release(descriptor));
    } catch (error) { this.store.release(descriptor); throw error; }
  }
  dispose(): void { /* RunService releases every execution; ModelRuntime has no dispose API. */ }
}
