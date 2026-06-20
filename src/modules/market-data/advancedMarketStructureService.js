const profileBins = 24;
const valueAreaFraction = 0.7;

export function analyzeAdvancedMarketStructure(candles, { volumeAvailable = true } = {}) {
  const latest = candles.at(-1);
  if (!latest || candles.length < 10) return unavailableStructure("Not enough candles.");
  if (!volumeAvailable || !candles.some((candle) => Number(candle.volume) > 0)) {
    return unavailableStructure("Reliable volume is unavailable for this market.");
  }

  const vwap = calculateVwapContext(candles);
  const volumeProfile = calculateVolumeProfile(candles);

  return {
    available: true,
    vwap,
    volumeProfile,
    chartZones: {
      vwap: [
        { label: "Session VWAP", price: vwap.session.value },
        { label: "Anchored VWAP", price: vwap.anchored.value }
      ],
      profile: [
        { label: "VAH", price: volumeProfile.valueAreaHigh },
        { label: "POC", price: volumeProfile.poc },
        { label: "VAL", price: volumeProfile.valueAreaLow }
      ]
    }
  };
}

export function evaluateAdvancedStructure(structure, direction, latestPrice, regime = null) {
  if (!structure?.available) {
    return neutralEvaluation(structure?.reason || "Advanced market structure unavailable.");
  }

  const price = Number(latestPrice);
  const vwap = structure.vwap;
  const profile = structure.volumeProfile;
  const aboveBoth = price > vwap.session.value && price > vwap.anchored.value;
  const belowBoth = price < vwap.session.value && price < vwap.anchored.value;
  const meanReversionMode = regime?.label === "Range";
  const vwapAligned = meanReversionMode
    ? direction === "long" ? belowBoth : aboveBoth
    : direction === "long" ? aboveBoth : belowBoth;
  const vwapEventAligned = direction === "long"
    ? vwap.event === "Reclaim"
    : vwap.event === "Rejection";
  const profileAligned = direction === "long"
    ? price >= profile.poc || price <= profile.valueAreaLow
    : price <= profile.poc || price >= profile.valueAreaHigh;
  const inLowVolumeBreakoutZone = profile.lowVolumeNodes.some((node) => (
    price >= node.lower && price <= node.upper
  ));
  const factors = [
    factor("VWAP", vwapAligned || vwapEventAligned, vwap.explanation),
    factor(
      "Volume Profile",
      profileAligned || inLowVolumeBreakoutZone,
      profile.explanation
    )
  ];
  const passed = factors.filter((item) => item.passed).length;
  const conflicts = meanReversionMode
    ? (direction === "long" && aboveBoth) || (direction === "short" && belowBoth)
    : (direction === "long" && belowBoth) || (direction === "short" && aboveBoth);

  return {
    available: true,
    vwap,
    volumeProfile: profile,
    factors,
    vwapAligned: factors[0].passed,
    volumeProfileAligned: factors[1].passed,
    contextMode: meanReversionMode ? "Mean reversion" : "Trend",
    conflict: conflicts,
    confidenceAdjustment: conflicts ? -7 : passed * 3,
    qualityAdjustment: conflicts ? -5 : passed * 2,
    explanation: conflicts
      ? "VWAP structure conflicts with the setup direction, reducing confidence."
      : passed
        ? `${passed}/2 advanced structure confirmations align in ${meanReversionMode ? "mean-reversion" : "trend"} context.`
        : "VWAP and volume profile are neutral for this setup."
  };
}

function calculateVwapContext(candles) {
  const latest = candles.at(-1);
  const latestDay = utcDay(latest.time);
  const sessionCandles = candles.filter((candle) => utcDay(candle.time) === latestDay);
  const anchorIndex = findLatestConfirmedSwingIndex(candles);
  const anchoredCandles = candles.slice(anchorIndex);
  const sessionValue = weightedVwap(sessionCandles);
  const anchoredValue = weightedVwap(anchoredCandles);
  const previous = candles.at(-2);
  const priorSessionCandles = candles
    .filter((candle) => candle.time <= previous.time && utcDay(candle.time) === utcDay(previous.time));
  const priorVwap = weightedVwap(priorSessionCandles);
  const event = previous.close <= priorVwap && latest.close > sessionValue
    ? "Reclaim"
    : previous.close >= priorVwap && latest.close < sessionValue
      ? "Rejection"
      : "None";

  return {
    session: {
      value: round(sessionValue),
      anchorTime: sessionCandles[0]?.time || latest.time
    },
    anchored: {
      value: round(anchoredValue),
      anchorTime: candles[anchorIndex]?.time || candles[0].time,
      anchorType: "Confirmed swing"
    },
    event,
    explanation: `Price is ${latest.close >= sessionValue ? "above" : "below"} session VWAP and ${latest.close >= anchoredValue ? "above" : "below"} anchored VWAP${event === "None" ? "." : ` with a confirmed VWAP ${event.toLowerCase()}.`}`
  };
}

