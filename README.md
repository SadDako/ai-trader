# AI Trader System

AI Trader System is a private quantitative trading automation platform built with TypeScript, Node.js, Express, SQLite, technical indicators, machine learning, and LLM-assisted market analysis. The system is designed as a controlled research and execution-support engine: it collects market data, evaluates signals through multiple independent layers, applies risk gates, persists decisions, and feeds outcomes back into adaptive scoring.

> Financial disclaimer: this software is for research, simulation, and controlled internal use only. It does not provide financial advice, does not guarantee profit, and must not be connected to live capital without independent validation, risk limits, exchange-level safeguards, and human oversight.

## Overview

The platform combines deterministic quantitative logic with optional LLM analysis. Market data is fetched from public exchange endpoints, transformed into technical features, evaluated by strategy intelligence modules, scored by a Random Forest model, and filtered through portfolio and risk controls before a final decision is persisted.

Current behavior is conservative by design:

- Public market-data ingestion only; no exchange private keys are required.
- Runtime artifacts are isolated under `data/` and `logs/`, both ignored by Git.
- LLM credentials are loaded only from `.env`.
- The dashboard binds to `127.0.0.1` by default and supports bearer-token protection.
- Logs are redacted before being written to disk.

## Architecture

```text
src/
  agents/          Domain agents for technical and sentiment-style analysis
  config/          Environment loading and validation
  execution/       Simulated execution, positions, fills, slippage, and portfolio state
  exchange/        Exchange friction and market-condition abstractions
  meta/            Adaptive portfolio brain and strategy health memory
  ml/              Feature encoding, Random Forest training, inference, auto-retrain
  orchestrator/    Main trading decision pipeline
  prompts/         Prompt templates for LLM-assisted analysis
  quant/           Monte Carlo simulation and risk distribution tools
  server/          Express API and local dashboard
  services/        LLM and public market-data integrations
  state/           SQLite schema, repositories, and in-process memory
  types/           Shared TypeScript contracts
  utils/           Indicators, scoring, risk, logging, backtest, datasets, health
```

## Decision Pipeline

1. Fetch OHLCV candles from public Binance market-data endpoints.
2. Compute technical indicators: RSI, SMA trend, momentum, breakout, ATR, market quality.
3. Detect market regime and setup type.
4. Generate an optional LLM-assisted market read via Anthropic if `ANTHROPIC_API_KEY` is configured.
5. Score the signal using rule-based strategy intelligence and historical performance.
6. Run ML inference with the trained Random Forest model when a model is available.
7. Apply risk gates: volatility, liquidity, regime fit, loss cooldown, inactivity, edge quality, and adaptive portfolio stress.
8. Persist the decision to SQLite and JSON runtime storage.
9. Evaluate later outcomes and use them for learning, backtests, datasets, and retraining.

## Modules

| Area | Main files | Purpose |
|---|---|---|
| Orchestration | `src/orchestrator/trading.orchestrator.ts` | Coordinates market data, agents, scoring, risk filters, and final decisioning. |
| AI service | `src/services/ai.service.ts` | Calls Anthropic only when an API key exists; otherwise uses deterministic fallback. |
| Market service | `src/services/market.service.ts` | Fetches and validates public market candles. |
| Risk and quality | `src/utils/riskManager.ts`, `src/utils/marketQuality.ts`, `src/utils/marketFilters.ts` | Blocks low-quality setups and calculates risk-aware trade context. |
| Execution model | `src/execution/*` | Simulates order lifecycle, slippage, portfolio snapshots, and position analytics. |
| ML | `src/ml/*` | Builds features, trains Random Forest models, performs inference, and auto-retrains. |
| Persistence | `src/state/database.ts`, `src/state/decisionsRepo.ts` | Stores decisions, execution events, strategy performance, and meta logs in SQLite. |
| Dashboard/API | `src/server/index.ts`, `public/*` | Local operational view and REST endpoints. |
| Security | `src/config/env.ts`, `src/utils/logger.ts`, `.gitignore` | Environment validation, log redaction, and secret-safe repository boundaries. |

## Risk Management

The system applies multiple defensive layers before allowing an operational signal:

- Minimum score thresholds with adaptive adjustments.
- Volatility and liquidity checks using ATR, ATR percentage, and volume context.
- Market-regime penalties for setups that do not fit current conditions.
- Historical edge scoring by setup, direction, asset, timeframe, and regime.
- Post-loss cooldown to reduce revenge-trade behavior.
- Low-frequency and inactivity checks to avoid stale decision loops.
- Portfolio stress controls that adapt risk mode and minimum confidence.
- ML probability checks that can penalize or block weak signals.

These controls are software safeguards, not a substitute for exchange-side limits, account-level drawdown caps, or supervised deployment.

## Security Model

- Secrets live only in `.env`; `.env` and `.env.*` are ignored.
- `.env.example` contains neutral placeholders only.
- Runtime databases, model files, datasets, and logs are ignored.
- Logs redact common token, password, API key, bearer, GitHub, AWS, Slack, and private-key patterns.
- Dashboard/API defaults to `WEB_HOST=127.0.0.1`.
- `DASHBOARD_AUTH_TOKEN` enables bearer-token or `x-dashboard-token` protection.
- Express disables `X-Powered-By` and sets basic hardening headers.
- Dependency audit is available through `npm run security:audit`.

Recommended operational controls:

- Rotate any credential that was ever stored outside a secret manager.
- Use read-only or least-privilege API keys for research.
- Do not enable withdrawal permissions on exchange keys.
- Keep live execution behind a private network, VPN, or zero-trust gateway.
- Review `git status`, `git diff --cached`, and secret scans before every push.

## Environment

Create a local `.env` from `.env.example`:

```env
ANTHROPIC_API_KEY=your-api-key-here
ANTHROPIC_MODEL=claude-sonnet-4-6
WEB_HOST=127.0.0.1
WEB_PORT=3000
DASHBOARD_AUTH_TOKEN=your-dashboard-token-here
DISABLE_DASHBOARD_AUTH=false
```

`ANTHROPIC_API_KEY` is optional. Without it, the system continues with deterministic fallback analysis.

## Installation

Requirements:

- Node.js 22 or newer
- npm

```bash
npm install
cp .env.example .env
npm run build
```

## Execution

```bash
# Trading loop with local dashboard
npm run start

# Watch mode during development
npm run dev

# Dashboard/API only
npm run web

# Build TypeScript
npm run build

# Dependency security audit
npm run security:audit
```

The dashboard defaults to `http://127.0.0.1:3000`.

When `DASHBOARD_AUTH_TOKEN` is configured, call protected endpoints with:

```bash
Authorization: Bearer <your-dashboard-token>
```

## Runtime Data

The following paths are intentionally excluded from Git:

- `data/trader.db`
- `data/decisions.json`
- `data/datasets/`
- `data/models/`
- `logs/`
- `dist/`
- `node_modules/`

These files can contain operational history, generated models, local market decisions, and diagnostic data. They must be backed up and secured separately if needed.

## Roadmap

- Pluggable private exchange execution with least-privilege key support.
- Dry-run/live execution mode separation with explicit kill switch.
- Per-strategy versioning and experiment tracking.
- CI secret scanning and dependency audit gates.
- Docker deployment profile with non-root runtime user.
- Portfolio-level capital allocation and max drawdown enforcement.
- Signed release workflow for private deployments.

## License

Private/internal software. All rights reserved unless a separate license is provided.
