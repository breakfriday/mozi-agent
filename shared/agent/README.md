# Mozi Agent 共享契约

本目录是 Renderer、preload、Main 和未来 AgentService 共用的协议来源。无 Electron、Pi 或 UI 依赖，也不需要单独构建。引用 `shared/agent` 的导出，禁止在各端复制请求、事件或快照类型。

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

`window.mozi.agent` 是 preload 暴露的固定方法，不包含任意 IPC invoke/send。它返回 `ApiResult<T>` 普通数据；`bridgeApi.agent` 校验、解包并在 Renderer 内创建 `AgentApiError`，因此 `error.code` 不依赖 contextBridge 保留 Error 自定义属性。`requestId` 在 preload 每次调用生成，Main 原样转发；`clientMessageId` 和 `clientOperationId` 由业务调用方维护。

浏览器环境没有 `window.mozi`：状态查询返回 unavailable，业务请求抛出 `RUNTIME_UNAVAILABLE`，事件监听返回可安全调用的解除函数。

## Main 与后台接入

`registerAgentIpc` 已在 Main 注册，默认运行时未连接。Main 独立处理 `runtime.getState`、`session.subscribe` 和 `session.unsubscribe`，其余请求经 `AgentTransport` 转发。订阅只登记事件投递；随后通过快照确认会话存在和建立 seq 游标。一个窗口多次订阅同一会话只收到一份事件，解除其中一个订阅不会删除其他订阅。

未来进程管理器创建 utilityProcess 后立即连接：

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

进程已启动不代表 ready。后台收到 `RuntimeRequest` 后也必须调用 `isAgentRequest` 校验，按 `requestId` 返回 `ResponseFor<M>`。响应不等待完整 Run；流式执行发送共享 `AgentEvent`。提交去重、审批阻断、状态机和持久化仍由 AgentService 实现。

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

在 `mozi-electron` 运行 `npm test`、`npm run check`、`npm run lint`；在 `mozi-app` 运行 `npm run check` 和 `npm run build`。测试覆盖真实处理函数之间的调用，后台与 Electron 系统对象用替身注入；尚不代表 Pi SDK 或真实工具执行已接入。

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

运行时配置只作用于调用它的 JS 上下文，Renderer、preload、Main 和未来 Agent 子进程各自独立；它不是跨进程配置广播。若需一次关闭所有端，修改统一默认配置并重启。日志输出器抛错不会中断请求、事件或取消流程。

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

`runtime.getState`、`session.subscribe/unsubscribe` 在 Main 处理，不会出现 transport 的 request.send。当前聊天已调用真实链路，但 AgentService 未接入：Electron 内发送第一条消息会调用 `session.create`，在 Main 返回 `RUNTIME_UNAVAILABLE`，页面保留输入并显示错误，不会继续到 `run.start`。纯浏览器缺少 preload，业务请求在 Renderer 返回同样错误。两种情况都不生成模拟回复；完整执行与回传事件仍需后台接入。