function calculateVolumeProfile(candles) {
  const recent = candles.slice(-120);
  const low = Math.min(...recent.map((candle) => candle.low));
  const high = Math.max(...recent.map((candle) => candle.high));
  const binSize = Math.max((high - low) / profileBins, Number.EPSILON);
  const bins = Array.from({ length: profileBins }, (_, index) => ({
    index,
    lower: low + index * binSize,
    upper: low + (index + 1) * binSize,
    volume: 0
  }));

  for (const candle of recent) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const index = Math.min(profileBins - 1, Math.max(0, Math.floor((typicalPrice - low) / binSize)));
    bins[index].volume += Number(candle.volume || 0);
  }

  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  const pocBin = [...bins].sort((a, b) => b.volume - a.volume)[0];
  const selected = new Set([pocBin.index]);
  let selectedVolume = pocBin.volume;
  let left = pocBin.index - 1;
  let right = pocBin.index + 1;

  while (selectedVolume < totalVolume * valueAreaFraction && (left >= 0 || right < bins.length)) {
    const leftVolume = left >= 0 ? bins[left].volume : -1;
    const rightVolume = right < bins.length ? bins[right].volume : -1;
    const next = rightVolume > leftVolume ? right++ : left--;
    selected.add(next);
    selectedVolume += bins[next].volume;
  }

  const selectedBins = bins.filter((bin) => selected.has(bin.index));
  const averageVolume = totalVolume / bins.length;
  const highVolumeNodes = bins
    .filter((bin) => bin.volume >= averageVolume * 1.35)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 4)
    .map(serializeNode);
  const lowVolumeNodes = bins
    .filter((bin) => bin.volume <= averageVolume * 0.55)
    .slice(0, 6)
    .map(serializeNode);

  return {
    poc: round((pocBin.lower + pocBin.upper) / 2),
    valueAreaHigh: round(Math.max(...selectedBins.map((bin) => bin.upper))),
    valueAreaLow: round(Math.min(...selectedBins.map((bin) => bin.lower))),
    highVolumeNodes,
    lowVolumeNodes,
    explanation: `POC is ${formatPrice((pocBin.lower + pocBin.upper) / 2)} with a 70% value area from ${formatPrice(Math.min(...selectedBins.map((bin) => bin.lower)))} to ${formatPrice(Math.max(...selectedBins.map((bin) => bin.upper)))}.`
  };
}

function weightedVwap(candles) {
  const totals = candles.reduce((result, candle) => {
    const volume = Number(candle.volume || 0);
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    result.priceVolume += typicalPrice * volume;
    result.volume += volume;
    return result;
  }, { priceVolume: 0, volume: 0 });
  return totals.volume ? totals.priceVolume / totals.volume : candles.at(-1)?.close || 0;
}

function findLatestConfirmedSwingIndex(candles) {
  for (let index = candles.length - 3; index >= 2; index -= 1) {
    const candle = candles[index];
    const neighbors = [
      candles[index - 2], candles[index - 1], candles[index + 1], candles[index + 2]
    ];
    if (
      neighbors.every((item) => candle.high > item.high) ||
      neighbors.every((item) => candle.low < item.low)
    ) return index;
  }
  return Math.max(0, candles.length - 60);
}

function serializeNode(bin) {
  return {
    lower: round(bin.lower),
    upper: round(bin.upper),
    midpoint: round((bin.lower + bin.upper) / 2),
    volume: round(bin.volume)
  };
}

function unavailableStructure(reason) {
  return {
    available: false,
    reason,
    vwap: null,
    volumeProfile: null,
    chartZones: { vwap: [], profile: [] }
  };
}

function neutralEvaluation(reason) {
  return {
    available: false,
    vwap: null,
    volumeProfile: null,
    factors: [
      factor("VWAP", false, reason),
      factor("Volume Profile", false, reason)
    ],
    vwapAligned: false,
    volumeProfileAligned: false,
    conflict: false,
    confidenceAdjustment: 0,
    qualityAdjustment: 0,
    explanation: reason
  };
}

function factor(name, passed, detail) {
  return { name, passed, detail };
}

function utcDay(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 10);
}

function round(value) {
  return Number(Number(value).toFixed(4));
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}
