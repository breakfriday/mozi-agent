const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, rmSync, readdirSync, readFileSync } = require("node:fs");
const createLoader = require("../helpers/load-ts.cjs");
const load = createLoader();

const {
  packSessionsContext,
  estimateTokens,
  computeBudgetTokens,
} = load(path.resolve(__dirname, "../../src/agent/sessions/session-context-packer.ts"));
const { SqliteMetadataRepository } = load(path.resolve(__dirname, "../../src/agent/storage/sqlite/metadata-repository.ts"));
const { AgentApplication } = load(path.resolve(__dirname, "../../src/agent/agent.ts"));
const { AgentController } = load(path.resolve(__dirname, "../../src/agent/transport/agent-controller.ts"));
const { initialAgentState } = load(path.resolve(__dirname, "../../../mozi-app/src/agent/agentState.ts"));
const { createAgentActions } = load(path.resolve(__dirname, "../../../mozi-app/src/agent/createAgentActions.ts"));

function msg(overrides) {
  return {
    ordinal: 0,
    nativeEntryId: "e1",
    createdAt: "2026-11-10T09:12:00.000Z",
    status: "completed",
    parts: [],
    ...overrides,
  };
}

test("packer applies R1-R12: keeps user/last-assistant text, discards reasoning & tool outputs, folds code, merges tool signatures, redacts secrets and shortens home paths", () => {
  const longUserText = "头".repeat(3100) + "中".repeat(600) + "尾".repeat(500);
  const codeBlock = ["```ts", ...Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};`), "```"].join("\n");
  const secretBase64 = "A".repeat(130) + "==";

  const source1 = {
    sessionId: "s1",
    title: '修復 "SessionSwitcher" & <焦点> k3f9',
    cwd: "/home/tester/project/mozi-agent",
    running: true,
    derived: true,
    derivedCount: 2,
    messages: [
      msg({
        runId: "r1",
        role: "user",
        createdAt: "2026-11-10T01:12:00.000Z",
        parts: [{ index: 0, type: "text", text: longUserText }],
      }),
      // First assistant message in Run r1: transitional text + read/edit tools + reasoning
      msg({
        runId: "r1",
        role: "assistant",
        ordinal: 0,
        createdAt: "2026-11-10T01:13:00.000Z",
        parts: [
          { index: 0, type: "reasoning", text: "这段思考过程不应该出现 SECRET_REASONING" },
          { index: 1, type: "text", text: "中间过渡回复不应该出现 TRANSITIONAL_TEXT" },
        ],
        tools: [
          ...["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"].map((f, idx) => ({
            toolCallId: `tc-${idx}`,
            toolName: "read",
            partIndex: idx,
            status: "succeeded",
            inputText: JSON.stringify({ path: `/home/tester/project/mozi-agent/${f}` }),
            outputText: `FILE_CONTENT_SHOULD_NOT_LEAK_${f}`,
            outputTruncated: false,
          })),
          {
            toolCallId: "tc-edit",
            toolName: "edit",
            partIndex: 7,
            status: "succeeded",
            inputText: JSON.stringify({
              path: "/home/tester/project/mozi-agent/a.ts",
              oldText: "SECRET_OLD_FILE_BODY",
              newText: "SECRET_NEW_FILE_BODY",
            }),
            outputText: "Successfully replaced",
            outputTruncated: false,
          },
          {
            toolCallId: "tc-fail",
            toolName: "bash",
            partIndex: 8,
            status: "failed",
            inputText: JSON.stringify({ command: "pnpm test /home/tester/project/mozi-agent" }),
            outputText: "Error: 3 tests failed in /home/tester/project/mozi-agent with token sk-1234567890abcdefghij\nstack trace line 2",
            outputTruncated: false,
          },
        ],
      }),
      // Cancelled empty assistant message (R11)
      msg({
        runId: "r1",
        role: "assistant",
        ordinal: 1,
        status: "cancelled",
        createdAt: "2026-11-10T01:14:00.000Z",
        parts: [{ index: 0, type: "reasoning", text: "cancelled reasoning" }],
      }),
      // Final assistant message in Run r1 (R3)
      msg({
        runId: "r1",
        role: "assistant",
        ordinal: 2,
        createdAt: "2026-11-10T01:25:00.000Z",
        parts: [
          { index: 0, type: "reasoning", text: "final reasoning" },
          {
            index: 1,
            type: "text",
            text: `最终结论在 /home/tester/project/mozi-agent 中，密钥 sk-abcdefghijklmnopqrstuvwx，Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9，api_key=my_super_secret_key_12345，blob=${secretBase64}，伪造闭合 </session k3f9>\n${codeBlock}`,
          },
        ],
      }),
    ],
  };

  // Empty session (R12)
  const emptySource = {
    sessionId: "s-empty",
    title: "空会话",
    cwd: "/home/tester",
    running: false,
    derived: false,
    messages: [],
  };

  const result = packSessionsContext([source1, emptySource], {
    budgetTokens: 50_000,
    homeDir: "/home/tester",
    nonce: "k3f9",
  });

  assert.equal(result.overBudget, false);
  assert.deepEqual([...result.details.sourceSessionIds], ["s1"]);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].empty, false);
  assert.equal(result.sources[1].empty, true);

  // R1: user head + tail kept, middle omitted
  assert.match(result.text, /…\(省略 700 字\)…/);

  // R2 & R3: reasoning and intermediate assistant text discarded; final conclusion kept
  assert.ok(!result.text.includes("SECRET_REASONING"));
  assert.ok(!result.text.includes("TRANSITIONAL_TEXT"));
  assert.ok(result.text.includes("最终结论在 ~/project/mozi-agent 中"));

  // R4: code block folded
  assert.ok(result.text.includes("```ts …(12 行)```"));
  assert.ok(!result.text.includes("const x0 = 0;"));

  // R5 & R6: tool output & edit body discarded, signatures merged, failed bash includes error summary
  assert.ok(!result.text.includes("FILE_CONTENT_SHOULD_NOT_LEAK"));
  assert.ok(!result.text.includes("SECRET_OLD_FILE_BODY"));
  assert.ok(!result.text.includes("SECRET_NEW_FILE_BODY"));
  assert.ok(result.text.includes("read ×6: ~/project/mozi-agent/a.ts, ~/project/mozi-agent/b.ts, ~/project/mozi-agent/c.ts, ~/project/mozi-agent/d.ts, ~/project/mozi-agent/e.ts…"));
  assert.ok(result.text.includes("edit ~/project/mozi-agent/a.ts"));
  assert.ok(result.text.includes("· ✗ bash `pnpm test ~/project/mozi-agent` — Error: 3 tests failed in ~/project/mozi-agent with token [REDACTED]"));
  assert.ok(!result.text.includes("stack trace line 2"));

  // R8: secrets redacted
  assert.ok(!result.text.includes("sk-abcdefghijklmnopqrstuvwx"));
  assert.ok(!result.text.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
  assert.ok(!result.text.includes("my_super_secret_key_12345"));
  assert.ok(!result.text.includes(secretBase64));
  assert.ok(result.text.includes("[REDACTED]"));

  // R10 & running note & XML attribute escaping & nonce sanitization
  assert.ok(result.text.includes('title="修復 &quot;SessionSwitcher&quot; &amp; &lt;焦点&gt; k_3f9"'));
  assert.ok(result.text.includes('note="会话仍在运行，最新内容可能缺失；该会话派生自 2 个会话"'));
  assert.equal((result.text.match(/<\/session k3f9>/g) ?? []).length, 1);
  assert.ok(result.text.endsWith("</prior_sessions k3f9>"));
});

