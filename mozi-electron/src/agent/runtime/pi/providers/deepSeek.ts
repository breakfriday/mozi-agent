import type { ModelSelection } from "../../../../../../shared/agent";
import type {
  ProviderConfig,
  ModelRuntime,
  AgentSession,
} from "@earendil-works/pi-coding-agent";

export const DEEPSEEK_PROVIDER = "deepseek";
export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com";
export const DEEPSEEK_API = "openai-responses";

type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** DeepSeek Responses API 原生模型定义 */
export function getDeepSeekProviderConfig(): ProviderConfig {
  return {
    name: "DeepSeek",
    baseUrl: DEEPSEEK_ENDPOINT,
    api: DEEPSEEK_API,
    models: [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text" as const],
        cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: {
          supportsDeveloperRole: false,
        },
        thinkingLevelMap: {
          off: "none",
          low: "low",
          medium: "high",
          high: "high",
          max: "max",
        },
        samplingParams: {
          tools: [{ type: "web_search" }],
        },
      },
      {
        id: "deepseek-flash",
        name: "DeepSeek V4.1 Flash",
        reasoning: true,
        input: ["text" as const, "image" as const],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: {
          supportsDeveloperRole: false,
        },
        thinkingLevelMap: {
          off: "none",
          low: "low",
          medium: "high",
          high: "high",
          max: "max",
        },
      },
    ],
  };
}

/** 仅 deepseek-v4-pro 且使用 openai-responses 时支持服务端 web_search */
export function supportsDeepSeekWebTools(model: RuntimeModel): boolean {
  return (
    model.provider === DEEPSEEK_PROVIDER &&
    model.api === DEEPSEEK_API &&
    model.id === "deepseek-v4-pro"
  );
}

/** 在启动 Session 时绑定服务端搜索工具 */
export function withDeepSeekWebTools(
  model: RuntimeModel,
  selection: ModelSelection,
): RuntimeModel {
  if (!supportsDeepSeekWebTools(model)) return model;
  const webSearchTool =
    selection.webSearch !== false ? [{ type: "web_search" }] : [];
  return {
    ...model,
    samplingParams: {
      ...model.samplingParams,
      tools: webSearchTool,
    },
  };
}

/** 保护 Agent 本地工具（read, bash 等）不被服务端的 web_search 冲掉，并在 payload 中合并 */
export function preserveDeepSeekLocalTools(
  agent: AgentSession["agent"],
  visualBrowser = false,
): void {
  const baseStream = agent.streamFunction;
  agent.streamFunction = (model, context, options) => {
    if (!supportsDeepSeekWebTools(model))
      return baseStream.call(agent, model, context, options);

    const parameters = {
      ...model.samplingParams,
      ...model.samplingParamsByThinkingLevel?.[options?.reasoning ?? "off"],
      ...options?.samplingParams,
    };
    if (!Array.isArray(parameters.tools))
      return baseStream.call(agent, model, context, options);

    // 浏览器模式下不发服务商原生 web_search
    const serverTools = visualBrowser
      ? parameters.tools.filter(
          (tool) =>
            !tool ||
            typeof tool !== "object" ||
            (tool as { type?: unknown }).type !== "web_search",
        )
      : parameters.tools;

    const withoutTools = (params: Record<string, unknown> | undefined) => {
      const copy = { ...params };
      delete copy.tools;
      return copy;
    };

    return baseStream.call(
      agent,
      { ...model, samplingParams: withoutTools(model.samplingParams),
        samplingParamsByThinkingLevel: Object.fromEntries(
          Object.entries(model.samplingParamsByThinkingLevel ?? {}).map(([level, params]) => [level, withoutTools(params)]),
        ),
      },
      context,
      {
        ...options,
        samplingParams: withoutTools(options?.samplingParams),
        onPayload: async (payload, requestModel) => {
          if (payload && typeof payload === "object") {
            const body = payload as { tools?: unknown[] };
            // 将服务端工具与本地工具合并注入
            body.tools = [...(body.tools ?? []), ...serverTools];
          }
          return options?.onPayload?.(payload, requestModel);
        },
      },
    );
  };
}
