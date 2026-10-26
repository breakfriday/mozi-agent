import type { ProviderPlugin } from "./provider-plugin";

export class ProviderRegistry {
  private readonly plugins = new Map<string, ProviderPlugin>();
  constructor(plugins: readonly ProviderPlugin[]) {
    for (const plugin of plugins) {
      if (this.plugins.has(plugin.id))
        throw new Error(`Duplicate provider plugin: ${plugin.id}`);
      if (plugin.authMethods.includes("oauth") !== Boolean(plugin.oauth))
        throw new Error(`OAuth policy missing or inconsistent: ${plugin.id}`);
      this.plugins.set(plugin.id, plugin);
    }
  }
  get(id: string): ProviderPlugin | undefined {
    return this.plugins.get(id);
  }
  all(): readonly ProviderPlugin[] {
    return [...this.plugins.values()];
  }
  credentialPolicy(id: string) {
    const plugin = this.get(id);
    return {
      shared: plugin?.authMethods.includes("oauth") ?? false,
    };
  }
}
