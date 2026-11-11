import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const OPENAI_PROVIDER = "openai";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reuse a single installation UUID across OpenAI ChatGPT OAuth logins. */
export function getOrCreateDeviceId(agentDir: string): string {
  const filename = path.join(agentDir, "device.json");
  if (existsSync(filename)) {
    try {
      const parsed = JSON.parse(readFileSync(filename, "utf8")) as {
        deviceId?: unknown;
      };
      if (
        typeof parsed?.deviceId === "string" &&
        UUID_PATTERN.test(parsed.deviceId)
      ) {
        return parsed.deviceId.toLowerCase();
      }
    } catch {
      // Regenerate when the device file is unreadable.
    }
  }
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const deviceId = randomUUID().toLowerCase();
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ deviceId }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, filename);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return deviceId;
}

export function configureOpenAIRuntime(
  runtime: ModelRuntime,
  context: {
    agentDir: string;
    onInvalidGrant(): void;
  },
): void {
  const provider = runtime.getProvider(OPENAI_PROVIDER);
  const oauth = provider?.auth.oauth;
  if (!provider || !oauth) return;
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        login: (interaction, options) =>
          oauth.login(interaction, {
            ...options,
            agentName: "Mozi",
            getDeviceId: () => getOrCreateDeviceId(context.agentDir),
          }),
        refresh: async (credential, signal) => {
          try {
            return await oauth.refresh(credential, signal);
          } catch (error) {
            if (
              error instanceof Error &&
              /invalid_grant|Stored OpenAI OAuth credential does not contain an issued client ID/.test(
                error.message,
              )
            ) {
              context.onInvalidGrant();
            }
            // Provider error bodies must not escape through SDK errors or diagnostics.
            // eslint-disable-next-line preserve-caught-error
            throw new Error(
              "OpenAI 凭据刷新失败，请检查网络；授权失效时请重新登录。",
            );
          }
        },
      },
    },
  });
}
