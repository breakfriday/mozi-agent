import {
  ModelRuntime,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import {
  isParamsFor,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ModelSelection,
  type ProviderSaveInput,
  type ProviderView,
} from "../../../../../../shared/agent";
import { failure } from "../../../errors";
import type { PiConfig, PiModelBinding } from "../types";
import {
  BAILIAN_API,
  BAILIAN_ENDPOINT,
  BAILIAN_PROVIDER,
  loadBailianProvider,
  supportsBailianWebTools,
  withBailianWebTools,
} from "./bailian";
import {
  DEEPSEEK_PROVIDER,
  getDeepSeekProviderConfig,
  supportsDeepSeekWebTools,
  withDeepSeekWebTools,
} from "./deepSeek";

type SavedProvider = Omit<ProviderSaveInput, "providerId" | "apiKey">;
type Configuration = { providers: Record<string, SavedProvider> };
import {
  CredentialRepository,
  type Credentials,
} from "./credential-repository";
import { getAntigravityProviderConfig } from "./antigravity/provider";
import { ProviderAuthManager } from "./provider-auth-manager";
import type { ProviderAuthState } from "../../../../../../shared/agent";
type Snapshot = {
  runtime: ModelRuntime;
  version: string;
  config: Configuration;
  builtinIds: Set<string>;
  activate(): void;
};

function thinkingLevels(model: PiModelBinding["model"]): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  const levels = THINKING_LEVELS.filter(
    (level) =>
      model.thinkingLevelMap?.[level] !== null &&
      (!(level === "xhigh" || level === "max") ||
        model.thinkingLevelMap?.[level] !== undefined),
  );
  const compat =
    model.compat && "thinkingFormat" in model.compat ? model.compat : undefined;
  // This Qwen compatibility path sends only enable_thinking, without an effort or budget.
  if (
    model.api === "openai-completions" &&
    compat?.thinkingFormat === "qwen" &&
    compat.supportsReasoningEffort === false &&
    !compat.supportsThinkingTokenBudget &&
    !compat.thinkingTokenBudgetField &&
    !model.samplingParamsByThinkingLevel
  ) {
    const enabled = levels.includes("medium")
      ? "medium"
      : levels.find((level) => level !== "off");
    return levels.filter((level) => level === "off" || level === enabled);
  }
  return levels;
}

