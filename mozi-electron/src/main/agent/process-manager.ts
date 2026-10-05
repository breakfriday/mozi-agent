import { utilityProcess, type UtilityProcess } from "electron";
import { kill } from "node:process";
import type { RuntimeShutdown } from "../../../../shared/agent";
import { createAgentLogger } from "../../../../shared/agent/logging";
import { utilityProcessConnection } from "./utility-process-connection";
import type { AgentTransport } from "./transport";
const log = createAgentLogger("main");

export class AgentProcessManager {
  private child?: UtilityProcess;
  private stopping = false;
  private restarts = 0;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopPromise?: Promise<void>;
  private readonly offState: () => void;
  constructor(private readonly transport: AgentTransport, private readonly options: {
    entry: string; dataDir: string; startupMs?: number; shutdownMs?: number; killWaitMs?: number; restartMs?: number;
  }) {
    this.offState = transport.onState((notice) => {
      if (notice.state === "ready") { clearTimeout(this.startupTimer); log.info("process.ready"); }
    });
  }
  start(): void {
    if (this.stopping || this.child) return;
    try {
      const child = utilityProcess.fork(this.options.entry, [], {
        serviceName: "Mozi Agent", stdio: "inherit",
        env: { ...process.env, MOZI_AGENT_DATA_DIR: this.options.dataDir },
      });
      this.child = child;
      child.once("spawn", () => log.info("process.spawned"));
      child.once("exit", (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        clearTimeout(this.startupTimer);
        log[this.stopping && code === 0 ? "info" : "warn"]("process.exited", { code: String(code) });
        if (!this.stopping) this.scheduleRestart();
      });
      this.transport.connect(utilityProcessConnection(child));
      this.startupTimer = setTimeout(() => {
        if (this.child !== child || this.transport.getState().state === "ready") return;
        this.transport.disconnect("Agent 启动超时。");
        this.killChild(child);
      }, this.options.startupMs ?? 30_000);
      log.info("process.starting");
    } catch {
      this.transport.disconnect("Agent 进程启动失败。");
      if (this.child) this.killChild(this.child);
      else this.scheduleRestart();
    }
  }
  private scheduleRestart(): void {
    // Bounded across this app lifetime, including processes that crash just after ready.
    if (this.stopping || this.restarts >= 3) {
      if (!this.stopping) log.error("process.restart.exhausted");
      return;
    }
    this.restarts++;
    this.retryTimer = setTimeout(() => this.start(), (this.options.restartMs ?? 500) * this.restarts);
    log.info("process.restart.scheduled", { generation: this.restarts });
  }
  private killChild(child: UtilityProcess): void {
    const pid = child.pid;
    if (pid === undefined) {
      // A shutdown can race spawn. Kill this same child once its PID is available.
      child.once("spawn", () => { if (this.child === child) this.killChild(child); });
      return;
    }
    try {
      kill(pid, "SIGKILL");
      log.warn("process.kill.sent");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        log.error("process.kill.failed", { code: (error as NodeJS.ErrnoException).code });
        throw error;
      }
    }
  }
  /** Synchronous fallback for app.exit/process exit; never schedules a restart. */
  forceStop(): void {
    this.stopping = true;
    clearTimeout(this.retryTimer); clearTimeout(this.startupTimer); this.offState();
    if (this.child) this.killChild(this.child);
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    clearTimeout(this.retryTimer); clearTimeout(this.startupTimer); this.offState();
    const child = this.child;
    this.transport.disconnect("Agent 正在关闭。");
    this.stopPromise = child ? new Promise<void>((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onExit = () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); };
      const force = () => {
        clearTimeout(timer);
        log.warn("process.shutdown.forced");
        // Install the timeout before killing: exit may be delivered synchronously in tests.
        killTimer = setTimeout(() => {
          child.removeListener("exit", onExit);
          reject(new Error("Agent did not exit after SIGKILL."));
        }, this.options.killWaitMs ?? 2_000);
        try { this.killChild(child); }
        catch (error) { clearTimeout(killTimer); child.removeListener("exit", onExit); reject(error); }
      };
      const timer = setTimeout(force, this.options.shutdownMs ?? 5_000);
      child.once("exit", onExit);
      try { child.postMessage({ protocolVersion: 1, kind: "control", action: "shutdown" } satisfies RuntimeShutdown); }
      catch { force(); }
    }) : Promise.resolve();
    return this.stopPromise;
  }
}
