import type { AgentRuntime, RuntimeHistoryMessage, RuntimeSession, RuntimeSessionDescriptor, RuntimeSessionInfo } from "../../application/ports/agent-runtime";
import { PiNativeHistory } from "./native-history";
import { PiSessionFactory, type PiConfig } from "./session-factory";
import { PiExecution } from "./execution";

/** Application-facing runtime adapter; all SDK types stay inside this directory. */
export class PiAdapter implements AgentRuntime {
  private readonly history: PiNativeHistory;
  private readonly factory: PiSessionFactory;
  constructor(config: PiConfig) {
    this.history = new PiNativeHistory(config);
    this.factory = new PiSessionFactory(config);
  }
  createSession(): Promise<RuntimeSessionDescriptor> { return this.history.createSession(); }
  listSessions(): Promise<RuntimeSessionInfo[]> { return this.history.listSessions(); }
  readHistory(descriptor: RuntimeSessionDescriptor): Promise<RuntimeHistoryMessage[]> { return this.history.readHistory(descriptor); }
  async openSession(descriptor: RuntimeSessionDescriptor): Promise<RuntimeSession> {
    const manager = this.history.open(descriptor);
    const session = await this.factory.create(manager, descriptor);
    return new PiExecution(session, manager);
  }
  dispose(): void { /* RunService releases every execution; ModelRuntime has no dispose API. */ }
}
