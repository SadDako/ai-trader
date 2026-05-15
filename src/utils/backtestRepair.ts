import { db } from "../state/database.js";
import { safeNumber, safeRound, clamp, clampNonNegative } from "./safeMath.js";
import { logger } from "./logger.js";
import { computeTradeMetrics, getInitialBalance } from "./riskManager.js";

const SALDO_INICIAL = getInitialBalance();
const TAXA_OPERACAO_PCT = 0.1;
const TAXA_TOTAL_PCT = TAXA_OPERACAO_PCT * 2;
const SLIPPAGE_PCT = 0.05;
const RETORNO_MAX_PCT = 100;        // |return %| > 100 vira corrompido
const RETORNO_MIN_PCT = -100;
const SALDO_FLOOR = 0;              // bankruptcy — não desce abaixo
const SIMBOLOS_PERMITIDOS = new Set<string>(["BTCUSDT", "ETHUSDT"]);

interface TradeRow {
  id: number;
  ativo: string;
  decisao: string;
  resultado: string;
  preco_entrada: number;
  preco_atual: number;
  timestamp: string;
  avaliada: number;
  lucro_prejuizo?: number | null;
  position_size?: number | null;
  notional?: number | null;
  risk_amount?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
}

interface DescartadoMotivo {
  id: number;
  ativo: string;
  timestamp: string;
  motivo: string;
}

export interface AtivoMetrics {
  ativo: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  saldoInicial: number;
  saldoFinal: number;
  retornoTotalPct: number;
  drawdownMaxPct: number;
}

export interface BacktestRepairResult {
  saldoInicial: number;
  saldoFinal: number;
  lucroPct: number;
  prejuizoPct: number;
  retornoTotalPct: number;
  drawdownMaxPct: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  sharpeSimplificado: number;
  maxLossStreak: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  equityCurve: Array<{ timestamp: string; ativo: string; equity: number; retornoPct: number }>;
  tradesValidos: number;
  tradesDescartados: number;
  motivosDescarte: DescartadoMotivo[];
  porAtivo: AtivoMetrics[];
  geradoEm: string;
}

const stmtAllOps = db.prepare(`
  SELECT id, ativo, decisao, resultado, preco_entrada, preco_atual, timestamp, avaliada,
         lucro_prejuizo, position_size, notional, risk_amount, stop_loss, take_profit
  FROM decisions
  WHERE avaliada = 1 AND (decisao = 'compra' OR decisao = 'venda')
  ORDER BY datetime(timestamp) ASC, id ASC
`);

function tradeReturnPctLiquido(decisao: string, precoEntrada: number, precoAtual: number): number {
  const pe = safeNumber(precoEntrada);
  const pa = safeNumber(precoAtual);
  if (pe <= 0 || pa <= 0) return NaN; // sinaliza inválido
  const slip = SLIPPAGE_PCT / 100;
  let bruto = 0;
  if (decisao === "compra") {
    const entrada = pe * (1 + slip);
    const saida = pa * (1 - slip);
    bruto = ((saida - entrada) / entrada) * 100;
  } else if (decisao === "venda") {
    const entrada = pe * (1 - slip);
    const saida = pa * (1 + slip);
    bruto = ((entrada - saida) / entrada) * 100;
  } else {
    return NaN;
  }
  const liquido = bruto - TAXA_TOTAL_PCT;
  return Number.isFinite(liquido) ? liquido : NaN;
}

function tradePnlDollars(row: TradeRow, saldoAntes: number): number {
  const pnlReal = Number(row.lucro_prejuizo);
  if (row.lucro_prejuizo !== null && row.lucro_prejuizo !== undefined && Number.isFinite(pnlReal)) return pnlReal;
  const retPct = tradeReturnPctLiquido(row.decisao, row.preco_entrada, row.preco_atual);
  if (!Number.isFinite(retPct)) return NaN;
  const notional = Number(row.notional);
  if (Number.isFinite(notional) && notional > 0 && notional <= saldoAntes) return notional * (retPct / 100);
  return saldoAntes * (retPct / 100);
}

let cache: BacktestRepairResult | null = null;

export function getCachedBacktestRepair(): BacktestRepairResult | null {
  return cache;
}

