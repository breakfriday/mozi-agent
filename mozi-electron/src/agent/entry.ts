import path from "node:path";
import { AGENT_PROTOCOL_VERSION, isRuntimeShutdown } from "../../../shared/agent";
import type { RuntimePacket } from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";
import { readAgentConfig } from "./config";
import { PiAdapter } from "./pi-adapter";
import { AgentRepository } from "./repository";
import { AgentService } from "./service";
import { AgentServer } from "./transport";
import { appError } from "./errors";

const log = createAgentLogger("agent-service");
const port = process.parentPort;
if (!port) throw new Error("Agent must run in an Electron utility process.");
const send = (packet: RuntimePacket) => port.postMessage(packet);
let stopping = false;
const fatal = (error: unknown) => {
  log.error("service.failed", appError(error));
  try { send({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "runtime", state: "unavailable", reason: appError(error).message }); }
  finally { process.exit(1); }
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
try {
  const config = readAgentConfig(process.env);
  const repository = new AgentRepository(path.join(config.dataDir, "mozi.sqlite"));
  const runtime = new PiAdapter(config);
  const service = new AgentService(repository, runtime, (event) => server.event(event), fatal);
  const server = new AgentServer(service, send);
  service.initialize();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    send({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "runtime", state: "unavailable", reason: "Agent 正在关闭。" });
    await service.close();
    log.info("service.stopped");
    process.exit(0);
  };
  port.on("message", ({ data }) => {
    if (isRuntimeShutdown(data)) { void shutdown().catch(fatal); return; }
    if (!stopping) void server.receive(data).catch(fatal);
  });
  process.on("SIGTERM", () => { void shutdown().catch(fatal); });
  send({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "runtime", state: "ready" });
  log.info("service.ready");
} catch (error) { fatal(error); }