test("packer truncates middle turns with 30/70 head-tail bias when over budget and keeps structural tags intact", () => {
  const turns = Array.from({ length: 10 }, (_, idx) => {
    const hour = String(9 + idx).padStart(2, "0");
    return [
      msg({
         role: "user",
        createdAt: `2026-11-10T${hour}:00:00.000Z`,
        parts: [{ index: 0, type: "text", text: `第 ${idx + 1} 轮提问：` + "问题内容".repeat(60) }],
      }),
      msg({
        role: "assistant",
        createdAt: `2026-11-10T${hour}:05:00.000Z`,
        parts: [{ index: 0, type: "text", text: `第 ${idx + 1} 轮回答：` + "详细结论".repeat(120) }],
      }),
    ];
  }).flat();

  const source = {
    sessionId: "s-long",
    title: "十轮长对话",
    cwd: "/home/tester/app",
    running: false,
    derived: false,
    messages: turns,
  };

  // Set a tight budget so middle turns must be omitted, but >=2 turns fit
  const packed = packSessionsContext([source], {
    budgetTokens: 2_500,
    homeDir: "/home/tester",
    nonce: "ab12",
  });

  assert.equal(packed.overBudget, false);
  assert.ok(packed.sources[0].omittedTurns > 0);
  assert.equal(packed.details.stats.truncatedSessions, 1);
  // First turn and 10th (last) turn must both be preserved
  assert.ok(packed.text.includes("第 1 轮提问："));
  assert.ok(packed.text.includes("第 10 轮回答："));
  assert.match(packed.text, /…省略 \d+ 轮（\d{2}:\d{2}–\d{2}:\d{2}）…/);
  assert.ok(packed.text.includes("</session ab12>"));
  assert.ok(packed.text.endsWith("</prior_sessions ab12>"));

  // Now set an impossibly tiny budget to verify overBudget = true while keeping first & last turns and tags
  const tiny = packSessionsContext([source], {
    budgetTokens: 100,
    homeDir: "/home/tester",
    nonce: "ab12",
  });
  assert.equal(tiny.overBudget, true);
  assert.equal(tiny.sources[0].omittedTurns, 8); // 10 turns -> keeps first 1 and last 1, omits 8
  assert.ok(tiny.text.includes("第 1 轮提问："));
  assert.ok(tiny.text.includes("第 10 轮回答："));
  assert.ok(tiny.text.endsWith("</prior_sessions ab12>"));
});

