import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BREAKEVEN_ATR_MULTIPLIER,
  DAILY_LOSS_LIMIT_PCT,
  FEE_PCT,
  LOSS_COOLDOWN_CANDLES,
  PARTIAL_ATR_MULTIPLIER,
  PARTIAL_EXIT_FRACTION,
  RISK_PER_TRADE_PCT,
  SLIPPAGE_PCT,
  calculateRiskPlan,
  computeTradeMetrics,
  feeForNotional,
  getInitialBalance,
  grossPnl,
  type TradeDirection
} from "./riskManager.js";

const DATA_DIR = resolve(process.cwd(), "data");
const DECISIONS_FILE = resolve(DATA_DIR, "decisions.json");
const BACKTEST_FILE = resolve(DATA_DIR, "backtest.json");

const SALDO_INICIAL = getInitialBalance();
const RISCO_POR_TRADE_PCT = RISK_PER_TRADE_PCT;
const TAXA_OPERACAO_PCT = FEE_PCT;

type Direcao = "LONG" | "SHORT";
type MotivoSaida = "venda" | "compra" | "stop_loss" | "take_profit" | "take_partial" | "trailing_stop";

interface RawDecision {
  ativo?: unknown;
  decisao?: unknown;
  precoEntrada?: unknown;
  precoAtual?: unknown;
  timestamp?: unknown;
  avaliada?: unknown;
  avaliado?: unknown;
  stopLoss?: unknown;
  takeProfit?: unknown;
  atr?: unknown;
  positionSize?: unknown;
  remainingPositionSize?: unknown;
  notional?: unknown;
  riskAmount?: unknown;
  rr?: unknown;
}

interface OpenPosition {
  id: number;
  ativo: string;
  direcao: Direcao;
  timestampEntrada: string;
  precoReferenciaEntrada: number;
  precoEntrada: number;
  quantidade: number;
  notional: number;
  taxaEntrada: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  restante: number;
  parcialRealizada: boolean;
  trailingStopAtivo: boolean;
  saldoAntesEntrada: number;
}

export interface BacktestTrade {
  id: number;
  ativo: string;
  direcao: Direcao;
  timestampEntrada: string;
  timestampSaida: string;
  motivoSaida: MotivoSaida;
  precoEntrada: number;
  precoSaida: number;
  precoReferenciaEntrada: number;
  precoReferenciaSaida: number;
  quantidade: number;
  notional: number;
  taxaEntrada: number;
  taxaSaida: number;
  slippagePct: number;
  lucroPrejuizo: number;
  retornoPercentual: number;
  saldoAntes: number;
  saldoDepois: number;
  parcial?: boolean;
  rr?: number;
}

export interface EquityPoint {
  timestamp: string;
  saldo: number;
  equity: number;
  drawdown: number;
}

export interface BacktestResult {
  saldoInicial: number;
  saldoFinal: number;
  retornoPercentual: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  sharpeSimplificado: number;
  maxLossStreak: number;
  numeroTrades: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  posicoesAbertas: Array<{
    ativo: string;
    direcao: Direcao;
    timestampEntrada: string;
    precoEntrada: number;
    quantidade: number;
    notional: number;
    stopLoss: number;
    takeProfit: number;
  }>;
  config: {
    saldoInicial: number;
    riscoPorTradePct: number;
    taxaOperacaoPct: number;
    slippagePct: number;
    stopLossPct: number;
    takeProfitPct: number;
  };
}