function readJson<T>(filename: string, fallback: T): T {
  if (!existsSync(filename)) return fallback;
  try {
    return JSON.parse(readFileSync(filename, "utf8")) as T;
  } catch {
    throw failure(
      "INVALID_ARGUMENT",
      "Provider 配置或凭据文件无法读取，请检查 JSON 格式。",
    );
  }
}
function writeJson(filename: string, data: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, filename);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function publicEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Owns managed provider configuration; published runtimes are never reconfigured. */
export class PiProviderManager {
  private readonly modelsPath: string;
  private readonly authPath: string;
  private reauthRequired = false;
  private catalogStatus: "idle" | "refreshing" | "ready" | "failed" = "idle";
  private catalogMessage = "登录后同步账号模型；当前列表为缓存或内置备用目录。";
  private catalogAttempted = false;
  private catalogTask?: Promise<void>;
  private catalogAbort?: AbortController;
  private authEpoch = 0;
  private disposed = false;
  private readonly credentials: CredentialRepository;
  readonly auth: ProviderAuthManager;
  private snapshot?: Promise<Snapshot>;
  private packageConfig?: Promise<ProviderConfig>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly config: PiConfig,
    private readonly visualBrowser = false,
    emitAuth: (state: ProviderAuthState) => void = () => {},
    private readonly emitCatalog: (providerId: string) => void = () => {},
  ) {
    const directory = path.join(config.dataDir, "providers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.modelsPath = path.join(directory, "models.json");
    this.authPath = path.join(directory, "auth.json");
    this.credentials = new CredentialRepository(this.authPath);
    this.auth = new ProviderAuthManager(
      async () =>
        (await this.build(this.readConfiguration(), this.credentials.readAll()))
          .runtime,
      emitAuth,
      (credential, signal) =>
        this.update(async () => {
          signal.throwIfAborted();
          const credentials = this.credentials.readAll();
          credentials.antigravity = credential;
          const next = await this.build(this.readConfiguration(), credentials);
          signal.throwIfAborted();
          await this.credentials.modify(
            "antigravity",
            async () => credential,
            signal,
          );
          this.reauthRequired = false;
          this.resetCatalog();
          next.activate();
          this.snapshot = Promise.resolve(next);
          // Discovery is background work; auth success must not depend on network availability.
          void this.refreshProviderModels("antigravity").catch(() => {});
        }),
      () =>
        this.update(async () => {
          await this.credentials.delete("antigravity");
          this.reauthRequired = false;
          this.resetCatalog();
          this.snapshot = undefined;
        }),
    );
  }
  private resetCatalog(): void {
    this.authEpoch++;
    this.catalogAbort?.abort();
    this.catalogTask = undefined;
    this.catalogAttempted = false;
    this.catalogStatus = "idle";
    this.catalogMessage = "登录后同步账号模型；当前列表为缓存或内置备用目录。";
  }
  refreshProviderModels(providerId: string): Promise<void> {
    if (providerId !== "antigravity")
      return Promise.reject(
        failure("UNSUPPORTED_CAPABILITY", "此 provider 不支持动态模型同步。"),
      );
    if (this.disposed)
      return Promise.reject(failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。"));
    if (!this.credentials.readAll().antigravity)
      return Promise.reject(
        failure("INVALID_ARGUMENT", "请先登录 Google 账号。"),
      );
    if (this.catalogTask) return this.catalogTask;
    this.catalogAttempted = true;
    this.catalogStatus = "refreshing";
    this.catalogMessage = "正在从账号同步最新模型…";
    const epoch = this.authEpoch;
    const controller = new AbortController();
    this.catalogAbort = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(12_000),
    ]);
    this.emitCatalog(providerId);
    const task = (async () => {
      try {
        // Shared credentials allow an expired access token to refresh under the same
        // lock as inference. Model configuration remains unpublished until complete.
        const next = await this.build(
          this.readConfiguration(),
          this.credentials.readAll(),
        );
        signal.throwIfAborted();
        next.activate();
        await next.runtime.getAuth(providerId, { signal });
        const result = await next.runtime.refresh({
          providers: [providerId],
          allowNetwork: true,
          force: true,
          signal,
        });
        signal.throwIfAborted();
        if (result.errors.has(providerId))
          throw new Error("Model discovery failed");
        await this.update(async () => {
          if (epoch !== this.authEpoch || this.disposed) return;
          // Rebuild from current settings and the newly published SDK model cache;
          // a concurrent unrelated provider edit must not be rolled back.
          const latest = await this.build(
            this.readConfiguration(),
            this.credentials.readAll(),
          );
          signal.throwIfAborted();
          latest.activate();
          this.snapshot = Promise.resolve(latest);
          this.catalogStatus = "ready";
          this.catalogMessage = "已同步账号模型目录。";
        });
      } catch {
        if (epoch === this.authEpoch && !this.disposed) {
          this.catalogStatus = "failed";
          this.catalogMessage =
            "账号模型同步失败，已保留缓存或内置列表；请检查网络后重试。";
        }
      } finally {
        if (epoch === this.authEpoch && !this.disposed)
          this.emitCatalog(providerId);
      }
    })();
    this.catalogTask = task;
    void task
      .finally(() => {
        if (this.catalogTask === task) this.catalogTask = undefined;
      })
      .catch(() => {});
    return task;
  }
  dispose(): void {
    this.disposed = true;
    this.catalogAbort?.abort();
    this.auth.dispose();
  }
  private readConfiguration(): Configuration {
    const config = readJson<Configuration>(this.modelsPath, { providers: {} });
    if (
      !config ||
      typeof config.providers !== "object" ||
      !config.providers ||
      Array.isArray(config.providers)
    ) {
      throw failure("INVALID_ARGUMENT", "Mozi provider 配置文件格式错误。");
    }
    for (const [providerId, item] of Object.entries(config.providers)) {
      if (
        !isParamsFor("provider.save", { ...item, providerId }) ||
        "apiKey" in item
      ) {
        throw failure("INVALID_ARGUMENT", "Mozi provider 配置文件格式错误。");
      }
    }
    return config;
  }
  private current(): Promise<Snapshot> {
    if (!this.snapshot) {
      const promise = this.build(
        this.readConfiguration(),
        readJson<Credentials>(this.authPath, {}),
      ).then((next) => {
        next.activate();
        return next;
      });
      this.snapshot = promise;
      void promise.catch(() => {
        if (this.snapshot === promise) this.snapshot = undefined;
      });
    }
    return this.snapshot;
  }
  private async build(
    config: Configuration,
    credentials: Credentials,
  ): Promise<Snapshot> {
    const external = readJson<Credentials>(
      path.join(this.config.piDir, "auth.json"),
      {},
    );
    const values: Credentials = { ...external, ...credentials };
    for (const credential of Object.values(values)) {
      if (
        !credential ||
        (credential.type !== "api_key" && credential.type !== "oauth")
      ) {
        throw failure("INVALID_ARGUMENT", "Pi 凭据文件格式错误。");
      }
    }
    const inheritedModels = readJson<{ providers?: Record<string, unknown> }>(
      path.join(this.config.piDir, "models.json"),
      {},
    );
    if (
      inheritedModels?.providers &&
      Object.hasOwn(inheritedModels.providers, "antigravity")
    ) {
      throw failure(
        "INVALID_ARGUMENT",
        "外部 Pi models.json 含有 Antigravity 配置，请移除该项；Mozi 使用自带 OAuth 入口和模型目录。",
      );
    }
    if (credentials.antigravity && credentials.antigravity.type !== "oauth") {
      throw failure(
        "INVALID_ARGUMENT",
        "Antigravity 需要 OAuth 凭据，请移除旧 API Key 后重新登录。",
      );
    }
    const credentialSnapshot = this.credentials.snapshot(credentials, external);
    const runtime = await ModelRuntime.create({
      credentials: credentialSnapshot.store,
      modelsPath: path.join(this.config.piDir, "models.json"),
      modelsStorePath: path.join(this.config.dataDir, "models-cache.json"),
      allowModelNetwork: false,
    });
    if (runtime.getError())
      throw failure(
        "INVALID_ARGUMENT",
        "Pi 模型配置无效，请检查 models.json。",
      );
    runtime.unregisterProvider("antigravity");
    const builtinIds = new Set(
      runtime.getProviders().map((provider) => provider.id),
    );
    runtime.registerProvider(
      "antigravity",
      getAntigravityProviderConfig(() => {
        if (!this.reauthRequired && !this.disposed) {
          this.reauthRequired = true;
          this.emitCatalog("antigravity");
        }
      }),
    );
    builtinIds.add("antigravity");
    runtime.registerProvider(DEEPSEEK_PROVIDER, getDeepSeekProviderConfig());
    builtinIds.add(DEEPSEEK_PROVIDER);
    this.packageConfig ??= loadBailianProvider(
      this.config.cwd,
      this.config.piDir,
    );
    const bailian = await this.packageConfig;
    // Package's "$ENV" reference is not a literal API key. Stored/runtime credentials own auth.
    const definition = { ...bailian };
    delete definition.apiKey;
    runtime.registerProvider(BAILIAN_PROVIDER, definition);
    if (process.env.BAILIAN_TP_API_KEY)
      await runtime.setRuntimeApiKey(
        BAILIAN_PROVIDER,
        process.env.BAILIAN_TP_API_KEY,
      );
    for (const [id, saved] of Object.entries(config.providers)) {
      if (id === "antigravity") continue;
      if (
        id === BAILIAN_PROVIDER &&
        ((saved.baseUrl && saved.baseUrl !== BAILIAN_ENDPOINT) ||
          (saved.api &&
            saved.api !== BAILIAN_API &&
            saved.api !== "openai-completions"))
      ) {
        throw failure(
          "INVALID_ARGUMENT",
          "Token Plan provider 必须使用专属套餐入口。",
        );
      }
      // Upgrade legacy settings in memory; reads never rewrite the user's config file.
      if (id === BAILIAN_PROVIDER) saved.api = BAILIAN_API;
      const baseModels = runtime.getModels(id);
      const models = saved.models?.map((item) => {
        const base = baseModels.find((model) => model.id === item.id);
        const template =
          id === BAILIAN_PROVIDER ? bailian.models?.[0] : undefined;
        return {
          ...(base ?? template),
          ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
          ...(saved.api ? { api: saved.api } : {}),
          id: item.id,
          name: item.name,
          reasoning: item.reasoning,
          input: item.vision
            ? ["text" as const, "image" as const]
            : ["text" as const],
          contextWindow: item.contextWindow,
          maxTokens: item.maxTokens,
          cost: base?.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        };
      });
      const additions: ProviderConfig = {
        ...(id === BAILIAN_PROVIDER ? definition : {}),
        ...(saved.name ? { name: saved.name } : {}),
        ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
        ...(saved.api ? { api: saved.api } : {}),
        ...(models?.length
          ? {
              models: [
                ...baseModels
                  .filter(
                    (model) => !models.some((item) => item.id === model.id),
                  )
                  .map((model) => ({
                    ...model,
                    ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
                    ...(saved.api ? { api: saved.api } : {}),
                  })),
                ...models,
              ],
            }
          : {}),
      };
      runtime.registerProvider(id, additions);
    }
    for (const [id, credential] of Object.entries(credentials)) {
      if (
        credential.type === "api_key" &&
        credential.key &&
        runtime.getProvider(id)
      )
        await runtime.setRuntimeApiKey(id, credential.key);
    }
    // Never let inherited Pi models.json override the subscription endpoint or per-model URLs.
    if (
      runtime
        .getModels(BAILIAN_PROVIDER)
        .some(
          (model) =>
            model.baseUrl !== BAILIAN_ENDPOINT || model.api !== BAILIAN_API,
        )
    ) {
      throw failure(
        "INVALID_ARGUMENT",
        "Pi 配置覆盖了 Token Plan 专属入口，请移除冲突配置。",
      );
    }
    await runtime.refresh({ allowNetwork: false });
    return {
      runtime,
      version: randomUUID(),
      config,
      builtinIds,
      activate: credentialSnapshot.activate,
    };
  }
  async listProviders(): Promise<ProviderView[]> {
    const { runtime, config, builtinIds } = await this.current();
    if (!this.catalogAttempted && this.credentials.readAll().antigravity)
      void this.refreshProviderModels("antigravity").catch(() => {});
    return runtime
      .getProviders()
      .flatMap((provider) => {
        const models = runtime.getModels(provider.id);
        if (!models.length) return [];
        const saved = config.providers[provider.id];
        return [
          {
            id: provider.id,
            name:
              saved?.name ||
              (provider.id === BAILIAN_PROVIDER
                ? "百炼 Token Plan"
                : provider.name || provider.id),
            source:
              provider.id === BAILIAN_PROVIDER || provider.id === "antigravity"
                ? ("extension" as const)
                : builtinIds.has(provider.id)
                  ? runtime.getRegisteredProviderConfig(provider.id)
                    ? ("configured" as const)
                    : ("builtin" as const)
                  : ("custom" as const),
            configured: runtime.hasConfiguredAuth(provider.id),
            ...(provider.id === "antigravity"
              ? {
                  catalogStatus: this.catalogStatus,
                  catalogMessage: this.catalogMessage,
                }
              : {}),
            authMethods:
              provider.id === "antigravity"
                ? ["oauth" as const]
                : ["api_key" as const],
            authStatus:
              provider.id === "antigravity" && this.reauthRequired
                ? ("reauth_required" as const)
                : runtime.hasConfiguredAuth(provider.id)
                  ? ("connected" as const)
                  : ("disconnected" as const),
            baseUrl: publicEndpoint(saved?.baseUrl ?? models[0].baseUrl),
            api: saved?.api ?? models[0].api,
            endpointLocked:
              provider.id === BAILIAN_PROVIDER || provider.id === "antigravity",
            removable:
              !builtinIds.has(provider.id) && provider.id !== BAILIAN_PROVIDER,
            models: models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              reasoning: model.reasoning,
              vision: model.input.includes("image"),
              supportsWebTools:
                supportsBailianWebTools(model) ||
                supportsDeepSeekWebTools(model),
              supportsWebExtractor: supportsBailianWebTools(model),
              supportsBrowserTools: this.visualBrowser,
              thinkingLevels: thinkingLevels(model),
            })),
            customModels: saved?.models ?? [],
          },
        ];
      })
      .sort(
        (a, b) =>
          Number(b.id === BAILIAN_PROVIDER) -
            Number(a.id === BAILIAN_PROVIDER) ||
          Number(b.configured) - Number(a.configured) ||
          a.name.localeCompare(b.name),
      );
  }
  private update(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(work);
    this.queue = job.catch(() => {});
    return job;
  }
  saveProvider(input: ProviderSaveInput): Promise<void> {
    return this.update(async () => {
      if (!isParamsFor("provider.save", input))
        throw failure("INVALID_ARGUMENT", "Provider 配置无效。");
      const current = await this.current();
      const config = structuredClone(current.config);
      const credentials = readJson<Credentials>(this.authPath, {});
      const { providerId, apiKey, ...settings } = input;
      if (providerId === "antigravity")
        throw failure(
          "INVALID_ARGUMENT",
          "Antigravity 请使用 Google 登录，模型和接口由扩展管理。",
        );
      if (
        !current.runtime.getProvider(providerId) &&
        (!settings.baseUrl || !settings.api || !settings.models?.length)
      ) {
        throw failure(
          "INVALID_ARGUMENT",
          "新 provider 需要接口地址、协议和至少一个模型。",
        );
      }
      config.providers[providerId] = {
        ...config.providers[providerId],
        ...settings,
      };
      const originalConfig = this.readConfiguration();
      if (apiKey)
        credentials[providerId] = { type: "api_key", key: apiKey.trim() };
      const next = await this.build(config, credentials);
      // Validate first. Publish after both writes; restore settings if credential persistence fails.
      try {
        writeJson(this.modelsPath, config);
        if (apiKey)
          await this.credentials.modify(
            providerId,
            async () => credentials[providerId],
          );
      } catch {
        writeJson(this.modelsPath, originalConfig);
        throw failure("INTERNAL_ERROR", "保存 provider 配置失败。");
      }
      next.activate();
      this.snapshot = Promise.resolve(next);
    });
  }
  removeProvider(providerId: string): Promise<void> {
    return this.update(async () => {
      const current = await this.current();
      if (providerId === BAILIAN_PROVIDER || current.builtinIds.has(providerId))
        throw failure("INVALID_ARGUMENT", "内置 provider 不能删除。");
      const config = structuredClone(current.config);
      delete config.providers[providerId];
      const credentials = readJson<Credentials>(this.authPath, {});
      const originalConfig = this.readConfiguration();
      delete credentials[providerId];
      const next = await this.build(config, credentials);
      try {
        writeJson(this.modelsPath, config);
        await this.credentials.delete(providerId);
      } catch {
        writeJson(this.modelsPath, originalConfig);
        throw failure("INTERNAL_ERROR", "删除 provider 配置失败。");
      }
      next.activate();
      this.snapshot = Promise.resolve(next);
    });
  }
  async prepare(selection: ModelSelection): Promise<PiModelBinding> {
    const { runtime, version } = await this.current();
    const model = runtime.getModel(selection.providerId, selection.modelId);
    if (!model)
      throw failure(
        "INVALID_ARGUMENT",
        "所选 provider 不支持此模型，请重新选择。",
      );
    if (selection.providerId === "antigravity" && this.reauthRequired)
      throw failure(
        "INVALID_ARGUMENT",
        "Google 授权已失效，请重新登录 Antigravity。",
      );
    if (!runtime.hasConfiguredAuth(selection.providerId))
      throw failure(
        "INVALID_ARGUMENT",
        "请先配置此 provider 的凭据或完成登录。",
      );
    if (
      selection.thinkingLevel !== undefined &&
      !thinkingLevels(model).includes(selection.thinkingLevel)
    ) {
      throw failure(
        "INVALID_ARGUMENT",
        "所选模型不支持此思考等级，请重新选择。",
      );
    }
    const webMode =
      selection.webMode ?? (this.visualBrowser ? "browser" : "provider");
    if (webMode === "browser" && !this.visualBrowser) {
      throw failure(
        "UNSUPPORTED_CAPABILITY",
        "当前运行环境不支持 Mozi 浏览器。",
      );
    }
    if (
      selection.webMode === "provider" &&
      !supportsBailianWebTools(model) &&
      !supportsDeepSeekWebTools(model)
    ) {
      throw failure(
        "UNSUPPORTED_CAPABILITY",
        "当前模型尚未接入服务商原生联网，请选择 Mozi 浏览器。",
      );
    }
    const webSelection =
      webMode === "browser"
        ? { ...selection, webSearch: false, webExtractor: false }
        : selection;
    const preparedModel = withDeepSeekWebTools(
      withBailianWebTools(model, webSelection),
      webSelection,
    );
    return {
      runtime,
      model: preparedModel,
      version,
      thinkingLevel: selection.thinkingLevel,
      webMode,
    };
  }
}
