import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isParamsFor } from "../../../../../../shared/agent";
import { failure } from "../../../errors";
import type { ProviderConfiguration } from "./provider-plugin";

export interface ProviderConfigurationStore {
  read(): ProviderConfiguration;
  write(config: ProviderConfiguration): void;
}
function readJson<T>(filename: string, fallback: T): T {
  if (!existsSync(filename)) return fallback;
  try {
    return JSON.parse(readFileSync(filename, "utf8")) as T;
  } catch {
    throw failure(
      "INVALID_ARGUMENT",
      "Provider 配置或凭据文件无法读取，请检查 JSON 格式。",
    );
  }
}
export class FileProviderConfigurationStore implements ProviderConfigurationStore {
  private readonly filename: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = path.join(directory, "models.json");
  }
  read(): ProviderConfiguration {
    const config = readJson<ProviderConfiguration>(this.filename, {
      providers: {},
    });
    if (
      !config ||
      typeof config.providers !== "object" ||
      !config.providers ||
      Array.isArray(config.providers) ||
      Object.entries(config.providers).some(
        ([providerId, item]) =>
          !isParamsFor("provider.save", { ...item, providerId }) ||
          "apiKey" in item,
      )
    )
      throw failure("INVALID_ARGUMENT", "Mozi provider 配置文件格式错误。");
    return config;
  }
  write(config: ProviderConfiguration): void {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(config, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.filename);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
