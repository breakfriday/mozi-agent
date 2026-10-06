import path from "node:path";
import type { RuntimePacket } from "../../../../shared/agent";
import type { AgentConfig } from "./config";
import { AgentApplication } from "../application/agent-application";
import { PiAdapter } from "../infrastructure/pi/pi-adapter";
import { SqliteMetadataRepository } from "../infrastructure/sqlite/metadata-repository";
import { AgentController } from "../transport/agent-controller";
import { IpcServer } from "../transport/ipc-server";

/** Composition root: the only module coupling concrete runtime, store and transport. */
export function createAgent(config: AgentConfig, send: (packet: RuntimePacket) => void, fatal: (error: unknown) => void): {
  application: AgentApplication; server: IpcServer;
} {
  const store = new SqliteMetadataRepository(path.join(config.dataDir, "mozi.sqlite"));
  try {
    const runtime = new PiAdapter(config);
    const application = new AgentApplication(store, runtime, event => server.event(event), fatal, runtime, config.provider && config.modelId ? { providerId: config.provider, modelId: config.modelId } : undefined);
    const server = new IpcServer(new AgentController(application), send);
    return { application, server };
  } catch (error) { store.close(); throw error; }
}
