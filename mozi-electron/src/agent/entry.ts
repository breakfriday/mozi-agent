import { AGENT_PROTOCOL_VERSION, isRuntimeShutdown } from "../../../shared/agent";
import type { RuntimePacket } from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";
import { readAgentConfig } from "./bootstrap/config";
import { createAgent } from "./bootstrap/create-agent";
import { appError } from "./application/errors";

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
async function start(): Promise<void> {
  const config = readAgentConfig(process.env);
  const { application, server } = createAgent(config, send, fatal);
  const initialized = application.initialize();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    send({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "runtime", state: "unavailable", reason: "Agent 正在关闭。" });
    await application.close();
    log.info("service.stopped");
    process.exit(0);
  };
  port.on("message", ({ data }) => {
    if (isRuntimeShutdown(data)) { void shutdown().catch(fatal); return; }
    if (!stopping) void server.receive(data).catch(fatal);
  });
  process.on("SIGTERM", () => { void shutdown().catch(fatal); });
  await initialized;
  if (stopping) return;
  send({ protocolVersion: AGENT_PROTOCOL_VERSION, kind: "runtime", state: "ready" });
  log.info("service.ready");
}
void start().catch(fatal);
