import {
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type ModelsStore = NonNullable<CreateModelRuntimeOptions["modelsStore"]>;
type Entry = NonNullable<Awaited<ReturnType<ModelsStore["read"]>>>;

/** The agent process owns this cache; synchronous read/replace keeps concurrent runtimes coherent. */
export function ownedModelsStore(filename: string): ModelsStore {
  const read = (): Record<string, Entry> =>
    existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) : {};
  const write = (entries: Record<string, Entry>) => {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(entries), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, filename);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  };
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      return read()[id];
    },
    async write(id, entry, options) {
      options?.signal?.throwIfAborted();
      write({ ...read(), [id]: entry });
    },
    async delete(id, options) {
      options?.signal?.throwIfAborted();
      const entries = read();
      delete entries[id];
      write(entries);
    },
  };
}

/** Explicit storage and credential-gated native auth prevent CLI/environment fallback. */
export async function createOwnedRuntime(options: {
  credentials: NonNullable<CreateModelRuntimeOptions["credentials"]>;
  modelsStorePath: string;
  allowModelNetwork: false;
}): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: options.credentials,
    modelsPath: null,
    modelsStore: ownedModelsStore(options.modelsStorePath),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  enforceOwnedAuth(runtime);
  return runtime;
}

/** Register the composed provider as native so SDK refreshes retain the credential gate. */
export function enforceOwnedAuth(runtime: ModelRuntime): void {
  for (const provider of runtime.getProviders()) {
    const apiKey = provider.auth.apiKey;
    if (!apiKey) continue;
    runtime.registerNativeProvider({
      ...provider,
      auth: {
        ...provider.auth,
        apiKey: {
          ...apiKey,
          check: async (input) => {
            if (!input.credential?.key) return undefined;
            return { type: "api_key", source: "Mozi credential" };
          },
          resolve: async (input) => {
            if (!input.credential?.key) return undefined;
            return apiKey.resolve({
              ...input,
              ctx: { ...input.ctx, env: async () => undefined },
            });
          },
        },
      },
    });
  }
}
