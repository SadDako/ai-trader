import { runTradingCycle } from "./orchestrator/trading.orchestrator";
import { saveDecision } from "./utils/saveDecision";
import { startServer } from "./server/index";
import { logger } from "./utils/logger";
import { heartbeat, recordError, startWatchdog } from "./utils/healthMonitor";
import { safeNumber } from "./utils/safeMath";
import { startAutoRetrainLoop } from "./ml/autoRetrain";
import { validateEnvironment } from "./config/env";

const CYCLE_INTERVAL_MS = 30_000;
const PER_ATIVO_TIMEOUT_MS = 60_000;
const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let stopping = false;

function logErro(scope: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[${scope}] Erro capturado: ${msg}`);
  recordError(scope, err);
}

function parseSymbols(argv: string[]): string[] {
  const args = argv
    .slice(2)
    .flatMap((a) => a.split(","))
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean);
  return args.length > 0 ? args : DEFAULT_SYMBOLS;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${ms}ms em ${label}`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function executarCicloAtivo(symbol: string): Promise<void> {
  try {
    const resultado = await withTimeout(runTradingCycle(symbol), PER_ATIVO_TIMEOUT_MS, `runTradingCycle(${symbol})`);

    let record;
    try {
      record = saveDecision({
        ativo: resultado.ativo,
        decisao: resultado.decisao,
        confianca: safeNumber(resultado.confianca, 0),
        analise: resultado.analise,
        precoEntrada: safeNumber(resultado.precoEntrada, 0),
        rsi: safeNumber(resultado.rsi, 50),
        momentum: safeNumber(resultado.momentum, 0),
        intensidade: safeNumber(resultado.intensidade, 0),
        atr: safeNumber(resultado.atr, 0),
        atrPct: safeNumber(resultado.atrPct, 0),
        volumeRelativo: safeNumber(resultado.volumeRelativo, 0),
        drawdownAtual: safeNumber(resultado.drawdownAtual, 0),
        setup: resultado.setup,
        timeframe: resultado.timeframe,
        edgeScore: safeNumber(resultado.edgeScore, 0),
        regime: resultado.regime,
        regimeConfidence: safeNumber(resultado.regimeConfidence, 0),
        marketQualityScore: safeNumber(resultado.marketQualityScore, 50),
        marketQualityLabel: resultado.marketQualityLabel
      });
    } catch (saveErr) {
      logErro(`saveDecision:${symbol}`, saveErr);
      return;
    }

    console.log(
      `[${record.timestamp}] ativo=${resultado.ativo} | decisão=${resultado.decisao} | confiança=${resultado.confianca} | preço=${resultado.precoEntrada}`
    );
  } catch (err) {
    logErro(`ciclo:${symbol}`, err);
  } finally {
    heartbeat();
  }
}

async function executarCicloCompleto(symbols: string[]): Promise<void> {
  for (const symbol of symbols) {
    if (stopping) break;
    try {
      await executarCicloAtivo(symbol);
    } catch (err) {
      logErro(`ciclo:${symbol}`, err);
    }
  }
}

async function loop(symbols: string[]): Promise<void> {
  while (!stopping) {
    try {
      await executarCicloCompleto(symbols);
    } catch (err) {
      logErro("loop", err);
    }

    if (stopping) break;

    try {
      heartbeat(); // pulse antes do sleep — detecta sleep travado
      await new Promise((resolve) => setTimeout(resolve, CYCLE_INTERVAL_MS));
    } catch (err) {
      logErro("loop:wait", err);
    }
  }
}

async function main(): Promise<void> {
  const envWarnings = validateEnvironment();
  for (const warning of envWarnings) {
    console.warn(`[security] ${warning}`);
    logger.warn("security.env", warning);
  }

  const symbols = parseSymbols(process.argv);
  const startMsg = `Iniciando loop a cada ${CYCLE_INTERVAL_MS / 1000}s para ${symbols.join(", ")}`;
  console.log(`[Draxon Trader AI] ${startMsg}. Ctrl+C para parar.`);
  logger.info("main", startMsg);

  process.on("SIGINT", () => {
    console.log("\n[Draxon Trader AI] Interrompendo após o ciclo atual...");
    logger.info("main", "SIGINT recebido — encerrando após ciclo atual");
    stopping = true;
  });

  process.on("SIGTERM", () => {
    logger.info("main", "SIGTERM recebido — encerrando após ciclo atual");
    stopping = true;
  });

  process.on("uncaughtException", (err) => {
    logErro("uncaughtException", err);
  });

  process.on("unhandledRejection", (reason) => {
    logErro("unhandledRejection", reason);
  });

  // Sobe o dashboard web no mesmo processo
  try {
    startServer();
  } catch (err) {
    logErro("web-server", err);
  }

  // Watchdog — se loop travar > 90s, registra warning
  startWatchdog((idleMs) => {
    const sec = Math.round(idleMs / 1000);
    console.warn(`[watchdog] loop sem heartbeat há ${sec}s — forçando heartbeat de recuperação`);
    logger.warn("watchdog", `recuperação automática após ${sec}s sem heartbeat`);
    heartbeat();
  });

  // ML auto-retrain — checa periodicamente se vale re-treinar
  try {
    startAutoRetrainLoop();
  } catch (errML) {
    logErro("ml.autoRetrain", errML);
  }

  // Loop principal — try/catch externo garante que NUNCA mata o processo
  while (!stopping) {
    try {
      await loop(symbols);
      break; // saída normal via SIGINT
    } catch (err) {
      logErro("loop:fatal", err);
      logger.error("main", "loop principal lançou exceção, reiniciando em 5s");
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  console.log("[Draxon Trader AI] Loop encerrado.");
  logger.info("main", "Loop encerrado");
}

main().catch((err: unknown) => {
  logErro("main", err);
  // Não chama process.exit — mantém o processo vivo (server pode estar rodando)
});
