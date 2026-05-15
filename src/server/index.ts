import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePerformance } from "../utils/performance.js";
import { computePerformanceSql, computeAjustePorDirecaoSql } from "../utils/performanceSql.js";
import { runBacktest } from "../utils/backtest.js";
import { countTotal as sqlCountTotal, getUniqueSymbols as sqlGetUniqueSymbols } from "../state/decisionsRepo.js";
import { analyzePerformance, computeConfidenceAdjustment } from "../utils/learningContext.js";
import { getHealth } from "../utils/healthMonitor.js";
import { logger } from "../utils/logger.js";
import { repairBacktestData, getCachedBacktestRepair } from "../utils/backtestRepair.js";
import { buildDataset, computeDatasetStats, exportDatasetCsv, exportDatasetJsonl } from "../utils/datasetBuilder.js";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { predictTradeProbability, getCurrentModelMeta } from "../ml/predictSignal.js";
import { maybeRetrain, getRetrainStatus } from "../ml/autoRetrain.js";
import { getStrategyPerformance } from "../utils/strategyIntelligence.js";
import { getCurrentMarketRegime } from "../utils/marketRegime.js";
import { assessMarketQuality, getMarketQualityStats } from "../utils/marketQuality.js";
import { getMarketData } from "../services/market.service.js";
import { getAdvancedPortfolioAnalytics, getExchangeConditions, getExecutionAnalytics, getExecutionHealth, getLiveExecutionState, getOpenPositionSymbols, getTradeTimeline, updateIntrabarFromMarketData } from "../execution/executionEngine.js";
import { getAdaptivePortfolioBrain, recentMetaBrainLogs } from "../meta/metaPerformance.js";
import { runMonteCarlo } from "../quant/monteCarlo.js";

interface RawDecision {
  [key: string]: unknown;
}

const SIMBOLOS_PERMITIDOS = new Set<string>(["BTCUSDT", "ETHUSDT"]);

function readDecisions(filePath: string): RawDecision[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RawDecision[]) : [];
  } catch {
    return [];
  }
}

function isSimboloPermitido(ativo: unknown): ativo is string {
  return typeof ativo === "string" && SIMBOLOS_PERMITIDOS.has(ativo.toUpperCase());
}

export interface ServerHandle {
  port: number;
  close: () => void;
}

