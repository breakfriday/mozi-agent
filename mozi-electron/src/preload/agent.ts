import {
  AGENT_CHANNELS, AGENT_PROTOCOL_VERSION, AGENT_REQUEST_TIMEOUT_MS,
  isAgentEvent, isAgentRequest, isResponseFor, isRuntimeNotice, isWirePayload, responseMatchesRequest,
} from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";

const log = createAgentLogger("preload");
import type {
  AgentBridgeApi, AgentEvent, ApiResult, Method, ParamsOf, ResultOf, RuntimeNotice,
} from "../../../shared/agent";

interface PreloadIpc {
  invoke(channel: string, request: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export function createAgentPreloadApi(
  ipc: PreloadIpc,
  options: { requestId?: () => string; timeoutMs?: number } = {},
): { api: AgentBridgeApi; dispose(): void } {
  const makeId = options.requestId ?? (() => globalThis.crypto.randomUUID());
  const listeners = new Set<(notice: RuntimeNotice) => void>();
  const eventCleanups = new Set<() => void>();
  const pendingInvalidations = new Set<() => void>();
  let generation = 0;
  let disposed = false;

  function unavailable(message: string): ApiResult<never> {
    return { ok: false, error: { code: "RUNTIME_UNAVAILABLE", message } };
  }

  const notify = (notice: RuntimeNotice) => {
    log.info("runtime.changed", notice, { generation });
    if (notice.state === "unavailable") {
      generation++;
      for (const invalidate of [...pendingInvalidations]) invalidate();
    }
    for (const listener of listeners) listener(notice);
  };
  const runtimeHandler = (_event: unknown, value: unknown) => {
    if (disposed) return;
    if (isWirePayload(value) && isRuntimeNotice(value)) notify(value);
    else {
      log.error("runtime.rejected", value, { code: "PROTOCOL_MISMATCH" });
      notify({ state: "unavailable", reason: "Invalid runtime notification; resynchronize before continuing." });
    }
  };
  ipc.on(AGENT_CHANNELS.runtime, runtimeHandler);
  log.debug("listener.added", { listenerType: "runtime", stage: "ipc" });

  async function request<M extends Method>(method: M, params: ParamsOf<M>): Promise<ApiResult<ResultOf<M>>> {
    if (disposed) return unavailable("Agent bridge is disposed.");
    const requestId = makeId();
    const envelope = { protocolVersion: AGENT_PROTOCOL_VERSION, kind: "request", requestId, method, params };
    const startedAt = Date.now();
    log.debug("request.received", envelope);
    if (!isAgentRequest(envelope)) {
      log.warn("request.rejected", envelope, { code: "INVALID_ARGUMENT" });
      return { ok: false, error: { code: "INVALID_ARGUMENT", message: `Invalid parameters for ${method}.` } };
    }
    const token = generation;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let invalidate: () => void = () => {};
    try {
      const interrupted = new Promise<ApiResult<never>>((resolve) => {
        invalidate = () => {
          log.warn("request.interrupted", envelope, { generation });
          resolve(unavailable("Agent connection changed; resynchronize before continuing."));
        };
        pendingInvalidations.add(invalidate);
        timer = setTimeout(() => {
          log.warn("request.timeout", envelope, { code: "REQUEST_TIMEOUT" });
          resolve({ ok: false, error: { code: "REQUEST_TIMEOUT", message: "Agent request timed out; its acceptance is unknown." } });
        }, options.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS + 1_000);
      });
      const operation = (async (): Promise<ApiResult<ResultOf<M>>> => {
        try {
          log.debug("request.validated", envelope);
          log.debug("request.send", envelope);
          const response = await ipc.invoke(AGENT_CHANNELS.request, envelope);
          if (disposed || token !== generation || finished) {
            log.warn("response.dropped", response, { requestId, method, stage: finished ? "request_finished" : "old_connection" });
            return unavailable("Agent connection changed.");
          }
          if (!isResponseFor(method, response) || !responseMatchesRequest(envelope, response)) {
            log.error("response.rejected", response, { requestId, method, code: "PROTOCOL_MISMATCH" });
            return { ok: false, error: { code: "PROTOCOL_MISMATCH", message: "Agent response failed contract validation." } };
          }
          log.debug("response.validated", response, { method });
          return response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error };
        } catch {
          log.warn("request.rejected", { requestId, method, stage: "invoke_failed", code: "RUNTIME_UNAVAILABLE" });
          // Never throw custom Error properties across contextBridge.
          return unavailable("Agent IPC is unavailable; its acceptance is unknown.");
        }
      })();
      const result = await Promise.race([operation, interrupted]);
      log[result.ok ? "debug" : "warn"]("response.return", result, { requestId, method, durationMs: Date.now() - startedAt });
      return result;
    } finally {
      finished = true;
      clearTimeout(timer);
      pendingInvalidations.delete(invalidate);
    }
  }

  const api = {
    getRuntimeState: () => request("runtime.getState", {}),
    getModelSettings: () => request("model.settings", {}),
    saveProvider: (input) => request("provider.save", input),
    removeProvider: (input) => request("provider.remove", input),
    setDefaultModel: (input) => request("model.setDefault", input),
    setSessionModel: (input) => request("session.setModel", input),
    createSession: (input) => request("session.create", input),
    listSessions: (input = {}) => request("session.list", input),
    renameSession: (input) => request("session.rename", input),
    deleteSession: (input) => request("session.delete", input),
    getSessionSnapshot: (input) => request("session.snapshot", input),
    subscribeSession: (input) => request("session.subscribe", input),
    unsubscribeSession: (input) => request("session.unsubscribe", input),
    startRun: (input) => request("run.start", input),
    cancelRun: (input) => request("run.cancel", input),
    getRun: (input) => request("run.get", input),
    respondApproval: (input) => request("approval.respond", input),
    onEvent(listener: (event: AgentEvent) => void) {
      if (disposed) return () => {};
      const handler = (_event: unknown, payload: unknown) => {
        if (isAgentEvent(payload)) {
          log.debug("event.validated", payload);
          listener(payload);
          log.debug("event.delivered", payload);
        } else {
          log.error("event.rejected", payload, { code: "PROTOCOL_MISMATCH" });
          notify({ state: "unavailable", reason: "Invalid Agent event; resynchronize before continuing." });
        }
      };
      ipc.on(AGENT_CHANNELS.event, handler);
      const off = () => {
        if (!eventCleanups.has(off)) return;
        ipc.removeListener(AGENT_CHANNELS.event, handler);
        eventCleanups.delete(off);
        log.debug("listener.removed", { listenerType: "event", listeners: eventCleanups.size });
      };
      eventCleanups.add(off);
      log.debug("listener.added", { listenerType: "event", listeners: eventCleanups.size });
      return off;
    },
    onRuntimeState(listener: (notice: RuntimeNotice) => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      log.debug("listener.added", { listenerType: "runtime", listeners: listeners.size });
      return () => {
        if (listeners.delete(listener)) log.debug("listener.removed", { listenerType: "runtime", listeners: listeners.size });
      };
    },
  } satisfies AgentBridgeApi;

  return {
    api,
    dispose() {
      if (disposed) return;
      disposed = true;
      notify({ state: "unavailable", reason: "Agent bridge disposed." });
      ipc.removeListener(AGENT_CHANNELS.runtime, runtimeHandler);
      for (const off of [...eventCleanups]) off();
      listeners.clear();
      log.info("bridge.disposed");
    },
  };
}
