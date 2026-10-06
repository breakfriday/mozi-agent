import { ModelRuntime, type ProviderConfig, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { isParamsFor, type ModelSelection, type ProviderSaveInput, type ProviderView } from "../../../../../shared/agent";
import { failure } from "../../application/errors";
import type { PiConfig } from "./session-factory";
import { BAILIAN_ENDPOINT, BAILIAN_PROVIDER, loadBailianProvider } from "./providers/bailian";

type SavedProvider = Omit<ProviderSaveInput, "providerId" | "apiKey">;
type Configuration = { providers: Record<string, SavedProvider> };
type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
type Credentials = Record<string, Credential>;
type Snapshot = { runtime: ModelRuntime; version: string; config: Configuration; builtinIds: Set<string>; activate(): void };
export type PiModelBinding = { runtime: ModelRuntime; model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; version: string };

function readJson<T>(filename: string, fallback: T): T {
  if (!existsSync(filename)) return fallback;
  try { return JSON.parse(readFileSync(filename, "utf8")) as T; }
  catch { throw failure("INVALID_ARGUMENT", "Provider 配置或凭据文件无法读取，请检查 JSON 格式。"); }
}
function writeJson(filename: string, data: unknown): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, filename);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function publicEndpoint(value: string): string {
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
  catch { return ""; }
}

