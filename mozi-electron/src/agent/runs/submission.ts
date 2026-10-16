import { createHash } from "node:crypto";
import type { InputPart } from "../../../../shared/agent";

export const contentHash = (content: InputPart[]): string => createHash("sha256")
  .update(JSON.stringify(content.map(({ type, text }) => ({ type, text })))).digest("hex");

