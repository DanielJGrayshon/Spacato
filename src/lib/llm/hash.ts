import { createHash } from "node:crypto";

export function promptHash(model: string, messages: unknown, schemaName: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, messages, schemaName }))
    .digest("hex");
}
