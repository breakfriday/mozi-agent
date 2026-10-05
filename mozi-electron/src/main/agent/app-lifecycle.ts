import { app } from "electron";
import { createAgentLogger } from "../../../../shared/agent/logging";
import type { AgentProcessManager } from "./process-manager";

const log = createAgentLogger("main");

/** The application owns the Agent lifetime, including exits that skip before-quit. */
export function registerAgentShutdown(agent: AgentProcessManager, disposeIpc: () => void): void {
  let shutdownComplete = false;
  let shutdownStarted = false;
  const forceStop = () => {
    try { agent.forceStop(); }
    catch (error) { log.error("app.agent.cleanup.failed", {}, { message: String(error) }); }
  };
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void agent.stop().then(() => {
      disposeIpc();
      shutdownComplete = true;
      app.quit();
    }).catch((error: unknown) => {
      log.error("app.shutdown.failed", {}, { message: String(error) });
      forceStop();
      app.exit(1);
    });
  });
  app.on("will-quit", forceStop);
  process.on("exit", forceStop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      log.info("app.shutdown.signal", { stage: signal });
      app.quit();
    });
  }
}
