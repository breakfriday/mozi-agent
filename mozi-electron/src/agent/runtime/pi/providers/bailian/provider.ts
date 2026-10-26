import { THINKING_LEVELS, type ModelSelection } from "../../../../../../../shared/agent";
import registerBailian from "@aiwayds/pi-bailian-token-plan";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ProviderConfig,
  type ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

export const BAILIAN_PROVIDER = "bailian-tp";
export const BAILIAN_ENDPOINT =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
export const BAILIAN_API = "openai-responses";

/** Load only the pinned package through Pi's real ExtensionAPI. No ambient extensions. */
export async function loadBailianProvider(
  cwd: string,
  agentDir: string,
): Promise<ProviderConfig> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [registerBailian],
  });
  await loader.reload();
  const result = loader.getExtensions();
  try {
    if (result.errors.length) throw new Error("百炼 provider 扩展加载失败。");
    const registered = result.runtime.pendingProviderRegistrations.find(
      (item) => item.name === BAILIAN_PROVIDER,
    );
    // Validate the pinned package's original protocol before adapting it to Responses below.
    if (
      !registered ||
      registered.config.baseUrl !== BAILIAN_ENDPOINT ||
      registered.config.api !== "openai-completions"
    ) {
      throw new Error("百炼扩展的套餐入口与预期不一致。");
    }
    return {
      ...registered.config,
      api: BAILIAN_API,
      models: registered.config.models?.map((model) => {
        if (model.type && model.type !== "chat") return model;
        const compat =
          model.compat && "supportsDeveloperRole" in model.compat
            ? model.compat
            : undefined;
        // Keep the package catalog, but use Pi's native Responses adapter and server tools.
        return {
          ...model,
          api: BAILIAN_API,
          compat: {
            supportsDeveloperRole: compat?.supportsDeveloperRole ?? false,
          },
          // Declare extended levels for Pi; preserve any model-specific restrictions or mappings.
          thinkingLevelMap: {
            xhigh: "xhigh",
            max: "max",
            ...model.thinkingLevelMap,
          },
          samplingParams: {
            ...model.samplingParams,
            tools: [{ type: "web_search" }, { type: "web_extractor" }],
          },
          samplingParamsByThinkingLevel: {
            // off：Pi 发送 reasoning.effort: "none"，仅保留非思考模式支持的搜索工具。
            off: { tools: [{ type: "web_search" }] },
            // 非 off：显式开启思考并提供网页提取；具体强度仍由 Pi 的 reasoning.effort 控制。
            minimal: {
              enable_thinking: true,
              tools: [{ type: "web_search" }, { type: "web_extractor" }],
            },
            low: {
              enable_thinking: true,
              tools: [{ type: "web_search" }, { type: "web_extractor" }],
            },
            medium: {
              enable_thinking: true,
              tools: [{ type: "web_search" }, { type: "web_extractor" }],
            },
            high: {
              enable_thinking: true,
              tools: [{ type: "web_search" }, { type: "web_extractor" }],
            },
            xhigh: {
              enable_thinking: true,
              tools: [{ type: "web_search" }, { type: "web_extractor" }],
            },
            max: {
              enable_thinking: true,
              tools: [{ type: "web_search" }, { type: "web_extractor" }],
            },
          },
        };
      }),
    };
  } finally {
    result.runtime.invalidate();
  }
}

type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function supportsBailianWebTools(model: RuntimeModel): boolean {
  return model.provider === BAILIAN_PROVIDER && model.api === BAILIAN_API;
}

/** Append server tools after Pi serializes local tools; samplingParams.tools would replace them. */
export function preserveBailianLocalTools(agent: AgentSession["agent"], visualBrowser = false): void {
  const baseStream = agent.streamFunction;
  agent.streamFunction = (model, context, options) => {
    if (!supportsBailianWebTools(model)) return baseStream.call(agent, model, context, options);
    const parameters = {
      ...model.samplingParams,
      ...model.samplingParamsByThinkingLevel?.[options?.reasoning ?? "off"],
      ...options?.samplingParams,
    };
    if (!Array.isArray(parameters.tools)) return baseStream.call(agent, model, context, options);
    const serverTools = visualBrowser ? parameters.tools.filter(tool => !tool || typeof tool !== "object"
      || !["web_search", "web_extractor"].includes(String((tool as { type?: unknown }).type))) : parameters.tools;
    const withoutTools = (params: Record<string, unknown> | undefined) => {
      const copy = { ...params };
      delete copy.tools;
      return copy;
    };
    return baseStream.call(agent, {
      ...model,
      samplingParams: withoutTools(model.samplingParams),
      samplingParamsByThinkingLevel: Object.fromEntries(
        Object.entries(model.samplingParamsByThinkingLevel ?? {}).map(([level, params]) => [level, withoutTools(params)]),
      ),
    }, context, {
      ...options,
      samplingParams: withoutTools(options?.samplingParams),
      onPayload: async (payload, requestModel) => {
        if (payload && typeof payload === "object") {
          const body = payload as { tools?: unknown[] };
          body.tools = [...(body.tools ?? []), ...serverTools];
        }
        return options?.onPayload?.(payload, requestModel);
      },
    });
  };
}

/** Bind tools to a session without changing the shared provider catalog. */
export function withBailianWebTools(model: RuntimeModel, selection: ModelSelection): RuntimeModel {
  if (!supportsBailianWebTools(model)) return model;
  const toolsFor = (thinking: boolean) => [
    ...(selection.webSearch !== false ? [{ type: "web_search" }] : []),
    ...(thinking && selection.webExtractor !== false ? [{ type: "web_extractor" }] : []),
  ];
  return {
    ...model,
    samplingParams: { ...model.samplingParams, tools: toolsFor(selection.thinkingLevel !== "off") },
    samplingParamsByThinkingLevel: Object.fromEntries(THINKING_LEVELS.map(level => [level, {
      ...model.samplingParamsByThinkingLevel?.[level],
      tools: toolsFor(level !== "off"),
    }])),
  };
}
