import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const clientSuffix = "/src/db/client.js";
const marketDataSuffix = "/src/modules/market-data/marketDataService.js";
const dbMockUrl = pathToFileURL(resolvePath("scripts/test-support/scan-all-active-unlock-db-transport.mock.js")).href;
const marketDataMockUrl = pathToFileURL(resolvePath("scripts/test-support/scan-all-active-unlock-market-data.mock.js")).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const url = new URL(resolved.url);
  const pathname = url.pathname.replaceAll("\\", "/");

  if (pathname.endsWith(clientSuffix)) {
    return { url: dbMockUrl, shortCircuit: true };
  }
  if (pathname.endsWith(marketDataSuffix) && url.searchParams.get("active-scan-actual") !== "1") {
    return { url: marketDataMockUrl, shortCircuit: true };
  }
  return resolved;
}
