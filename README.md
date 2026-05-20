# AI-Trader

> **Private quantitative trading research platform.**
> Multi-layer signal engine combining technical indicators, market-regime detection, a Random Forest classifier, optional LLM-assisted reads, and a multi-stage risk gate — exposed through a local-only operational dashboard.

[![security](https://img.shields.io/badge/security-hardened-success)](#security-model)
[![status](https://img.shields.io/badge/status-internal--research-blue)](#disclaimer)
[![runtime](https://img.shields.io/badge/runtime-node%2022%2B-brightgreen)](#stack)
[![license](https://img.shields.io/badge/license-UNLICENSED-lightgrey)](#license)

---

## Disclaimer

This software is **research and execution-support tooling for controlled internal use**. It does not constitute financial advice, does not guarantee profit, and **must not be wired to live capital** without (a) independent code review, (b) exchange-level safeguards, (c) account-level drawdown limits, and (d) supervised deployment with a documented kill switch. Past simulated performance is not predictive of future returns.

---

## Overview

AI-Trader is a TypeScript + Node.js trading research engine. Each cycle:

1. Pulls public OHLCV candles from a venue endpoint.
2. Extracts technical features and detects the current market regime.
3. Optionally consults an LLM for a structured market read.
4. Scores the signal through rule-based strategy intelligence and historical edge memory.
5. Runs ML inference (Random Forest) when a trained model is available.
6. Filters the candidate through a multi-stage risk gate.
7. Persists the decision into SQLite + JSON storage and feeds the outcome back into learning.

Everything happens in-process on a single Node runtime. There is no external broker connection, no withdrawal capability, and no outbound data path beyond the public market-data fetch and (optionally) the LLM provider.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        TRADING ORCHESTRATOR                          │
│                  (src/orchestrator/trading.orchestrator.ts)          │
└────────┬───────────────┬──────────────┬──────────────┬──────────────┘
         │               │              │              │
         ▼               ▼              ▼              ▼
   ┌──────────┐   ┌────────────┐  ┌──────────┐  ┌──────────────┐
   │  Market  │   │  Indicators│  │   Regime │  │  Strategy    │
   │  Service │   │  RSI/SMA/  │  │  Detect  │  │  Intelligence│
   │ (public) │   │  ATR/MOM   │  │          │  │  + Edge mem  │
   └────┬─────┘   └──────┬─────┘  └────┬─────┘  └──────┬───────┘
        │                │              │              │
        └────────┬───────┴──────────────┴──────────────┘
                 ▼
         ┌───────────────┐      ┌──────────────────┐
         │  AI Service   │◀────▶│  LLM (optional)  │
         │  (heuristic   │      │  Anthropic API   │
         │   fallback)   │      └──────────────────┘
         └───────┬───────┘
                 ▼
         ┌───────────────┐      ┌──────────────────┐
         │  ML Inference │◀────▶│  Random Forest   │
         │               │      │  auto-retrain    │
         └───────┬───────┘      └──────────────────┘
                 ▼
         ┌───────────────────────────────────────┐
         │   RISK GATE                           │
         │   volatility · liquidity · regime fit │
         │   loss-cooldown · inactivity · edge   │
         │   adaptive portfolio stress           │
         └───────────────┬───────────────────────┘
                         ▼
                ┌─────────────────┐
                │   PERSISTENCE   │
                │  SQLite + JSON  │
                └────────┬────────┘
                         ▼
                ┌─────────────────┐
                │  Local Dashboard│
                │   127.0.0.1     │
                │   bearer-token  │
                └─────────────────┘
```

---

## Modules

| Layer          | Path                                         | Responsibility                                                                            |
| -------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Orchestration  | `src/orchestrator/`                          | End-to-end cycle: data → features → scoring → risk → decision.                            |
| Agents         | `src/agents/`                                | Technical and sentiment-style analyzers feeding the orchestrator.                         |
| Market service | `src/services/market.service.ts`             | Fetches and validates public OHLCV; rejects malformed payloads.                           |
| AI service     | `src/services/ai.service.ts`                 | Calls the LLM only when a key is configured; falls back to deterministic heuristic.       |
| Indicators     | `src/utils/{rsi,sma,momentum,breakout,…}.ts` | Pure technical functions; no I/O.                                                         |
| Regime/quality | `src/utils/marketRegime.ts`, `marketQuality.ts` | Classifies the tape so risk and scoring can adapt.                                       |
| Strategy mem.  | `src/utils/strategyIntelligence.ts`          | Historical edge per setup/direction/asset/timeframe/regime.                               |
| Risk gate      | `src/utils/riskManager.ts`, `marketFilters.ts` | Blocks low-edge or hostile-condition trades.                                            |
| ML pipeline    | `src/ml/`                                    | Feature encoder, Random Forest training, inference, auto-retrain loop.                    |
| Execution sim  | `src/execution/`                             | Order lifecycle, slippage, fills, position analytics, portfolio snapshots.                |
| Meta brain     | `src/meta/metaPerformance.ts`                | Adaptive portfolio mode (risk dial) based on rolling performance.                         |
| Quant          | `src/quant/monteCarlo.ts`                    | Monte Carlo on trade distribution.                                                        |
| Persistence    | `src/state/`                                 | SQLite schema, decisions repository, in-process memory.                                   |
| Dashboard      | `src/server/`, `public/`                     | Express API + static UI bound to `127.0.0.1`, bearer-token authenticated.                 |
| Config/env     | `src/config/env.ts`                          | Loads `.env`, rejects placeholders, emits warnings for unsafe combos.                     |
| Logger         | `src/utils/logger.ts`                        | Disk logger with rotation and per-pattern secret redaction.                               |

---

## Decision Pipeline

1. **Ingest** — `getMarketData` fetches OHLCV candles from public endpoints with a 15 s timeout and array-shape validation.
2. **Features** — RSI, SMA trend, momentum, breakout detection, ATR / ATR%, volume context, market quality.
3. **Regime** — current regime + confidence; setups inappropriate for the regime are penalized.
4. **LLM read** *(optional)* — only fires if `ANTHROPIC_API_KEY` is present; output is parsed and validated, never `eval`'d.
5. **Score** — rule-based strategy intelligence + historical edge memory.
6. **ML** — Random Forest probability if a trained model is loaded; auto-retrain loop checks periodically.
7. **Risk gate** — volatility/liquidity, regime fit, loss cooldown, inactivity, edge quality, adaptive portfolio stress, ML probability cutoff.
8. **Persist** — decision written to SQLite + JSON; later outcomes evaluated and fed back into learning, backtests, and datasets.

---

## Risk Management

Defensive layers applied **before** a signal is allowed to surface:

- Minimum-score threshold with adaptive adjustments per regime/asset.
- ATR and ATR%-based volatility floors and ceilings.
- Volume-relative liquidity check.
- Regime-fit penalty for misaligned setups.
- Per-setup / per-direction / per-asset / per-timeframe / per-regime edge memory.
- Post-loss cooldown to suppress revenge trades.
- Low-frequency and inactivity guards to avoid stale decision loops.
- Adaptive portfolio brain that raises required confidence as stress grows.
- ML probability gate that can penalize or block weak signals.

These are *software* safeguards. They are **not** a substitute for exchange-side limits, account-level drawdown caps, or human supervision.

---

## Security Model

| Layer                | Control                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets at rest      | Loaded only from `.env`. `.env` and `.env.*` are gitignored. `.env.example` carries placeholders only.                                    |
| Secrets in transit   | `Authorization: Bearer …` or `x-dashboard-token` header. Comparison uses `crypto.timingSafeEqual` to resist timing attacks.               |
| Secrets in logs      | `src/utils/logger.ts` redacts known token shapes (`sk-…`, `AKIA…`, `gh[pousr]_…`, `xox[baprs]-…`, PEM blocks, `Bearer …`) and key-named fields. |
| Dashboard exposure   | Defaults to `WEB_HOST=127.0.0.1`. Warning emitted at boot if exposed without a token.                                                     |
| HTTP hardening       | `x-powered-by` disabled; `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` set; JSON body capped at 256 KB.                  |
| Error responses      | 5xx replies return `{"error":"internal_error"}` — full message is logged server-side only.                                                |
| Input validation     | Symbol allow-list (`BTCUSDT`, `ETHUSDT`); query params parsed defensively; ML/regime endpoints reject unknown values.                     |
| Process resilience   | `uncaughtException` and `unhandledRejection` captured; watchdog re-arms a stalled main loop; logger never crashes the process.            |
| Build-time gates     | `npm run security:audit` and GitHub Actions: `gitleaks` secret scan + `npm audit` + TypeScript build (`.github/workflows/security.yml`).  |
| Pre-commit defense   | Optional `.githooks/pre-commit` blocks staged diffs containing high-confidence secret patterns and refuses to commit `.env`.              |

### Enabling the pre-commit hook (once per clone)

```bash
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit   # macOS / Linux
```

On Windows + Git Bash, Git executes the hook through bash automatically; no `chmod` needed.

### Operational recommendations

- Rotate any credential that was ever stored outside a secret manager.
- Use **read-only** or least-privilege keys for research.
- Never enable withdrawal permissions on exchange keys used by this stack.
- Keep any live execution behind a private network, VPN, or zero-trust gateway.
- Review `git status`, `git diff --cached`, and `npm run security:audit` before every push.

---

## Environment

Copy the example and fill values locally — never commit `.env`.

```env
# Optional. Without it, the engine falls through to deterministic heuristics.
ANTHROPIC_API_KEY=your-api-key-here
ANTHROPIC_MODEL=claude-sonnet-4-6

# Dashboard / API exposure. Localhost is the secure default.
WEB_HOST=127.0.0.1
WEB_PORT=3000

# Required if WEB_HOST is exposed outside localhost.
DASHBOARD_AUTH_TOKEN=your-dashboard-token-here

# Only true for isolated local development.
DISABLE_DASHBOARD_AUTH=false
```

Placeholders (`your-api-key-here`, `change-me`, `replace-me`, etc.) are detected and treated as **unset** by `src/config/env.ts`.

---

## Stack

- **Runtime:** Node.js 22+, TypeScript 6, ESM
- **HTTP:** Express 5
- **Persistence:** `node:sqlite` (no native build needed) + JSON snapshots
- **ML:** `ml-random-forest`
- **LLM (optional):** Anthropic Messages API
- **Logging:** custom rotating file logger with secret redaction
- **Build tooling:** `tsc`, `tsx`
- **CI:** GitHub Actions — gitleaks, `npm audit`, TypeScript build

---

## Installation

```bash
# Requires Node.js 22+
git clone <private-repo-url> ai-trader
cd ai-trader
npm install
cp .env.example .env       # fill in any values you want
npm run build
git config core.hooksPath .githooks   # enable anti-secret pre-commit
```

---

## Execution

```bash
npm run start            # trading loop + local dashboard (recommended)
npm run dev              # same, with tsx --watch
npm run web              # dashboard / API only
npm run build            # TypeScript build to dist/
npm run security:audit   # dependency audit (moderate+)
```

The dashboard is served at `http://127.0.0.1:3000`. When `DASHBOARD_AUTH_TOKEN` is set, every request must carry:

```http
Authorization: Bearer <your-dashboard-token>
```

…or the equivalent `x-dashboard-token` header.

### Selected endpoints

| Method | Path                       | Purpose                                          |
| ------ | -------------------------- | ------------------------------------------------ |
| GET    | `/health`                  | Process health + Binance fetch freshness         |
| GET    | `/decisions?symbol=BTCUSDT`| Persisted decisions (whitelisted symbols only)   |
| GET    | `/performance-sql`         | SQL-backed performance breakdown                 |
| GET    | `/backtest`                | Run the in-process backtest                      |
| GET    | `/market-regime`           | Current regime + confidence                      |
| GET    | `/execution/live`          | Live simulated position state                    |
| GET    | `/ml/status`               | Current model + retrain status                   |
| GET    | `/ml/predict`              | Random Forest probability for a given context    |
| POST   | `/ml/retrain`              | Force a retrain pass                             |
| GET    | `/quant/monte-carlo`       | Monte Carlo over the recorded trade distribution |

---

## Runtime Data — Excluded from Git

Operational artifacts and any local-only data live outside the tracked tree:

```
.env
.env.*           (except .env.example)
data/            (trader.db, decisions.json, datasets/, models/)
logs/            (runtime.log, runtime.log.1..3)
dist/
node_modules/
```

Back these up out-of-band if you need to preserve them. They can contain decisions, generated models, and diagnostic data — none of which belong on a public surface.

---

## Roadmap

- [ ] Pluggable private-exchange execution with least-privilege key support.
- [ ] Explicit `dry-run` / `live` mode separation with mandatory kill switch.
- [ ] Per-strategy versioning + experiment tracking.
- [ ] Per-endpoint rate limiting (currently localhost-only).
- [ ] Docker deployment profile with non-root runtime user and read-only FS.
- [ ] Portfolio-level capital allocation and hard max-drawdown enforcement.
- [ ] Signed release workflow for private deployments.
- [ ] Replace JSON decision snapshots with append-only SQLite event log.

---

## License

UNLICENSED — private/internal software. All rights reserved unless a separate license is provided in writing.
