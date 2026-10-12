# Inventory delta: findings re-checked on `origin/main`

`docs/pivot/inventory.md` was written against `feature/commodities-infrastructure` @ `13aea56`.
That branch isn't an ancestor of `main`; the two share merge-base `5acd136`. This file re-checks each finding on
`origin/main` @ `293988b` (2026-10-11). **Use this file, not the original inventory, for phase 0 onward.**

Legend:
- **Holds:** still true on main, with the corrected `file:line`.
- **Differs:** main changed it, and the row says how.
- **N/A:** not applicable on main.

Files that are **byte-identical** between `13aea56` and `main`, so every line reference into them still holds:
`src/modules/subscriptions/{stripeService,subscriptionService,subscriptionController}.js`,
`src/middleware/legacyHostRedirect.js`, `src/modules/support/{supportRepository,supportService}.js`,
`src/modules/promo-codes/*`, `src/modules/credits/signalCreditLedgerRepository.js`,
`src/modules/signals/signalController.js` and `src/modules/analyst/signalAnalystService.js`.

Production facts (the paid-user count, Stripe prices, webhook registration, Railway variables and DNS) don't depend on a branch.
They hold as recorded in the inventory.

## TL;DR items

| # | Finding | Status on main |
|---|---|---|
| 1 | 0 live-mode payers; 3 test-mode subscriptions | **Holds** (production fact) |
| 2 | 99-signal replay, 28.4% WR, −0.028R vs "High-Probability" copy | **Holds.** Copy at `public/index.html:14, 157, 734`; `public/app.js:5964, 8600, 8606`. **Also found on main:** "No high-probability setups right now" in the server scan message at `src/modules/signals/signalService.js:1034`. |
| 3 | Stripe isn't ready for a trial | **Holds.** `stripeService.js` is unchanged; `'trialing'` default at `src/db/repositories.js:189` and `migrations/001_initial_schema.sql:23`. |
| 4 | Admin MRR hard-codes 2900/9900 | **Holds.** `stripeService.js:560–564`; `src/db/repositories.js:452–458, 574–577, 733` |
| 5 | Promo codes off in prod, but the UI says to use them at checkout | **Holds.** `public/index.html:2373` |
| 6 | Password reset doesn't revoke sessions; admin temp password does | **Holds** for reset (`src/db/repositories.js:1364–1390`, `src/modules/auth/authService.js:532`) and for admin (`supportRepository.js:210–222`). **New on main:** a logged-in `POST /api/auth/password/change` (`authController.js:174`, `authService.js:104`) **does** revoke the other sessions and all restore tokens (`repositories.js:1332–1351`). |
| 7 | Webhook URL agrees; `charge.refunded` isn't subscribed | **Holds** (production fact; code unchanged) |

## Section 1: claims

