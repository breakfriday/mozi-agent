import type { ModelSelection, ModelSettings, ProviderSaveInput } from "../../../../shared/agent";
import type { MetadataStore } from "../storage/metadata-store";
import type { ModelCatalog, PreparedModel } from "./model-catalog";
import type { ApplicationControl } from "../agent-control";
import { failure } from "../errors";

export class ModelService {
  constructor(private readonly store: MetadataStore, private readonly control: ApplicationControl,
    private readonly catalog?: ModelCatalog, private readonly startupDefault?: ModelSelection) {}
  startBackgroundWork(): void { this.catalog?.startBackgroundWork?.(); }
  async refreshProviderModels(providerId: string): Promise<ModelSettings> {
    const catalog = this.requireCatalog();
    if (!catalog.refreshProviderModels) throw failure("UNSUPPORTED_CAPABILITY", "当前运行时不支持动态模型目录。");
    await catalog.refreshProviderModels(providerId);
    return this.settings();
  }
  get auth() {
    const auth = this.requireCatalog().auth;
    if (!auth) throw failure("UNSUPPORTED_CAPABILITY", "当前运行时不支持 OAuth。");
    return auth;
  }
  defaultSelection(): ModelSelection | undefined { return this.store.getDefaultModel() ?? this.startupDefault; }
  async settings(): Promise<ModelSettings> {
    this.control.assertAvailable();
    const defaultModel = this.defaultSelection();
    return { providers: await this.requireCatalog().listProviders(), ...(defaultModel ? { defaultModel } : {}) };
  }
  async prepare(selection?: ModelSelection): Promise<PreparedModel | undefined> {
    this.control.assertAvailable();
    if (!this.catalog) return undefined;
    const model = selection ?? this.defaultSelection();
    if (!model) throw failure("INVALID_ARGUMENT", "请先选择 provider 和模型，或设置默认模型。");
    return this.catalog.prepareModel(model);
  }
  async setDefault(model: ModelSelection): Promise<ModelSettings> {
    await this.requireCatalog().prepareModel(model);
    this.control.assertAvailable();
    this.control.write(() => this.store.setDefaultModel(model));
    return this.settings();
  }
  async save(input: ProviderSaveInput): Promise<ModelSettings> {
    await this.requireCatalog().saveProvider(input);
    return this.settings();
  }
  async remove(providerId: string): Promise<ModelSettings> {
    if (this.defaultSelection()?.providerId === providerId
      || this.store.listSessions().some(item => item.session.model?.providerId === providerId)) {
      throw failure("INVALID_ARGUMENT", "此 provider 仍被默认模型或会话使用，请先切换这些选择。");
    }
    await this.requireCatalog().removeProvider(providerId);
    return this.settings();
  }
  private requireCatalog(): ModelCatalog {
    this.control.assertAvailable();
    if (!this.catalog) throw failure("UNSUPPORTED_CAPABILITY", "当前运行时不支持 provider 管理。");
    return this.catalog;
  }
}
