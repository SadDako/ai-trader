import type { MarketData } from "../types/index.js";

export const DEFAULT_INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE ?? process.env.BANCA_INICIAL ?? 1000);
export const RISK_PER_TRADE_PCT = Number(process.env.RISK_PER_TRADE_PCT ?? 1);
export const DAILY_LOSS_LIMIT_PCT = Number(process.env.DAILY_LOSS_LIMIT_PCT ?? 5);
export const LOSS_COOLDOWN_CANDLES = Number(process.env.LOSS_COOLDOWN_CANDLES ?? 10);
export const FEE_PCT = Number(process.env.TRADE_FEE_PCT ?? 0.1);
export const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT ?? 0.05);
export const STOP_ATR_MULTIPLIER = Number(process.env.STOP_ATR_MULTIPLIER ?? 1.2);
export const TAKE_PROFIT_ATR_MULTIPLIER = Number(process.env.TAKE_PROFIT_ATR_MULTIPLIER ?? 2);
export const BREAKEVEN_ATR_MULTIPLIER = Number(process.env.BREAKEVEN_ATR_MULTIPLIER ?? 1);
export const PARTIAL_ATR_MULTIPLIER = Number(process.env.PARTIAL_ATR_MULTIPLIER ?? 1);
export const PARTIAL_EXIT_FRACTION = Number(process.env.PARTIAL_EXIT_FRACTION ?? 0.5);

const ATR_PERIOD = 14;

export type TradeDirection = "compra" | "venda";

export interface RiskPlan {
  balance: number;
  riskPct: number;
  riskAmount: number;
  atr: number;
  stopDistance: number;
  takeProfitDistance: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  notional: number;
  rr: number;
}

export interface TradeMetrics {
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  sharpeSimplificado: number;
  maxLossStreak: number;
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundPrice(value: number): number {
  return round(value, 8);
}

function safePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getInitialBalance(): number {
  return safePositive(DEFAULT_INITIAL_BALANCE, 1000);
}

export function computeATRFromMarket(market: MarketData, period = ATR_PERIOD): number {
  if (!Array.isArray(market) || market.length < period + 1) return 0;
  const ranges: number[] = [];
  for (let i = 1; i < market.length; i += 1) {
    const high = Number(market[i][2]);
    const low = Number(market[i][3]);
    const prevClose = Number(market[i - 1][4]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const last = ranges.slice(-period);
  if (last.length < period) return 0;
  return round(last.reduce((sum, tr) => sum + tr, 0) / last.length, 8);
}

export function calculateRiskPlan(input: {
  balance: number;
  direction: TradeDirection;
  entryPrice: number;
  atr: number;
  riskPct?: number;
}): RiskPlan | null {
  const balance = safePositive(input.balance, getInitialBalance());
  const entryPrice = safePositive(input.entryPrice, 0);
  const atr = safePositive(input.atr, 0);
  const riskPct = Math.min(Math.max(safePositive(input.riskPct ?? RISK_PER_TRADE_PCT, 1), 0), RISK_PER_TRADE_PCT * 1.35);
  if (entryPrice <= 0 || atr <= 0 || balance <= 0) return null;

  const stopDistance = atr * STOP_ATR_MULTIPLIER;
  const takeProfitDistance = atr * TAKE_PROFIT_ATR_MULTIPLIER;
  const riskAmount = balance * (riskPct / 100);
  const rawPositionSize = riskAmount / stopDistance;
  const maxPositionSize = balance / entryPrice;
  const positionSize = Math.min(rawPositionSize, maxPositionSize);
  const notional = positionSize * entryPrice;
  if (!Number.isFinite(positionSize) || positionSize <= 0 || notional <= 0 || notional > balance) return null;

  const stopLoss = input.direction === "compra"
    ? entryPrice - stopDistance
    : entryPrice + stopDistance;
  const takeProfit = input.direction === "compra"
    ? entryPrice + takeProfitDistance
    : entryPrice - takeProfitDistance;

  return {
    balance: round(balance, 2),
    riskPct,
    riskAmount: round(riskAmount, 2),
    atr: round(atr, 8),
    stopDistance: round(stopDistance, 8),
    takeProfitDistance: round(takeProfitDistance, 8),
    entryPrice: roundPrice(entryPrice),
    stopLoss: roundPrice(Math.max(0, stopLoss)),
    takeProfit: roundPrice(Math.max(0, takeProfit)),
    positionSize: round(positionSize, 8),
    notional: round(notional, 2),
    rr: round(takeProfitDistance / stopDistance, 4)
  };
}

export function applyEntrySlippage(direction: TradeDirection, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return direction === "compra"
    ? roundPrice(price * (1 + SLIPPAGE_PCT / 100))
    : roundPrice(price * (1 - SLIPPAGE_PCT / 100));
}

export function applyExitSlippage(direction: TradeDirection, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return direction === "compra"
    ? roundPrice(price * (1 - SLIPPAGE_PCT / 100))
    : roundPrice(price * (1 + SLIPPAGE_PCT / 100));
}

export function grossPnl(direction: TradeDirection, entryPrice: number, exitPrice: number, quantity: number): number {
  if (direction === "compra") return (exitPrice - entryPrice) * quantity;
  return (entryPrice - exitPrice) * quantity;
}

export function feeForNotional(notional: number): number {
  return Math.max(0, notional) * (FEE_PCT / 100);
}

export function computeTradeMetrics(pnls: number[], equityCurve: Array<{ equity: number }>): TradeMetrics {
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((sum, p) => sum + p, 0);
  const grossLoss = losses.reduce((sum, p) => sum + Math.abs(p), 0);
  const expectancy = pnls.length > 0 ? pnls.reduce((sum, p) => sum + p, 0) / pnls.length : 0;

  let peak = equityCurve[0]?.equity ?? getInitialBalance();
  let maxDrawdown = 0;
  for (const p of equityCurve) {
    if (!Number.isFinite(p.equity)) continue;
    peak = Math.max(peak, p.equity);
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
  }

  let maxLossStreak = 0;
  let currentLossStreak = 0;
  for (const pnl of pnls) {
    if (pnl < 0) {
      currentLossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    } else if (pnl > 0) {
      currentLossStreak = 0;
    }
  }

  const returns = equityCurve
    .map((p, i, arr) => {
      if (i === 0) return 0;
      const prev = arr[i - 1].equity;
      return prev > 0 ? ((p.equity - prev) / prev) * 100 : 0;
    })
    .filter((r) => Number.isFinite(r));
  const avg = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + (r - avg) ** 2, 0) / (returns.length - 1)
    : 0;
  const std = Math.sqrt(variance);

  return {
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? Infinity : 0,
    expectancy: round(expectancy, 4),
    maxDrawdown: round(maxDrawdown, 4),
    sharpeSimplificado: std > 0 ? round(avg / std, 4) : 0,
    maxLossStreak
  };
}
