import { isApiResultFor } from "../../../shared/agent";
import type { AgentApi, AgentBridgeApi, AppError, Method, ResultOf, ApiResult } from "../../../shared/agent";
import type { MoziApi } from "../../../shared/mozi-api";

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
  async function call<M extends Method>(method: M, invoke: (api: AgentBridgeApi) => Promise<ApiResult<ResultOf<M>>>): Promise<ResultOf<M>> {
    const api = getBridge();
    if (!api) throw new AgentApiError({ code: "RUNTIME_UNAVAILABLE", message: "Agent is available only in the Mozi desktop app." });
    let response: unknown;
    try { response = await invoke(api); } catch {
      throw new AgentApiError({ code: "RUNTIME_UNAVAILABLE", message: "Agent bridge disconnected; request acceptance is unknown." });
    }
    if (!isApiResultFor(method, response)) {
      throw new AgentApiError({ code: "PROTOCOL_MISMATCH", message: "Agent bridge returned an invalid result." });
    }
    if (!response.ok) throw new AgentApiError(response.error);
    return response.result;
  }

  return {
    getRuntimeState: () => getBridge()
      ? call("runtime.getState", (api) => api.getRuntimeState())
      : Promise.resolve({ state: "unavailable", reason: "Agent is available only in the Mozi desktop app." }),
    createSession: (input) => call("session.create", (api) => api.createSession(input)),
    listSessions: (input) => call("session.list", (api) => api.listSessions(input)),
    getSessionSnapshot: (input) => call("session.snapshot", (api) => api.getSessionSnapshot(input)),
    subscribeSession: (input) => call("session.subscribe", (api) => api.subscribeSession(input)),
    unsubscribeSession: (input) => call("session.unsubscribe", (api) => api.unsubscribeSession(input)),
    startRun: (input) => call("run.start", (api) => api.startRun(input)),
    cancelRun: (input) => call("run.cancel", (api) => api.cancelRun(input)),
    getRun: (input) => call("run.get", (api) => api.getRun(input)),
    respondApproval: (input) => call("approval.respond", (api) => api.respondApproval(input)),
    onEvent: (listener) => getBridge()?.onEvent(listener) ?? (() => {}),
    onRuntimeState: (listener) => getBridge()?.onRuntimeState(listener) ?? (() => {}),
  };
}

export const agentApi = createAgentApi();
