# Mozi Agent 共享契约

本目录是 Renderer、preload、Main 和 AgentService 共用的协议来源。无 Electron、Pi 或 UI 依赖，也不需要单独构建。引用 `shared/agent` 的导出，禁止在各端复制请求、事件或快照类型。

| 文件 | 内容 |
| --- | --- |
| `models.ts` | 消息、Run、工具、审批、快照、错误码和状态取值 |
| `protocol.ts` | `MethodMap`、IPC 请求/响应、`AgentEvent`、运行时通知和内部握手 |
| `api.ts` | 从 MethodMap 派生的 `AgentApi`、`AgentBridgeApi`、返回包装 |
| `validation.ts` | 集中维护的参数、响应、事件校验与标识关联校验 |
| `channels.ts` | 协议版本、固定通道、消息与请求容量限制 |

## 前端入口

组件通过 agentActions 编排业务，agentActions 使用 `mozi-app/src/runtime/bridge.ts`：

```ts
import { bridgeApi } from "./runtime/bridge";
import type { StartRunInput } from "../../shared/agent";

// 同一次创建操作超时重试时，复用 clientOperationId。
const createInput = { clientOperationId: crypto.randomUUID(), title: "播放器诊断" };
const { sessionId } = await bridgeApi.agent.createSession(createInput);

// 先安装应用级监听、开始缓冲，再订阅会话并安装快照。
const off = bridgeApi.agent.onEvent((event) => {
  // 交给 store：按 sessionId 路由，缓冲、seq 去重，再应用事件。
  console.log(event.type);
});
const subscription = await bridgeApi.agent.subscribeSession({ sessionId });
const snapshot = await bridgeApi.agent.getSessionSnapshot({ sessionId });
// store.installSnapshotAndDrain(snapshot) 必须在允许提交前完成。

const input: StartRunInput = {
  sessionId,
  clientMessageId: crypto.randomUUID(),
  content: [{ type: "text", text: "检查播放器状态" }],
};
const accepted = await bridgeApi.agent.startRun(input);
// accepted.runId；同次提交重试时复用完整 input。

// 离开会话时解除订阅，不会取消后台 Run。
await bridgeApi.agent.unsubscribeSession({ subscriptionId: subscription.subscriptionId });
off();
```

上例展示接口顺序。实际聊天通过 `agent/agentActions.ts` 创建应用级动作，`createAgentActions.ts` 负责发送、取消、订阅和快照同步，`agentState.ts` 按共享契约归并事件。`AssistantUiProvider` 安装和清理应用级监听；聊天页不再生成本地演示回复。

创建会话后，先订阅并安装快照，再提交 Run。快照期间缓冲事件，按 seq 去重；发现缺口时重新同步。提交超时保留原始内容和 clientMessageId，用户可重试原提交。已选 sessionId 保存在 sessionStorage，刷新后待 ready 重新同步。

前端 `pendingSubmissions` 按 clientMessageId 保存多条乐观提交及各自的错误，`inFlightSubmissionId` 单独跟踪当前请求。新提交先追加显示，创建会话失败也保留消息；取得 sessionId 后将本地会话的提交绑定到后台会话。重试指定 clientMessageId，保留原内容且不增加气泡。`messageOrder` 维护本地显示位置，用户气泡在确认前后均使用 clientMessageId 派生的稳定标识；`submissionState.ts` 将事件/快照中的权威消息与本地提交合并，未匹配的失败或结果不确定的消息不会被快照删除。待提交记录保存在当前页面内存中，尚未做刷新后的本地持久化；断线恢复不会自动重发失败消息。

`window.mozi.agent` 是 preload 暴露的固定方法，不包含任意 IPC invoke/send。它返回 `ApiResult<T>` 普通数据；`bridgeApi.agent` 校验、解包并在 Renderer 内创建 `AgentApiError`，因此 `error.code` 不依赖 contextBridge 保留 Error 自定义属性。`requestId` 在 preload 每次调用生成，Main 原样转发；`clientMessageId` 和 `clientOperationId` 由业务调用方维护。