| Finding | Status |
|---|---|
| og:description "high-probability setups" | Holds. `public/index.html:14` |
| twitter:description "better trading setups" | Holds. `public/index.html:19` |
| Hero h1 "High-Probability Setups" | Holds. `public/index.html:157` |
| Hero sub "better trading decisions", "cleaner … signals" | Holds. `public/index.html:158–159` |
| Hero mock LONG / 89% / 2.4R | Holds. `public/index.html:191, 197, 203` |
| "Unlock the Best Setup… earns attention" | Holds. `public/index.html:226–227` |
| "AI-assisted analysis" | Holds. `public/index.html:251` |
| "ranks qualifying opportunities" | Holds. `public/index.html:279` |
| Demo "Signal Found", LONG, 89% | Holds. `public/index.html:306–311` |
| "Upgrade when you need more signal capacity" | Holds. `public/index.html:337` |
| "Ready to Find Better Trading Setups?" | Holds. `public/index.html:442` |
| Topbar "High-probability setup lab" | Holds. `public/index.html:734`; `public/app.js:5964` |
| Scan summaries "high-probability setup(s)" | Holds. `public/app.js:8600, 8606` |
| `getConfidenceBand` Elite/Excellent/Strong/Good | Holds. `public/app.js:11882–11888` |
| Quality label "Excellent" (qualityScore ≥ 90) | Holds. `public/app.js:9368` |
| Telegram tiers "Rare near-perfect"… | Holds. `src/modules/notifications/notificationService.js:301–307` |
| Telegram "Setup Ready", "Confidence: N% (tier)" | Holds. `notificationService.js:208, 214` |
| Analyst "tradable", "Overall setup quality" | Holds. `signalAnalystService.js:158–161, 180` |
| manifest / JSON-LD descriptions | Holds. `public/manifest.json:5`; `public/index.html:38` |
| **Not in the inventory, found on main:** server-side confidence and quality label sets | `src/modules/signals/signalValidationService.js:20–22` (`confidenceBand`: Elite ≥95, Excellent ≥90, Strong ≥80); `src/modules/signals/signalQualityService.js:280–282` ("**Proven elite**" ≥89, …); `src/modules/signals/signalConfidenceCalibrationService.js:935–937` ("**Proven elite**"); `src/modules/signals/signalLearningService.js:278–280` (Elite/Excellent/Strong); `signalAnalystService.js:302` ("Excellent"). These strings reach the UI as `confidenceBand` / `signalQuality.label`. |
| Win-rate displays (dashboard, Performance, Backtest lab, Leaderboard, profile) | Holds. `public/index.html:1131, 1445–1446, 1464–1468, 1538, 1816` (leaderboard tab), `1832` (disclaimer), `1866` (profile) |
| Hidden `#performance-preview` | Holds. `public/index.html:383` |
| Disclaimers to keep | Holds. Risk doc at `public/app.js:574–575`; how-it-works at `public/app.js:4318, 4377`; tooltips at `public/app.js:8730, 9202, 9253` |
| Emails: "activate your free SignalForge unlocks" (old `emailVerificationService.js:42`) | **Differs.** Emails were rebuilt in `src/modules/notifications/emailTemplates.js` (new on main). Verify: `:43–60` ("activate your 3 free signal unlocks"). Welcome: `:64–86`. Subscription confirmation: `:102–116` (still sent on every paid invoice, `stripeService.js:449`). Footer disclaimer: `:189`. **New problem on main:** the no-trial welcome says "To unlock a signal, choose a plan or a credit pack in Billing" (`:80`), which is false once checkout is paused. |
| Emails contain no accuracy or win-rate claims | Holds on main |

## Section 2: unlock mechanic

| Finding | Status |
|---|---|
| Tables (`credit_balances`, `unlocked_signals`, `signal_credit_transactions`, grants, `promo_codes`, `device_trial_history`, …) | Holds (migrations unchanged) |
| **Trial guard** = device fingerprint only | **Differs.** Main adds `trial_identity_claims` (`migrations/066_trial_identity_claims.sql`): one trial per HMAC'd email or Google subject, kept after deletion. Logic is in `src/modules/auth/trialIdentity.js`; `grantOAuthFreeTrial(userId, deviceHash, { email, googleSubject })` is at `repositories.js:1523`; `verifyEmailToken` is at `repositories.js:1271`. Deletion keeps it (`accountDeletionRepository.js:54–56, 83–94`). The device guard is still there (`accountDeletionRepository.js:46`). |
| Plan constants / gates | Holds. `subscriptionService.js:8–39, 124–160` |
| Unlock entry points | Holds, moved: `signalService.js:75` (`createSignal`), `:178`, `:304`; decrement mirrors at `:167, :235, :397` |
| Atomic debit `saveUnlockedSignal` | Holds, moved: `repositories.js:1971`; verify check `:2004`, `UNLOCK_LIMIT` `:2011` |
| Refund on SL/expiry | Holds. Ledger unchanged; callers at `repositories.js:2333, 2371` |
| Locked preview `toScanPreview` | Holds, moved: `signalService.js:1419–1451` |
| Scan-all metering / discovery gate | Holds, moved: `signalService.js:801`, `:1493` |
| Endpoints | Holds (controllers unchanged) |
| Promo code service/repo, Stripe promo calls | Holds (unchanged) |
| UI: hero "3 Free Signal Unlocks", "No Credit Card Required" | Holds. `public/index.html:163, 169` |
| UI: pricing lists | Holds. `public/index.html:350–351, 359–365, 370–376`; JSON-LD offers `:40–66` |
| UI: sidebar "Plan capacity" / Upgrade | Holds. `public/index.html:721–725` |
| UI: "Unlock Current" | Holds. `public/index.html:805` |
| UI: Billing promo panel / plan grid / packs | Holds. `public/index.html:2373` (discount-codes sentence), `:2375` (form), `:2386`, `:2392`, `:2397–2399` |
| UI: app.js billing render, checkout, unlock labels | Holds, moved: `renderBilling` `6417`, plan buttons `6452–6456`, "Buy credits" `6466`, `startCheckout` `6523`, scan card `8636` ("Unlock Signal" `8664`), "Unlock Full Signal" `9650`, unlock reveal `11776` ("Signal Unlocked" `11788`, levels `11808`, "Copy levels" `11819`), toast `11603`, trust card `4349`, promo toast `1766`, onboarding `11449` |
| **New on main:** Refund Policy linked from pricing | `public/index.html:342, 472`; text at `public/app.js:579–586` |

