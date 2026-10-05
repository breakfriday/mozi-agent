import { isAppError } from "../../../shared/agent";
import type { AgentApi, AgentEvent, AppError, RuntimeNotice } from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";
import { applyAgentEvent, installAgentSnapshot, isTerminalRun } from "./agentState";
import type { AgentState, PendingSubmission } from "./types";

interface AgentStore {
  getState(): AgentState;
  setState(update: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)): void;
}

const log = createAgentLogger("renderer");

function appError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error && typeof error === "object" && "appError" in error && isAppError(error.appError)) return error.appError;
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Agent 操作失败。" };
}

/** App-wide async actions for one selected session; no mock transport or Agent loop. */
export function createAgentActions(api: AgentApi, store: AgentStore, rememberSession: (id: string) => void = () => {}) {
  let attached = false;
  let lifecycle = 0;
  let generation = 0;
  let noticeVersion = 0;
  let startInFlight = false;
  let subscription: { subscriptionId: string; sessionId: string } | undefined;
  let createInput: { clientOperationId: string } | undefined;
  let syncJob: { token: number; sessionId: string; promise: Promise<boolean> } | undefined;
  let buffered: AgentEvent[] = [];
  let overflow = false;
  const finishedRuns = new Set<string>();
  let offEvent: () => void = () => {};
  let offRuntime: () => void = () => {};

  function buffer(event: AgentEvent) {
    if (buffered.length >= 10_000) { buffered = []; overflow = true; }
    buffered.push(event);
  }

  function synchronize(): Promise<boolean> {
    const sessionId = store.getState().sessionId;
    if (!sessionId) return Promise.resolve(true);
    const token = generation;
    if (syncJob?.token === token && syncJob.sessionId === sessionId) return syncJob.promise;
    store.setState({ syncStatus: "syncing" });
    const job = { token, sessionId, promise: Promise.resolve(false) };
    job.promise = (async () => {
      try {
        if (!subscription || subscription.sessionId !== sessionId) {
          const created = await api.subscribeSession({ sessionId });
          if (token !== generation) {
            await api.unsubscribeSession({ subscriptionId: created.subscriptionId }).catch(() => {});
            return false;
          }
          subscription = created;
        }
        // A bounded retry absorbs an event gap without a request per delta.
        for (let attempt = 0; attempt < 3; attempt++) {
          overflow = false;
          const snapshot = await api.getSessionSnapshot({ sessionId });
          if (token !== generation) return false;
          let state = installAgentSnapshot(store.getState(), snapshot);
          const events = buffered.filter((event) => event.seq > snapshot.lastSeq).sort((a, b) => a.seq - b.seq);
          let complete = !overflow;
          for (const event of events) {
            if (event.seq <= state.lastSeq) continue;
            if (event.seq !== state.lastSeq + 1) { complete = false; break; }
            try { state = applyAgentEvent(state, event); } catch { complete = false; break; }
          }
          buffered = events.filter((event) => event.seq > state.lastSeq);
          store.setState({ ...state, syncStatus: complete ? "ready" : "syncing" });
          if (complete) {
            log.info("snapshot.installed", { sessionId, lastSeq: state.lastSeq });
            return true;
          }
        }
        throw { code: "PROTOCOL_MISMATCH", message: "会话事件不连续，请重新同步。" } satisfies AppError;
      } catch (error) {
        if (token === generation) store.setState({ syncStatus: "error", error: appError(error) });
        throw error;
      } finally {
        if (syncJob === job) syncJob = undefined;
      }
    })();
    syncJob = job;
    return job.promise;
  }

  function receiveEvent(event: AgentEvent) {
    const state = store.getState();
    if (event.sessionId !== state.sessionId) return;
    if (event.type === "run.finished") finishedRuns.add(event.runId);
    if (state.syncStatus === "syncing") { buffer(event); return; }
    if (state.runtime.state !== "ready") return;
    if (event.seq <= state.lastSeq) return;
    if (state.syncStatus === "ready" && event.seq === state.lastSeq + 1) {
      try {
        store.setState(applyAgentEvent(state, event));
        log.debug("event.applied", event);
        return;
      } catch { /* Missing preceding state: recover from a snapshot. */ }
    }
    buffer(event);
    log.warn("event.resync", event, { lastSeq: state.lastSeq });
    void synchronize().catch(() => {});
  }

  function receiveRuntime(notice: RuntimeNotice) {
    noticeVersion++;
    if (notice.state === "unavailable") {
      generation++;
      subscription = undefined;
      syncJob = undefined;
      buffered = [];
      finishedRuns.clear();
      store.setState((state) => ({
        runtime: notice, lastSeq: 0, syncStatus: "idle", activeRunId: null, isSubmitting: false,
        pendingSubmission: state.pendingSubmission ? {
          ...state.pendingSubmission,
          status: startInFlight || state.pendingSubmission.status === "accepted" ? "unknown" : state.pendingSubmission.status === "sending" ? "rejected" : state.pendingSubmission.status,
        } : null,
      }));
      startInFlight = false;
    } else {
      store.setState({ runtime: notice, error: null });
      if (store.getState().sessionId) void synchronize().catch(() => {});
    }
  }

  async function refresh() {
    const token = generation;
    const version = noticeVersion;
    try {
      const notice = await api.getRuntimeState();
      if (token !== generation || version !== noticeVersion) return;
      receiveRuntime(notice);
    } catch (error) {
      if (token === generation && version === noticeVersion) store.setState({ error: appError(error) });
    }
  }

  function dispose() {
    if (!attached) return;
    attached = false;
    lifecycle++;
    generation++;
    offEvent(); offRuntime();
    if (subscription) void api.unsubscribeSession({ subscriptionId: subscription.subscriptionId }).catch(() => {});
    subscription = undefined;
    syncJob = undefined;
    buffered = [];
    startInFlight = false;
    store.setState({ isSubmitting: false, syncStatus: "idle" });
    log.info("chat.disposed");
  }

  function initialize() {
    if (attached) return () => {};
    attached = true;
    const owner = ++lifecycle;
    offEvent = api.onEvent((event) => { if (owner === lifecycle) receiveEvent(event); });
    offRuntime = api.onRuntimeState((notice) => { if (owner === lifecycle) receiveRuntime(notice); });
    log.info("chat.initialized", { stage: "real_bridge" });
    void refresh();
    return () => { if (owner === lifecycle) dispose(); };
  }

  async function send(pending: PendingSubmission) {
    if (store.getState().isSubmitting) return;
    const token = generation;
    let submitted = false;
    store.setState({ pendingSubmission: { ...pending, status: "sending" }, isSubmitting: true, error: null });
    log.info("chat.submit", { clientMessageId: pending.clientMessageId, content: pending.content });
    try {
      let sessionId = store.getState().sessionId;
      if (!sessionId) {
        createInput ??= { clientOperationId: crypto.randomUUID() };
        const created = await api.createSession(createInput);
        if (token !== generation) return;
        sessionId = created.sessionId;
        createInput = undefined;
        store.setState({ sessionId });
        rememberSession(sessionId);
      }
      if (store.getState().syncStatus !== "ready" && !await synchronize()) return;
      if (token !== generation) return;
      submitted = true;
      startInFlight = true;
      const accepted = await api.startRun({ sessionId, clientMessageId: pending.clientMessageId, content: pending.content });
      if (token !== generation) return;
      store.setState((state) => ({
        activeRunId: finishedRuns.has(accepted.runId) || state.runs.some((run) => run.id === accepted.runId && isTerminalRun(run.status))
          ? state.activeRunId : accepted.runId,
        pendingSubmission: state.messages.some((message) => message.clientMessageId === pending.clientMessageId)
          ? null : { ...pending, status: "accepted" },
      }));
      if (accepted.disposition === "duplicate") await synchronize();
    } catch (error) {
      if (token !== generation) return;
      const failure = appError(error);
      const uncertain = submitted && !["INVALID_ARGUMENT", "SESSION_NOT_FOUND", "SESSION_BUSY", "CAPACITY_EXCEEDED", "SUBMISSION_CONFLICT", "PERMISSION_DENIED"].includes(failure.code);
      store.setState((state) => ({
        error: failure,
        pendingSubmission: state.messages.some((message) => message.clientMessageId === pending.clientMessageId)
          ? null : { ...pending, status: uncertain ? "unknown" : "rejected" },
      }));
      log.warn("chat.submit.failed", { clientMessageId: pending.clientMessageId, code: failure.code });
    } finally {
      if (token === generation) {
        startInFlight = false;
        store.setState({ isSubmitting: false });
      }
    }
  }

  return {
    initialize, dispose, refresh,
    async submit(text: string) {
      const content = text.trim();
      const state = store.getState();
      if (!content || state.isSubmitting || state.activeRunId) return;
      if (state.pendingSubmission?.status === "unknown") {
        store.setState({ error: { code: "REQUEST_TIMEOUT", message: "上一条提交结果尚未确认，请先重试原提交。" } });
        return;
      }
      // Querying/creating through the real API also makes an offline backend visible.
      await send({ clientMessageId: crypto.randomUUID(), content: [{ type: "text", text: content }], status: "sending" });
    },
    async retry() {
      const pending = store.getState().pendingSubmission;
      if (pending && (pending.status === "unknown" || pending.status === "rejected")) await send(pending);
    },
    async cancel() {
      const { sessionId, activeRunId: runId } = store.getState();
      if (!sessionId || !runId) return;
      const token = generation;
      try {
        const result = await api.cancelRun({ sessionId, runId });
        if (token === generation && result.disposition === "already_finished") await synchronize();
      } catch (error) {
        if (token === generation) store.setState({ error: appError(error) });
      }
    },
  };
}