浏览器环境没有 `window.mozi`：状态查询返回 unavailable，业务请求抛出 `RUNTIME_UNAVAILABLE`，事件监听返回可安全调用的解除函数。

## Main 与后台接入

`registerAgentIpc` 已在 Main 注册，`AgentProcessManager` 自动启动一个 utilityProcess 并连接 transport；恢复完成前状态为 unavailable。Main 独立处理 `runtime.getState`、`session.subscribe` 和 `session.unsubscribe`，其余请求经 `AgentTransport` 转发。订阅只登记事件投递；随后通过快照确认会话存在和建立 seq 游标。一个窗口多次订阅同一会话只收到一份事件，解除其中一个订阅不会删除其他订阅。

进程管理器创建 utilityProcess 后立即连接：

```ts
const child = utilityProcess.fork(agentEntry);
agentIpc.transport.connect(utilityProcessConnection(child));
```

AgentService 完成持久化恢复后，通过父进程端口发送 `RuntimeControl`：

```ts
const ready: RuntimeControl = {
  protocolVersion: 1,
  kind: "runtime",
  state: "ready",
};
process.parentPort.postMessage(ready);
```

进程已启动不代表 ready。后台收到 `RuntimeRequest` 后也必须调用 `isAgentRequest` 校验，按 `requestId` 返回 `ResponseFor<M>`。响应不等待完整 Run；流式执行发送共享 `AgentEvent`。AgentService 已实现提交去重、Run 状态机、取消及持久化。本阶段仅启用文本会话，禁用 Pi 内置工具、扩展、Skills 和模板；工具执行与审批阻断尚未启用。

Main 校验自有窗口、主 frame、配置的 Renderer URL，并绑定请求和订阅的窗口身份。HTTP(S) 目录入口允许同源目录内的 SPA 路由，file 入口要求精确文件路径；开发地址须与 Vite base 一致（当前为 `/mozi_app/`）。默认所有可信窗口属于同一桌面用户；可注入 `canAccessSession` 收窄会话访问，列表与事件也按该策略过滤。导航离开文档、Renderer 崩溃或窗口销毁时清理请求等待和订阅，不自动取消 Run。

## 连接与同步约定

- 初始化时先注册 `onRuntimeState`，再调用 `getRuntimeState()`，避免错过已有 ready 状态。业务同步器仍需连接 token，防止查询结果回退新通知。
- Agent 断开时立即取消旧请求等待、解绑旧 child 回调、清空订阅，发布 unavailable；新 child 完成 ready 握手后才能继续请求。
- Renderer 收到 unavailable 后丢弃旧 seq/缓冲，使旧同步 token 失效。收到 ready 后重新获取列表、订阅和快照，完成同步才开放发送与审批。
- 连接代次仅为内部实现，不新增公开的事件流 ID。旧 child 即使迟到调用回调也不会投递事件或完成新请求。
- 请求默认 15 秒超时，不自动重发，不代表 Run 已取消或未接受。preload 增加 1 秒兜底，避免 Main 无响应时永久等待。
- 同时最多 128 个 pending 请求，每窗口最多 64 个订阅；单个 wire 消息上限 4 MiB，列表 limit 为 1–100。超限快照需由后续历史分页方案解决，不能突破 IPC 上限。
- 无效后台数据导致连接失效，不能静默接受格式错误的 delta。类型、校验和事件语义必须一起更新。

## 验证

在 `mozi-electron` 运行 `npm test`、`npm run check`、`npm run lint`；在 `mozi-app` 运行 `npm run check` 和 `npm run build`。单元测试覆盖真实处理函数之间的调用、SQLite 接受事务、恢复和进程生命周期。另运行 `npm run test:agent:smoke`，启动真实 Electron utilityProcess 和 Pi SDK，以本机 HTTP 测试接口验证流式回复、取消、重启去重及强制退出恢复；不调用收费模型。`npm run test:agent:lifecycle` 使用隔离数据目录验证正常退出、SIGINT/SIGTERM/SIGHUP、app.exit/process.exit、Agent 不响应关闭和主进程被 SIGKILL 后，Agent 均不再运行；当前已在 Linux 验证。`npm run package` 会构建 Main、preload、Agent 三个入口。

