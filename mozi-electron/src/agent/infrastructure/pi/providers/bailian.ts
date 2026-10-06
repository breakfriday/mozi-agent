import registerBailian from "@aiwayds/pi-bailian-token-plan";
import { DefaultResourceLoader, SettingsManager, type ProviderConfig } from "@earendil-works/pi-coding-agent";

export const BAILIAN_PROVIDER = "bailian-tp";
export const BAILIAN_ENDPOINT = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

/** Load only the pinned package through Pi's real ExtensionAPI. No ambient extensions. */
export async function loadBailianProvider(cwd: string, agentDir: string): Promise<ProviderConfig> {
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [registerBailian] });
  await loader.reload();
  const result = loader.getExtensions();
  try {
    if (result.errors.length) throw new Error("百炼 provider 扩展加载失败。");
    const registered = result.runtime.pendingProviderRegistrations.find(item => item.name === BAILIAN_PROVIDER);
    if (!registered || registered.config.baseUrl !== BAILIAN_ENDPOINT || registered.config.api !== "openai-completions") {
      throw new Error("百炼扩展的套餐入口与预期不一致。");
    }
    return registered.config;
  } finally { result.runtime.invalidate(); }
}
