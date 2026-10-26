import path from "node:path";
import { mkdirSync } from "node:fs";
export interface AgentConfig { dataDir: string; cwd: string; provider?: string; modelId?: string }
export function readAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  if (!env.MOZI_AGENT_DATA_DIR) throw new Error("Main must supply MOZI_AGENT_DATA_DIR.");
  const dataDir = path.resolve(env.MOZI_AGENT_DATA_DIR);
  const cwd = path.resolve(env.MOZI_AGENT_CWD || path.join(dataDir, "workspace"));
  mkdirSync(cwd, { recursive: true });
  const provider = env.MOZI_AGENT_PROVIDER?.trim() || undefined;
  const modelId = env.MOZI_AGENT_MODEL?.trim() || undefined;
  if (Boolean(provider) !== Boolean(modelId)) throw new Error("MOZI_AGENT_PROVIDER and MOZI_AGENT_MODEL must be configured together.");
  return { dataDir, cwd, provider, modelId };
}