## AgentService 配置与存储

SDK 锁定 `@earendil-works/pi-coding-agent@1.0.3`，开发 Node 要求 >=22.19.0。`src/agent/config.ts` 集中读取配置；主进程只注入数据目录，模型凭据不经过 Renderer。

| 配置 | 默认与用途 |
| --- | --- |
| `MOZI_AGENT_PI_DIR` | `~/.pi/agent`，读取 Pi 的 auth.json、models.json 和 settings.json |
| `MOZI_AGENT_PROVIDER`、`MOZI_AGENT_MODEL` | 必须同时指定；未指定时使用 Pi 的模型选择规则 |
| `MOZI_AGENT_CWD` | `<userData>/agent/workspace`，Agent 工作目录 |
| 数据目录 | Main 使用 `app.getPath("userData")/agent`，与应用安装目录分离 |

例如在启动 Electron 的终端设置（替换为已配置的 provider 和 model ID）：

```sh
MOZI_AGENT_PI_DIR=/path/to/pi-config MOZI_AGENT_PROVIDER=my-provider MOZI_AGENT_MODEL=my-model npm start
```

兼容接口在该 Pi 配置目录的 models.json 中配置 baseUrl、api 和凭据引用。此阶段不提供模型设置界面；配置改变后重启 Electron。不要把凭据硬编码进代码或提交到仓库。

- `pi-sessions/*.jsonl`：Pi 是会话正文、消息树及模型上下文的持久化来源。新会话先持久化 SDK header，未发送首条消息也能保留 sessionId。PiAdapter 使用 SDK `listAll(sessionDir)` 发现 Mozi 原生目录中不同工作目录的会话，使用 `getBranch()` 读取当前分支；不要求消息带有 `mozi.run` 标记。
- `mozi.sqlite`：使用 `node:sqlite`，只保存 Mozi 元数据。v3 不再有 `messages`、`submissions`、`tools`、`approvals` 表，不保存 SessionSnapshot、已完成消息正文或 delta 检查点。`runs` 合并提交去重字段；尚未确认交付到原生历史的输入暂存在 `pending_content`。
- 开发数据处理：首次打开 v1/v2 数据库时，在事务内重建为 v3，不迁移旧 Mozi 元数据（开发环境已授权丢弃）。原生 Pi JSONL 不删除，启动后重新发现、按需读取。旧提交去重、随机消息 ID、Run 状态和自定义标题无法从已删除的元数据恢复；原生消息会获得确定性的展示 ID。v3 重启保留元数据，未知版本拒绝打开。正式发布前需替换开发重建策略。
- 启动只发现原生会话并读取轻量会话绑定，未完成的 Mozi Run 标为 interrupted，不自动重新提交。SDK 会话发现本身会扫描文件生成摘要；Mozi 不在启动时为所有会话组装前端快照。首次访问会话时异步读取原生历史、叠加元数据并缓存内存视图，并发访问共享一次加载。当前不会实时侦测其他进程对原生文件的修改，重启 Agent 后重新读取。
- 查询结果始终是 `shared/agent` 的 SessionSnapshot，SDK 类型不进入 Renderer/preload/Main。AgentRuntime 使用 `engine + locator` 描述底层定位，`locator` 仅由对应 Adapter 解释；当前仅实现 PiAdapter，尚未实现 DSH。
- 接受提交时，在同一事务中保存 Run、clientMessageId、规范化内容 SHA-256、待交付输入和用户消息 ID。事务成功后才发送接受事件、调用 Pi。助手消息开始前保存其 Mozi ID 关联；正文只更新内存并通过统一事件推送。任务结束或历史读取时，确认原生用户条目并绑定 ID，同时清空该 Run 的 pending_content。失败且尚未交付的输入继续保留，确保刷新/重启后不丢失已接受的用户消息。
- `run.get` 和重复提交确认直接使用 Mozi 元数据，无需先加载整份历史。读取正文与继续执行依赖原生会话；原生文件丢失时返回错误，不用数据库拼造空会话。单个会话的历史读取失败不影响其他会话的启动。
- delta 不写 SQLite，也不逐条读取原生文件。进程崩溃后恢复到 Pi 已落盘的消息；尚未落盘的流式内容可能丢失。已发送到前端但未关联原生条目的助手 ID 保留为空内容的中断/失败/取消记录，避免生成新 ID 或伪造回复。seq 是进程内事件序号，重启归零，不写入数据库。
- 消息和 Run 仍使用内存索引及增量容量校验。完整快照只在加载/查询时校验；快照仍受 4 MiB IPC 上限约束，尚未实现历史分页和缓存淘汰。当前仅转换原生用户/助手文本；工具和审批执行仍未启用，后续按实际能力扩展共享契约及适配器。
- 原生读取和 SDK 执行不会被 SQLite 快照替代。写入必要元数据失败时关闭服务、停止接受请求，不发布虚假的完成状态。
- PiAdapter 每次执行打开已有会话，结束后释放 SDK Session；不同会话最多同时执行 8 个 Run，同会话只允许 1 个。
- 启动等待上限 30 秒，进程异常退出最多重启 3 次。应用退出先禁止重启、发送内部 RuntimeShutdown，等待 Agent 的 exit 事件；5 秒未退出则向该 Agent PID 发送 SIGKILL，再等待最多 2 秒确认退出，确认失败记录错误并以失败状态退出应用。发送关闭消息失败时直接进入强制终止流程，不把“已发送信号”视为“已退出”。
- `main/agent/app-lifecycle.ts` 统一处理 before-quit、SIGINT/SIGTERM/SIGHUP，will-quit 与 process exit 同步强制清理兜底。主进程被 SIGKILL 时无法执行 JS 清理，依靠 Electron utilityProcess 生命周期回收；由上述独立进程测试验证。关闭聊天页面或隐藏到托盘不会停止 Agent，主进程退出才会关闭 Agent。