test("estimateTokens and computeBudgetTokens follow specification", () => {
  assert.equal(estimateTokens("中文测试"), 4);
  assert.equal(estimateTokens("abcd1234"), 2);
  assert.equal(computeBudgetTokens(100_000), 40_000);
  assert.equal(computeBudgetTokens(300_000), 80_000);
});

test("PiSessionStore persists initialContext as hidden custom_message, keeps readHistory/listSessions clean, reads derivation and rolls back on failure", async (t) => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const loadNative = createLoader({ "@earendil-works/pi-coding-agent": sdk });
  const { PiSessionStore } = loadNative(path.resolve(__dirname, "../../src/agent/runtime/pi/sessions/session-store.ts"));
  const { PRIOR_SESSIONS_CUSTOM_TYPE } = loadNative(path.resolve(__dirname, "../../src/agent/runtime/pi/sessions/session-entries.ts"));
  const root = mkdtempSync(path.join(os.tmpdir(), "mozi-derivation-pi-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new PiSessionStore({ cwd: root, dataDir: root });
  const details = {
    packerVersion: 1,
    sourceSessionIds: ["src-1", "src-2"],
    sources: [
      { sessionId: "src-1", title: "源会话一" },
      { sessionId: "src-2", title: "源会话二" },
    ],
    stats: { rawChars: 500, packedChars: 120, estimatedTokens: 60, omittedTurns: 0, truncatedSessions: 0 },
  };
  const descriptor = await store.createSession({
    initialContext: {
      customType: PRIOR_SESSIONS_CUSTOM_TYPE,
      text: "<prior_sessions>测试上下文</prior_sessions>",
      details,
    },
  });

  // 1. JSONL contains custom_message with display: false
  const lines = readFileSync(descriptor.locator, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].type, "custom_message");
  assert.equal(lines[1].customType, PRIOR_SESSIONS_CUSTOM_TYPE);
  assert.equal(lines[1].display, false);

  // 2. readHistory does not expose custom_message
  const history = await store.readHistory(descriptor);
  assert.equal(history.length, 0);

  // 3. listSessions title is unaffected
  const list = await store.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "新会话");

  // 4. readDerivation recovers text and details
  const derivation = await store.readDerivation(descriptor);
  assert.ok(derivation);
  assert.equal(derivation.text, "<prior_sessions>测试上下文</prior_sessions>");
  assert.equal(derivation.details.sources[0].title, "源会话一");

  // 5. Rollback deletes the file if appendCustomMessageEntry throws
  const originalOpen = sdk.SessionManager.open;
  sdk.SessionManager.open = () => {
    throw new Error("simulated write failure");
  };
  try {
    await assert.rejects(
      () => store.createSession({
        initialContext: { customType: PRIOR_SESSIONS_CUSTOM_TYPE, text: "x", details },
      }),
      (err) => err.code === "INTERNAL_ERROR",
    );
  } finally {
    sdk.SessionManager.open = originalOpen;
  }
  const files = readdirSync(path.join(root, "pi-sessions")).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 1, "failed session creation rolled back its JSONL file");
});

