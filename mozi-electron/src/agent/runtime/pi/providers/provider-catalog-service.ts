import { failure } from "../../../errors";
import type { ProviderRegistry } from "./provider-registry";

type CatalogState = {
  status: "idle" | "refreshing" | "ready" | "failed";
  message: string;
  task?: Promise<void>;
  abort?: AbortController;
};
const idle = (): CatalogState => ({
  status: "idle",
  message: "登录后同步账号模型；当前列表为缓存或内置备用目录。",
});
/** Scheduling and status are per provider. Network/SDK work is supplied by the owner. */
export class ProviderCatalogService {
  private readonly states = new Map<string, CatalogState>();
  private disposed = false;
  constructor(
    private readonly options: {
      registry: ProviderRegistry;
      hasCredential(id: string): boolean;
      emit(id: string): void;
      refresh(id: string, signal: AbortSignal): Promise<void>;
      timeoutMs?: number;
    },
  ) {}
  view(id: string) {
    if (!this.options.registry.get(id)?.dynamicModels) return {};
    const state = this.states.get(id) ?? idle();
    return { catalogStatus: state.status, catalogMessage: state.message };
  }
  refresh(id: string): Promise<void> {
    if (!this.options.registry.get(id)?.dynamicModels)
      return Promise.reject(
        failure("UNSUPPORTED_CAPABILITY", "此 provider 不支持动态模型同步。"),
      );
    if (this.disposed)
      return Promise.reject(failure("RUNTIME_UNAVAILABLE", "Agent 已关闭。"));
    if (!this.options.hasCredential(id))
      return Promise.reject(failure("INVALID_ARGUMENT", "请先配置账号凭据。"));
    const state = this.states.get(id) ?? idle();
    if (state.task) return state.task;
    this.states.set(id, state);
    state.status = "refreshing";
    state.message = "正在从账号同步最新模型…";
    const controller = new AbortController();
    state.abort = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 12_000),
    ]);
    this.options.emit(id);
    const current = () => !this.disposed && this.states.get(id) === state;
    state.task = (async () => {
      try {
        await Promise.resolve().then(() => {
          signal.throwIfAborted();
          return this.options.refresh(id, signal);
        });
        signal.throwIfAborted();
        if (current()) {
          state.status = "ready";
          state.message = "已同步账号模型目录。";
        }
      } catch {
        if (current()) {
          state.status = "failed";
          state.message =
            "账号模型同步失败，已保留缓存或内置列表；请检查网络后重试。";
        }
      } finally {
        state.task = undefined;
        if (current()) this.options.emit(id);
      }
    })();
    return state.task;
  }
  refreshConfiguredInBackground(): void {
    for (const plugin of this.options.registry.all()) {
      if (
        plugin.dynamicModels &&
        !this.states.has(plugin.id) &&
        this.options.hasCredential(plugin.id)
      )
        void this.refresh(plugin.id).catch(() => {});
    }
  }
  reset(id: string): void {
    const previous = this.states.get(id);
    previous?.abort?.abort();
    this.states.delete(id);
  }
  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) state.abort?.abort();
  }
}
