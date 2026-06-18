import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { appConfig } from "./config/appConfig.js";
import { verifyDatabaseConnection } from "./db/client.js";
import { runPendingMigrations, verifySessionSchema } from "./db/migrations.js";
import { attachAuth } from "./middleware/authMiddleware.js";
import { handleAuthRoutes } from "./modules/auth/authController.js";
import { handleMarketDataRoutes } from "./modules/market-data/marketDataController.js";
import { handleSignalRoutes } from "./modules/signals/signalController.js";
import { startSignalOutcomeTracker } from "./modules/signals/signalOutcomeService.js";
import { handleSubscriptionRoutes } from "./modules/subscriptions/subscriptionController.js";
import { sendError } from "./shared/http.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(rootDir, "public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  await attachAuth(req);

  try {
    const handled =
      (await handleAuthRoutes(req, res, url.pathname)) ||
      (await handleSubscriptionRoutes(req, res, url.pathname)) ||
      (await handleMarketDataRoutes(req, res, url.pathname, url)) ||
      (await handleSignalRoutes(req, res, url.pathname));

    if (handled !== false) {
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      return sendError(res, 404, "API route not found.");
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendError(res, 500, "Unexpected server error.", error.message);
  }
});

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    return sendError(res, 403, "Forbidden.");
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    const index = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mimeTypes[".html"] });
    res.end(index);
  }
}

await verifyDatabaseConnection();
await runPendingMigrations();
await verifySessionSchema();

server.listen(appConfig.port, () => {
  console.log(`${appConfig.appName} running at http://localhost:${appConfig.port}`);
  startSignalOutcomeTracker();
});
