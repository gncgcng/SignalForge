# SignalForge

SignalForge is a modern full-stack MVP for an AI-ready trading signal scanner. It includes auth, a responsive dashboard, crypto pair and timeframe selection, live OHLCV market data, rule-based trade setups, and a Stripe-ready subscription boundary with a 3-signal free trial.

## Run

```bash
npm install
npm run db:migrate
npm run dev
```

Open `http://localhost:4173`.

## PostgreSQL

SignalForge now uses PostgreSQL for users, sessions, subscriptions, credit balances, saved/unlocked signals, and signal outcomes.

Local setup:

```bash
docker compose up -d postgres
copy .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Default local `DATABASE_URL`:

```bash
postgres://signalforge:signalforge@localhost:5432/signalforge
```

All application, migration, seed, authentication, and outcome-tracking database connections use `DATABASE_URL` exclusively. `DB_HOST`, `PGHOST`, and split host/user/password variables are not read by SignalForge.

## Demo Login

Use any valid email and a password of 6+ characters. For a seeded local account, run `npm run db:seed` and sign in with `demo@signalforge.app` / `signal123`.

## Architecture

- `src/server.js`: HTTP server, static file serving, API router.
- `src/config`: runtime constants and feature settings.
- `src/middleware`: auth/session middleware.
- `src/modules/auth`: login, registration, current-user endpoints.
- `src/modules/market-data`: provider-ready market catalog and price facade.
- `src/modules/signals`: mock signal generator and signal quota flow.
- `src/modules/subscriptions`: trial and Stripe-ready subscription service.
- `src/shared`: shared API helpers and ids.
- `src/db`: PostgreSQL connection and repository layer.
- `migrations`: SQL schema migrations.
- `public`: responsive SaaS dashboard frontend.

Real AI trading logic is intentionally not implemented. The signal generator uses live Coinbase OHLCV candles with a simple rule-based setup model, isolated behind a service contract so it can be replaced with AI later.

## Market Data

The live provider uses Coinbase Exchange public candles for crypto pairs:

- `BTC-USD`
- `ETH-USD`
- `SOL-USD`

Supported scanner timeframes are `5m`, `15m`, `1h`, and `4h`. Stocks and ETFs remain visible in the UI as coming soon and are disabled for scanning.
