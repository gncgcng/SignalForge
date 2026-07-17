# SignalForge chart-pattern audit

## Existing engine before this module

SignalForge already used objective pattern-like market structure, but did not expose classic formations through a dedicated detector. The existing signal engine recognizes breakout/retest events, momentum breakouts, range bounces, trend continuation, pullback bounces, support/resistance retests, VWAP reclaim/rejection, liquidity sweeps, BOS/CHoCH, fair-value gaps, and order blocks. These are strategy and structure events, not classic named chart-pattern recognition.

Existing indicators and context include EMA20/EMA50, RSI14, ATR14, volume MA20, ADX/regime data, swing support/resistance, VWAP, volume profile, SMC, multi-timeframe confluence, session/news context, and correlation checks.

## Support matrix

| Pattern | Before | After this change | Notes |
| --- | --- | --- | --- |
| Double top | Partially supported | Supported in shadow mode | Swing resistance existed; paired peaks and neckline are now named. |
| Double bottom | Partially supported | Supported in shadow mode | Swing support existed; paired troughs and neckline are now named. |
| Head and shoulders | Not supported | Supported in shadow mode | Uses confirmed swing pivots and neckline context. |
| Inverse head and shoulders | Not supported | Supported in shadow mode | Uses confirmed swing pivots and neckline context. |
| Cup and handle | Not supported | Not supported | Deferred because it needs a longer, cleaner history window. |
| Inverted cup and handle | Not supported | Not supported | Deferred for the same reason. |
| Bull flag | Partially supported | Supported in shadow mode | Momentum plus consolidation existed but was not named. |
| Bear flag | Partially supported | Supported in shadow mode | Momentum plus consolidation existed but was not named. |
| Bullish rectangle | Partially supported | Supported in shadow mode | Range structure existed; prior directional impulse is now retained. |
| Bearish rectangle | Partially supported | Supported in shadow mode | Range structure existed; prior directional impulse is now retained. |
| Bullish pennant | Partially supported | Partially supported | Symmetrical-triangle context is detected, but a pennant is not promoted as a distinct type yet. |
| Bearish pennant | Partially supported | Partially supported | Same as bullish pennant. |
| Rising wedge | Not supported | Not supported | Deferred until enough shadow data exists for robust slope validation. |
| Falling wedge | Not supported | Not supported | Deferred until enough shadow data exists for robust slope validation. |
| Ascending triangle | Partially supported | Supported in shadow mode | Breakout structure existed; converging boundaries are now named. |
| Descending triangle | Partially supported | Supported in shadow mode | Breakdown structure existed; converging boundaries are now named. |
| Symmetrical triangle | Not supported | Supported in shadow mode | Direction remains neutral until breakout validation. |
| Range / rectangle consolidation | Supported | Supported in shadow mode | Existing range regime remains authoritative; detector adds explanation. |
| Choppy range | Supported | Supported in shadow mode | Existing choppy regime remains authoritative; detector adds named context. |
| Failed breakout | Partially supported | Supported in shadow mode | Existing breakout checks now receive explicit failure context. |

## Safety boundary

Pattern confidence is separate from trade confidence. Detected patterns cannot create or promote a signal. Existing trend, volume, entry-readiness, risk/reward, stop/target, market-structure, stale-data, and publication validation checks remain mandatory. Pattern observations are stored in shadow mode; the live confidence modifier is `0` until at least 30 resolved outcomes exist for a pattern type, and is capped at plus or minus 2 points afterward.