## Section 3: Stripe

| Finding | Status |
|---|---|
| Prices, checkout flow, webhook handler, plan sync, mode handling | **Holds** with identical line numbers (`stripeService.js`, `subscriptionController.js`, `subscriptionService.js` unchanged) |
| Config lines | Holds, moved: `src/config/appConfig.js:50` (env keys), `:210–232` (stripe block; success/cancel/portal URLs `:215–217`, promo flag `:218`, prices `:219`, price env keys `:226`) |
| Registered webhook and events | Holds (production) |
| `'trialing'` default for free users | Holds. `repositories.js:189`; MRR queries `:452–458, 574–577, 733` |

## Section 4: gates

| Finding | Status |
|---|---|
| Only quantity is plan-gated; Telegram, backtest and performance are open to free users | Holds (no plan checks were added on main) |
| What free users see | Holds. The locked preview still shows direction, confidence and RR, and hides entry/SL/TP. |

## Section 5: stats sources

| Finding | Status |
|---|---|
| Replay data folder, replay scripts, missing `production-parity-risk-replay.js` | Holds (not branch-dependent; the script is absent on main too) |
| `generated_signals` / `signal_performance_groups` / learning tables | Holds (no schema changes to them) |
| `scripts/weekly-realized-r-decomposition.js` | **N/A** on main. Untracked local file only. |

## Section 6: action wording

| Finding | Status |
|---|---|
| Direction pills, "Signal Found", "Setup Ready", "Unlock Signal", Entry/SL/TP "Critical trade levels", "Copy levels", "Add to Paper Trading", "Ready signals" | Holds, at the main lines listed under section 2 UI. Telegram is at `notificationService.js:208, 213, 221, 235`. |
| "calling a signal", "Buyers are in control" | Holds. `public/app.js:5334–5340` |

## Section 7: legal

| Finding | Status |
|---|---|
| Terms / Privacy / Risk text | Holds. `public/app.js:553–578` (text unchanged) |
| **Refunds: silent** | **Differs.** Main has a Refund Policy (`public/app.js:579–586`): no refunds except billing errors; cancelling stops future billing. |
| Auto-renewal, trial terms | Holds: still not stated |
| "do not sell personal trading history" (narrow) | Holds. `public/app.js:567` |
| Trial identifiers disclosure | Holds, and the gap is larger. The privacy text still mentions only IP hashes and device fingerprints; it doesn't mention `trial_identity_claims` (email/Google-subject hashes kept after deletion). |
| **Consent "checked but never saved"** | **Differs.** Main stores `legal_consent_accepted_at`, `legal_consent_version` and `age_confirmed_at` (`migrations/063_legal_consent_and_age.sql`; `repositories.js:100–182`; version `2026-09-30` at `src/modules/auth/authPolicy.js:17`). An 18+ confirmation is required (`public/index.html:593`; `authService.js:321–326`). Google carries consent through the OAuth state (`authController.js:121–135`). |

## Section 8: open items

| Finding | Status |
|---|---|
| Password reset doesn't revoke | **Holds.** `repositories.js:1364–1390` |
| Admin temp password revokes | Holds. `supportRepository.js:210–222` |
| Change password (new) revokes others | New on main (see TL;DR 6) |
| Webhook URL vs domain | Holds. `legacyHostRedirect.js` is unchanged; the stale comment is at `:13–15` |

## Consequences for phase 0

- Billing copy changes target `public/index.html:337–380, 2370–2400` and `public/app.js:6417–6530`.
- Email copy lives in `emailTemplates.js`, not `transactionalEmailService.js`/`emailVerificationService.js`. The no-trial welcome must stop pointing to plans and credit packs.
- Confidence labels have **five** server-side sources plus two client-side ones (see section 1). Only the user-visible strings change. Thresholds and any logic that compares labels stay as they are.
