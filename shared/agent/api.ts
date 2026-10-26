import type { AppError } from "./models";
import type { AgentEvent, Method, MethodMap, RuntimeNotice } from "./protocol";

export type ParamsOf<M extends Method> = MethodMap[M]["params"];
export type ResultOf<M extends Method> = MethodMap[M]["result"];

// Ordinary data survives both IPC and contextBridge, including error codes.
export type ApiResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: AppError };

export const AGENT_API_METHODS = {
  getRuntimeState: "runtime.getState",
  startProviderAuth: "provider.auth.start",
  statusProviderAuth: "provider.auth.status",
  submitProviderAuth: "provider.auth.submit",
  cancelProviderAuth: "provider.auth.cancel",
  openProviderAuth: "provider.auth.open",
  logoutProviderAuth: "provider.auth.logout",
  refreshProviderModels: "provider.refreshModels",
  getModelSettings: "model.settings",
  saveProvider: "provider.save",
  removeProvider: "provider.remove",
  setDefaultModel: "model.setDefault",
  setSessionModel: "session.setModel",
  createSession: "session.create",
  listSessions: "session.list",
  renameSession: "session.rename",
  deleteSession: "session.delete",
  getSessionSnapshot: "session.snapshot",
  subscribeSession: "session.subscribe",
  unsubscribeSession: "session.unsubscribe",
  startRun: "run.start",
  cancelRun: "run.cancel",
  getRun: "run.get",
  respondApproval: "approval.respond",
} as const satisfies Record<string, Method>;

type ApiMethodName = keyof typeof AGENT_API_METHODS;
type ArgumentsFor<M extends Method> = M extends "runtime.getState" | "model.settings"
  ? []
  : M extends "session.list"
    ? [input?: ParamsOf<M>]
    : [input: ParamsOf<M>];

interface AgentListeners {
  onProviderModelsChanged(listener: (providerId: string) => void): () => void;
  onProviderAuth(listener: (state: import("./auth").ProviderAuthState) => void): () => void;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  onRuntimeState(listener: (notice: RuntimeNotice) => void): () => void;
}

/** Renderer-facing API, implemented by bridgeApi.agent. */
export type AgentApi = AgentListeners & {
  [K in ApiMethodName]: (
    ...args: ArgumentsFor<(typeof AGENT_API_METHODS)[K]>
  ) => Promise<ResultOf<(typeof AGENT_API_METHODS)[K]>>;
};

/** Fixed methods exposed as window.mozi.agent by the isolated preload. */
export type AgentBridgeApi = AgentListeners & {
  [K in ApiMethodName]: (
    ...args: ArgumentsFor<(typeof AGENT_API_METHODS)[K]>
  ) => Promise<ApiResult<ResultOf<(typeof AGENT_API_METHODS)[K]>>>;
};