表结构定义集中在 `mozi-electron/src/agent/storage-schema.ts`：

`AgentService` 通过 `agent-store.ts` 的 AgentStore 接口访问元数据，接口没有 snapshot/history 的读写方法。`history-projection.ts` 负责将原生历史与 Mozi 元数据组装为内存视图；`entry.ts` 装配 SQLite 实现。存储操作当前是同步事务，未来接异步存储时还需调整提交串行化，保持原子接受。

| 表 | 存储内容 |
| --- | --- |
| `sessions` | 引擎、原生定位、工作目录、应用标题及时间 |
| `runs` | Run 状态、用户消息 ID、clientMessageId、内容摘要、尚未交付的输入、时间及错误 |
| `creations` | 创建操作去重 |
| `message_links` | Mozi 消息 ID、Run、角色/序号及原生条目 ID；无正文 |

存储/服务测试覆盖原生历史独立发现、按需与并发加载、恢复稳定 ID、原生正文权威性、待交付输入及去重、缺失文件报错、接受事务回滚、元数据写失败停止服务，以及 1,000 条 delta 不写 SQLite、不读取原生历史、不序列化旧消息。真实 Pi/Electron 测试还验证模型上下文恢复、取消、强制退出、清空测试数据库后重新发现原生会话，以及无 Mozi 标记的消息读取。

## 通信日志

日志统一由 `shared/agent/logging.ts` 管理，业务代码只调用 `createAgentLogger(scope)`，不散落直接的 console 调用。默认输出到控制台，不写日志文件，不向外部服务发送数据。

修改该文件顶部的 `AGENT_LOG_DEFAULTS`，然后重启/重新构建，所有进程使用相同配置：

