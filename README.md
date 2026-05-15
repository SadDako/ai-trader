# AI Trader

> Autonomous multi-agent trading system that combines LLM-powered analysis, real-time market data, technical indicators, machine learning, and self-correcting decision logic.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white)
![Anthropic](https://img.shields.io/badge/LLM%20%E2%80%94%20Claude-D97757?style=flat&logo=anthropic&logoColor=white)
![Random Forest](https://img.shields.io/badge/ML%20%E2%80%94%20Random%20Forest-FF6F00?style=flat&logo=scikitlearn&logoColor=white)

---

## Overview

AI Trader is a backend automation platform for algorithmic trading. It uses a **multi-agent orchestration architecture** where a sentiment agent (LLM-powered) and a technical analysis agent independently evaluate market conditions. An orchestrator synthesises both signals, weighs them against historical performance, and applies a layered risk engine before committing — or skipping — each decision.

The system **learns from itself**: every decision is persisted, evaluated against outcome, and fed back into both a rule-based weighting system and a Random Forest model that predicts signal quality. It also **regime-detects** the market (trending, ranging, volatile, dead) and adjusts strategy accordingly.

A built-in **backtest engine** replays historical data through the full pipeline so strategy changes can be validated before going live.

---

## Architecture

```
src/
├── agents/
│   ├── sentimento.agent.ts        # LLM-powered sentiment analysis (Claude)
│   └── tecnico.agent.ts           # Technical indicators analysis agent
│
├── orchestrator/
│   └── trading.orchestrator.ts    # Coordinates agents, applies decision pipeline
│
├── services/
│   ├── ai.service.ts              # LLM (Anthropic) integration layer
│   └── market.service.ts          # Real-time market data ingestion
│
├── state/
│   ├── marketMemory.ts            # In-process market state across cycles
│   ├── database.ts                # SQLite (node:sqlite) connection + schema
│   └── decisionsRepo.ts           # Decision persistence repository
│
├── ml/
│   ├── featureEncoder.ts          # Encodes market state → feature vector
│   ├── modelManager.ts            # Loads/saves trained models from disk
│   ├── trainModel.ts              # Trains Random Forest on labelled decisions
│   ├── predictSignal.ts           # Inference: predicts signal quality
│   └── autoRetrain.ts             # Scheduled retraining loop
│
├── prompts/
│   └── tecnico.prompt.ts          # Prompt templates for technical agent
│
├── utils/
│   ├── rsi.ts · sma.ts · momentum.ts · breakout.ts   # Indicator primitives
│   ├── patternAnalysis.ts         # Candlestick pattern recognition
│   ├── trendAnalysis.ts           # Trend direction & strength
│   ├── indicator.ts               # Indicator orchestration
│   ├── marketRegime.ts            # Regime detection (trend / range / chop / dead)
│   ├── marketFilters.ts           # Pre-trade filters (liquidity, volatility)
│   ├── marketQuality.ts           # Quality scoring of current market conditions
│   ├── riskManager.ts             # Position sizing & risk gating
│   ├── lossCooldown.ts            # Anti-revenge-trade cooldown
│   ├── inactivityCheck.ts         # Stale-data and inactivity detection
│   ├── forceExploration.ts        # Exploration enforcement (anti-overfit)
│   ├── score.ts                   # Composite signal scoring
│   ├── learning.ts                # Rule-based weight updates
│   ├── learningContext.ts         # Context window for learning loop
│   ├── strategyIntelligence.ts    # Meta-strategy selection
│   ├── evaluateDecision.ts        # Outcome evaluation of past decisions
│   ├── performance.ts             # In-memory P&L tracking
│   ├── performanceSql.ts          # SQL-backed performance queries
│   ├── saveDecision.ts            # Decision persistence (JSON + SQL)
│   ├── analyzeHistory.ts          # Historical decision analysis
│   ├── backtest.ts                # Backtest engine
│   ├── backtestRepair.ts          # Backtest data cleaning / gap repair
│   ├── datasetBuilder.ts          # Builds ML training datasets
│   ├── healthMonitor.ts           # Runtime health checks
│   ├── logger.ts                  # Structured logging
│   ├── safeMath.ts                # Numeric guards (NaN, Infinity, divide-by-zero)
│   └── bootstrap.ts               # Startup wiring
│
└── server/
    └── index.ts                   # Express API + dashboard server
```

---

## Features

- **Dual-agent analysis** — Sentiment agent (Claude) and technical agent run independently and produce signed signals.
- **Orchestrated decisioning** — A central orchestrator weights signals against past performance and applies a multi-stage risk pipeline.
- **Technical indicators from scratch** — RSI, SMA, momentum, breakout detection, pattern & trend analysis — no external TA library.
- **Machine learning loop** — Random Forest model (`ml-random-forest`) is trained on labelled decision history and used to score new signals; auto-retrains on a schedule.
- **Market regime detection** — Trades are gated by detected regime (trend / range / chop / dead market).
- **Layered risk management** — Loss cooldown, inactivity guard, volatility/liquidity filters, and a `riskManager` that handles sizing and exposure caps.
- **Self-evaluation** — Each closed decision is evaluated; the result feeds both rule-based weights and the ML dataset.
- **Backtest engine** — Replays historical data through the full pipeline; includes a repair pass to handle gaps and bad ticks.
- **SQLite persistence** — Uses Node's built-in `node:sqlite` (Node 22+) — zero native deps, single file at `data/trader.db`.
- **REST API + dashboard** — Express server with a static dashboard (`public/`) for live decisions, metrics and controls.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js **22+** (uses built-in `node:sqlite`) |
| API & Server | Express |
| LLM | Anthropic Claude (configurable via `.env`) |
| ML | `ml-random-forest` |
| HTTP Client | Axios |
| Persistence | SQLite (`node:sqlite`) + JSON snapshots |
| Frontend | Vanilla HTML/CSS/JS dashboard |

---

## Getting Started

### Prerequisites

```bash
node >= 22       # required for built-in node:sqlite
npm
```

### Installation

```bash
git clone https://github.com/SadDako/ai-trader.git
cd ai-trader
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your API key
```

### Environment Variables

```env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

### Run

```bash
# Development (CLI loop)
npm run dev

# Web dashboard + API
npm run web

# Production build
npm run build
npm run serve
```

The dashboard is served on the port configured in the Express server (`src/server/index.ts`).

---

## How It Works

1. **Market data** is fetched and normalised by `market.service.ts`.
2. **Market regime** is detected — strategy gates open or stay shut accordingly.
3. **Sentiment agent** receives market context and asks Claude for a directional read.
4. **Technical agent** computes RSI, SMA, momentum, breakout, patterns and trend from raw OHLCV.
5. **ML predictor** scores the combined signal against a Random Forest trained on past outcomes.
6. **Orchestrator** weighs all three sources, applies `marketQuality` and `marketFilters`, and produces a candidate decision.
7. **Risk pipeline** runs: loss cooldown → inactivity → risk manager → exploration enforcement.
8. **Decision is persisted** to SQLite and JSON for audit, backtest and future training.
9. **Evaluation** runs against subsequent ticks; outcome feeds back into both rule weights and the ML training set.
10. **Auto-retrain** rebuilds the model when enough new labelled data accumulates.

---

## Technical Highlights

- **Agent pattern with orchestration** — Each agent owns one concern; the orchestrator owns synthesis and decisioning.
- **Hybrid scoring** — Rule-based weights *and* a Random Forest model vote on every decision, balancing interpretability with adaptivity.
- **Regime-aware** — The same input produces different output depending on detected market regime; this prevents over-trading in dead markets.
- **Self-correcting** — Outcome evaluation rewrites both rule weights and ML training labels — the system improves without human tuning.
- **Backtest-first** — Any strategy change can be validated on historical data through the same pipeline used in production.
- **Zero-native-deps persistence** — `node:sqlite` (Node 22+) means no `better-sqlite3` compile step; container-friendly.
- **Strictly typed** — TypeScript end-to-end; interfaces for market data, signals, decisions, and performance.

---

## Project Structure (high-level)

```
.
├── data/                # runtime artefacts: SQLite DB, decision snapshots, ML models (gitignored)
├── logs/                # runtime logs (gitignored)
├── public/              # static dashboard (HTML/CSS/JS)
├── src/                 # application source (see Architecture above)
├── .env.example         # template for environment variables
├── package.json
└── tsconfig.json
```

> `data/` and `logs/` are runtime-generated and excluded from git on purpose.

---

## Roadmap

- Pluggable exchange execution layer
- Multi-asset portfolio orchestration
- Online learning (incremental updates without full retrain)
- Strategy versioning and A/B comparison through the dashboard

---

## License

MIT
