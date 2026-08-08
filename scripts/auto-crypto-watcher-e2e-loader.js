import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const clientSuffix = "/src/db/client.js";
const mockUrl = pathToFileURL(resolvePath("scripts/test-support/auto-crypto-watcher-db-transport.mock.js")).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const url = String(resolved.url || "").replaceAll("\\", "/");
  if (url.endsWith(clientSuffix)) {
    return { url: mockUrl, shortCircuit: true };
  }
  return resolved;
}
