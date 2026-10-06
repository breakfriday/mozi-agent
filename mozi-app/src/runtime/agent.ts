import { isApiResultFor } from "../../../shared/agent";
import type { AgentApi, AgentBridgeApi, AppError, Method, ResultOf, ApiResult } from "../../../shared/agent";
import type { MoziApi } from "../../../shared/mozi-api";
import { createAgentLogger } from "../../../shared/agent/logging";

const log = createAgentLogger("renderer");

/** Constructed in the renderer, never passed through Electron contextBridge. */
export class AgentApiError extends Error {
  readonly code: AppError["code"];
  readonly appError: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = "AgentApiError";
    this.code = error.code;
    this.appError = { ...error };
  }
}

function getAgentBridge(): AgentBridgeApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { mozi?: MoziApi }).mozi?.agent;
}

export function createAgentApi(getBridge: () => AgentBridgeApi | undefined = getAgentBridge): AgentApi {
  async function call<M extends Method>(method: M, params: unknown, invoke: (api: AgentBridgeApi) => Promise<ApiResult<ResultOf<M>>>): Promise<ResultOf<M>> {
    const startedAt = Date.now();
    const context = { method, params };
    log.debug("request.send", context);
    const api = getBridge();
    if (!api) {
      log.warn("request.rejected", context, { code: "RUNTIME_UNAVAILABLE", stage: "bridge_missing" });
      throw new AgentApiError({ code: "RUNTIME_UNAVAILABLE", message: "Agent is available only in the Mozi desktop app." });
    }
    let response: unknown;
    try { response = await invoke(api); } catch {
      log.warn("request.rejected", context, { code: "RUNTIME_UNAVAILABLE", stage: "invoke_failed", durationMs: Date.now() - startedAt });
      throw new AgentApiError({ code: "RUNTIME_UNAVAILABLE", message: "Agent bridge disconnected; request acceptance is unknown." });
    }
    if (!isApiResultFor(method, response)) {
      log.error("response.rejected", context, response, { code: "PROTOCOL_MISMATCH" });
      throw new AgentApiError({ code: "PROTOCOL_MISMATCH", message: "Agent bridge returned an invalid result." });
    }
    if (!response.ok) {
      log.warn("response.rejected", context, response, { durationMs: Date.now() - startedAt });
      throw new AgentApiError(response.error);
    }
    log.debug("response.validated", context, response, { durationMs: Date.now() - startedAt });
    return response.result;
  }

  function listen<T>(listenerType: "event" | "runtime", listener: (value: T) => void,
    register: (api: AgentBridgeApi, callback: (value: T) => void) => () => void): () => void {
    const api = getBridge();
    if (!api) {
      log.warn("listener.skipped", { listenerType, stage: "bridge_missing" });
      return () => {};
    }
    const off = register(api, (value) => {
      log.debug("listener.received", { listenerType }, value);
      try {
        listener(value);
        log.debug("listener.delivered", { listenerType }, value);
      } catch (error) {
        log.error("listener.failed", { listenerType }, value);
        throw error;
      }
    });
    log.debug("listener.added", { listenerType });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      off();
      log.debug("listener.removed", { listenerType });
    };
  }

  return {
    getRuntimeState: () => getBridge()
      ? call("runtime.getState", {}, (api) => api.getRuntimeState())
      : Promise.resolve({ state: "unavailable", reason: "Agent is available only in the Mozi desktop app." }),
    createSession: (input) => call("session.create", input, (api) => api.createSession(input)),
    listSessions: (input) => call("session.list", input, (api) => api.listSessions(input)),
    renameSession: (input) => call("session.rename", input, (api) => api.renameSession(input)),
    deleteSession: (input) => call("session.delete", input, (api) => api.deleteSession(input)),
    getSessionSnapshot: (input) => call("session.snapshot", input, (api) => api.getSessionSnapshot(input)),
    subscribeSession: (input) => call("session.subscribe", input, (api) => api.subscribeSession(input)),
    unsubscribeSession: (input) => call("session.unsubscribe", input, (api) => api.unsubscribeSession(input)),
    startRun: (input) => call("run.start", input, (api) => api.startRun(input)),
    cancelRun: (input) => call("run.cancel", input, (api) => api.cancelRun(input)),
    getRun: (input) => call("run.get", input, (api) => api.getRun(input)),
    respondApproval: (input) => call("approval.respond", input, (api) => api.respondApproval(input)),
    onEvent: (listener) => listen("event", listener, (api, callback) => api.onEvent(callback)),
    onRuntimeState: (listener) => listen("runtime", listener, (api, callback) => api.onRuntimeState(callback)),
  };
}

export const agentApi = createAgentApi();
