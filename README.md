# AI Trader

> Autonomous multi-agent trading system that combines LLM-powered analysis with real-time market data, technical indicators, and self-learning decision logic.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![OpenAI](https://img.shields.io/badge/LLM%20Powered-412991?style=flat&logo=openai&logoColor=white)

---

## Overview

AI Trader is a backend automation system for algorithmic trading. It uses a **multi-agent orchestration architecture** where a sentiment agent and a technical analysis agent independently evaluate market conditions. The orchestrator synthesises both signals and applies reinforcement-style learning logic to make — or skip — trade execution decisions.

The system persists decision history, tracks performance metrics, and adjusts its exploration/exploitation balance over time to improve execution quality.

---

## Architecture

```
src/
├── agents/
│   ├── sentimento.agent.ts    # LLM-powered sentiment analysis agent
│   └── tecnico.agent.ts       # Technical indicators analysis agent
│
├── orchestrator/
│   └── trading.orchestrator.ts  # Coordinates agents & makes final decisions
│
├── services/
│   ├── ai.service.ts          # LLM API integration (OpenAI/compatible)
│   └── market.service.ts      # Real-time market data ingestion
│
├── state/
│   └── marketMemory.ts        # Persistent market state across cycles
│
├── utils/
│   ├── rsi.ts                 # Relative Strength Index
│   ├── sma.ts                 # Simple Moving Average
│   ├── momentum.ts            # Momentum calculation
│   ├── breakout.ts            # Breakout detection
│   ├── patternAnalysis.ts     # Pattern recognition
│   ├── trendAnalysis.ts       # Trend direction analysis
│   ├── learning.ts            # Adaptive learning logic
│   ├── evaluateDecision.ts    # Decision quality evaluation
│   ├── score.ts               # Composite signal scoring
│   ├── performance.ts         # P&L and performance tracking
│   ├── lossCooldown.ts        # Risk management: loss cooldown
│   ├── inactivityCheck.ts     # Inactivity and stale data detection
│   ├── forceExploration.ts    # Exploration forcing (anti-overfitting)
│   └── saveDecision.ts        # Decision persistence to JSON store
│
└── server/
    └── index.ts               # Express API server
```

---

## Features

- **Dual-agent analysis** — Sentiment agent (LLM) and technical agent (indicators) run independently, each producing a signal
- **Orchestrated decision-making** — The orchestrator weighs both agents and applies configurable rules before executing
- **Technical indicators** — RSI, SMA, momentum, breakout detection, trend analysis, pattern recognition — all implemented from scratch
- **Adaptive learning** — The system evaluates its own past decisions and adjusts scoring weights over time
- **Risk management** — Loss cooldown prevents over-trading after losses; inactivity checks avoid stale-data decisions
- **Market memory** — Persists market state and decision history across execution cycles
- **Performance tracking** — Tracks win rate, P&L, and decision quality metrics
- **REST API** — Express server exposes endpoints for triggering cycles and querying state

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| API Framework | Express |
| LLM | OpenAI API (or compatible) |
| Data | Axios (market data REST APIs) |
| Persistence | JSON store (`data/decisions.json`) |

---

## Getting Started

### Prerequisites

```bash
node >= 18
npm
```

### Installation

```bash
git clone https://github.com/SadDako/ai-trader.git
cd ai-trader
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your API keys
```

### Environment Variables

```env
OPENAI_API_KEY=your_openai_key
MARKET_API_KEY=your_market_data_key
PORT=3000
```

### Run

```bash
npm run dev
```

---

## How It Works

1. **Market data** is fetched and normalised by `market.service.ts`
2. **Sentiment agent** sends market context to the LLM and receives a directional signal
3. **Technical agent** computes RSI, SMA, momentum, breakout, and trend signals from raw OHLCV data
4. **Orchestrator** scores and weighs both signals using historical performance data
5. **Decision engine** applies risk rules (cooldown, inactivity, exploration forcing) before committing
6. **Learning module** evaluates the outcome of past decisions and updates scoring weights
7. **Decision is persisted** to the JSON store for audit and backtesting

---

## Technical Highlights

- **Agent pattern** — Separates concerns cleanly: each agent is responsible for one type of signal, the orchestrator for synthesis
- **Self-correcting logic** — The learning module uses outcome evaluation to shift the system's bias toward strategies that perform better over time
- **Exploration / exploitation balance** — `forceExploration.ts` prevents the system from getting stuck in local optima
- **Full TypeScript** — Typed throughout; interfaces for market data, signals, decisions, and performance metrics

---

## License

MIT
