import { isAppError } from "../../../shared/agent";
import type { AgentApi, AgentEvent, AppError, ModelSelection, ParamsOf, RuntimeNotice } from "../../../shared/agent";
import { createAgentLogger } from "../../../shared/agent/logging";
import { applyAgentEvent, initialAgentState, installAgentSnapshot, isTerminalRun } from "./agentState";
import { interruptSubmissions, putSubmission } from "./submissionState";
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
export function createAgentActions(api: AgentApi, store: AgentStore, rememberSession: (id: string | null) => void = () => {}) {
  let attached = false;
  let lifecycle = 0;
  let generation = 0;
  let noticeVersion = 0;
  let connection = 0;
  let listVersion = 0;
  let operationVersion = 0;
  let newCreateInput: ParamsOf<"session.create"> | undefined;
  const localSessions = new Map<string, Pick<AgentState, "localSessionId" | "pendingSubmissions" | "messageOrder" | "modelSelection">>();
  let startInFlight = false;
  let subscription: { subscriptionId: string; sessionId: string } | undefined;
  let createInput: ParamsOf<"session.create"> | undefined;
  let syncJob: { token: number; sessionId: string; promise: Promise<boolean> } | undefined;
  let buffered: AgentEvent[] = [];
  let overflow = false;
  const finishedRuns = new Set<string>();
  let offEvent: () => void = () => {};
  let offRuntime: () => void = () => {};

  async function listSessions() {
    const version = ++listVersion;
    const token = connection;
    store.setState({ sessionsLoading: true, sessionsError: null });
    try {
      const sessions: AgentState["sessions"] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await api.listSessions({ limit: 100, ...(cursor ? { cursor } : {}) });
        if (version !== listVersion || token !== connection) return;
        sessions.push(...page.items);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw { code: "PROTOCOL_MISMATCH", message: "会话列表分页异常，请重试。" };
        if (cursor) cursors.add(cursor);
      } while (cursor);
      store.setState({ sessions });
      const state = store.getState();
      if (state.sessionId && !sessions.some(item => item.sessionId === state.sessionId)
        && !state.inFlightSubmissionId && !state.sessionOperation) await activateSession(null);
    } catch (error) {
      if (version === listVersion && token === connection) store.setState({ sessionsError: appError(error) });
    } finally {
      if (version === listVersion && token === connection) store.setState({ sessionsLoading: false });
    }
  }

  async function activateSession(sessionId: string | null) {
    const state = store.getState();
    if (state.inFlightSubmissionId || state.sessionOperation) return;
    if (state.sessionId === sessionId) {
      if (sessionId && state.runtime.state === "ready") await synchronize().catch(() => {});
      return;
    }
    localSessions.set(state.sessionId ?? "draft", {
      localSessionId: state.localSessionId, pendingSubmissions: state.pendingSubmissions, messageOrder: state.messageOrder, modelSelection: state.modelSelection,
    });
    generation++;
    if (subscription) void api.unsubscribeSession({ subscriptionId: subscription.subscriptionId }).catch(() => {});
    subscription = undefined;
    syncJob = undefined;
    buffered = [];
    finishedRuns.clear();
    const cached = localSessions.get(sessionId ?? "draft");
    const empty = initialAgentState(sessionId);
    store.setState({
      ...empty, ...cached, runtime: state.runtime, sessions: state.sessions,
      sessionsLoading: state.sessionsLoading, sessionsError: state.sessionsError,
    });
    rememberSession(sessionId);
    if (sessionId && state.runtime.state === "ready") await synchronize().catch(() => {});
  }

  function bindCreatedSession(sessionId: string) {
    store.setState((state) => ({
      sessionId,
      pendingSubmissions: Object.fromEntries(Object.entries(state.pendingSubmissions).map(([id, submission]) => [id,
        submission.localSessionId === state.localSessionId && submission.sessionId === null
          ? { ...submission, sessionId } : submission,
      ])),
    }));
    localSessions.delete("draft");
    rememberSession(sessionId);
  }

  async function newSession() {
    const state = store.getState();
    if (state.inFlightSubmissionId || state.sessionOperation) return;
    const token = connection;
    const operation = ++operationVersion;
    ++listVersion;
    store.setState({ sessionOperation: "new", sessionsError: null, sessionsLoading: false });
    try {
      // Reuse an uncertain creation when the current draft already has submissions.
      const input = state.sessionId
        ? newCreateInput ??= { clientOperationId: crypto.randomUUID() }
        : createInput ??= { clientOperationId: crypto.randomUUID(), ...(state.modelSelection ? { model: state.modelSelection } : {}) };
      const created = await api.createSession(input);
      if (token !== connection) return;
      ++listVersion;
      if (state.sessionId) {
        newCreateInput = undefined;
        store.setState({ sessionOperation: null, sessionsLoading: false });
        await activateSession(created.sessionId);
      } else {
        createInput = undefined;
        bindCreatedSession(created.sessionId);
        await synchronize().catch(() => {});
      }
      if (token === connection) void listSessions();
    } catch (error) {
      if (token === connection) store.setState({ sessionsError: appError(error) });
    } finally {
      if (token === connection && operation === operationVersion) store.setState({ sessionOperation: null });
    }
  }

  async function mutateSession(sessionId: string, title?: string) {
    const state = store.getState();
    if (state.sessionOperation || state.inFlightSubmissionId) throw new Error("请等待当前操作完成。");
    const token = connection;
    const operation = ++operationVersion;
    ++listVersion;
    store.setState({ sessionOperation: sessionId, sessionsError: null, sessionsLoading: false });
    try {
      if (title !== undefined) {
        const result = await api.renameSession({ sessionId, title: title.trim() });
        if (token !== connection) throw new Error("Agent 连接已变化，请重试。");
        ++listVersion;
        store.setState({ sessionsLoading: false });
        store.setState(current => ({ sessions: current.sessions.map(item => item.sessionId === sessionId ? result.session : item) }));
      } else {
        await api.deleteSession({ sessionId });
        if (token !== connection) throw new Error("Agent 连接已变化，请重试。");
        ++listVersion;
        localSessions.delete(sessionId);
        store.setState({ sessionsLoading: false });
        store.setState(current => ({ sessions: current.sessions.filter(item => item.sessionId !== sessionId), sessionOperation: null }));
        if (store.getState().sessionId === sessionId) {
          await activateSession(store.getState().sessions[0]?.sessionId ?? null);
          localSessions.delete(sessionId);
        }
      }
    } catch (error) {
      if (token === connection) store.setState({ sessionsError: appError(error) });
      throw error;
    } finally {
      if (token === connection && operation === operationVersion) store.setState({ sessionOperation: null });
    }
  }

  function buffer(event: AgentEvent) {
    if (buffered.length >= 10_000) { buffered = []; overflow = true; }
    buffered.push(event);
  }

  function synchronize(): Promise<boolean> {
    const sessionId = store.getState().sessionId;
    if (!sessionId) return Promise.resolve(true);
    const token = generation;
    if (syncJob?.token === token && syncJob.sessionId === sessionId) return syncJob.promise;
    store.setState({ syncStatus: "syncing", error: null });
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
      connection++;
      listVersion++;
      subscription = undefined;
      syncJob = undefined;
      buffered = [];
      finishedRuns.clear();
      store.setState((state) => ({
        ...interruptSubmissions(state, startInFlight),
        runtime: notice, lastSeq: 0, syncStatus: "idle", activeRunId: null,
        sessionsLoading: false, sessionOperation: null,
      }));
      startInFlight = false;
    } else {
      store.setState({ runtime: notice, error: null });
      void listSessions();
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
    connection++;
    listVersion++;
    offEvent(); offRuntime();
    if (subscription) void api.unsubscribeSession({ subscriptionId: subscription.subscriptionId }).catch(() => {});
    subscription = undefined;
    syncJob = undefined;
    buffered = [];
    store.setState((state) => ({ ...interruptSubmissions(state, startInFlight), syncStatus: "idle", sessionsLoading: false, sessionOperation: null }));
    startInFlight = false;
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
    if (store.getState().inFlightSubmissionId) return;
    const token = generation;
    let submitted = false;
    store.setState((state) => ({
      ...putSubmission(state, { ...pending, status: "sending", error: undefined }),
      inFlightSubmissionId: pending.clientMessageId, error: null,
    }));
    log.info("chat.submit", { clientMessageId: pending.clientMessageId, content: pending.content });
    try {
      let sessionId = store.getState().sessionId;
      if (!sessionId) {
        createInput ??= { clientOperationId: crypto.randomUUID(), ...(store.getState().modelSelection ? { model: store.getState().modelSelection! } : {}) };
        const created = await api.createSession(createInput);
        if (token !== generation) return;
        sessionId = created.sessionId;
        createInput = undefined;
        bindCreatedSession(sessionId);
        void listSessions();
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
        pendingSubmissions: state.pendingSubmissions[pending.clientMessageId] ? {
          ...state.pendingSubmissions,
          [pending.clientMessageId]: {
            ...state.pendingSubmissions[pending.clientMessageId], status: "accepted",
            messageId: accepted.messageId, runId: accepted.runId, error: undefined,
          },
        } : state.pendingSubmissions,
      }));
      if (accepted.disposition === "duplicate") await synchronize();
    } catch (error) {
      if (token !== generation) return;
      const failure = appError(error);
      if (!submitted && !store.getState().sessionId && ["INVALID_ARGUMENT", "PERMISSION_DENIED"].includes(failure.code)) createInput = undefined;
      const uncertain = submitted && !["INVALID_ARGUMENT", "SESSION_NOT_FOUND", "SESSION_BUSY", "CAPACITY_EXCEEDED", "SUBMISSION_CONFLICT", "PERMISSION_DENIED"].includes(failure.code);
      store.setState((state) => ({
        pendingSubmissions: state.pendingSubmissions[pending.clientMessageId] ? {
          ...state.pendingSubmissions,
          [pending.clientMessageId]: {
            ...state.pendingSubmissions[pending.clientMessageId], status: uncertain ? "unknown" : "rejected", error: failure,
          },
        } : state.pendingSubmissions,
      }));
      log.warn("chat.submit.failed", { clientMessageId: pending.clientMessageId, code: failure.code });
    } finally {
      if (token === generation) {
        startInFlight = false;
        store.setState({ inFlightSubmissionId: null });
      }
    }
  }

  async function setModel(model: ModelSelection) {
    const state = store.getState();
    if (state.runtime.state !== "ready" || state.sessionOperation || state.inFlightSubmissionId || state.activeRunId || state.syncStatus === "syncing"
      || Object.values(state.pendingSubmissions).some(item => item.status === "unknown")) {
      throw new Error("请等待当前操作完成或停止任务后再切换模型。");
    }
    if (!state.sessionId) {
      if (createInput) throw new Error("上次创建会话尚未确认，请先重试原提交。");
      store.setState({ modelSelection: model });
      return;
    }
    const token = generation;
    ++listVersion;
    const operation = ++operationVersion;
    store.setState({ sessionOperation: `model:${state.sessionId}`, sessionsLoading: false, error: null });
    try {
      const { session } = await api.setSessionModel({ sessionId: state.sessionId, model });
      if (token !== generation) return;
      ++listVersion;
      store.setState(current => ({ modelSelection: session.model ?? null, sessionsLoading: false,
        sessions: current.sessions.map(item => item.sessionId === session.sessionId ? session : item) }));
    } catch (error) {
      if (token === generation) store.setState({ error: appError(error) });
      throw error;
    } finally {
      if (token === generation && operation === operationVersion) store.setState({ sessionOperation: null });
    }
  }

  return {
    setModel,
    initialize, dispose, refresh, listSessions, activateSession, newSession,
    renameSession: (sessionId: string, title: string) => mutateSession(sessionId, title),
    deleteSession: (sessionId: string) => mutateSession(sessionId),
    async submit(text: string) {
      const content = text.trim();
      const state = store.getState();
      if (!content || state.sessionOperation || state.inFlightSubmissionId || state.activeRunId || state.syncStatus === "syncing") return;
      if (Object.values(state.pendingSubmissions).some((submission) => submission.status === "unknown")) {
        store.setState({ error: { code: "REQUEST_TIMEOUT", message: "上一条提交结果尚未确认，请先重试原提交。" } });
        return;
      }
      // Querying/creating through the real API also makes an offline backend visible.
      await send({
        localSessionId: state.localSessionId, sessionId: state.sessionId,
        clientMessageId: crypto.randomUUID(), content: [{ type: "text", text: content }], status: "sending",
      });
    },
    async retry(clientMessageId: string) {
      const state = store.getState();
      const pending = state.pendingSubmissions[clientMessageId];
      if (!pending || state.sessionOperation || state.inFlightSubmissionId || state.syncStatus === "syncing"
        || pending.localSessionId !== state.localSessionId || pending.sessionId !== state.sessionId) return;
      if (state.activeRunId && pending.status !== "unknown") return;
      if (Object.values(state.pendingSubmissions).some((item) => item.status === "unknown" && item.clientMessageId !== clientMessageId)) return;
      if (pending.status === "unknown" || pending.status === "rejected") await send(pending);
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
