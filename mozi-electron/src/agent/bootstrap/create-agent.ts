import path from "node:path";
import type { RuntimePacket } from "../../../../shared/agent";
import type { AgentConfig } from "./config";
import { AgentApplication } from "../agent";
import { PiAdapter } from "../runtime/pi/pi-adapter";
import { SqliteMetadataRepository } from "../storage/sqlite/metadata-repository";
import { AgentController } from "../transport/agent-controller";
import { IpcServer } from "../transport/ipc-server";
import type { BrowserToMain } from "../../../../shared/browser";

/** Composition root: the only module coupling concrete runtime, store and transport. */
export function createAgent(config: AgentConfig, send: (packet: RuntimePacket | BrowserToMain) => void, fatal: (error: unknown) => void): {
  application: AgentApplication; server: IpcServer;
} {
  const store = new SqliteMetadataRepository(path.join(config.dataDir, "mozi.sqlite"));
  try {
    const runtime: PiAdapter = new PiAdapter(config, (operation, context) => server.callBrowser(operation, context));
    const application = new AgentApplication(store, runtime, event => server.event(event), fatal, runtime, config.provider && config.modelId ? { providerId: config.provider, modelId: config.modelId } : undefined);
    const server = new IpcServer(new AgentController(application), send);
    return { application, server };
  } catch (error) { store.close(); throw error; }
}
