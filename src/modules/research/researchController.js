import { getTrackRecords } from "../track-records/trackRecordService.js";
import { renderResearchPage } from "./researchPage.js";
import { loadResearchSummary } from "./researchSummary.js";

let summary = null;

// Loaded once at boot; a missing or malformed file must not stop the server.
export function loadResearchData() {
  try {
    summary = loadResearchSummary();
    console.info(`[research] summary loaded figures=${summary.figures.length}`);
  } catch (error) {
    summary = null;
    console.warn(`[research] summary not loaded: ${error.message}`);
  }
  return summary;
}

// Public and server-rendered, so search engines and link previews get real HTML. Never gated.
export function handleResearchPage(req, res, pathname) {
  if (pathname !== "/research" && pathname !== "/research/") return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let html;
  try {
    html = renderResearchPage({ trackRecords: getTrackRecords(), summary });
  } catch (error) {
    console.warn(`[research] page unavailable: ${error.message}`);
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("The research page is temporarily unavailable.");
    return true;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300"
  });
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}
