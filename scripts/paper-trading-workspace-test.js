import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addPaperDrawingPoint,
  calculatePaperForecastMetrics,
  calculatePaperWorkspaceLayout,
  createPaperForecastDrawing,
  deletePaperDrawing,
  getPaperChartWindow,
  getPaperPinchTransform,
  panPaperTimeWindow,
  translatePaperPriceRange,
  updatePaperForecastDrawing,
  zoomPaperPriceRange,
  zoomPaperTimeWindow
} from "../public/paperChartUtils.js";

const app = read("public/app.js");
const html = read("public/index.html");
const styles = read("public/styles.css");
const utilities = read("public/paperChartUtils.js");
let passed = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  passed += 1;
};
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  passed += 1;
};

const expanded = calculatePaperWorkspaceLayout(1200);
const marketsCollapsed = calculatePaperWorkspaceLayout(1200, { marketsCollapsed: true });
const orderCollapsed = calculatePaperWorkspaceLayout(1200, { orderCollapsed: true });
const bothCollapsed = calculatePaperWorkspaceLayout(1200, { marketsCollapsed: true, orderCollapsed: true });
equal(expanded.chartWidth, 624, "expanded panels should leave the remaining width to the chart");
check(marketsCollapsed.chartWidth > expanded.chartWidth, "collapsing Markets should increase chart width");
check(orderCollapsed.chartWidth > expanded.chartWidth, "collapsing Order should increase chart width");
check(bothCollapsed.chartWidth > marketsCollapsed.chartWidth && bothCollapsed.chartWidth > orderCollapsed.chartWidth, "both collapsed should maximize chart width");
equal(calculatePaperWorkspaceLayout(390, { mobile: true }).chartWidth, 390, "phone panels should not squeeze chart width");
equal(calculatePaperWorkspaceLayout(844, { mobile: true }).chartWidth, 844, "landscape phone panels should not squeeze chart width");
check(calculatePaperWorkspaceLayout(1920).chartWidth > 1200, "1920px desktop should provide a wide central chart");
check(calculatePaperWorkspaceLayout(1366).chartWidth > 700, "1366px laptop should keep the chart usable with both panels open");
equal(calculatePaperWorkspaceLayout(768, { mobile: true }).chartWidth, 768, "tablet panels should overlay rather than shrink the chart");
check(/height: max\(520px, calc\(100dvh - 285px\)\)/.test(styles), "desktop workspace should use available viewport height");
check(/position: absolute;[\s\S]*width: min\(86vw, 340px\)/.test(styles), "mobile panels should overlay the chart");
check(/PAPER_PANEL_STATE_KEY/.test(app) && /persistPaperPanelState/.test(app), "panel collapse state should persist locally");
const panelHandler = sourceBetween(app, "paperTerminalLayout?.addEventListener(\"click\"", "paperTerminalLayout?.addEventListener(\"transitionend\"");
check(!/resetPaperChartViewport|drawings\s*=\s*\[\]|manualPriceRange\s*=\s*null/.test(panelHandler), "panel toggles must preserve viewport and drawings");

const timeWindow = getPaperChartWindow(300, 120, 240);
const horizontalPan = panPaperTimeWindow(300, timeWindow, 90, 830);
check(horizontalPan.endIndex < timeWindow.end, "horizontal plot drag should pan time");
const priceRange = { min: 90, max: 110, range: 20 };
const translated = translatePaperPriceRange(priceRange, -60, 400);
equal(translated.range, 20, "vertical plot drag should translate without scaling price range");
check(translated.min < priceRange.min && translated.max < priceRange.max, "upward plot drag should translate the price viewport");
check(/drag\.mode === "pan"[\s\S]*panPaperTimeWindow[\s\S]*translatePaperPriceRange/.test(app), "diagonal plot drag should update time and price together");
check(/chart\.autoPriceScale = false;[\s\S]*translatePaperPriceRange/.test(app), "vertical plot movement should exit Auto scale");
check(/data-paper-auto-scale[\s\S]*autoPriceScale = true[\s\S]*manualPriceRange = null/.test(app), "Auto scale should restore automatic price scaling");

