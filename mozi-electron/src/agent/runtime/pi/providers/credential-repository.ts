import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export type CredentialStore = NonNullable<
  CreateModelRuntimeOptions["credentials"]
>;
export type Credential = NonNullable<
  Awaited<ReturnType<CredentialStore["read"]>>
>;
export type Credentials = Record<string, Credential>;

/** One process owns this file. All runtimes share the same OAuth refresh lock. */
export class CredentialRepository {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly filename: string,
    private readonly policy: (id: string) => {
      shared: boolean;
    } = () => ({ shared: false }),
  ) {}
  readAll(): Credentials {
    const values = existsSync(this.filename)
      ? (JSON.parse(readFileSync(this.filename, "utf8")) as Credentials)
      : {};
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.values(values).some(
        (v) => !v || !["api_key", "oauth"].includes(v.type),
      )
    )
      throw new Error("Provider 凭据格式错误。");
    return values;
  }
  private write(values: Credentials): void {
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(values, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, this.filename);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const job = (this.queues.get(id) ?? Promise.resolve()).then(work);
    const tail = job.catch(() => {});
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return job;
  }
  modify(
    id: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    signal?: AbortSignal,
  ): Promise<Credential | undefined> {
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      const current = this.readAll();
      const value = await fn(structuredClone(current[id]));
      signal?.throwIfAborted();
      if (value) {
        const latest = this.readAll();
        latest[id] = value;
        this.write(latest);
      }
      return structuredClone(value ?? current[id]);
    });
  }
  delete(id: string, signal?: AbortSignal): Promise<void> {
    return this.serialize(id, async () => {
      signal?.throwIfAborted();
      const all = this.readAll();
      delete all[id];
      this.write(all);
    });
  }
  /** API-key snapshots stay immutable; OAuth always reads current shared credentials. */
  snapshot(owned: Credentials): { store: CredentialStore; activate(): void } {
    const values = structuredClone(owned);
    let active = false;
    const shared = (id: string) =>
      this.policy(id).shared || values[id]?.type === "oauth";
    const read = (id: string) =>
      active && shared(id) ? this.readAll()[id] : values[id];
    return {
      activate: () => {
        active = true;
      },
      store: {
        read: async (id) => structuredClone(read(id)),
        list: async () =>
          [
            ...new Set([
              ...Object.keys(values),
              ...Object.keys(this.readAll()),
            ]),
          ].flatMap((providerId) => {
            const v = read(providerId);
            return v ? [{ providerId, type: v.type }] : [];
          }),
        modify: async (id, fn, options) => {
          if (active && shared(id)) return this.modify(id, fn, options?.signal);
          options?.signal?.throwIfAborted();
          const next = await fn(structuredClone(values[id]));
          options?.signal?.throwIfAborted();
          if (next) values[id] = next;
          return structuredClone(values[id]);
        },
        delete: async (id, options) => {
          if (active) await this.delete(id, options?.signal);
          delete values[id];
        },
      },
    };
  }
}

/** Structural boundary for hosts/tests that provide another persistence implementation. */
export type CredentialStorage = Pick<
  CredentialRepository,
  "readAll" | "modify" | "delete" | "snapshot"
>;