function readDecisions(): RawDecision[] {
  if (!existsSync(DECISIONS_FILE)) return [];
  try {
    const raw = readFileSync(DECISIONS_FILE, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RawDecision[]) : [];
  } catch {
    return [];
  }
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundPrice(value: number): number {
  return round(value, 8);
}

function isEvaluated(decision: RawDecision): boolean {
  return decision.avaliada === true || decision.avaliado === true;
}

function normalizeSymbol(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeDecision(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseTimestamp(value: unknown, fallbackIndex: number): string {
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date(fallbackIndex).toISOString();
}

function parsePrice(decision: RawDecision): number {
  const entry = typeof decision.precoEntrada === "number" ? decision.precoEntrada : Number(decision.precoEntrada);
  if (Number.isFinite(entry) && entry > 0) return entry;

  const current = typeof decision.precoAtual === "number" ? decision.precoAtual : Number(decision.precoAtual);
  if (Number.isFinite(current) && current > 0) return current;

  return 0;
}

function applyBuySlippage(price: number): number {
  return roundPrice(price * (1 + SLIPPAGE_PCT / 100));
}

function applySellSlippage(price: number): number {
  return roundPrice(price * (1 - SLIPPAGE_PCT / 100));
}

function applyShortEntrySlippage(price: number): number {
  return roundPrice(price * (1 - SLIPPAGE_PCT / 100));
}

function applyShortExitSlippage(price: number): number {
  return roundPrice(price * (1 + SLIPPAGE_PCT / 100));
}

function entryFee(notional: number): number {
  return notional * (TAXA_OPERACAO_PCT / 100);
}

function exitFee(grossProceeds: number): number {
  return grossProceeds * (TAXA_OPERACAO_PCT / 100);
}

function liquidationValue(position: OpenPosition, referencePrice: number): number {
  const qty = Math.max(0, position.restante ?? position.quantidade);
  const ref = referencePrice > 0 ? referencePrice : position.precoEntrada;
  const isLong = position.direcao === "LONG";
  const exitPrice = isLong ? applySellSlippage(ref) : applyShortExitSlippage(ref);
  const capital = position.precoEntrada * qty;
  const pnl = grossPnl(isLong ? "compra" : "venda", position.precoEntrada, exitPrice, qty);
  return capital + pnl - exitFee(exitPrice * qty);
}

function currentEquity(cash: number, positions: Map<string, OpenPosition>, lastPriceByAsset: Map<string, number>): number {
  let equity = cash;
  for (const position of positions.values()) {
    equity += liquidationValue(position, lastPriceByAsset.get(position.ativo) ?? position.precoEntrada);
  }
  return equity;
}

function openPosition(input: {
  id: number;
  ativo: string;
  signal: string;
  decision: RawDecision;
  timestamp: string;
  referencePrice: number;
  cash: number;
  equity: number;
}): { position: OpenPosition; nextCash: number } | null {
  const direction: TradeDirection | null = input.signal === "compra" || input.signal === "venda" ? input.signal : null;
  if (!direction) return null;
  const atr = Number(input.decision.atr);
  const precoEntrada = direction === "compra" ? applyBuySlippage(input.referencePrice) : applyShortEntrySlippage(input.referencePrice);
  const plan = calculateRiskPlan({
    balance: input.equity,
    direction,
    entryPrice: precoEntrada,
    atr: Number.isFinite(atr) && atr > 0 ? atr : 0
  });
  const riskNotional = input.equity * (RISCO_POR_TRADE_PCT / 100);
  const maxAffordableNotional = input.cash / (1 + TAXA_OPERACAO_PCT / 100);
  const storedNotional = Number(input.decision.notional);
  const notional = Math.min(
    Number.isFinite(storedNotional) && storedNotional > 0 ? storedNotional : (plan?.notional ?? riskNotional),
    maxAffordableNotional,
    input.equity
  );
  if (!Number.isFinite(notional) || notional <= 0) return null;

  const taxaEntrada = entryFee(notional);
  const storedQty = Number(input.decision.positionSize);
  const quantidade = Number.isFinite(storedQty) && storedQty > 0 ? storedQty : notional / precoEntrada;
  const stopLoss = Number(input.decision.stopLoss);
  const takeProfit = Number(input.decision.takeProfit);
  const position: OpenPosition = {
    id: input.id,
    ativo: input.ativo,
    direcao: direction === "compra" ? "LONG" : "SHORT",
    timestampEntrada: input.timestamp,
    precoReferenciaEntrada: roundPrice(input.referencePrice),
    precoEntrada,
    quantidade,
    notional,
    taxaEntrada,
    stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : (plan?.stopLoss ?? precoEntrada),
    takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : (plan?.takeProfit ?? precoEntrada),
    atr: plan?.atr ?? (Number.isFinite(atr) ? atr : 0),
    restante: quantidade,
    parcialRealizada: false,
    trailingStopAtivo: false,
    saldoAntesEntrada: input.equity
  };

  return {
    position,
    nextCash: input.cash - notional - taxaEntrada
  };
}

function closePosition(input: {
  position: OpenPosition;
  timestamp: string;
  referencePrice: number;
  motivoSaida: MotivoSaida;
  cash: number;
  quantidade?: number;
}): { trade: BacktestTrade; nextCash: number } {
  const quantidade = Math.min(input.quantidade ?? input.position.restante, input.position.restante);
  const isLong = input.position.direcao === "LONG";
  const precoSaida = isLong ? applySellSlippage(input.referencePrice) : applyShortExitSlippage(input.referencePrice);
  const grossProceeds = quantidade * precoSaida;
  const taxaSaida = exitFee(grossProceeds);
  const entryFeePart = input.position.quantidade > 0
    ? input.position.taxaEntrada * (quantidade / input.position.quantidade)
    : 0;
  const lucroPrejuizo = grossPnl(isLong ? "compra" : "venda", input.position.precoEntrada, precoSaida, quantidade) - taxaSaida - entryFeePart;
  const capital = input.position.precoEntrada * quantidade;
  const nextCash = input.cash + capital + lucroPrejuizo;
  const retornoPercentual = capital > 0
    ? (lucroPrejuizo / capital) * 100
    : 0;

  return {
    nextCash,
    trade: {
      id: input.position.id,
      ativo: input.position.ativo,
      direcao: input.position.direcao,
      timestampEntrada: input.position.timestampEntrada,
      timestampSaida: input.timestamp,
      motivoSaida: input.motivoSaida,
      precoEntrada: input.position.precoEntrada,
      precoSaida,
      precoReferenciaEntrada: input.position.precoReferenciaEntrada,
      precoReferenciaSaida: roundPrice(input.referencePrice),
      quantidade: round(quantidade, 8),
      notional: round(capital),
      taxaEntrada: round(entryFeePart),
      taxaSaida: round(taxaSaida),
      slippagePct: SLIPPAGE_PCT,
      lucroPrejuizo: round(lucroPrejuizo),
      retornoPercentual: round(retornoPercentual, 4),
      saldoAntes: round(input.position.saldoAntesEntrada),
      saldoDepois: round(nextCash),
      parcial: quantidade < input.position.quantidade,
      rr: input.position.atr > 0 ? round(Math.abs(input.position.takeProfit - input.position.precoEntrada) / Math.abs(input.position.precoEntrada - input.position.stopLoss), 4) : undefined
    }
  };
}

function exitByRisk(position: OpenPosition, referencePrice: number): { price: number; reason: MotivoSaida } | null {
  if (position.direcao === "LONG") {
    if (referencePrice >= position.takeProfit) return { price: position.takeProfit, reason: "take_profit" };
    if (referencePrice <= position.stopLoss) return { price: position.stopLoss, reason: position.trailingStopAtivo ? "trailing_stop" : "stop_loss" };
  } else {
    if (referencePrice <= position.takeProfit) return { price: position.takeProfit, reason: "take_profit" };
    if (referencePrice >= position.stopLoss) return { price: position.stopLoss, reason: position.trailingStopAtivo ? "trailing_stop" : "stop_loss" };
  }
  return null;
}

function emptyResult(): BacktestResult {
  return {
    saldoInicial: SALDO_INICIAL,
    saldoFinal: SALDO_INICIAL,
    retornoPercentual: 0,
    maxDrawdown: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
    sharpeSimplificado: 0,
    maxLossStreak: 0,
    numeroTrades: 0,
    trades: [],
    equityCurve: [],
    posicoesAbertas: [],
    config: {
      saldoInicial: SALDO_INICIAL,
      riscoPorTradePct: RISCO_POR_TRADE_PCT,
      taxaOperacaoPct: TAXA_OPERACAO_PCT,
      slippagePct: SLIPPAGE_PCT,
      stopLossPct: 0,
      takeProfitPct: 0
    }
  };
}

function persistBacktest(result: BacktestResult): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BACKTEST_FILE, JSON.stringify(result, null, 2), "utf-8");
}

export function runBacktest(): BacktestResult {
  const decisions = readDecisions()
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => isEvaluated(decision))
    .sort((a, b) => {
      const ta = new Date(parseTimestamp(a.decision.timestamp, a.index)).getTime();
      const tb = new Date(parseTimestamp(b.decision.timestamp, b.index)).getTime();
      return ta === tb ? a.index - b.index : ta - tb;
    });

  if (decisions.length === 0) {
    const result = emptyResult();
    persistBacktest(result);
    return result;
  }

  let cash = SALDO_INICIAL;
  let nextTradeId = 1;
  let peakEquity = SALDO_INICIAL;
  let maxDrawdown = 0;
  const positions = new Map<string, OpenPosition>();
  const lastPriceByAsset = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const cooldownUntilByAsset = new Map<string, number>();
  const dailyPnl = new Map<string, number>();

  for (const { decision, index } of decisions) {
    const ativo = normalizeSymbol(decision.ativo);
    const signal = normalizeDecision(decision.decisao);
    const timestamp = parseTimestamp(decision.timestamp, index);
    const referencePrice = parsePrice(decision);
    if (!ativo || referencePrice <= 0) continue;

    lastPriceByAsset.set(ativo, referencePrice);

    const existingPosition = positions.get(ativo);
    if (existingPosition) {
      const favorableMove = existingPosition.direcao === "LONG"
        ? referencePrice - existingPosition.precoEntrada
        : existingPosition.precoEntrada - referencePrice;
      if (
        existingPosition.atr > 0 &&
        !existingPosition.parcialRealizada &&
        favorableMove >= existingPosition.atr * PARTIAL_ATR_MULTIPLIER &&
        existingPosition.restante > 0
      ) {
        const qty = Math.min(existingPosition.restante, existingPosition.quantidade * PARTIAL_EXIT_FRACTION);
        const partialPrice = existingPosition.direcao === "LONG"
          ? existingPosition.precoEntrada + existingPosition.atr * PARTIAL_ATR_MULTIPLIER
          : existingPosition.precoEntrada - existingPosition.atr * PARTIAL_ATR_MULTIPLIER;
        const partial = closePosition({
          position: existingPosition,
          timestamp,
          referencePrice: partialPrice,
          motivoSaida: "take_partial",
          cash,
          quantidade: qty
        });
        cash = Math.max(0, partial.nextCash);
        existingPosition.restante = Math.max(0, existingPosition.restante - qty);
        existingPosition.parcialRealizada = true;
        existingPosition.trailingStopAtivo = true;
        existingPosition.stopLoss = existingPosition.precoEntrada;
        trades.push(partial.trade);
      }

      if (
        existingPosition.atr > 0 &&
        existingPosition.trailingStopAtivo &&
        favorableMove >= existingPosition.atr * BREAKEVEN_ATR_MULTIPLIER
      ) {
        existingPosition.stopLoss = existingPosition.precoEntrada;
      }

      const riskExit = exitByRisk(existingPosition, referencePrice);
      const signalExit =
        (existingPosition.direcao === "LONG" && signal === "venda") || (existingPosition.direcao === "SHORT" && signal === "compra")
          ? { price: referencePrice, reason: signal as MotivoSaida }
          : null;
      const exit = riskExit ?? signalExit;

      if (exit) {
        const closed = closePosition({
          position: existingPosition,
          timestamp,
          referencePrice: exit.price,
          motivoSaida: exit.reason,
          cash
        });
        cash = closed.nextCash;
        positions.delete(ativo);
        trades.push(closed.trade);
        const day = timestamp.slice(0, 10);
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + closed.trade.lucroPrejuizo);
        if (closed.trade.lucroPrejuizo < 0) cooldownUntilByAsset.set(ativo, index + LOSS_COOLDOWN_CANDLES);
      }
    }

    const day = timestamp.slice(0, 10);
    const dailyLossActive = (dailyPnl.get(day) ?? 0) < -(SALDO_INICIAL * DAILY_LOSS_LIMIT_PCT / 100);
    const cooldownActive = (cooldownUntilByAsset.get(ativo) ?? -1) > index;
    if ((signal === "compra" || signal === "venda") && !positions.has(ativo) && !dailyLossActive && !cooldownActive) {
      const equity = currentEquity(cash, positions, lastPriceByAsset);
      const opened = openPosition({
        id: nextTradeId,
        ativo,
        signal,
        decision,
        timestamp,
        referencePrice,
        cash,
        equity
      });
      if (opened) {
        cash = opened.nextCash;
        positions.set(ativo, opened.position);
        nextTradeId += 1;
      }
    }

    const equity = currentEquity(cash, positions, lastPriceByAsset);
    peakEquity = Math.max(peakEquity, equity);
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    equityCurve.push({
      timestamp,
      saldo: round(cash),
      equity: round(equity),
      drawdown: round(drawdown, 4)
    });
  }

  const saldoFinal = currentEquity(cash, positions, lastPriceByAsset);
  const wins = trades.filter((trade) => trade.lucroPrejuizo > 0).length;
  const grossProfit = trades
    .filter((trade) => trade.lucroPrejuizo > 0)
    .reduce((sum, trade) => sum + trade.lucroPrejuizo, 0);
  const grossLoss = trades
    .filter((trade) => trade.lucroPrejuizo < 0)
    .reduce((sum, trade) => sum + Math.abs(trade.lucroPrejuizo), 0);
  const metricas = computeTradeMetrics(
    trades.map((trade) => trade.lucroPrejuizo),
    equityCurve.map((point) => ({ equity: point.equity }))
  );

  const result: BacktestResult = {
    saldoInicial: SALDO_INICIAL,
    saldoFinal: round(saldoFinal),
    retornoPercentual: round(((saldoFinal - SALDO_INICIAL) / SALDO_INICIAL) * 100, 4),
    maxDrawdown: round(maxDrawdown, 4),
    winRate: trades.length > 0 ? round((wins / trades.length) * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: metricas.expectancy,
    sharpeSimplificado: metricas.sharpeSimplificado,
    maxLossStreak: metricas.maxLossStreak,
    numeroTrades: trades.length,
    trades,
    equityCurve,
    posicoesAbertas: Array.from(positions.values()).map((position) => ({
      ativo: position.ativo,
      direcao: position.direcao,
      timestampEntrada: position.timestampEntrada,
      precoEntrada: position.precoEntrada,
      quantidade: round(position.restante, 8),
      notional: round(position.notional),
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit
    })),
    config: {
      saldoInicial: SALDO_INICIAL,
      riscoPorTradePct: RISCO_POR_TRADE_PCT,
      taxaOperacaoPct: TAXA_OPERACAO_PCT,
      slippagePct: SLIPPAGE_PCT,
      stopLossPct: 0,
      takeProfitPct: 0
    }
  };

  persistBacktest(result);
  return result;
}
