# Pivot inventory: "trading signals" → "know the odds"

Read-only audit for moving to a single $15/month plan with a 7-day, card-required Stripe trial.
No code, config, Stripe or database state was changed.

- **Audited code:** `feature/commodities-infrastructure` @ `13aea56` (this branch was cut from it). Line numbers refer to that commit.
- **Audit date:** 2026-10-11.
- **Production checks (all read-only):** `railway status`, non-secret Railway variables, Stripe `GET` on webhook endpoints and prices, public `GET /api/debug/ping`, and one aggregate SQL query run in a `READ ONLY` transaction.

---

## TL;DR: what drives the pivot

1. **No real customers have paid yet.** Production has 6 non-deleted users and 0 live-mode payers. The 3 "active" Pro/Elite subscriptions are all Stripe **test-mode** leftovers, and the production key is now **live** (see [Paid-user count](#paid-user-count)). Grandfathering and migration risk is close to zero.
2. **The odds aren't good yet, and the product says the opposite.** The only multi-period historical replay covers 99 signals: **28.4% win rate, −0.028R expectancy** (`SignalForgeData/cross-period-signal-stability-audit.json`). Meanwhile the landing hero, the og:description and the in-app header say "High-Probability Setups", and confidence bands say "Elite", "Excellent" and "Rare near-perfect".
3. **Stripe needs real work for trials.** Checkout never sets `subscription_data[trial_period_days]` or `payment_method_collection`. The webhook hard-codes `status: "active"` on checkout. The local DB defaults every free user's subscription row to `'trialing'`. Nothing handles `customer.subscription.trial_will_end`. A $0 trial invoice would grant credits, send a "subscription confirmed" email and run affiliate commission code.
4. **Admin and analytics MRR is wrong.** It hard-codes $29 and $99, but live prices are $9.99 and $19.99.
5. **Promo discount codes can't be used.** Production sets `STRIPE_ALLOW_PROMOTION_CODES=false`, yet the Billing page tells users discount codes are entered at checkout.
6. **Password reset doesn't revoke sessions.** It leaves every existing session and 180-day restore token alive. Admin temp password does revoke both.
7. **The webhook URL is fine.** Stripe posts to `https://signalforge-app.com/api/stripe/webhook`, which is served and exempt from the host redirect. The code comment saying it's "registered against the old host" is stale. Stripe also isn't subscribed to `charge.refunded`, so affiliate refund reconciliation never runs.

---

## 1. User-facing claims about accuracy, win rate, profit or "high-probability"

### 1a. Claims to remove or rewrite (positive or implied-performance)

| Where | Line | Text / behaviour |
|---|---|---|
| `public/index.html` (og:description) | 14 | "scan crypto markets for **high-probability setups**" |
| `public/index.html` (twitter:description) | 19 | "Scan crypto markets for **better trading setups**" |
| `public/index.html` (landing hero h1) | 157 | "Stop Searching Charts. Start Finding **High-Probability Setups**." |
| `public/index.html` (hero sub) | 158–159 | "…so you can focus on **better trading decisions**", "surface **cleaner** crypto trading signals" |
| `public/index.html` (hero mock card) | 191, 197, 203 | "BTCUSD **LONG**", "Confidence **89%**", "Reward/Risk **2.4R**" (fabricated example) |
| `public/index.html` (steps) | 226–227 | "**Unlock the Best Setup**… only when a signal **earns attention**" |
| `public/index.html` (comparison) | 251 | "Finding confluence manually → **AI-assisted analysis**". README:91 says real AI is "intentionally not implemented". |
| `public/index.html` (features) | 279 | "ranks **qualifying opportunities**" |
| `public/index.html` (live preview demo) | 306–309 | "**Signal Found**", BTCUSD LONG, **89%** |
| `public/index.html` (pricing) | 337 | "Upgrade when you need more **signal capacity**" |
| `public/index.html` (final CTA) | 441 | "Ready to Find **Better Trading Setups**?" |
| `public/index.html` (in-app topbar h2) | 733 | "**High-probability setup lab**" |
| `public/app.js` (view titles) | 5683 | `scanner: ["Market scanner", "High-probability setup lab"]` |
| `public/app.js` (scan summary) | 8331 | "No **high-probability setups** right now. Trial credits were not used." |
| `public/app.js` (scan summary) | 8337 | "Found N **high-probability setup(s)**. Unlocking one will use a trial credit." |
| `public/app.js` `getConfidenceBand` | 11602–11608 | Bands: ≥95 "**Elite**", ≥90 "**Excellent**", ≥80 "**Strong**", else "Good" |
| `src/modules/notifications/notificationService.js` `getConfidenceTier` | 302–308 | Telegram tiers: ≥98 "**Rare near-perfect**", ≥90 "Excellent", ≥80 "Strong", ≥70 "Decent" |
| `src/modules/notifications/notificationService.js` `formatTelegramSignalMessage` | 209, 215 | "🚨 SignalForge **Setup Ready**", "Confidence: N% (tier)" |
| `public/app.js` (quality label) | 9099 | `qualityScore >= 90 ? "Excellent"` |
| `src/modules/analyst/signalAnalystService.js` | 158–161, 180 | "…volatility context is **tradable**", "Overall setup quality: …" in the server-generated `reasoning` summary |
| `public/manifest.json` | 5 | "Crypto trading signal scanner with … performance tracking" |
| `public/index.html` (JSON-LD SoftwareApplication) | 38 | "crypto trading signal scanner and trading setup assistant" |

### 1b. Win-rate / performance displays (user-facing numbers)

These are honest calculations, but they're framed as personal "performance" and published publicly through the leaderboard and profiles.

| Where | Line | What |
|---|---|---|
| `public/index.html` dashboard stat | 1130 | "Win rate" (`#stat-win-rate`, filled at `public/app.js:6437`) |
| `public/index.html` Performance page | 1485, 1537, 1551 | "Track … win rate", primary "Win rate", "Cumulative R and win rate over time" (`public/app.js:7496–7519`, tables 7595–7876) |
| `public/index.html` Backtesting lab | 1444–1445, 1463–1467 | "Win rate", "Profit factor", win rate by market/timeframe/regime/confluence/SMC |
| `public/index.html` Leaderboard | 1773, 1789 | "**Best Win Rate**" tab. Disclaimer: "Past performance does not guarantee future results." |
| `public/index.html` Public profile | 1823 | "Win rate" (`#profile-win-rate`) |
| `public/app.js` Paper trading | 6585 | Paper account win rate |
| `public/index.html` landing | 382–386 | Hidden `#performance-preview`: "Real product statistics will appear here when available." This is the natural slot for the new odds content. |
| Admin only (`public/app.js` 4556–4848; `public/index.html` 2163–2175) | — | Admin performance / calibration win-rate views. Not user-facing. |

### 1c. Existing disclaimers (keep and reuse)

- `public/index.html:78, 83, 98, 410, 414, 426`: FAQ: not financial advice; "Signals do not guarantee profit."
- `public/index.html:170, 172, 447, 453–455`: "Educational Tool Only. Not Financial Advice."; "past or simulated performance does not predict future results".
- `public/index.html:948`, `public/app.js:8461, 8933, 8984`: "Confidence reflects rule alignment, not the probability of profit", "…not a guaranteed win rate."
- `public/app.js:551–552` (Risk Disclaimer doc): confidence "describe rule alignment, not a probability of profit". **This directly contradicts a "know the odds" positioning, so the new copy has to reconcile it.**
- `public/app.js:4053`: "Does not guarantee profit or provide financial advice."
- Emails: every template appends "Educational tool only. Not financial advice." (`src/modules/notifications/transactionalEmailService.js:180`).
- Telegram: `notificationService.js:36, 96, 224`.

### 1d. Emails

No accuracy, win-rate or profit claims in any template (`src/modules/notifications/transactionalEmailService.js:60–171`, `src/modules/auth/emailVerificationService.js:38–47`). These need pivot wording changes:

- Verification: "Verify your email to **activate your free SignalForge unlocks**." (`emailVerificationService.js:42`).
- Welcome: "scan markets, **unlock setups**, and track outcomes" (`transactionalEmailService.js:67`).
- Subscription confirmation: "Your plan **credits** will appear in Billing" (`transactionalEmailService.js:100`). It's also sent on **every** paid invoice, renewals included (`stripeService.js:449`).

---

## 2. Free unlocks / per-signal unlock mechanic

### 2a. Tables

| Table | Migration | Role |
|---|---|---|
| `credit_balances` | `migrations/001_initial_schema.sql:31–37`, `013_stripe_billing.sql:7–9` | `free_signal_allowance` (default 3), `trial_signals_used`, `paid_credits`, **`unlock_credits_balance`** (the live balance), `lifetime_unlocks_used` |
| `users.trial_signals_used`, `users.trial_used` | `001:8`, `012_anti_abuse_protection.sql:3` | Free-tier usage flags |
| `unlocked_signals` | `001:58–64` | One row per unlocked saved signal (`unlocked_with` default `'trial_credit'`) |
| `saved_signals` (+`setup_key`) | `001:39–56`, `022` | The user's unlocked copy with entry/SL/TP |
| `signal_credit_transactions` | `055_signal_credit_refunds.sql` | Ledger: `unlock_charge` (−1) and `terminal_refund` (+1) |
| `billing_credit_grants` | `013:44–51` | Idempotent grants: `credit_pack`, `promo_code` |
| `billing_entitlement_grants` | `015_stripe_webhook_processing.sql:13–21` | Per-period Pro/Elite grant (`scan_credits`, `unlock_credits`) |
| `setup_discovery_usage` | `013:27–33` | Metered "setup discoveries" (scan results) |
| `scan_result_cache` | `013:35–42` | Caches scans so re-viewing doesn't re-meter |
| `promo_codes`, `promo_code_redemptions` | `057_promo_codes.sql` | `stripe_discount` or `credit_grant` codes |
| `device_trial_history` | `012:36–43` | One free-unlock trial per hashed device fingerprint |
| `signup_attempts` | `012:25–34` | IP-hash velocity for anti-abuse |

### 2b. Server logic

- Plan constants: `src/modules/subscriptions/subscriptionService.js:8–33` (`BILLING_PLANS`: free 10 discoveries/day + 3 lifetime unlocks; pro 300/mo + 100 unlocks; elite 1000/mo + 500 unlocks), `:35–39` (`CREDIT_PACKS` 10/50/100). `appConfig.freeSignalAllowance = 3` at `src/config/appConfig.js:80`.
- Balance and summary: `subscriptionService.js:60–122` (`getSubscriptionSummary`), `:181–190` (`getUnlockBalance`).
- Gates: `canGenerateSignal` `:124–128`, `canDiscoverSetups` `:130–135`, `recordDiscoveryUsage` `:137–160`.
- Unlock entry points: `src/modules/signals/signalService.js:72` (`createSignal`), `:167` (`unlockPreviouslyDiscoveredSetup`), `:286` (`unlockTelegramSignal`). Each does a client-side decrement mirror at `:152–157`, `:213–218`, `:367–372`.
- Atomic debit: `src/db/repositories.js:1824` (`saveUnlockedSignal`). Email-verified check `:1857` (403), balance check `:1864` (402 `UNLOCK_LIMIT`), ledger charge via `src/modules/credits/signalCreditLedgerRepository.js:3–39`, then it marks `trial_used` and `device_trial_history.trial_used`.
- **Credit refund on loss or expiry:** `signalCreditLedgerRepository.js:1, 41–80` refunds the unlock credit when a signal ends **Hit SL** or **Expired**. Called from the outcome tracker at `repositories.js:2189, 2234`. Users effectively pay only for TP hits. This is a pricing design choice to unwind.
- Locked preview shape: `signalService.js:1467–1501` (`toScanPreview`, `locked: true`). It strips entry/SL/TP but keeps direction, setup type, confidence, RR, quality, reasoning and confirmations.
- Scan-all metering: `signalService.js:794–815`. Results are truncated to the remaining discoveries (`limitedByCredits`).
- Discovery gate error: `signalService.js:1541–1551` (402 `DISCOVERY_LIMIT` / `EMAIL_VERIFICATION_REQUIRED`).

### 2c. Endpoints

| Method / path | File:line | Purpose |
|---|---|---|
| `POST /api/signals/scan` | `src/modules/signals/signalController.js:51` | Single scan (meters discoveries) |
| `POST /api/signals/scan-all`, `/scan-all/start\|status\|resume\|cancel` | `signalController.js:62–132` | Scan all (meters discoveries) |
| `POST /api/signals/generate` | `signalController.js:134` | **Unlock** (with `setupKey`) or scan+unlock |
| `POST /api/signals/telegram-unlock` | `signalController.js:146` | Unlock from a Telegram deep link |
| `GET /api/signals` | `signalController.js:30` | User's unlocked signals |
| `GET /api/subscriptions/me` | `src/modules/subscriptions/subscriptionController.js:77` | Plan, credits, plans/packs list |
| `POST /api/promo-codes/redeem` | `src/modules/promo-codes/promoCodeController.js:12` | Redeem a `credit_grant` code |
| `GET/POST /api/admin/promo-codes`, `/:id`, `/:id/redemptions` | `promoCodeController.js:23–60` | Admin promo management |

### 2d. Promo codes

- Service: `src/modules/promo-codes/promoCodeService.js:25–101` (create), `:125` (redeem). Repository: `promoCodeRepository.js:83` (`redeemCreditGrantCode` → `grantUnlockCredits(..., "promo_code")` at `:131`). Stripe discount mirror at `:144`.
- Stripe-side coupon and promotion code creation: `src/modules/subscriptions/stripeService.js:109–144`. The API version is pinned to `2025-09-30.clover` for these calls only. Coupons are `duration: "once"`.
- **Production `STRIPE_ALLOW_PROMOTION_CODES=false`**, so checkout omits `allow_promotion_codes` (`stripeService.js:73`, `appConfig.js:228`). `stripe_discount` codes can't be entered, yet the Billing page says "Discount codes are entered at checkout instead" (`public/index.html:2330`).

### 2e. Trial guard (current "3 free unlocks")

- Device fingerprint (client): `public/app.js:11002–11011`, `public/auth-bootstrap.js:176–189`. UA, language, platform, timezone, screen size and colour depth, sent as the `x-device-fingerprint` header (`app.js:598`).
- Hashing: `src/modules/auth/abuseProtectionService.js:21–29` (HMAC with `ABUSE_HASH_SECRET`, falling back to `DATABASE_URL`; `appConfig.js:105`).
- Grant on email verify: `repositories.js:1194–1252` (`verifyEmailToken`). It reserves `device_trial_history`. On conflict it grants no credits and sets `abuse_score += 50`, flag `repeated_trial_device`, `abuse_review_status='flagged'`.
- Grant on Google OAuth: `repositories.js:1411–1450` (`grantOAuthFreeTrial`). Same logic.
- Consumption: `repositories.js:1049–1070` (legacy `incrementTrialSignalsUsed`) and inside `saveUnlockedSignal`.
- Kept after account deletion: `src/modules/account-deletion/accountDeletionRepository.js:43–45`, so a repeat device is still recognised.
- **For a card-required Stripe trial**, this guard becomes mostly redundant. Stripe trial abuse is better limited per customer, card fingerprint and email. Nothing in code does that yet.

### 2f. UI

| Where | Line | What |
|---|---|---|
| `public/index.html` hero CTA | 161–164, 169 | "Start Free · **3 Free Signal Unlocks**", "**No Credit Card Required**" |
| `public/index.html` pricing | 346–377 | Free: "3 free unlocks after email verification", "10 setup discoveries per day". Pro $9.99: 300 discoveries, **100 monthly unlock credits**. Elite $19.99: 1,000 discoveries, **500 monthly unlock credits** |
| `public/index.html` final CTA | 442 | "unlock your first three signals today" |
| `public/index.html` sidebar | 719–724 | "Plan capacity", `#trial-count` "3 signals left", **Upgrade** |
| `public/index.html` scanner | 804 | "**Unlock Current**" button |
| `public/index.html` Billing | 2318–2356 | Current plan / discoveries / unlock credits; **promo redeem form** (2332); plan grid; "**Unlock credit packs** – Purchased unlocks do not expire" |
| `public/app.js` scan card | 8367–8403 | Locked card with "**Unlock Signal**" (8395) |
| `public/app.js` alerts | 9381 | "**Unlock Full Signal**" |
| `public/app.js` Telegram deep link | 3801–3854 | `?telegramUnlock=<setupKey>` |
| `public/app.js` unlock reveal | 11496–11548 | "Signal Unlocked" modal |
| `public/app.js` unlock toast | 11321–11324 | "One unlock credit deducted." |
| `public/app.js` billing render | 6136–6190 | "3 lifetime unlocks", "Unused unlocks roll over", "Buy credits" |
| `public/app.js` How-it-works | 4084–4089 | "Unlocks and credits – Pay only for eligible full signal details." |
| `public/app.js` promo redeem | 1516–1522 | "Code redeemed: N unlock credits added." |
| `public/app.js` onboarding | 11176–11180 | "Unlock first signal" checklist step |
| Telegram | `notificationService.js:222, 236` | "Preview only. Unlock to view full levels." + "**Unlock Signal**" button |

---

## 3. Current Stripe setup

### 3a. Products and prices

Code only knows env price IDs (`src/config/appConfig.js:50–58, 229–242`). Live values were read from Stripe:

| Key | Env var | Live price | Product |
|---|---|---|---|
| `pro` | `STRIPE_PRO_PRICE_ID` | **$9.99 / month**, recurring, no `trial_period_days` | "Plan Pro" |
| `elite` | `STRIPE_ELITE_PRICE_ID` | **$19.99 / month**, recurring, no trial | "Plan Elite" |
| `pack10` | `STRIPE_CREDITS_10_PRICE_ID` | $2.99 one-time | "10 Unlocks" |
| `pack50` | `STRIPE_CREDITS_50_PRICE_ID` | $9.99 one-time | "50 Unlocks" |
| `pack100` | `STRIPE_CREDITS_100_PRICE_ID` | $17.99 one-time | "100 Unlocks" |

- Production Stripe key mode: **live**. All seven Stripe env vars are present.
- Landing and JSON-LD prices match ($9.99/$19.99: `public/index.html:44–64, 358, 369`).
- **Mismatches:** `stripeService.js:560–564` (`planMonthlyAmountCents`: 2900/9900) and `src/db/repositories.js:376–381, 497–501, 655–656` (admin MRR / active subscriptions: 2900/9900).
- `planFromPrice` (`stripeService.js:554–558`) maps exactly two price IDs. Any other price, such as a new $15 price, resolves to `free`. `processInvoicePaymentSucceeded` would then throw "Unknown subscription price" (`:400–405`), so Stripe retries indefinitely.

### 3b. Checkout flow

1. Billing page → `startCheckout` (`public/app.js:6242`) → `POST /api/subscriptions/checkout` (`subscriptionController.js:80–85`).
2. `createCheckout` (`stripeService.js:33–96`):
   - Asserts the secret key and `APP_URL`, then ensures a Stripe customer (`:251–284`; a new customer is created if the stored customer's mode differs from the key mode).
   - If the user already has a same-mode subscription, it returns a **Customer Portal** session instead (`:43–52`).
   - Creates a Checkout Session (`:66–83`): `mode` `subscription` or `payment`, one line item, success `#billing?checkout=success`, cancel `#billing?checkout=cancelled` (`appConfig.js:225–226`), metadata `user_id/kind/plan/pack`, and `subscription_data[metadata]`.
   - **No** `subscription_data[trial_period_days]`, `payment_method_collection`, `trial_settings[end_behavior]` or `customer_update`.
3. Return page polls `/api/subscriptions/me` for up to 40s (`public/app.js:6192–6240`).
4. Customer Portal: `POST /api/subscriptions/portal` (`subscriptionController.js:86–90`, `stripeService.js:98–107`), return URL `#billing`. Portal cancellation and plan-change behaviour is configured in the Stripe dashboard. It wasn't inspected.

### 3c. Webhook

- **Paths:** `POST /api/stripe/webhook` and `POST /api/subscriptions/webhook` (`subscriptionController.js:14–41`). The signature is checked manually with HMAC and a 300s tolerance (`stripeService.js:146–174`). Events are idempotent through `stripe_webhook_events` (`:182–193`). Admins can view and retry them (`subscriptionController.js:43–67`).
- **Registered in Stripe (live):** one endpoint, `https://signalforge-app.com/api/stripe/webhook`, enabled, API version `2024-09-30.acacia`. Events:
  `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.created|updated|deleted`.
- **Handled in code** (`stripeService.js:197–214`):

| Event | Handler | Effect |
|---|---|---|
| `checkout.session.completed` | `:294–378` | Credit pack: grant credits. Subscription: `updateStripeSubscription(status **"active"** hard-coded, plan)` (`:329–340`), affiliate activation, analytics, then re-fetches the subscription and syncs. |
| `invoice.payment_succeeded` / `invoice.paid` | `:380–462` | Sets plan and period, **grants per-period unlock and scan entitlements**, records affiliate commission, sends the "subscription confirmed" email. ⚠ `invoice.paid` isn't subscribed in Stripe. |
| `invoice.payment_failed` | `:464–475` | Sends the failed-payment email only. No plan change. |
| `customer.subscription.created/updated/deleted` | `:477–528` | `active = status ∈ {active, trialing, past_due}`, otherwise plan → `free`. A deleted subscription sets `status='canceled'` and deactivates the affiliate referral. |
| `charge.refunded` | `:547–552` | Affiliate refund reconciliation. ⚠ **Not subscribed in Stripe, so this never fires.** |
| anything else | — | Stored as `ignored` |

- **Not handled:** `customer.subscription.trial_will_end`, `invoice.upcoming`, `customer.subscription.paused/resumed`, `payment_method.*`, `charge.dispute.*`.

### 3d. How plan status gates features

- `users.plan` (`free|pro|elite`, plus legacy `trial` normalised to `free` at `subscriptionService.js:55–58`) is written only by `updateStripeSubscription` (`repositories.js:1565–1608`).
- The only enforced effect of the plan is **quantity**: discovery limit and period (`subscriptionService.js:60–122, 130–160`) and the unlock-credit grant per paid invoice (`stripeService.js:427–433`). `subscriptions.status` isn't consulted by any gate.
- `past_due` keeps the paid plan (`stripeService.js:503`). `unpaid` or `incomplete` drops it to `free`.
- Testers (`users.role='tester'`) bypass everything (`subscriptionService.js:124–135`, `repositories.js:1507, 1856–1868`).
- **Trial-semantics collision:** every free user's `subscriptions.status` defaults to **`'trialing'`** (`migrations/001_initial_schema.sql:23`, `repositories.js:133`, `subscriptionService.js:43`). Admin MRR queries treat `trialing` like `active` (`repositories.js:375, 380, 500, 656`), filtered only by `plan IN ('pro','elite')`.
- **Trial-invoice side effects (if a trial is added unchanged):** the $0 trial invoice fires `invoice.payment_succeeded`. That grants full-period credits, sends the "subscription confirmed" email and calls `recordRecurringAffiliateCommission` with `amount_paid = 0` (`stripeService.js:409–455`).
- Customer-mode handling: `ensureStripeCustomer` / `shouldReuseStripeCustomer` (`stripeService.js:251–292`). A test-mode customer is replaced on the next live checkout. This applies to the 3 test-mode subscribers below.

---

## 4. Features gated by plan or unlock, and what free users see today

**Server-side gates (complete list):**

| Gate | Where | Free user | Pro / Elite |
|---|---|---|---|
| Email verification for discoveries and unlocks | `subscriptionService.js:124–135`; `repositories.js:1856–1861` | Required | Required |
| Setup discoveries (scan results) | `signalService.js:1541–1551, 794–815`; `repositories.js:1490` | **10 / UTC day** | 300 / 1,000 per billing period |
| Unlock credits (entry/SL/TP reveal) | `repositories.js:1863–1868` | **3 lifetime** (after verify, once per device) | 100 / 500 per paid invoice, roll over; packs never expire |
| Admin-only endpoints | various `isAdminUser` checks | — | — |

**Nothing else is plan-gated, on the server or in the client.** Telegram alerts, the backtesting lab, the performance dashboard, paper trading, journal, watchlist/alerts, leaderboard and profiles, the daily market brief and the setup-candidate ("watching") list all work for free users. The landing page still sells "Telegram alerts" and "Performance tracking" as Pro features and "Backtesting lab" and "Advanced analytics" as Elite features (`public/index.html:363–364, 374–375`). That's a pre-existing claim/behaviour mismatch.

**What a free user sees today:**

- Landing: "3 Free Signal Unlocks", "No Credit Card Required" (`public/index.html:163, 169`).
- After signup, before verification: discoveries and unlocks are blocked ("Verify your email before using setup or unlock credits.", `public/app.js:6131`).
- Scanner: up to 10 results/day. Each locked card shows **symbol, timeframe, direction (LONG/SHORT), setup type, confidence %, risk/reward, quality summary, passed confirmations and server reasoning**. Entry, stop loss and take profit are hidden (`signalService.js:1467–1501`; `public/app.js:8367–8403, 8444–8480`).
- Unlock: costs 1 of 3 credits and reveals the levels (`public/app.js:11496–11548`). The credit is refunded if the signal hits SL or expires.
- Telegram: free users can connect and receive "Setup Ready" previews with direction and confidence. Unlocking from Telegram uses a credit.
- Billing: plan cards ("3 lifetime unlocks"), credit packs and the promo redeem form.

---

## 5. Sources for per-setup historical stats

### 5a. Offline replay harness outputs (exist today)

Data lives outside the repo in `C:\Users\monge\Documents\SignalForgeData\` (34 files, ~99 MB).

| Artifact | Contents |
|---|---|
| `{btc,eth,sol}-{historical,h2-2025,2024,2026-ytd}-historical-manifest.json` | Candle manifests per symbol and period (input data) |
| `{btc,eth,sol}-…-risk-replay-results.txt` | UTF-16 console logs from `scripts/production-parity-risk-replay.js`. **⚠ That script isn't in the repo** (not tracked, not on disk). |
| `cross-period-signal-stability-audit.{json,csv}` | **The main cohort:** 99 replayed signals (BTC/ETH/SOL; 15m/1h/4h; 2024, 2025, 2026 YTD). Per signal: strategy, direction, confidence, entry/SL/TP, ATR multiples, outcome, realizedR. Totals: 21 TP / 53 SL / 25 expired, **28.4% win rate, −2.81R total, −0.028R expectancy**. Its own limitations section notes the small sample, no fees or slippage, 3 symbols only, and sampled replay points. |
| `combined-2025-signal-loss-audit.{json,csv}`, `loss-group-overlap-audit.{json,csv}`, `min-stop-atr-holdout-audit.json`, `min-stop-atr-holdout-signals.csv` | Loss and stop-distance diagnostics |
| `momentum-breakout-entry-quality-analysis.json`, `…-signals.csv` | From `scripts/momentum-breakout-entry-quality-analysis.js` |

Replay scripts in the repo. All print JSON to stdout and read the audit above via `--data-folder` (default `C:\Users\monge\Documents\SignalForgeData`):

- One per strategy: `scripts/{breakout-retest,liquidity-sweep-reversal,mean-reversion,momentum-breakout-freshness,multi-timeframe-continuation,pullback-bounce,range-bounce,support-resistance-retest,trend-continuation,vwap-reclaim-rejection}-historical-replay.js`.
- `scripts/consolidated-strategy-production-replay.js`: re-runs the **current** `generateMarketDataSetup` over the 99-signal cohort and replays outcomes with the production `candleOutcome`. Output has `perStrategy` performance, a confidence distribution and comparability flags.
- `scripts/market-data-candle-integrity-replay.js`, `scripts/strategy-aware-risk-shadow-study.js`.

None of these outputs are persisted anywhere the app can read. The sample (99 signals, at most 10 per strategy/symbol/timeframe cell) is too thin for per-setup odds.

### 5b. Production data that already exists (forward, live)

| Source | Notes |
|---|---|
| `generated_signals` (`043`, +`050`, `053`, `054`) | **The best base.** Every system-generated signal regardless of unlock: pair, timeframe, direction, strategy, pattern, entry/SL/TP, RR, confidence (+`calibrated_confidence`), status, `hit_tp_at`/`hit_sl_at`/`expired_at`, MFE/MAE, `realized_r` + `outcome_r_version`, `source`. Read by `src/modules/admin-signals/generatedSignalPerformance.js`, `signalConfidenceCalibrationService.js:551, 677, 760`, `scripts/forward-shadow-cohort-report.js:126` and the untracked `scripts/weekly-realized-r-decomposition.js:63`. |
| `signal_performance_groups` (`050:9–34`) | Already an aggregate: per `group_type/group_value` total/TP/SL/expired, `win_rate`, `expired_rate`, `average_realized_r`, `estimated_expectancy`, `break_even_win_rate`, confidence gap. Maintained by `signalConfidenceCalibrationService.js` for calibration. Single-dimension groups only. |
| `strategy_learning_stats` (`029:24–37`) | Keyed (strategy, market, timeframe), but fed from **user-unlocked** `signal_learning_events`, so it's biased by what users chose to unlock. |
| `market_timeframe_learning_stats`, `factor_learning_stats` (`029`) | Same unlock bias |
| `saved_signals` + `signal_outcomes` | Per-user unlocked copies (also unlock-biased) |
| Backtesting lab (`src/modules/backtesting/backtestService.js`) | On-demand user backtests. Not persisted as reference stats. |

### 5c. What a production per-setup stats table would need

- **Key:** `strategy` (setup type) × `symbol` (or asset class) × `timeframe` × `direction`. Optionally a regime or confidence bucket, but only where samples allow.
- **Counts:** `n_total`, `n_closed`, `hit_tp`, `hit_sl`, `expired`, `still_active_excluded`.
- **Rates with uncertainty:** `win_rate` (TP / (TP+SL)) plus a Wilson or Bayesian 90/95% interval, `expired_rate`, `break_even_win_rate` from the median RR.
- **R metrics:** `avg_realized_r`, `median_r`, `expectancy_r`, `p10_r`/`p90_r`, average MFE/MAE in R, median time to resolution.
- **Provenance:** `source_kind` (`live_forward` | `historical_replay`), `engine/strategy_version`, `outcome_r_version` (e.g. `terminal_v1_tp_rr_sl_minus1_expired_zero`), `window_start/window_end`, `computed_at`, `fees_slippage_included boolean`, `min_sample_met boolean`.
- **Population rules** (already encoded in `scripts/forward-shadow-cohort-report.js:10–13`): include sources `manual_scan`, `auto_crypto_watcher`, `telegram_alert`, `candidate_promotion`; exclude `backtest_shadow`, `admin_test` and test/fixture/replay/backtest markers. De-duplicate by `dedupe_key`/`setup_key`.
- **Refresh:** a scheduled recompute from `generated_signals`, like the existing calibration refresh, plus a one-time import of replay cohorts tagged `historical_replay`.
- **Display policy:** show "not enough data (n < N)" instead of a rate below a minimum sample. Keep live-forward and replay numbers separate.

---

## 6. Wording that tells users to act

| Where | Line | Text |
|---|---|---|
| `public/index.html` hero mock | 191 | **LONG** pill, "Entry / Take Profit / Stop Loss – Unlock to view" (200–202) |
| `public/index.html` demo | 306–311 | "**Signal Found**", "BTCUSD **LONG**", "**Unlock Preview**" |
| `public/index.html` | 161–163, 354, 366, 377, 444 | "Start Free", "Choose Pro", "Choose Elite" (CTAs; fine) |
| `public/index.html` | 226 | "**Unlock the Best Setup**" |
| `public/index.html` | 280 | "Receive **signals** instantly when setups match…" |
| `public/index.html` | 804 | "**Unlock Current**" |
| `public/index.html` | 821 | "**Ready signals**" |
| `public/app.js` scan card | 8381, 8395 | Direction pill (`long`/`short`); "**Unlock Signal**" |
| `public/app.js` unlock reveal | 11508, 11519, 11528–11531 | "**Signal Unlocked**", **LONG/SHORT**, "**Entry**", "**Stop Loss**", "**Take Profit**" under "Critical trade levels" |
| `public/app.js` | 11539 | "**Copy levels**" |
| `public/app.js` | 8806 | "**Add to Paper Trading**" |
| `public/app.js` | 9381 | "**Unlock Full Signal**" |
| `public/app.js` | 8211, 8231 | "No ready signals yet", "**Ready signals** appear below." |
| `public/app.js` | 5053–5059 | "…before **calling a signal**", "Buyers are in control. Long setups may have better follow-through…" |
| `public/app.js` | 6185 | "Buy credits" (billing, not a trade instruction) |
| Telegram `notificationService.js` | 209, 214, 222, 236 | "🚨 SignalForge **Setup Ready**", "**Direction: LONG/SHORT**", "Unlock to view full levels", "**Unlock Signal**" button |
| Server reasoning `signalAnalystService.js` | 170–180 | Summary begins "`LONG <setup> in a <regime> regime.`" and ends "Overall setup quality: …" |
| Risk engine `src/modules/risk/riskEngineService.js` | 169 | "Stop uses N× ATR… The target adapts…" |
| Paper trading drawing tools | `public/index.html:1230–1231` | "Long" / "Short" forecast tools (simulated; low concern) |
| Naming throughout | — | Product name "Signal**Forge**", nav "Signals", "Signal history", "signal quality", "Signal Desk" (`public/index.html:178`) |

No literal "Buy"/"Sell" trade instructions were found. The action framing comes from **LONG/SHORT + Entry/SL/TP + "Signal Found"/"Setup Ready"**.

---

## 7. Legal pages: what they say today

The legal docs are an in-app modal populated from `public/app.js:530–556` (`legalDocuments`). There are no standalone pages or routes and no version number. Linked from the landing footer (`public/index.html:468–470`) and the signup consent (`:593–601`).

| Topic | Terms (`app.js:531–538`) | Privacy (`app.js:539–546`) | Risk (`app.js:547–555`) | Elsewhere |
|---|---|---|---|---|
| Subscriptions | "Subscriptions, unlock credits, affiliate links, and notifications are provided subject to availability and may change as the product evolves." (536) | "subscription status" stored; "Payment information is handled by Stripe." (542–543) | "Affiliates may earn commissions from paid subscriptions." (553) | FAQ "Can I cancel anytime? Yes. Subscriptions are managed through Stripe…" (`index.html:103, 429–430`) |
| **Refunds** | **Silent** | **Silent** | — | Support topic "Refund question" (`app.js:560`). Signal credits auto-refund on SL/expiry (product mechanic, not a policy). |
| **Auto-renewal** | **Silent** | **Silent** | — | Nowhere stated |
| **Free trial / trial terms** | "You agree not to … abuse trials" (535) | — | — | Landing "No Credit Card Required" (`index.html:169`) |
| Cancellation | Silent | — | — | FAQ above; Customer Portal |
| **Data selling** | — | "We do not sell **personal trading history**." (544). Narrow: says nothing about other personal data. | — | — |
| **Trial identifiers** | — | "We use security and anti-abuse signals such as **IP-derived hashes and device fingerprints** to protect free trials and subscriptions." (544) | — | Not disclosed: fingerprint components (UA, language, platform, timezone, screen), that the device hash is **kept after account deletion** (`accountDeletionRepository.js:43–45`), or retention periods. |
| Not advice / risk | "does not … provide personalized investment recommendations" (535) | — | Full risk text; "confidence scores … describe rule alignment, not a probability of profit" (551) | Footer/hero disclaimers |

- **Consent capture:** the signup checkbox (`index.html:593–601`) is enforced server-side for password signup (`src/modules/auth/authService.js:227`) and Google (`src/modules/auth/authController.js:116`). It **isn't persisted**: no timestamp, terms version or IP is stored (no column in any migration).
- **Gaps before charging cards on a trial** (for counsel to review): auto-renewal and price disclosure, trial-to-paid conversion terms, cancellation method and timing, refund policy, governing law, entity name and contact, privacy-policy breadth (data categories, processors such as Stripe/Resend/Telegram/Google, retention, rights requests).

---

## 8. Open items

### 8a. Does password reset or admin temp password revoke other sessions?

| Flow | Revokes sessions? | Revokes restore tokens? | Code |
|---|---|---|---|
| **Password reset** (`POST /api/auth/password-reset/confirm`) | **No** | **No** | `src/modules/auth/authController.js:284–294` → `authService.js:411–426` (`completePasswordReset`) → `src/db/repositories.js:1280–1306` (`resetPasswordWithToken`). Only marks the token used and updates the hash. |
| **Admin temporary password** (support recovery) | **Yes** (`DELETE FROM sessions`) | **Yes** (`revoked_at = now()`) | `src/modules/support/supportService.js:146–154` → `src/modules/support/supportRepository.js:210–222` (sessions at 216, restore tokens at 217) |
| Admin "revoke sessions" | Yes | Yes | `supportService.js:156–160` → `supportRepository.js:224–233` |
| `npm run repair:admin` | Yes | Yes (deletes) | `scripts/repair-admin-account.js:62–63` |
| Password-hash upgrade on login | n/a | n/a | `repositories.js:1270–1278` (compare-and-set only) |

Sessions last up to 180 days (`appConfig.js:77–78`, `resolveSessionMaxAgeSeconds`), and restore tokens can recreate sessions. A reset after a compromise leaves the attacker signed in. The auth middleware doesn't compare a password-changed timestamp (`src/middleware/authMiddleware.js` has none). There's no logged-in "change password" endpoint.

### 8b. Webhook URL: code vs current domain

| Item | Value |
|---|---|
| Paths the code accepts | `POST /api/stripe/webhook`, `POST /api/subscriptions/webhook` on **any host** (`subscriptionController.js:14–16`) |
| Redirect exemption | Both paths are exempt from the legacy-host redirect (`src/middleware/legacyHostRedirect.js:16–22`) |
| Canonical domain in code | `signalforge-app.com` (`legacyHostRedirect.js:2`; `appConfig.js:89, 97`; `index.html:10–37`; `robots.txt`; `sitemap.xml`) |
| Production `APP_URL` | `https://signalforge-app.com` (drives checkout success/cancel/portal URLs, `appConfig.js:225–227`) |
| Production `LEGACY_HOST_REDIRECT` | `true`. `signalforge-app.xyz/` returns 302 → `.com`; `/api/debug/ping` on `.xyz` returns 200 (exempt) |
| Railway public domain | `signalforge-app.xyz` (`RAILWAY_PUBLIC_DOMAIN`). `.com` is served too (`/api/debug/ping` 200). |
| **Registered in Stripe** | `https://signalforge-app.com/api/stripe/webhook` (enabled, API `2024-09-30.acacia`) |
| `www.signalforge-app.com` | **Doesn't resolve** (no response), though the code lists it as a redirect source (`legacyHostRedirect.js:5–7`) |

**Conclusion:** the expected and registered URL agree, and `.com` serves the endpoint. The comment at `legacyHostRedirect.js:13–15`, which says Stripe is registered against the old host, is out of date. Keeping the `.xyz` exemption is harmless.

Related findings:
- `charge.refunded` isn't subscribed, so `processChargeRefunded` is dead in production.
- The webhook API version (`acacia`) differs from the promo-code calls' pinned `2025-09-30.clover`. The invoice parsers already handle both shapes (`stripeService.js:844–871`).
- The Google OAuth redirect is `.com` (`GOOGLE_REDIRECT_URI`); its path is also redirect-exempt.

---

## Paid-user count

One read-only aggregate query against production (`BEGIN TRANSACTION READ ONLY … ROLLBACK`, run in the Railway container). Counts only.

| Metric | Count |
|---|---|
| Users (not deleted) | 6 |
| Testers (unlimited access role) | 2 |
| Active paid subscription (`plan ∈ {pro, elite}`, status ∈ {active, trialing, past_due}, has Stripe subscription id) | **3** |
| …of which Stripe **live** mode | **0** |
| …of which Stripe **test** mode | 3 |
| Users with any past payment, any mode (`billing_entitlement_grants` ∪ credit-pack grants) | 3 |
| Users with a subscription invoice paid | 3 |
| Users with a credit-pack purchase | 0 |
| Users with a **live-mode** payment webhook (processed, `livemode=true`) | **0** (webhook payload history starts 2026-06-22) |
| **Active paid OR past payment, live mode** | **0** |
| Active paid OR past payment, any mode | 3 |

The 3 subscribers have test-mode Stripe customers while the production key is live. `getSubscriptionSummary` flags this as `customerModeMismatch`, the Customer Portal is hidden for them, and their next checkout creates a new live customer (`subscriptionService.js:72–78, 113–117`; `stripeService.js:251–284`). Their local `plan` stays `pro`/`elite` until something changes it, because no live webhook will ever arrive for those test subscriptions.

---

## Pivot touch-list (derived)

- **Stripe:**
  - Create the $15/mo price and add a `trial_period_days: 7` / `payment_method_collection: always` checkout path.
  - Update `planFromPrice`, `BILLING_PLANS`, `planMonthlyAmountCents` and the admin MRR SQL.
  - Stop hard-coding `status: "active"` on checkout.
  - Decide what a $0 trial invoice grants. Suppress the confirmation email and affiliate commission for $0.
  - Subscribe and handle `customer.subscription.trial_will_end` (reminder email) and `charge.refunded`.
  - Retire the credit-pack prices and the promo `credit_grant` type, or redefine them.
- **Data:** stop defaulting free users to `subscriptions.status='trialing'`, or migrate to an explicit `none`. Decide the fate of `unlock_credits_balance`, packs, refunds-on-loss and `device_trial_history`.
- **Gates:** replace credit and discovery metering with "subscribed or trialing", then decide what non-subscribers see.
- **Copy:** every row in sections 1a and 6, the three email templates in 1d, the Telegram template and the confidence band names.
- **Stats:** build the per-setup table in 5c from `generated_signals`. Commit or recreate the missing `production-parity-risk-replay.js` if replay numbers are going to be shown.
- **Legal:** add auto-renewal, trial, cancellation and refund terms. Widen "do not sell". Persist consent with a version.
- **Security:** revoke sessions and restore tokens on password reset.
