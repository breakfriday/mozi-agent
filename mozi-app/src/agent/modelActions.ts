import type { ModelSelection, ModelSettings, ProviderSaveInput } from "../../../shared/agent";
import { bridgeApi } from "../runtime/bridge";
import { useAgentStore } from "./agentStore";
import { useModelStore } from "./modelStore";

let connection = 0;
let request = 0;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "模型配置操作失败，请重试。";
async function refresh() {
  const token = connection, version = ++request;
  useModelStore.setState({ loading: true, error: null });
  try {
    const settings = await bridgeApi.agent.getModelSettings();
    if (token === connection && version === request) useModelStore.setState({ settings });
  } catch (error) {
    if (token === connection && version === request) useModelStore.setState({ error: errorMessage(error) });
  } finally {
    if (token === connection && version === request) useModelStore.setState({ loading: false });
  }
}
async function mutate(action: () => Promise<ModelSettings>) {
  if (useModelStore.getState().saving || useAgentStore.getState().runtime.state !== "ready") throw new Error("请等待连接或当前配置操作完成。");
  const token = connection;
  ++request;
  useModelStore.setState({ saving: true, loading: false, error: null });
  try {
    const settings = await action();
    if (token !== connection) throw new Error("连接已变化，请刷新后确认配置。");
    ++request;
    useModelStore.setState({ settings, loading: false });
  } catch (error) {
    if (token === connection) useModelStore.setState({ error: errorMessage(error) });
    throw error;
  } finally {
    if (token === connection) useModelStore.setState({ saving: false });
  }
}
export const modelActions = {
  initialize() {
    const off = useAgentStore.subscribe((state, previous) => {
      if (state.runtime === previous.runtime) return;
      if (state.runtime.state === "ready") void refresh();
      else { connection++; request++; useModelStore.setState({ saving: false, loading: false }); }
    });
    if (useAgentStore.getState().runtime.state === "ready") void refresh();
    return () => { off(); connection++; request++; useModelStore.setState({ saving: false, loading: false }); };
  },
  refresh,
  saveProvider: (input: ProviderSaveInput) => mutate(() => bridgeApi.agent.saveProvider(input)),
  removeProvider: (providerId: string) => mutate(() => bridgeApi.agent.removeProvider({ providerId })),
  setDefault: (model: ModelSelection) => mutate(() => bridgeApi.agent.setDefaultModel({ model })),
};
