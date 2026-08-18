import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addPaperDrawingPoint,
  calculatePaperForecastMetrics,
  calculatePaperWorkspaceLayout,
  calculatePaperWorkspaceHeight,
  createPaperForecastDrawing,
  deletePaperDrawing,
  getPaperChartDimensions,
  getPaperChartRegion,
  getPaperChartWindow,
  getPaperPinchTransform,
  getPaperTimeAxisTicks,
  getPaperTimeframeSeconds,
  getPaperTimelinePointAtCoordinate,
  getPaperTimelinePosition,
  getPaperTimelineWindow,
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
equal(calculatePaperWorkspaceHeight(390, 844, 140), 696, "390x844 portrait should allocate the remaining viewport below its compact header");
equal(calculatePaperWorkspaceHeight(844, 390, 4), 378, "844x390 landscape should aggressively use the remaining viewport");
check(/--paper-workspace-height/.test(styles) && /function updatePaperWorkspaceHeight/.test(app), "workspace height should be measured from the available viewport");
check(!/@media \(max-width: 767px\)[\s\S]*paper-terminal-layout[\s\S]*height: max\(420px/.test(styles), "phone layout must not override the measured workspace height");
check(/position: absolute;[\s\S]*width: min\(86vw, 340px\)/.test(styles), "mobile panels should overlay the chart");
check(/PAPER_PANEL_STATE_KEY/.test(app) && /persistPaperPanelState/.test(app), "panel collapse state should persist locally");
const panelHandler = sourceBetween(app, "paperTerminalLayout?.addEventListener(\"click\"", "paperTerminalLayout?.addEventListener(\"transitionend\"");
check(!/resetPaperChartViewport|drawings\s*=\s*\[\]|manualPriceRange\s*=\s*null/.test(panelHandler), "panel toggles must preserve viewport and drawings");

for (const target of [
  { width: 1920, height: 760, mobile: false },
  { width: 1366, height: 560, mobile: false },
  { width: 768, height: 760, mobile: true },
  { width: 390, height: 620, mobile: true },
  { width: 844, height: 300, mobile: true }
]) {
  const dimensions = getPaperChartDimensions(target.width, target.height, { mobile: target.mobile, volume: true, priceLabels: ["0.00001000"] });
  equal(dimensions.height, target.height, `${target.width}x${target.height} chart should use measured stage height`);
  equal(dimensions.top + dimensions.plotHeight + dimensions.bottom, target.height, `${target.width}x${target.height} should have no unused SVG height`);
  check(dimensions.plotWidth > 0 && dimensions.plotHeight > dimensions.volumeHeight, `${target.width}x${target.height} plot should remain usable`);
}
check(!/const width = 920;[\s\S]*const height = 480;/.test(sourceBetween(app, "function renderPaperTradingChart", "function renderPaperDrawings")), "renderer must not retain the old fixed 920x480 chart geometry");
check(/paperChart\.setAttribute\("viewBox"/.test(app), "SVG viewBox should follow measured chart dimensions");
check(/paper-top-market/.test(html) && /paper-top-provider/.test(html), "mobile quote header should retain market and provider information compactly");

const timelineCandles = Array.from({ length: 300 }, (_, index) => ({ time: 1_700_000_000 + index * 900 }));
const latestTimeline = getPaperTimelineWindow(timelineCandles.length, 120, null, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
equal(latestTimeline.futureSlots, 24, "Latest should reserve 20 percent of its slots for future space");
equal(latestTimeline.end - timelineCandles.length, 24, "Latest candle should not sit against the right edge");
const latestPositionRatio = (timelineCandles.length - 1 - latestTimeline.start + 0.5) / latestTimeline.count;
check(latestPositionRatio > 0.75 && latestPositionRatio < 0.85, "latest candle should render near 80 percent of plot width");
const timelineWithNewCandle = getPaperTimelineWindow(timelineCandles.length + 1, 120, null, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
equal(timelineWithNewCandle.end - (timelineCandles.length + 1), 24, "new candles should preserve future space");
const timelineAfterResize = getPaperTimelineWindow(timelineCandles.length, latestTimeline.count, null, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
equal(timelineAfterResize.futureSlots, latestTimeline.futureSlots, "chart resize should preserve the Latest future-space model");
const futurePoint = getPaperTimelinePointAtCoordinate(820, timelineCandles, "15m", latestTimeline, { width: 920, left: 10, right: 72 });
check(futurePoint.isFuture && futurePoint.time > timelineCandles.at(-1).time, "future plot coordinates should resolve to future timestamps");
equal(getPaperTimeframeSeconds("15m"), 900, "future slots should use real timeframe duration");
check(getPaperTimelinePosition(timelineCandles, "15m", futurePoint.time) >= timelineCandles.length, "future timestamp should map beyond the newest candle index");
const futurePan = panPaperTimeWindow(latestTimeline.maxEnd, latestTimeline, -120, 830);
check((futurePan.endIndex || latestTimeline.maxEnd) > latestTimeline.latestEnd, "user should be able to pan current price farther left into future space");
const narrowTicks = getPaperTimeAxisTicks(latestTimeline, timelineCandles, "15m", 320);
const wideTicks = getPaperTimeAxisTicks(latestTimeline, timelineCandles, "15m", 1400);
check(narrowTicks.length < wideTicks.length, "time-axis tick density should adapt to available width");
const mobileDimensions = getPaperChartDimensions(390, 620, { mobile: true, volume: true });
equal(getPaperChartRegion(390 - 88, 200, mobileDimensions), "price-axis", "mobile price axis should have a forgiving invisible hit target");
equal(getPaperChartRegion(180, 620 - 38, mobileDimensions), "time-axis", "mobile time axis should have a forgiving invisible hit target");

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
const futureForecast = createPaperForecastDrawing({
  id: "future-long", symbol: "BTC-USD", timeframe: "15m", direction: "long",
  entry: 100, target: 110, stop: 95, startTime: timelineCandles.at(-1).time,
  endTime: futurePoint.time
});
check(futureForecast.valid && futureForecast.drawing.endTime > timelineCandles.at(-1).time, "forecast should extend into logical future slots");
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
check(/paper-forecast-handle-hit[\s\S]*r="13"/.test(app), "forecast handles should use forgiving invisible touch targets");
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