export function repairBacktestData(): BacktestRepairResult {
  const rows = stmtAllOps.all() as unknown as TradeRow[];
  logger.info("repair", `executando repair sobre ${rows.length} trades brutos`);

  const motivos: DescartadoMotivo[] = [];
  const dedupKey = new Set<string>();
  const validos: TradeRow[] = [];

  for (const r of rows) {
    const ativo = (r.ativo || "").toString().toUpperCase();
    const dec = r.decisao;
    const pe = Number(r.preco_entrada);
    const pa = Number(r.preco_atual);

    if (!ativo) {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: "ativo vazio" });
      continue;
    }
    if (!SIMBOLOS_PERMITIDOS.has(ativo)) {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: `ativo fora da whitelist (${ativo})` });
      continue;
    }
    if (dec !== "compra" && dec !== "venda") {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: `decisao inválida: ${dec}` });
      continue;
    }
    if (!Number.isFinite(pe) || !Number.isFinite(pa) || pe <= 0 || pa <= 0) {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: "preco_entrada/atual inválido (NaN/Inf/<=0)" });
      continue;
    }

    const key = `${ativo}:${r.timestamp}`;
    if (dedupKey.has(key)) {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: "duplicado" });
      continue;
    }
    dedupKey.add(key);

    const ret = tradeReturnPctLiquido(dec, pe, pa);
    if (!Number.isFinite(ret)) {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: "retorno NaN/Infinity" });
      continue;
    }
    if (ret > RETORNO_MAX_PCT || ret < RETORNO_MIN_PCT) {
      motivos.push({ id: r.id, ativo, timestamp: r.timestamp, motivo: `retorno fora dos limites (${ret.toFixed(2)}%)` });
      continue;
    }

    validos.push(r);
  }

  // Replay compound com PnL real quando disponivel; fallback preserva registros antigos.
  let saldo = SALDO_INICIAL;
  let saldoMax = SALDO_INICIAL;
  let drawdownMaxPct = 0;
  let lucroPct = 0;
  let prejuizoPct = 0;
  let wins = 0;
  let losses = 0;
  const pnls: number[] = [];

  const equityCurve: BacktestRepairResult["equityCurve"] = [];
  const porAtivoAcc = new Map<string, {
    ativo: string; trades: number; wins: number; losses: number;
    saldoInicial: number; saldo: number; saldoMax: number; ddMax: number;
  }>();

  for (const t of validos) {
    const ativo = t.ativo.toUpperCase();
    const saldoAntes = saldo;
    let pnl = tradePnlDollars(t, saldoAntes);
    if (!Number.isFinite(pnl)) pnl = 0;
    pnl = clamp(pnl, -saldoAntes, saldoAntes);
    const retClamped = saldoAntes > 0 ? clamp((pnl / saldoAntes) * 100, RETORNO_MIN_PCT, RETORNO_MAX_PCT) : 0;
    pnls.push(pnl);

    if (pnl > 0) { lucroPct += retClamped; wins += 1; }
    else if (pnl < 0) { prejuizoPct += Math.abs(retClamped); losses += 1; }

    saldo = saldo + pnl;
    if (!Number.isFinite(saldo) || saldo < SALDO_FLOOR) saldo = SALDO_FLOOR;
    saldoMax = Math.max(saldoMax, saldo);
    const dd = saldoMax > 0 ? ((saldoMax - saldo) / saldoMax) * 100 : 0;
    drawdownMaxPct = Math.max(drawdownMaxPct, dd);

    equityCurve.push({
      timestamp: t.timestamp,
      ativo,
      equity: safeRound(saldo, 4),
      retornoPct: safeRound(retClamped, 4)
    });

    let p = porAtivoAcc.get(ativo);
    if (!p) {
      p = { ativo, trades: 0, wins: 0, losses: 0, saldoInicial: SALDO_INICIAL, saldo: SALDO_INICIAL, saldoMax: SALDO_INICIAL, ddMax: 0 };
      porAtivoAcc.set(ativo, p);
    }
    p.trades += 1;
    if (pnl > 0) p.wins += 1;
    else if (pnl < 0) p.losses += 1;
    p.saldo = p.saldo + pnl;
    if (!Number.isFinite(p.saldo) || p.saldo < SALDO_FLOOR) p.saldo = SALDO_FLOOR;
    p.saldoMax = Math.max(p.saldoMax, p.saldo);
    const ddA = p.saldoMax > 0 ? ((p.saldoMax - p.saldo) / p.saldoMax) * 100 : 0;
    p.ddMax = Math.max(p.ddMax, ddA);
  }

  const retornoTotalPct = ((saldo - SALDO_INICIAL) / SALDO_INICIAL) * 100;
  const metricas = computeTradeMetrics(pnls, equityCurve.map((p) => ({ equity: p.equity })));

  const porAtivo: AtivoMetrics[] = [];
  for (const p of porAtivoAcc.values()) {
    const retornoAtivo = ((p.saldo - p.saldoInicial) / p.saldoInicial) * 100;
    porAtivo.push({
      ativo: p.ativo,
      trades: p.trades,
      wins: p.wins,
      losses: p.losses,
      winRate: p.trades > 0 ? safeRound((p.wins / p.trades) * 100) : 0,
      saldoInicial: p.saldoInicial,
      saldoFinal: safeRound(p.saldo, 2),
      retornoTotalPct: safeRound(retornoAtivo, 2),
      drawdownMaxPct: safeRound(p.ddMax, 2)
    });
  }
  porAtivo.sort((a, b) => a.ativo.localeCompare(b.ativo));

  const result: BacktestRepairResult = {
    saldoInicial: SALDO_INICIAL,
    saldoFinal: safeRound(clampNonNegative(saldo), 2),
    lucroPct: safeRound(lucroPct, 2),
    prejuizoPct: safeRound(prejuizoPct, 2),
    retornoTotalPct: safeRound(retornoTotalPct, 2),
    drawdownMaxPct: safeRound(drawdownMaxPct, 2),
    profitFactor: Number.isFinite(metricas.profitFactor) ? metricas.profitFactor : 999,
    expectancy: metricas.expectancy,
    maxDrawdown: metricas.maxDrawdown,
    sharpeSimplificado: metricas.sharpeSimplificado,
    maxLossStreak: metricas.maxLossStreak,
    totalTrades: validos.length,
    wins,
    losses,
    winRate: validos.length > 0 ? safeRound((wins / validos.length) * 100) : 0,
    equityCurve,
    tradesValidos: validos.length,
    tradesDescartados: motivos.length,
    motivosDescarte: motivos.slice(0, 200), // limita payload
    porAtivo,
    geradoEm: new Date().toISOString()
  };

  cache = result;
  logger.info("repair", "concluído", {
    validos: result.tradesValidos,
    descartados: result.tradesDescartados,
    saldoFinal: result.saldoFinal,
    drawdown: result.drawdownMaxPct
  });
  return result;
}
