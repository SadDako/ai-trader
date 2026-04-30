import dotenv from "dotenv";
import { runTradingCycle } from "./orchestrator/trading.orchestrator.js";
import { saveDecision } from "./utils/saveDecision.js";

dotenv.config({ override: true });

const CYCLE_INTERVAL_MS = 30_000;
const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

let stopping = false;

function logErro(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[${scope}] Erro capturado: ${msg}`);
}

function parseSymbols(argv: string[]): string[] {
  const args = argv.slice(2).flatMap((a) => a.split(",")).map((a) => a.trim().toUpperCase()).filter(Boolean);
  return args.length > 0 ? args : DEFAULT_SYMBOLS;
}

async function executarCicloAtivo(symbol: string): Promise<void> {
  try {
    const resultado = await runTradingCycle(symbol);

    const record = saveDecision({
      ativo: resultado.ativo,
      decisao: resultado.decisao,
      confianca: resultado.confianca,
      analise: resultado.analise,
      precoEntrada: resultado.precoEntrada,
      rsi: resultado.rsi,
      momentum: resultado.momentum,
      intensidade: resultado.intensidade
    });

    console.log(
      `[${record.timestamp}] ativo=${resultado.ativo} | decisão=${resultado.decisao} | confiança=${resultado.confianca} | preço=${resultado.precoEntrada}`
    );
  } catch (err) {
    logErro(`ciclo:${symbol}`, err);
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
      await new Promise((resolve) => setTimeout(resolve, CYCLE_INTERVAL_MS));
    } catch (err) {
      logErro("loop:wait", err);
    }
  }
}

async function main(): Promise<void> {
  const symbols = parseSymbols(process.argv);
  console.log(
    `[Draxon Trader AI] Iniciando loop a cada ${CYCLE_INTERVAL_MS / 1000}s para ${symbols.join(", ")}. Ctrl+C para parar.`
  );

  process.on("SIGINT", () => {
    console.log("\n[Draxon Trader AI] Interrompendo após o ciclo atual...");
    stopping = true;
  });

  process.on("uncaughtException", (err) => {
    logErro("uncaughtException", err);
  });

  process.on("unhandledRejection", (reason) => {
    logErro("unhandledRejection", reason);
  });

  await loop(symbols);
  console.log("[Draxon Trader AI] Loop encerrado.");
}

main().catch((err: unknown) => {
  logErro("main", err);
});