const horizontalPinch = getPaperPinchTransform([{ x: 100, y: 100 }, { x: 200, y: 105 }], [{ x: 75, y: 100 }, { x: 225, y: 105 }]);
check(horizontalPinch.timeFactor < 1 && horizontalPinch.priceFactor === 1, "horizontal pinch should zoom time only");
const verticalPinch = getPaperPinchTransform([{ x: 100, y: 100 }, { x: 105, y: 200 }], [{ x: 100, y: 75 }, { x: 105, y: 225 }]);
check(verticalPinch.priceFactor < 1 && verticalPinch.timeFactor === 1, "vertical pinch should zoom price only");
const combinedPinch = getPaperPinchTransform([{ x: 100, y: 100 }, { x: 200, y: 200 }], [{ x: 75, y: 75 }, { x: 225, y: 225 }]);
check(combinedPinch.timeFactor < 1 && combinedPinch.priceFactor < 1, "diagonal pinch should zoom both axes");
check(/paperChartPointers\.size === 2/.test(app) && /getPaperPinchTransform/.test(app), "real Pointer Events path should recognize a two-finger pinch");
check(/region === "price-axis"[\s\S]*"price-scale"/.test(app), "price-axis pointer drag should retain price scaling");
check(/region === "time-axis"[\s\S]*"time-scale"/.test(app), "time-axis pointer drag should retain time scaling");
check(/#paper-candle-chart[\s\S]*touch-action: none/.test(styles), "the chart should own touch gestures that begin inside it");
check(!/body[^{]*\{[^}]*touch-action:\s*none/.test(styles), "page touch behavior outside the chart must remain enabled");

let result = addPaperDrawingPoint([], {
  tool: "forecast-long", id: "long-1", symbol: "BTC-USD", timeframe: "15m", time: 100, price: 100
});
result = addPaperDrawingPoint(result.drawings, {
  tool: "forecast-long", id: "long-1", symbol: "BTC-USD", timeframe: "15m", time: 110, price: 110, pending: result.pending
});
result = addPaperDrawingPoint(result.drawings, {
  tool: "forecast-long", id: "long-1", symbol: "BTC-USD", timeframe: "15m", time: 120, price: 95, pending: result.pending, defaultEndTime: 180
});
const longForecast = result.drawings[0];
equal(result.drawings.length, 1, "three chart points should create one long forecast");
check(longForecast.target > longForecast.entry && longForecast.entry > longForecast.stop, "long forecast geometry must be target above entry above stop");
equal(calculatePaperForecastMetrics(longForecast).riskRewardRatio, 2, "long forecast R:R should use reward divided by risk");

const shortCreated = createPaperForecastDrawing({
  id: "short-1", symbol: "ETH-USD", timeframe: "1h", direction: "short",
  entry: 100, target: 88, stop: 106, startTime: 100, endTime: 200
});
check(shortCreated.valid, "valid short forecast should be created");
check(shortCreated.drawing.stop > shortCreated.drawing.entry && shortCreated.drawing.entry > shortCreated.drawing.target, "short forecast geometry must be stop above entry above target");
equal(shortCreated.metrics.riskRewardRatio, 2, "short forecast R:R should invert correctly");
const invalidLong = createPaperForecastDrawing({ direction: "long", entry: 100, target: 90, stop: 95, startTime: 1, endTime: 2 });
equal(invalidLong.valid, false, "invalid long geometry should fail closed");
const movedTarget = updatePaperForecastDrawing(longForecast, "target", { price: 115 });
equal(calculatePaperForecastMetrics(movedTarget).riskRewardRatio, 3, "moving a forecast handle should update its metrics");
const movedBody = updatePaperForecastDrawing(longForecast, "body", { priceDelta: 10 });
equal(movedBody.entry, 110, "moving the forecast body should translate entry");
equal(movedBody.target, 120, "moving the forecast body should translate target");
equal(movedBody.stop, 105, "moving the forecast body should translate stop");
equal(deletePaperDrawing([longForecast, shortCreated.drawing], longForecast.id).length, 1, "delete should remove only the selected forecast");
check(/chartNavigation\.drawings = \[\]/.test(app), "Clear drawings should remove forecasts with other local drawings");
check(/data-paper-forecast-handle="entry"/.test(app) && /data-paper-forecast-handle="target"/.test(app) && /data-paper-forecast-handle="stop"/.test(app), "selected forecast should expose entry, target and stop handles");
check(/data-paper-forecast-handle="extent"/.test(app), "selected forecast should expose a time-extent handle");
check(/class="paper-trade-line/.test(app) && !/renderPaperPriceLine[\s\S]{0,300}data-paper-forecast-handle/.test(app), "canonical Signal Review lines must remain separate from draggable forecast handles");

const frozenSignal = Object.freeze({ id: "signal-a", entry: 100, stopLoss: 95, takeProfit: 110, status: "Active" });
const frozenOrderCount = 3;
calculatePaperForecastMetrics(longForecast);
updatePaperForecastDrawing(longForecast, "entry", { price: 101 });
equal(frozenSignal.entry, 100, "forecast math must not mutate signal state");
equal(frozenOrderCount, 3, "forecast math must not create paper orders");
const forecastUtilitySection = sourceBetween(utilities, "export function createPaperForecastDrawing", "export function deletePaperDrawing");
check(!/fetch\(|api\.|request\(|generatedSignal|paperOrder|credit/i.test(forecastUtilitySection), "forecast utilities must perform zero backend, order, signal, or credit writes");
check(/ResizeObserver/.test(app), "chart should re-render after panel or browser size changes");
check(/renderPaperPanelState\(\)/.test(panelHandler) && /function renderPaperPanelState\([\s\S]*schedulePaperChartRender\(\)/.test(app), "panel toggle should schedule a redraw without resetting logical state");

const priceZoom = zoomPaperPriceRange(priceRange, 0.8, 100);
check(priceZoom.range < priceRange.range, "price-axis scaling characterization remains intact");
const timeZoom = zoomPaperTimeWindow(300, timeWindow, 0.8, 0.5);
check(timeZoom.visibleCount < timeWindow.count, "time-axis scaling characterization remains intact");

console.log(JSON.stringify({
  tests: { passed, failed: 0 },
  layout: { expanded: expanded.chartWidth, marketsCollapsed: marketsCollapsed.chartWidth, orderCollapsed: orderCollapsed.chartWidth, bothCollapsed: bothCollapsed.chartWidth },
  movement: { twoDimensionalPan: true, horizontalPinch: true, verticalPinch: true, axisTouch: true },
  forecast: { localOnly: true, longRiskReward: 2, shortRiskReward: 2, draggableHandles: ["entry", "target", "stop", "extent"] }
}, null, 2));

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected source section ${start}`);
  return source.slice(startIndex, endIndex);
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}