test("SessionService supports previewContext, derived session creation outside createQueue, idempotency conflict check, context query and deleted source tracking", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mozi-derivation-svc-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let sessionCount = 0;
  const nativeSessions = [];
  const histories = new Map();
  const derivations = new Map();
  let readBarrier;

  const runtime = {
    async createSession(options) {
      const descriptor = { sessionId: `s${++sessionCount}`, engine: "fixture", cwd: directory, locator: `native-${sessionCount}` };
      nativeSessions.push({ descriptor, title: "新会话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      histories.set(descriptor.sessionId, []);
      if (options?.initialContext) {
        derivations.set(descriptor.sessionId, {
          text: options.initialContext.text,
          details: structuredClone(options.initialContext.details),
        });
      }
      return descriptor;
    },
    async listSessions() { return structuredClone(nativeSessions); },
    deleteSession(descriptor) {
      const idx = nativeSessions.findIndex((s) => s.descriptor.sessionId === descriptor.sessionId);
      if (idx >= 0) nativeSessions.splice(idx, 1);
      histories.delete(descriptor.sessionId);
      derivations.delete(descriptor.sessionId);
    },
    setSessionName(descriptor, name) {
      const found = nativeSessions.find((s) => s.descriptor.sessionId === descriptor.sessionId);
      if (found) Object.assign(found, { name, title: name });
    },
    async readHistory(descriptor) {
      if (readBarrier) await readBarrier;
      return structuredClone(histories.get(descriptor.sessionId) ?? []);
    },
    async readDerivation(descriptor) {
      return structuredClone(derivations.get(descriptor.sessionId));
    },
    async openSession() {
      return { async execute() {}, async cancel() {}, dispose() {} };
    },
    dispose() {},
  };

  const repository = new SqliteMetadataRepository(path.join(directory, "state.sqlite"));
  const app = new AgentApplication(repository, runtime, () => {}, () => {});
  const controller = new AgentController(app);
  await app.initialize();
  t.after(() => app.close());

  let reqSeq = 0;
  const call = (method, params) => controller.dispatch({ protocolVersion: 1, kind: "request", requestId: `r${++reqSeq}`, method, params });

  // Create source sessions s1 and s2
  const { sessionId: s1 } = await call("session.create", { clientOperationId: "op-s1", title: "源会话 A" });
  const { sessionId: s2 } = await call("session.create", { clientOperationId: "op-s2", title: "源会话 B" });
  histories.set(s1, [
    msg({ role: "user", parts: [{ index: 0, type: "text", text: "问题 A" }] }),
    msg({ role: "assistant", parts: [{ index: 0, type: "text", text: "回答 A" }] }),
  ]);
  histories.set(s2, [
    msg({ role: "user", parts: [{ index: 0, type: "text", text: "问题 B" }] }),
    msg({ role: "assistant", parts: [{ index: 0, type: "text", text: "回答 B" }] }),
  ]);

  // 1. previewContext returns accurate stats
  const preview = await call("session.previewContext", { sourceSessionIds: [s1, s2] });
  assert.equal(preview.sources.length, 2);
  assert.equal(preview.overBudget, false);
  assert.ok(preview.packedChars > 0);

  // 2. Reading source history happens outside createQueue (does not block normal session creation)
  let releaseRead;
  readBarrier = new Promise((resolve) => { releaseRead = resolve; });
  const derivedPromise = call("session.create", {
    clientOperationId: "op-derived",
    title: "派生总结会话",
    sourceSessionIds: [s1, s2],
  });
  const concurrentNormal = await call("session.create", {
    clientOperationId: "op-normal",
    title: "普通并发会话",
  });
  assert.ok(concurrentNormal.sessionId, "normal session creation succeeded while derived source reading was paused");
  readBarrier = undefined;
  releaseRead();
  const { sessionId: derivedId } = await derivedPromise;

  // 3. Idempotency: exact retry succeeds; changed sourceSessionIds order/list throws SUBMISSION_CONFLICT
  const retrySame = await call("session.create", {
    clientOperationId: "op-derived",
    title: "派生总结会话",
    sourceSessionIds: [s1, s2],
  });
  assert.equal(retrySame.sessionId, derivedId);
  await assert.rejects(
    () => call("session.create", {
      clientOperationId: "op-derived",
      title: "派生总结会话",
      sourceSessionIds: [s2, s1],
    }),
    (err) => err.code === "SUBMISSION_CONFLICT",
  );

  // 4. Snapshot and session.context include derivedFrom; deleting s1 marks deleted: true while preserving title snapshot
  const snapBefore = await call("session.snapshot", { sessionId: derivedId });
  assert.equal(snapBefore.derivedFrom.length, 2);
  assert.equal(snapBefore.derivedFrom[0].deleted, false);

  await call("session.delete", { sessionId: s1 });
  const snapAfter = await call("session.snapshot", { sessionId: derivedId });
  assert.equal(snapAfter.derivedFrom[0].sessionId, s1);
  assert.equal(snapAfter.derivedFrom[0].title, "源会话 A");
  assert.equal(snapAfter.derivedFrom[0].deleted, true);
  assert.equal(snapAfter.derivedFrom[1].deleted, false);

  const ctx = await call("session.context", { sessionId: derivedId });
  assert.ok(ctx.derivation.text.includes("问题 A"));
  assert.equal(ctx.derivation.sources[0].deleted, true);
  assert.equal(ctx.derivation.sources[0].title, "源会话 A");
});

test("frontend createAgentActions creates derived session, installs derivedFrom snapshot, and updates source status on rename/delete", async () => {
  let state = { ...initialAgentState("s1"), runtime: { state: "ready" } };
  const store = {
    getState: () => state,
    setState(update) {
      const next = typeof update === "function" ? update(state) : update;
      state = { ...state, ...next };
    },
  };
  const createdInputs = [];
  const api = {
    getRuntimeState: async () => ({ state: "ready" }),
    listSessions: async () => ({
      items: [
        { sessionId: "s1", title: "源会话 1", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" },
        { sessionId: "derived", title: "新会话", createdAt: "2026-11-10T01:00:00.000Z", updatedAt: "2026-11-10T01:00:00.000Z" },
      ],
    }),
    createSession: async (input) => {
      createdInputs.push(input);
      return { sessionId: "derived" };
    },
    previewSessionContext: async ({ sourceSessionIds }) => ({
      sources: sourceSessionIds.map((id) => ({
        sessionId: id, title: "源会话", turns: 2, omittedTurns: 0, running: false, derived: false, empty: false,
      })),
      packedChars: 200,
      estimatedTokens: 80,
      budgetTokens: 40000,
      overBudget: false,
    }),
    getSessionContext: async () => ({
      derivation: { text: "<prior_sessions>...</prior_sessions>", sources: [{ sessionId: "s1", title: "源会话 1", deleted: false }] },
    }),
    subscribeSession: async ({ sessionId }) => ({ subscriptionId: `sub-${sessionId}`, sessionId }),
    unsubscribeSession: async () => ({ removed: true }),
    getSessionSnapshot: async ({ sessionId }) => ({
      session: { sessionId, title: "新会话", createdAt: "2026-11-10T01:00:00.000Z", updatedAt: "2026-11-10T01:00:00.000Z" },
      ...(sessionId === "derived"
        ? { derivedFrom: [{ sessionId: "s1", title: "源会话 1", deleted: false }] }
        : {}),
      lastSeq: 0,
      messages: [],
      tools: [],
      runs: [],
      approvals: [],
    }),
    renameSession: async ({ sessionId, title }) => ({
      session: { sessionId, title, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" },
    }),
    deleteSession: async ({ sessionId }) => ({ sessionId }),
    onEvent: () => () => {},
    onRuntimeState: () => () => {},
    onSessionsChanged: () => () => {},
    onProviderAuth: () => () => {},
    onProviderModelsChanged: () => () => {},
  };

  const actions = createAgentActions(api, store);
  const preview = await actions.previewSessionContext({ sourceSessionIds: ["s1"] });
  assert.equal(preview.estimatedTokens, 80);

  await actions.newSession({ sourceSessionIds: ["s1"] });
  assert.equal(createdInputs.length, 1);
  assert.deepEqual([...createdInputs[0].sourceSessionIds], ["s1"]);
  assert.equal(state.sessionId, "derived");
  assert.equal(state.derivedFrom.length, 1);
  assert.equal(state.derivedFrom[0].title, "源会话 1");

  await actions.renameSession("s1", "改名后的源会话");
  assert.equal(state.derivedFrom[0].title, "改名后的源会话");

  await actions.deleteSession("s1");
  assert.equal(state.derivedFrom[0].deleted, true);
});