export function startServer(port?: number): ServerHandle {
  const PORT = port ?? Number(process.env.WEB_PORT ?? 3000);
  const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
  const PUBLIC_DIR = resolve(process.cwd(), "public");

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Wrapper que registra com try/catch — se um handler explodir o servidor sobe sem rota fantasma
  const safeGet = (path: string, handler: express.RequestHandler): void => {
    try {
      app.get(path, handler);
      console.log(`[BOOT] route registered: GET ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BOOT] FALHA ao registrar GET ${path}: ${msg}`);
      logger.error("web.boot", `GET ${path} não registrada: ${msg}`);
    }
  };
  const safePost = (path: string, handler: express.RequestHandler): void => {
    try {
      app.post(path, handler);
      console.log(`[BOOT] route registered: POST ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BOOT] FALHA ao registrar POST ${path}: ${msg}`);
      logger.error("web.boot", `POST ${path} não registrada: ${msg}`);
    }
  };
  void safeGet; void safePost;

  app.use(express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
    }
  }));

  app.get("/decisions", (req, res) => {
    res.set("Cache-Control", "no-store");
    const all = readDecisions(DECISIONS_FILE).filter((d) => isSimboloPermitido(d.ativo));
    const raw = req.query.symbol;
    const symbol = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!symbol) {
      res.json(all);
      return;
    }
    if (!SIMBOLOS_PERMITIDOS.has(symbol)) {
      res.json([]);
      return;
    }
    const filtered = all.filter((d) => typeof d.ativo === "string" && d.ativo.toUpperCase() === symbol);
    res.json(filtered);
  });

  app.get("/symbols", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const all = readDecisions(DECISIONS_FILE);
    const set = new Set<string>();
    for (const d of all) {
      if (isSimboloPermitido(d.ativo)) set.add(d.ativo.toUpperCase());
    }
    // garante ordem estável BTC, ETH
    const ordered = ["BTCUSDT", "ETHUSDT"].filter((s) => set.has(s));
    res.json(ordered);
  });

  app.get("/performance", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(computePerformance());
  });

  app.get("/performance-sql", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(computePerformanceSql());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/backtest", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(runBacktest());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/learning-sql", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(computeAjustePorDirecaoSql());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/learning-context", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const perf = analyzePerformance();
      res.json(perf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/learning-adjust", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const decisao = String(req.query.decisao ?? "esperar");
      const tendencia = String(req.query.tendencia ?? "lateral");
      const rsi = Number(req.query.rsi ?? 50);
      const momentum = Number(req.query.momentum ?? 0);
      res.json(computeConfidenceAdjustment({ decisao, tendencia, rsi, momentum }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/strategy-performance", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(getStrategyPerformance());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/market-regime", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "BTCUSDT";
      const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : "1m";
      res.json(await getCurrentMarketRegime(symbol, timeframe));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/market-quality", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "BTCUSDT";
      const timeframe = typeof req.query.timeframe === "string" ? req.query.timeframe : "1m";
      const market = await getMarketData(symbol, timeframe, 120);
      res.json({ ativo: symbol.toUpperCase(), timeframe, ...assessMarketQuality(market) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/market-quality/stats", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(getMarketQualityStats());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/execution/live", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
      const updateSymbols = new Set<string>(getOpenPositionSymbols());
      if (symbol && SIMBOLOS_PERMITIDOS.has(symbol)) updateSymbols.add(symbol);
      for (const sym of updateSymbols) {
        if (!SIMBOLOS_PERMITIDOS.has(sym)) continue;
        try {
          const market = await getMarketData(sym, "1m", 2);
          updateIntrabarFromMarketData(sym, market);
        } catch (err) {
          logger.warn("execution", `intrabar update falhou para ${sym}`, err instanceof Error ? err.message : String(err));
        }
      }
      res.json(getLiveExecutionState(symbol || undefined));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/execution/timeline", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const positionId = typeof _req.query.positionId === "string" ? _req.query.positionId : undefined;
      res.json(getTradeTimeline(positionId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/execution/analytics", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(getExecutionAnalytics());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/execution/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(getExecutionHealth());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/exchange/conditions", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(getExchangeConditions());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/portfolio/analytics", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(getAdvancedPortfolioAnalytics());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/quant/monte-carlo", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const iterations = req.query.iterations !== undefined ? Number(req.query.iterations) : 1000;
      const horizon = req.query.horizonTrades !== undefined ? Number(req.query.horizonTrades) : 120;
      res.json(runMonteCarlo(iterations, horizon));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/meta/brain", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
      let market;
      if (symbol && SIMBOLOS_PERMITIDOS.has(symbol)) {
        try {
          market = await getMarketData(symbol, "1m", 120);
        } catch (err) {
          logger.warn("meta.brain", `market context indisponível para ${symbol}`, err instanceof Error ? err.message : String(err));
        }
      }
      res.json(getAdaptivePortfolioBrain({ ativo: symbol || undefined, market }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/meta/logs", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 30;
      res.json({ source: "meta-brain", logs: recentMetaBrainLogs(limit) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/repair-backtest", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const result = repairBacktestData();
      logger.info("repair", "endpoint POST /repair-backtest executado", {
        validos: result.tradesValidos,
        descartados: result.tradesDescartados
      });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("repair", `falhou: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/repair-backtest", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const cached = getCachedBacktestRepair();
      const result = cached ?? repairBacktestData();
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/dataset/stats", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(computeDatasetStats());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("dataset", `stats falhou: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/dataset/export", (req, res) => {
    res.set("Cache-Control", "no-store");
    const format = String(req.query.format ?? "csv").toLowerCase();
    try {
      const samples = buildDataset();
      const result = format === "jsonl" ? exportDatasetJsonl(samples) : exportDatasetCsv(samples);
      const filename = basename(result.path);
      const mime = format === "jsonl" ? "application/x-ndjson" : "text/csv";
      res.set("Content-Type", mime + "; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${filename}"`);
      res.set("X-Dataset-Rows", String(result.rows));
      res.set("X-Dataset-Bytes", String(result.bytes));
      createReadStream(result.path).pipe(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("dataset", `export falhou: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/ml/status", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const meta = getCurrentModelMeta();
      const retrain = getRetrainStatus();
      res.json({ model: meta, retrain });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/ml/predict", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const ctx = {
        rsi: req.query.rsi !== undefined ? Number(req.query.rsi) : undefined,
        atr: req.query.atr !== undefined ? Number(req.query.atr) : undefined,
        atrPct: req.query.atrPct !== undefined ? Number(req.query.atrPct) : undefined,
        momentum: req.query.momentum !== undefined ? Number(req.query.momentum) : undefined,
        intensidade: req.query.intensidade !== undefined ? Number(req.query.intensidade) : undefined,
        smaDistPct: req.query.smaDistPct !== undefined ? Number(req.query.smaDistPct) : undefined,
        confianca: req.query.confianca !== undefined ? Number(req.query.confianca) : undefined,
        edgeScore: req.query.edgeScore !== undefined ? Number(req.query.edgeScore) : undefined,
        tendencia: typeof req.query.tendencia === "string" ? req.query.tendencia : undefined,
        direcao: typeof req.query.direcao === "string" ? req.query.direcao : undefined,
        setup: typeof req.query.setup === "string" ? req.query.setup : undefined
      };
      res.json(predictTradeProbability(ctx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/ml/retrain", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const result = await maybeRetrain(true);
      logger.info("ml", "retrain manual via POST /ml/retrain", result || {});
      res.json(result || { ok: false, error: "retrain em progresso ou indisponível" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("ml", `retrain endpoint falhou: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const h = getHealth();
      res.status(h.online ? 200 : 503).json(h);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ online: false, error: msg });
    }
  });

  app.get("/db-stats", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json({
        totalDecisoes: sqlCountTotal(),
        ativos: sqlGetUniqueSymbols(),
        engine: "node:sqlite"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Endpoint de introspecção — lista todas as rotas registradas (ajuda diagnóstico)
  app.get("/__routes", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ routes: listRoutes(app) });
  });

  // Boot summary com lista completa de rotas
  const rotas = listRoutes(app);
  console.log(`[BOOT] ${rotas.length} rotas registradas:`);
  for (const r of rotas) console.log(`[BOOT] route registered: ${r.methods.join(",")} ${r.path}`);
  logger.info("web.boot", `rotas registradas: ${rotas.length}`, { routes: rotas });

  const server = app.listen(PORT, () => {
    console.log(`[web] Dashboard em http://localhost:${PORT}`);
    logger.info("web", `Dashboard online em http://localhost:${PORT}`, {
      pid: process.pid,
      rotas: rotas.length,
      versaoServidor: SERVER_VERSION
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[web] FATAL: porta ${PORT} já está em uso por outro processo — esta instância NÃO está servindo HTTP.\n` +
          `[web] Possível causa: instância antiga zumbi com versão antiga do código (sem rotas /ml/* /dataset/* etc).\n` +
          `[web] Liberar a porta:\n` +
          `      Get-Process node | Where-Object {$_.Path -like '*node*'} | Stop-Process -Force\n` +
          `      ou: netstat -ano | findstr :${PORT} → tasklist | findstr <pid> → taskkill /F /PID <pid>`
      );
      logger.error("web", `EADDRINUSE na porta ${PORT} — instância NÃO atende HTTP. PID atual: ${process.pid}`);
    } else {
      console.error(`[web] Erro no servidor:`, err.message);
      logger.error("web", err.message);
    }
  });

  return { port: PORT, close: () => server.close() };
}

interface RouteInfo { path: string; methods: string[]; }

// Compatível com Express 4 (_router.stack) E Express 5 (router.stack)
function listRoutes(app: express.Express): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const candidate =
    (app as unknown as { router?: { stack?: unknown[] } }).router ??
    (app as unknown as { _router?: { stack?: unknown[] } })._router;
  const stack = (candidate && Array.isArray(candidate.stack)) ? candidate.stack : [];
  for (const raw of stack) {
    const layer = raw as { route?: { path: string | string[]; methods?: Record<string, boolean>; stack?: Array<{ method?: string }> } };
    if (!layer.route) continue;
    const path = Array.isArray(layer.route.path) ? layer.route.path.join("|") : layer.route.path;
    if (typeof path !== "string") continue;
    const methodsObj = layer.route.methods || {};
    let methods = Object.keys(methodsObj).filter((m) => methodsObj[m]).map((m) => m.toUpperCase());
    if (methods.length === 0 && Array.isArray(layer.route.stack)) {
      // Express 5: methods migraram pra layer.route.stack[].method
      methods = layer.route.stack
        .map((s) => (s.method || "").toUpperCase())
        .filter(Boolean);
    }
    routes.push({ path, methods });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

const SERVER_VERSION = "2026.05.07-ml-v1";

// auto-start quando executado como entry point (npm run web)
const entry = process.argv[1] ? fileURLToPath("file://" + process.argv[1].replace(/\\/g, "/")) : "";
const self = fileURLToPath(import.meta.url);
if (entry === self) {
  startServer();
}