/** Owns managed provider configuration; published runtimes are never reconfigured. */
export class PiProviderManager {
  private readonly modelsPath: string;
  private readonly authPath: string;
  private snapshot?: Promise<Snapshot>;
  private packageConfig?: Promise<ProviderConfig>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: PiConfig) {
    const directory = path.join(config.dataDir, "providers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.modelsPath = path.join(directory, "models.json");
    this.authPath = path.join(directory, "auth.json");
  }
  private readConfiguration(): Configuration {
    const config = readJson<Configuration>(this.modelsPath, { providers: {} });
    if (!config || typeof config.providers !== "object" || !config.providers || Array.isArray(config.providers)) {
      throw failure("INVALID_ARGUMENT", "Mozi provider 配置文件格式错误。");
    }
    for (const [providerId, item] of Object.entries(config.providers)) {
      if (!isParamsFor("provider.save", { ...item, providerId }) || "apiKey" in item) {
        throw failure("INVALID_ARGUMENT", "Mozi provider 配置文件格式错误。");
      }
    }
    return config;
  }
  private current(): Promise<Snapshot> {
    if (!this.snapshot) {
      const promise = this.build(this.readConfiguration(), readJson<Credentials>(this.authPath, {})).then(next => { next.activate(); return next; });
      this.snapshot = promise;
      void promise.catch(() => { if (this.snapshot === promise) this.snapshot = undefined; });
    }
    return this.snapshot;
  }
  private async build(config: Configuration, credentials: Credentials): Promise<Snapshot> {
    const external = readJson<Credentials>(path.join(this.config.piDir, "auth.json"), {});
    const values: Credentials = { ...external, ...credentials };
    for (const credential of Object.values(values)) {
      if (!credential || (credential.type !== "api_key" && credential.type !== "oauth")) {
        throw failure("INVALID_ARGUMENT", "Pi 凭据文件格式错误。");
      }
    }
    // Snapshot keys per runtime; OAuth refreshes persist only to Mozi's owned file.
    // Compare before writing so an older Run cannot overwrite a newly saved API key.
    const baseline = structuredClone(credentials);
    let active = false;
    let credentialQueue: Promise<unknown> = Promise.resolve();
    const persist = (id: string, value: Credential | undefined) => {
      if (!active) return;
      const latest = readJson<Credentials>(this.authPath, {});
      if (JSON.stringify(latest[id]) !== JSON.stringify(baseline[id])) return;
      if (value) latest[id] = value; else delete latest[id];
      writeJson(this.authPath, latest);
      if (value) baseline[id] = structuredClone(value); else delete baseline[id];
    };
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const job = credentialQueue.then(work);
      credentialQueue = job.catch(() => {});
      return job;
    };
    const store: CredentialStore = {
      read: async id => structuredClone(values[id]),
      list: async () => Object.entries(values).map(([providerId, credential]) => ({ providerId, type: credential.type })),
      modify: (id, fn, options) => serialize(async () => {
        options?.signal?.throwIfAborted();
        const value = await fn(structuredClone(values[id]));
        if (value) { persist(id, value); values[id] = structuredClone(value); }
        return structuredClone(values[id]);
      }),
      delete: (id, options) => serialize(async () => {
        options?.signal?.throwIfAborted(); persist(id, undefined); delete values[id];
      }),
    };
    const runtime = await ModelRuntime.create({
      credentials: store, modelsPath: path.join(this.config.piDir, "models.json"),
      modelsStorePath: path.join(this.config.dataDir, "models-cache.json"), allowModelNetwork: false,
    });
    if (runtime.getError()) throw failure("INVALID_ARGUMENT", "Pi 模型配置无效，请检查 models.json。");
    const builtinIds = new Set(runtime.getProviders().map(provider => provider.id));
    this.packageConfig ??= loadBailianProvider(this.config.cwd, this.config.piDir);
    const bailian = await this.packageConfig;
    // Package's "$ENV" reference is not a literal API key. Stored/runtime credentials own auth.
    const definition = { ...bailian };
    delete definition.apiKey;
    runtime.registerProvider(BAILIAN_PROVIDER, definition);
    if (process.env.BAILIAN_TP_API_KEY) await runtime.setRuntimeApiKey(BAILIAN_PROVIDER, process.env.BAILIAN_TP_API_KEY);
    for (const [id, saved] of Object.entries(config.providers)) {
      if (id === BAILIAN_PROVIDER && ((saved.baseUrl && saved.baseUrl !== BAILIAN_ENDPOINT)
        || (saved.api && saved.api !== "openai-completions"))) {
        throw failure("INVALID_ARGUMENT", "Token Plan provider 必须使用专属套餐入口。");
      }
      const baseModels = runtime.getModels(id);
      const models = saved.models?.map(item => {
        const base = baseModels.find(model => model.id === item.id);
        const template = id === BAILIAN_PROVIDER ? bailian.models?.[0] : undefined;
        return { ...(base ?? template), ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}), ...(saved.api ? { api: saved.api } : {}), id: item.id, name: item.name, reasoning: item.reasoning,
          input: item.vision ? ["text" as const, "image" as const] : ["text" as const],
          contextWindow: item.contextWindow, maxTokens: item.maxTokens,
          cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      });
      const additions: ProviderConfig = { ...(id === BAILIAN_PROVIDER ? definition : {}),
        ...(saved.name ? { name: saved.name } : {}), ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
        ...(saved.api ? { api: saved.api } : {}),
        ...(models?.length ? { models: [...baseModels.filter(model => !models.some(item => item.id === model.id)).map(model => ({ ...model, ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}), ...(saved.api ? { api: saved.api } : {}) })), ...models] } : {}),
      };
      runtime.registerProvider(id, additions);
    }
    for (const [id, credential] of Object.entries(credentials)) {
      if (credential.type === "api_key" && credential.key && runtime.getProvider(id)) await runtime.setRuntimeApiKey(id, credential.key);
    }
    // Never let inherited Pi models.json override the subscription endpoint or per-model URLs.
    if (runtime.getModels(BAILIAN_PROVIDER).some(model => model.baseUrl !== BAILIAN_ENDPOINT || model.api !== "openai-completions")) {
      throw failure("INVALID_ARGUMENT", "Pi 配置覆盖了 Token Plan 专属入口，请移除冲突配置。");
    }
    await runtime.refresh({ allowNetwork: false });
    return { runtime, version: randomUUID(), config, builtinIds, activate: () => { active = true; } };
  }
  async listProviders(): Promise<ProviderView[]> {
    const { runtime, config, builtinIds } = await this.current();
    return runtime.getProviders().flatMap(provider => {
      const models = runtime.getModels(provider.id);
      if (!models.length) return [];
      const saved = config.providers[provider.id];
      return [{ id: provider.id, name: saved?.name || (provider.id === BAILIAN_PROVIDER ? "百炼 Token Plan" : provider.name || provider.id),
        source: provider.id === BAILIAN_PROVIDER ? "extension" as const : builtinIds.has(provider.id)
          ? (runtime.getRegisteredProviderConfig(provider.id) ? "configured" as const : "builtin" as const) : "custom" as const,
        configured: runtime.hasConfiguredAuth(provider.id),
        baseUrl: publicEndpoint(saved?.baseUrl ?? models[0].baseUrl), api: saved?.api ?? models[0].api,
        endpointLocked: provider.id === BAILIAN_PROVIDER,
        removable: !builtinIds.has(provider.id) && provider.id !== BAILIAN_PROVIDER,
        models: models.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow,
          maxTokens: model.maxTokens, reasoning: model.reasoning, vision: model.input.includes("image") })),
        customModels: saved?.models ?? [],
      }];
    }).sort((a, b) => Number(b.id === BAILIAN_PROVIDER) - Number(a.id === BAILIAN_PROVIDER) || Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  }
  private update(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(work);
    this.queue = job.catch(() => {});
    return job;
  }
  saveProvider(input: ProviderSaveInput): Promise<void> {
    return this.update(async () => {
      if (!isParamsFor("provider.save", input)) throw failure("INVALID_ARGUMENT", "Provider 配置无效。");
      const current = await this.current();
      const config = structuredClone(current.config);
      const credentials = readJson<Credentials>(this.authPath, {});
      const { providerId, apiKey, ...settings } = input;
      if (!current.runtime.getProvider(providerId) && (!settings.baseUrl || !settings.api || !settings.models?.length)) {
        throw failure("INVALID_ARGUMENT", "新 provider 需要接口地址、协议和至少一个模型。");
      }
      config.providers[providerId] = { ...config.providers[providerId], ...settings };
      const originalCredentials = structuredClone(credentials);
      if (apiKey) credentials[providerId] = { type: "api_key", key: apiKey.trim() };
      const next = await this.build(config, credentials);
      // Validate first. Publish only after both files commit; roll back credentials on config failure.
      try { writeJson(this.authPath, credentials); writeJson(this.modelsPath, config); }
      catch { writeJson(this.authPath, originalCredentials); throw failure("INTERNAL_ERROR", "保存 provider 配置失败。"); }
      next.activate();
      this.snapshot = Promise.resolve(next);
    });
  }
  removeProvider(providerId: string): Promise<void> {
    return this.update(async () => {
      const current = await this.current();
      if (providerId === BAILIAN_PROVIDER || current.builtinIds.has(providerId)) throw failure("INVALID_ARGUMENT", "内置 provider 不能删除。");
      const config = structuredClone(current.config);
      delete config.providers[providerId];
      const credentials = readJson<Credentials>(this.authPath, {});
      const originalCredentials = structuredClone(credentials);
      delete credentials[providerId];
      const next = await this.build(config, credentials);
      try { writeJson(this.authPath, credentials); writeJson(this.modelsPath, config); }
      catch { writeJson(this.authPath, originalCredentials); throw failure("INTERNAL_ERROR", "删除 provider 配置失败。"); }
      next.activate();
      this.snapshot = Promise.resolve(next);
    });
  }
  async prepare(selection: ModelSelection): Promise<PiModelBinding> {
    const { runtime, version } = await this.current();
    const model = runtime.getModel(selection.providerId, selection.modelId);
    if (!model) throw failure("INVALID_ARGUMENT", "所选 provider 不支持此模型，请重新选择。");
    if (!runtime.hasConfiguredAuth(selection.providerId)) throw failure("INVALID_ARGUMENT", "请先配置此 provider 的 API Key。");
    return { runtime, model, version };
  }
}