```ts
{
  enabled: true,          // false：关闭全部日志
  level: "debug",         // debug / info / warn / error
  payloads: true,         // true：包含消息正文、工具参数、工具输出和响应内容
  maxPayloadChars: 32000, // 单条载荷的字符上限；超出时 payloadTruncated 为 true
  deltas: false,          // true：记录每个文本/工具 delta；正文输出与 delta 开关独立
  scopes: ["renderer", "preload", "main", "transport", "agent-service"],
}
```

`payload` 是写日志时捕获的 JSON 文本，之后业务对象变化不会改变旧日志。超长载荷会截断，截断后的文本不保证仍是完整 JSON。关闭 payloads 后仅保留可搜索的标识、状态、错误码和耗时。关闭 deltas 只隐藏成功的 debug 增量，增量校验失败仍可见。Electron 原始事件、窗口对象和 IPC 对象不会作为日志载荷传入。

需要在代码中临时切换或替换输出目的地：

```ts
import { configureAgentLogging } from "../../../shared/agent/logging";

configureAgentLogging({ enabled: false });
configureAgentLogging({ enabled: true, deltas: true });
configureAgentLogging({ level: "warn" });
// 可注入采集器用于测试，未来也可接文件日志：
configureAgentLogging({ enabled: true }, (record) => customSink(record));
```

运行时配置只作用于调用它的 JS 上下文，Renderer、preload、Main 和 Agent 子进程各自独立；它不是跨进程配置广播。若需一次关闭所有端，修改统一默认配置并重启。日志输出器抛错不会中断请求、事件或取消流程。

**查询位置：** Renderer/preload 查看窗口 DevTools 的 Console；Main/transport 查看启动 Electron 的终端。都使用 `[mozi.agent]` 前缀；按 `scope`、`action`、`requestId`、`clientMessageId`、`sessionId`、`runId`、`seq` 搜索。

DevTools 需要勾选 **Verbose** 才能看到 `console.debug` 请求和事件明细。preload 启动时输出 info 级 `bridge.exposed`，页面安装监听时输出 `chat.initialized`，提交时输出 `chat.submit`。修改 preload/Main 后需要重启 Electron；仅刷新页面不足以更新 Main。

一次 `run.start` 的预期记录：

```text
renderer  request.send         method + clientMessageId + sessionId + 正文
preload   request.received     生成 requestId
preload   request.validated    请求通过共享契约校验
preload   request.send         发往 ipcMain
main      request.received
main      request.validated
main      request.forward      发往 AgentTransport
transport request.send         postMessage 到当前 Agent 连接
transport response.validated   按 pending 方法及标识核对结果
main      response.return
preload   response.validated / response.return
renderer  response.validated   解包结果；失败为 response.rejected
```

Renderer 的调用开始时尚无 requestId，用 `clientMessageId`（或创建操作的 `clientOperationId`）与 preload 日志关联。requestId 从 preload 起贯穿 Main/transport。执行事件不借用最初的 requestId，按 `(sessionId, runId, seq)` 对齐：

```text
transport event.validated
main      event.forward
preload   event.validated
renderer  listener.received / listener.delivered
preload   event.delivered
```

`listener.delivered` 只证明前端注册的回调已正常返回，不代表 store 已经完成 seq 去重或快照合并。`listener.added/removed` 是本地监听，`subscription.added/removed` 是 Main 的远端会话订阅，二者不同。未订阅或无权限时，Main 记录 `event.dropped`；旧连接、迟到响应、超时和契约不匹配也各有明确 action/stage/code。

`runtime.getState`、`session.subscribe/unsubscribe` 在 Main 处理，不会出现 transport 的 request.send。Electron 内已接入真实 AgentService：创建会话、订阅、获取快照、接受 Run 后由 PiAdapter 调用 Pi SDK，并回传流式事件。进程未 ready 时返回 `RUNTIME_UNAVAILABLE`；模型或凭据不可用时任务以失败终态结束，不产生演示回复。纯浏览器缺少 preload，业务请求仍在 Renderer 返回 `RUNTIME_UNAVAILABLE`。
