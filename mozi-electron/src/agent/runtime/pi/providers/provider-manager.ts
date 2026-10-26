import type {
  ProviderSaveInput,
  ProviderView,
  ModelSelection,
  ProviderAuthState,
} from "../../../../../../shared/agent";
import { isParamsFor } from "../../../../../../shared/agent";
import { failure } from "../../../errors";
import type { PiModelBinding } from "../types";
import type {
  CredentialStorage,
  Credential,
  Credentials,
} from "./credential-repository";
import type { ProviderConfiguration } from "./provider-plugin";
import type { ProviderRegistry } from "./provider-registry";
import type { ProviderConfigurationStore } from "./provider-configuration-store";
import type { RuntimeFactory, ProviderSnapshot } from "./pi-runtime-factory";
import { ProviderAuthManager } from "./provider-auth-manager";
import { ProviderCatalogService } from "./provider-catalog-service";
import { thinkingLevels, publicEndpoint } from "./provider-view";

export interface ProviderManagerDependencies {
  registry: ProviderRegistry;
  configuration: ProviderConfigurationStore;
  credentials: CredentialStorage;
  runtimeFactory: RuntimeFactory;
  visualBrowser: boolean;
  emitAuth(state: ProviderAuthState): void;
  emitCatalog(providerId: string): void;
}
/** Coordinates configuration transactions and snapshot publication, without vendor branches. */
export class PiProviderManager {
  readonly auth: ProviderAuthManager;
  private readonly catalog: ProviderCatalogService;
  private readonly reauthRequired = new Set<string>();
  private snapshot?: Promise<ProviderSnapshot>;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private readonly deps: ProviderManagerDependencies) {
    this.catalog = new ProviderCatalogService({
      registry: deps.registry,
      hasCredential: (id) => Boolean(deps.credentials.readAll()[id]),
      emit: deps.emitCatalog,
      refresh: (id, signal) => this.refreshCatalog(id, signal),
    });
    this.auth = new ProviderAuthManager({
      policy: (id) => deps.registry.get(id)?.oauth,
      runtime: async () =>
        (
          await this.buildRuntime(
            deps.configuration.read(),
            deps.credentials.readAll(),
          )
        ).runtime,
      emit: deps.emitAuth,
      committed: (id, credential, signal) =>
        this.commitLogin(id, credential, signal),
      removeCredential: (id) =>
        this.update(async () => {
          this.catalog.reset(id);
          await deps.runtimeFactory.clearModelCache(id);
          await deps.credentials.delete(id);
          this.reauthRequired.delete(id);
          this.catalog.reset(id);
          this.snapshot = undefined;
        }),
    });
  }
  /** Called explicitly by the host after its ready handshake, never by a read operation. */
  startBackgroundWork(): void {
    this.catalog.refreshConfiguredInBackground();
  }
  refreshProviderModels(id: string): Promise<void> {
    return this.catalog.refresh(id);
  }
  markReauthenticationRequired(id: string): void {
    if (!this.disposed && !this.reauthRequired.has(id)) {
      this.reauthRequired.add(id);
      this.deps.emitCatalog(id);
    }
  }
  private commitLogin(
    id: string,
    credential: Credential,
    signal: AbortSignal,
  ): Promise<void> {
    return this.update(async () => {
      signal.throwIfAborted();
      const credentials = this.deps.credentials.readAll();
      credentials[id] = credential;
      this.catalog.reset(id);
      await this.deps.runtimeFactory.clearModelCache(id);
      const next = await this.buildRuntime(
        this.deps.configuration.read(),
        credentials,
      );
      signal.throwIfAborted();
      await this.deps.credentials.modify(id, async () => credential, signal);
      this.reauthRequired.delete(id);
      this.catalog.reset(id);
      this.publish(next);
      if (this.deps.registry.get(id)?.dynamicModels)
        void this.catalog.refresh(id).catch(() => {});
    });
  }
  private async refreshCatalog(id: string, signal: AbortSignal): Promise<void> {
    const { credentials, configuration } = this.deps;
    const next = await this.buildRuntime(
      configuration.read(),
      credentials.readAll(),
    );
    signal.throwIfAborted();
    next.activate();
    await next.runtime.getAuth(id, { signal });
    const result = await next.runtime.refresh({
      providers: [id],
      allowNetwork: true,
      force: true,
      signal,
    });
    signal.throwIfAborted();
    if (result.errors.has(id)) throw new Error("Model discovery failed");
    await this.update(async () => {
      signal.throwIfAborted();
      // Merge refreshed SDK catalog with current settings; never roll back a concurrent edit.
      const latest = await this.buildRuntime(
        configuration.read(),
        credentials.readAll(),
      );
      signal.throwIfAborted();
      this.publish(latest);
    });
  }
  private buildRuntime(
    config: ProviderConfiguration,
    credentials: Credentials,
  ): Promise<ProviderSnapshot> {
    return this.deps.runtimeFactory.build(config, credentials, {
      onInvalidGrant: (id) => this.markReauthenticationRequired(id),
    });
  }
  private publish(next: ProviderSnapshot): void {
    if (this.disposed) throw failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。");
    next.activate();
    this.snapshot = Promise.resolve(next);
  }
  private current(): Promise<ProviderSnapshot> {
    if (this.disposed)
      return Promise.reject(failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。"));
    if (!this.snapshot) {
      const promise = this.buildRuntime(
        this.deps.configuration.read(),
        this.deps.credentials.readAll(),
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
  async listProviders(): Promise<ProviderView[]> {
    const { runtime, config, builtinIds } = await this.current();
    const { registry, visualBrowser } = this.deps;
    return runtime
      .getProviders()
      .flatMap((provider) => {
        const models = runtime.getModels(provider.id);
        if (!models.length) return [];
        const saved = config.providers[provider.id],
          plugin = registry.get(provider.id);
        return [
          {
            id: provider.id,
            name: saved?.name || plugin?.name || provider.name || provider.id,
            source:
              plugin?.source === "extension"
                ? ("extension" as const)
                : builtinIds.has(provider.id)
                  ? saved || plugin
                    ? ("configured" as const)
                    : ("builtin" as const)
                  : ("custom" as const),
            configured: runtime.hasConfiguredAuth(provider.id),
            ...this.catalog.view(provider.id),
            authMethods: [...(plugin?.authMethods ?? ["api_key" as const])],
            authStatus: this.reauthRequired.has(provider.id)
              ? ("reauth_required" as const)
              : runtime.hasConfiguredAuth(provider.id)
                ? ("connected" as const)
                : ("disconnected" as const),
            baseUrl: publicEndpoint(saved?.baseUrl ?? models[0].baseUrl),
            api: saved?.api ?? models[0].api,
            endpointLocked: plugin?.endpointLocked ?? false,
            removable: !builtinIds.has(provider.id),
            models: models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              reasoning: model.reasoning,
              vision: model.input.includes("image"),
              supportsWebTools: plugin?.supportsWebTools?.(model) ?? false,
              supportsWebExtractor:
                plugin?.supportsWebExtractor?.(model) ?? false,
              supportsBrowserTools: visualBrowser,
              thinkingLevels: thinkingLevels(model),
            })),
            customModels: saved?.models ?? [],
          },
        ];
      })
      .sort(
        (a, b) =>
          (registry.get(b.id)?.priority ?? 0) -
            (registry.get(a.id)?.priority ?? 0) ||
          Number(b.configured) - Number(a.configured) ||
          a.name.localeCompare(b.name),
      );
  }
  private update(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(() => {
      if (this.disposed) throw failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。");
      return work();
    });
    this.queue = job.catch(() => {});
    return job;
  }
  saveProvider(input: ProviderSaveInput): Promise<void> {
    return this.update(async () => {
      if (!isParamsFor("provider.save", input))
        throw failure("INVALID_ARGUMENT", "Provider 配置无效。");
      const { providerId, apiKey, ...settings } = input;
      if (this.deps.registry.get(providerId)?.settingsEditable === false)
        throw failure(
          "INVALID_ARGUMENT",
          "此 provider 的配置由插件管理，请使用其登录入口。",
        );
      const current = await this.current(),
        config = structuredClone(current.config);
      if (
        !current.runtime.getProvider(providerId) &&
        (!settings.baseUrl || !settings.api || !settings.models?.length)
      )
        throw failure(
          "INVALID_ARGUMENT",
          "新 provider 需要接口地址、协议和至少一个模型。",
        );
      config.providers[providerId] = {
        ...config.providers[providerId],
        ...settings,
      };
      const credentials = this.deps.credentials.readAll(),
        original = this.deps.configuration.read();
      if (apiKey)
        credentials[providerId] = { type: "api_key", key: apiKey.trim() };
      const next = await this.buildRuntime(config, credentials);
      try {
        this.deps.configuration.write(config);
        if (apiKey)
          await this.deps.credentials.modify(
            providerId,
            async () => credentials[providerId],
          );
      } catch {
        this.deps.configuration.write(original);
        throw failure("INTERNAL_ERROR", "保存 provider 配置失败。");
      }
      this.publish(next);
    });
  }
  removeProvider(providerId: string): Promise<void> {
    return this.update(async () => {
      const current = await this.current();
      if (current.builtinIds.has(providerId))
        throw failure("INVALID_ARGUMENT", "内置 provider 不能删除。");
      const config = structuredClone(current.config),
        credentials = this.deps.credentials.readAll(),
        original = this.deps.configuration.read();
      delete config.providers[providerId];
      delete credentials[providerId];
      const next = await this.buildRuntime(config, credentials);
      try {
        this.deps.configuration.write(config);
        await this.deps.credentials.delete(providerId);
      } catch {
        this.deps.configuration.write(original);
        throw failure("INTERNAL_ERROR", "删除 provider 配置失败。");
      }
      this.publish(next);
    });
  }
  configureAgent: NonNullable<PiModelBinding["configureAgent"]> = (
    agent,
    visualBrowser,
  ) => {
    for (const plugin of this.deps.registry.all())
      plugin.configureAgent?.(agent, visualBrowser);
  };
  async prepare(selection: ModelSelection): Promise<PiModelBinding> {
    const { runtime, version } = await this.current();
    const model = runtime.getModel(selection.providerId, selection.modelId);
    if (!model)
      throw failure(
        "INVALID_ARGUMENT",
        "所选 provider 不支持此模型，请重新选择。",
      );
    if (this.reauthRequired.has(selection.providerId))
      throw failure("INVALID_ARGUMENT", "账号授权已失效，请重新登录。");
    if (!runtime.hasConfiguredAuth(selection.providerId))
      throw failure(
        "INVALID_ARGUMENT",
        "请先配置此 provider 的凭据或完成登录。",
      );
    if (
      selection.thinkingLevel !== undefined &&
      !thinkingLevels(model).includes(selection.thinkingLevel)
    )
      throw failure(
        "INVALID_ARGUMENT",
        "所选模型不支持此思考等级，请重新选择。",
      );
    const plugin = this.deps.registry.get(selection.providerId);
    const webMode =
      selection.webMode ?? (this.deps.visualBrowser ? "browser" : "provider");
    if (webMode === "browser" && !this.deps.visualBrowser)
      throw failure(
        "UNSUPPORTED_CAPABILITY",
        "当前运行环境不支持 Mozi 浏览器。",
      );
    if (selection.webMode === "provider" && !plugin?.supportsWebTools?.(model))
      throw failure(
        "UNSUPPORTED_CAPABILITY",
        "当前模型尚未接入服务商原生联网，请选择 Mozi 浏览器。",
      );
    const webSelection =
      webMode === "browser"
        ? { ...selection, webSearch: false, webExtractor: false }
        : selection;
    return {
      configureAgent: this.configureAgent,
      runtime,
      model: plugin?.prepareModel?.(model, webSelection) ?? model,
      version,
      thinkingLevel: selection.thinkingLevel,
      webMode,
    };
  }
  dispose(): void {
    this.disposed = true;
    this.catalog.dispose();
    this.auth.dispose();
  }
}
