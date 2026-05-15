import { randomUUID } from "node:crypto";
import { db } from "../state/database.js";
import { positionManager, type PositionSide } from "./positionManager.js";
import type { Kline, MarketData } from "../types/index.js";
import { getInitialBalance } from "../utils/riskManager.js";
import { getLastExchangeConditions, simulateMarketFriction, type FrictionResult, type SmartExecutionMode } from "../exchange/marketFriction.js";

export type OrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
export type OrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED" | "EXPIRED";
export type OrderSide = "BUY" | "SELL";
export type LatencyProfile = "FAST" | "NORMAL" | "SLOW";

export interface MarketMicrostructure {
  referencePrice: number;
  atr?: number;
  atrPct?: number;
  volumeRelative?: number;
  momentum?: number;
  spreadPct?: number;
  stressScore?: number;
}

export interface ExecutionRequest {
  ativo: string;
  side: OrderSide;
  type?: OrderType;
  quantity: number;
  referencePrice: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  createdAt?: string;
  decisionId?: number | null;
  decisionTimestamp?: string | null;
  setup?: string | null;
  regime?: string | null;
  regimeConfidence?: number | null;
  latencyProfile?: LatencyProfile;
  executionMode?: SmartExecutionMode;
  microstructure?: MarketMicrostructure;
}

export interface ExecutionOrder {
  orderId: string;
  positionId: string | null;
  status: OrderStatus;
  ativo: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  remainingQuantity: number;
  requestedPrice: number;
  avgFillPrice: number | null;
  slippagePct: number;
  slippageCost: number;
  executionLatencyMs: number;
  executionQuality: number;
  missedProfit: number;
  adverseExcursion: number;
  favorableExcursion: number;
  createdAt: string;
  filledAt: string | null;
  fills: ExecutionFill[];
}

export interface ExecutionFill {
  fillId: string;
  orderId: string;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  slippagePct: number;
  latencyMs: number;
  createdAt: string;
}

export interface DecisionExecutionInput {
  decisionId?: number | null;
  ativo: string;
  decisao: string;
  timestamp: string;
  precoEntrada: number;
  positionSize?: number;
  stopLoss?: number;
  takeProfit?: number;
  atr?: number;
  atrPct?: number;
  volumeRelativo?: number;
  momentum?: number;
  setup?: string;
  regime?: string;
  regimeConfidence?: number;
  latencyProfile?: LatencyProfile;
  executionMode?: SmartExecutionMode;
}

const FEE_PCT = 0.1;
const DEFAULT_LATENCY_PROFILE: LatencyProfile = (process.env.EXECUTION_LATENCY_PROFILE as LatencyProfile) || "NORMAL";
const DEFAULT_EXECUTION_MODE: SmartExecutionMode = (process.env.EXECUTION_MODE as SmartExecutionMode) || "BALANCED";

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 6): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function sideSign(side: OrderSide): number {
  return side === "BUY" ? 1 : -1;
}

function positionSide(side: OrderSide): PositionSide {
  return side === "BUY" ? "LONG" : "SHORT";
}

function feeFor(notional: number): number {
  return Math.abs(notional) * (FEE_PCT / 100);
}

function latency(profile: LatencyProfile): { decisionDelayMs: number; exchangeLatencyMs: number; executionLatencyMs: number } {
  const ranges: Record<LatencyProfile, [number, number, number]> = {
    FAST: [20, 55, 90],
    NORMAL: [75, 160, 280],
    SLOW: [180, 420, 850]
  };
  const [decisionBase, exchangeBase, executionBase] = ranges[profile] ?? ranges.NORMAL;
  const jitter = (base: number) => Math.round(base * (0.75 + Math.random() * 0.7));
  const decisionDelayMs = jitter(decisionBase);
  const exchangeLatencyMs = jitter(exchangeBase);
  const executionLatencyMs = jitter(executionBase) + decisionDelayMs + exchangeLatencyMs;
  return { decisionDelayMs, exchangeLatencyMs, executionLatencyMs };
}

function estimateSpreadPct(input: MarketMicrostructure): number {
  const atrPct = Math.max(0, finite(input.atrPct, input.referencePrice > 0 ? (finite(input.atr) / input.referencePrice) * 100 : 0));
  const volume = Math.max(0.05, finite(input.volumeRelative, 1));
  const momentum = Math.abs(finite(input.momentum));
  const base = input.referencePrice >= 10_000 ? 0.012 : 0.018;
  const volatilityPenalty = clamp(atrPct * 0.08, 0, 0.18);
  const volumePenalty = clamp((1 / volume - 1) * 0.04, 0, 0.18);
  const momentumPenalty = clamp(momentum * 0.018, 0, 0.12);
  return round(finite(input.spreadPct, base + volatilityPenalty + volumePenalty + momentumPenalty), 5);
}

export function modelSlippagePct(input: MarketMicrostructure): number {
  const atrPct = Math.max(0, finite(input.atrPct, input.referencePrice > 0 ? (finite(input.atr) / input.referencePrice) * 100 : 0));
  const volume = Math.max(0.05, finite(input.volumeRelative, 1));
  const momentum = Math.abs(finite(input.momentum));
  const spreadPct = estimateSpreadPct(input);
  const atrImpact = clamp(atrPct * 0.16, 0, 0.65);
  const volumeImpact = clamp((1 / volume - 1) * 0.12, 0, 0.5);
  const momentumImpact = clamp(momentum * 0.025, 0, 0.35);
  const randomImpact = Math.random() * (0.015 + atrPct * 0.01);
  return round(clamp(spreadPct / 2 + atrImpact + volumeImpact + momentumImpact + randomImpact, 0.005, 1.8), 5);
}

function syntheticExcursions(request: ExecutionRequest, fillPrice: number): {
  missedProfit: number;
  adverseExcursion: number;
  favorableExcursion: number;
} {
  const micro = request.microstructure ?? { referencePrice: request.referencePrice };
  const atr = Math.max(0, finite(micro.atr, request.referencePrice * Math.max(0.001, finite(micro.atrPct, 0.1) / 100)));
  const momentum = finite(micro.momentum);
  const drift = atr * clamp(Math.abs(momentum) / 3, 0.1, 1.4);
  const favorable = Math.max(0, atr * (0.45 + Math.random() * 1.1) + drift * 0.3);
  const adverse = Math.max(0, atr * (0.25 + Math.random() * 0.9) - drift * 0.1);
  const sign = sideSign(request.side);
  const bestPrice = fillPrice + favorable * sign;
  return {
    missedProfit: round(Math.max(0, Math.abs(bestPrice - fillPrice) * request.quantity), 4),
    adverseExcursion: round(adverse, 6),
    favorableExcursion: round(favorable, 6)
  };
}

function qualityScore(input: {
  slippagePct: number;
  executionLatencyMs: number;
  missedProfit: number;
  notional: number;
  adverseExcursion: number;
  favorableExcursion: number;
}): number {
  const slippagePenalty = input.slippagePct * 18;
  const latencyPenalty = Math.min(25, input.executionLatencyMs / 80);
  const missedPenalty = input.notional > 0 ? Math.min(22, (input.missedProfit / input.notional) * 1000) : 0;
  const excursionPenalty = input.favorableExcursion > 0
    ? Math.min(15, (input.adverseExcursion / input.favorableExcursion) * 10)
    : 0;
  return round(clamp(100 - slippagePenalty - latencyPenalty - missedPenalty - excursionPenalty, 0, 100), 2);
}

function orderShouldFill(request: ExecutionRequest): boolean {
  const price = request.referencePrice;
  if (request.type === "MARKET" || !request.type) return true;
  if (request.type === "LIMIT") {
    const limit = finite(request.limitPrice, NaN);
    return Number.isFinite(limit) && (request.side === "BUY" ? limit >= price : limit <= price);
  }
  if (request.type === "STOP") {
    const stop = finite(request.stopPrice, NaN);
    return Number.isFinite(stop) && (request.side === "BUY" ? price >= stop : price <= stop);
  }
  if (request.type === "STOP_LIMIT") {
    const stop = finite(request.stopPrice, NaN);
    const limit = finite(request.limitPrice, NaN);
    const stopHit = Number.isFinite(stop) && (request.side === "BUY" ? price >= stop : price <= stop);
    const limitOk = Number.isFinite(limit) && (request.side === "BUY" ? limit >= price : limit <= price);
    return stopHit && limitOk;
  }
  return false;
}

function splitFills(quantity: number, volumeRelative: number, latencyMs: number): number[] {
  const weakBook = volumeRelative < 0.75 || latencyMs > 700;
  const parts = weakBook ? 3 : volumeRelative < 1 ? 2 : 1;
  if (parts === 1) return [quantity];
  const first = quantity * (0.35 + Math.random() * 0.25);
  const second = parts === 2 ? quantity - first : quantity * (0.25 + Math.random() * 0.2);
  const third = quantity - first - second;
  return [first, second, third].filter((q) => q > 0).map((q) => round(q, 8));
}

function persistOrder(input: {
  order: ExecutionOrder;
  request: ExecutionRequest;
  decisionDelayMs: number;
  exchangeLatencyMs: number;
  metadata: Record<string, unknown>;
}): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO execution_orders (
      order_id, decision_id, decision_timestamp, ativo, side, type, status, position_id,
      quantity, remaining_quantity, requested_price, limit_price, stop_price, avg_fill_price,
      slippage_pct, slippage_cost, execution_latency_ms, decision_delay_ms, exchange_latency_ms,
      created_at, filled_at, cancelled_at, execution_quality, missed_profit, adverse_excursion,
      favorable_excursion, setup, regime, regime_confidence, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    input.order.orderId,
    input.request.decisionId ?? null,
    input.request.decisionTimestamp ?? null,
    input.order.ativo,
    input.order.side,
    input.order.type,
    input.order.status,
    input.order.positionId,
    input.order.quantity,
    input.order.remainingQuantity,
    input.order.requestedPrice,
    input.request.limitPrice ?? null,
    input.request.stopPrice ?? null,
    input.order.avgFillPrice,
    input.order.slippagePct,
    input.order.slippageCost,
    input.order.executionLatencyMs,
    input.decisionDelayMs,
    input.exchangeLatencyMs,
    input.order.createdAt,
    input.order.filledAt,
    null,
    input.order.executionQuality,
    input.order.missedProfit,
    input.order.adverseExcursion,
    input.order.favorableExcursion,
    input.request.setup ?? null,
    input.request.regime ?? null,
    input.request.regimeConfidence ?? null,
    JSON.stringify(input.metadata)
  );
}

function persistFill(fill: ExecutionFill): void {
  const stmt = db.prepare(`
    INSERT INTO execution_fills (
      order_id, fill_id, price, quantity, notional, fee, slippage_pct, latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(fill.orderId, fill.fillId, fill.price, fill.quantity, fill.notional, fill.fee, fill.slippagePct, fill.latencyMs, fill.createdAt);
}

function attachDecisionExecution(input: DecisionExecutionInput, order: ExecutionOrder): void {
  try {
    db.prepare(`
      UPDATE decisions
      SET execution_order_id = ?, execution_status = ?, execution_quality = ?, slippage_cost = ?,
          execution_latency_ms = ?, missed_profit = ?, adverse_excursion = ?, favorable_excursion = ?
      WHERE ativo = ? AND timestamp = ?
    `).run(
      order.orderId,
      order.status,
      order.executionQuality,
      order.slippageCost,
      order.executionLatencyMs,
      order.missedProfit,
      order.adverseExcursion,
      order.favorableExcursion,
      input.ativo.toUpperCase(),
      input.timestamp
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[execution] falha ao anexar execução na decisão: ${msg}`);
  }
}

function simulateIntrabarPath(request: ExecutionRequest, avgFillPrice: number): Array<{ price: number; timestamp: string; atr?: number; volumeRelative?: number }> {
  const micro = request.microstructure ?? { referencePrice: request.referencePrice };
  const atr = Math.max(0, finite(micro.atr, avgFillPrice * Math.max(finite(micro.atrPct, 0.12), 0.05) / 100));
  const momentum = finite(micro.momentum);
  const sign = sideSign(request.side);
  const start = new Date(request.createdAt ?? nowIso()).getTime();
  const ticks = 6;
  const path: Array<{ price: number; timestamp: string; atr?: number; volumeRelative?: number }> = [];
  for (let i = 1; i <= ticks; i += 1) {
    const progress = i / ticks;
    const wave = Math.sin(progress * Math.PI * 1.35) * atr * 0.45;
    const drift = momentum * atr * 0.08 * progress;
    const noise = (Math.random() - 0.5) * atr * 0.35;
    const price = avgFillPrice + (wave + drift + noise) * sign;
    path.push({
      price: round(Math.max(0.00000001, price), 8),
      timestamp: new Date(start + i * 8_000).toISOString(),
      atr,
      volumeRelative: micro.volumeRelative
    });
  }
  return path;
}

export function submitOrder(request: ExecutionRequest): ExecutionOrder {
  const createdAt = request.createdAt ?? nowIso();
  const type = request.type ?? "MARKET";
  const profile = request.latencyProfile ?? DEFAULT_LATENCY_PROFILE;
  const orderId = "ord_" + randomUUID();
  const requestedPrice = finite(request.referencePrice);
  const quantity = Math.max(0, finite(request.quantity));
  const micro = request.microstructure ?? { referencePrice: requestedPrice };
  const friction = simulateMarketFriction({
    ativo: request.ativo,
    side: request.side,
    referencePrice: requestedPrice,
    quantity,
    atr: micro.atr,
    atrPct: micro.atrPct,
    volumeRelative: micro.volumeRelative,
    momentum: micro.momentum,
    regime: request.regime,
    stressScore: micro.stressScore,
    mode: request.executionMode ?? DEFAULT_EXECUTION_MODE
  });
  const executionLatencyMs = friction.latencyMs;
  const decisionDelayMs = Math.round(executionLatencyMs * 0.22);
  const exchangeLatencyMs = Math.max(0, executionLatencyMs - decisionDelayMs);
  const spreadPct = friction.spreadPct;
  const modeledSlippagePct = friction.actualSlippagePct;
  const fills: ExecutionFill[] = [];
  console.log(
    `[order-created] ${request.ativo.toUpperCase()} ${type} ${request.side} qty=${quantity} ref=${requestedPrice} mode=${friction.mode} spread=${spreadPct}% liquidity=${friction.liquidityScore}`
  );

  if (quantity <= 0 || requestedPrice <= 0) {
    const rejected: ExecutionOrder = {
      orderId,
      positionId: null,
      status: "REJECTED",
      ativo: request.ativo.toUpperCase(),
      side: request.side,
      type,
      quantity,
      remainingQuantity: quantity,
      requestedPrice,
      avgFillPrice: null,
      slippagePct: 0,
      slippageCost: 0,
      executionLatencyMs,
      executionQuality: 0,
      missedProfit: 0,
      adverseExcursion: 0,
      favorableExcursion: 0,
      createdAt,
      filledAt: null,
      fills
    };
    persistOrder({ order: rejected, request: { ...request, type, createdAt }, decisionDelayMs, exchangeLatencyMs, metadata: { reason: "invalid_quantity_or_price", friction } });
    console.warn(`[execution] order-rejected ${orderId}: invalid_quantity_or_price qty=${quantity} price=${requestedPrice}`);
    return rejected;
  }

  const fakeMiss = type !== "MARKET" && Math.random() * 100 < friction.fakeFillRisk;
  if (!orderShouldFill({ ...request, type }) || fakeMiss) {
    const pending: ExecutionOrder = {
      orderId,
      positionId: null,
      status: "NEW",
      ativo: request.ativo.toUpperCase(),
      side: request.side,
      type,
      quantity,
      remainingQuantity: quantity,
      requestedPrice,
      avgFillPrice: null,
      slippagePct: modeledSlippagePct,
      slippageCost: 0,
      executionLatencyMs,
      executionQuality: 50,
      missedProfit: 0,
      adverseExcursion: 0,
      favorableExcursion: 0,
      createdAt,
      filledAt: null,
      fills
    };
    persistOrder({ order: pending, request: { ...request, type, createdAt }, decisionDelayMs, exchangeLatencyMs, metadata: { spreadPct, pending: true, fakeMiss, friction } });
    console.log(`[execution] order-pending ${orderId} ${pending.ativo} ${pending.type} ${pending.side} fakeMiss=${fakeMiss}`);
    return pending;
  }

  const side = sideSign(request.side);
  const fillRatios = friction.fillRatios.length ? friction.fillRatios : [1];
  const totalRatio = clamp(fillRatios.reduce((sum, ratio) => sum + finite(ratio), 0), 0.05, type === "MARKET" ? 1 : friction.fillProbability);
  const fillQuantities = fillRatios
    .map((ratio) => round(quantity * finite(ratio), 8))
    .filter((q) => q > 0);
  if (!fillQuantities.length) fillQuantities.push(round(quantity * totalRatio, 8));
  let filledQty = 0;
  let weightedPrice = 0;
  fillQuantities.forEach((q, i) => {
    const progressPenalty = i * (modeledSlippagePct * 0.08 + friction.marketImpactPct * 0.18);
    const slip = modeledSlippagePct + progressPenalty;
    const price = round(requestedPrice * (1 + side * slip / 100), 8);
    const notional = Math.abs(price * q);
    const fill: ExecutionFill = {
      fillId: "fill_" + randomUUID(),
      orderId,
      price,
      quantity: q,
      notional: round(notional, 4),
      fee: round(feeFor(notional), 4),
      slippagePct: round(slip, 5),
      latencyMs: Math.round(executionLatencyMs * ((i + 1) / fillQuantities.length)),
      createdAt: addMs(createdAt, Math.round(executionLatencyMs * ((i + 1) / fillQuantities.length)))
    };
    fills.push(fill);
    filledQty += q;
    weightedPrice += price * q;
  });

  const avgFillPrice = round(weightedPrice / filledQty, 8);
  const slippageCost = round(Math.abs(avgFillPrice - requestedPrice) * filledQty, 4);
  const excursions = syntheticExcursions(request, avgFillPrice);
  const notional = Math.abs(avgFillPrice * filledQty);
  const executionQuality = round(clamp(
    friction.executionQuality -
      (filledQty < quantity ? (1 - filledQty / Math.max(quantity, 1)) * 18 : 0) -
      (excursions.adverseExcursion > excursions.favorableExcursion ? 5 : 0),
    0,
    100
  ), 2);
  const status: OrderStatus = filledQty >= quantity * 0.999 ? "FILLED" : "PARTIALLY_FILLED";
  const positionId = status === "FILLED" || status === "PARTIALLY_FILLED" ? "pos_" + randomUUID() : null;
  const order: ExecutionOrder = {
    orderId,
    positionId,
    status,
    ativo: request.ativo.toUpperCase(),
    side: request.side,
    type,
    quantity: round(quantity, 8),
    remainingQuantity: round(Math.max(0, quantity - filledQty), 8),
    requestedPrice,
    avgFillPrice,
    slippagePct: modeledSlippagePct,
    slippageCost,
    executionLatencyMs,
    executionQuality,
    missedProfit: round(excursions.missedProfit + friction.opportunityCost, 4),
    adverseExcursion: excursions.adverseExcursion,
    favorableExcursion: excursions.favorableExcursion,
    createdAt,
    filledAt: addMs(createdAt, executionLatencyMs),
    fills
  };

  persistOrder({
    order,
    request: { ...request, type, createdAt },
    decisionDelayMs,
    exchangeLatencyMs,
    metadata: {
      spreadPct,
      latencyProfile: profile,
      executionMode: friction.mode,
      partialFills: fills.length,
      expectedFillPrice: friction.expectedFillPrice,
      actualFillPrice: avgFillPrice,
      fillDeviationPct: round(((avgFillPrice - friction.expectedFillPrice) * side / requestedPrice) * 100, 5),
      executionAlpha: friction.executionAlpha,
      slippageAlpha: friction.slippageAlpha,
      opportunityCost: friction.opportunityCost,
      marketImpactPct: friction.marketImpactPct,
      orderBookPressure: friction.pressure,
      regimeTransition: friction.regimeTransition,
      liquidityScore: friction.liquidityScore,
      liquidityHoleRisk: friction.liquidityHoleRisk,
      fakeFillRisk: friction.fakeFillRisk,
      marketStress: friction.stressLabel,
      friction
    }
  });
  for (const fill of fills) persistFill(fill);
  console.log(
    `[order-filled] ${order.ativo} ${order.side} status=${order.status} avg=${order.avgFillPrice} fills=${fills.length} slippage=${order.slippagePct}% impact=${friction.marketImpactPct}% quality=${order.executionQuality}`
  );

  if (positionId) {
    const gate = positionManager.canOpen(order.ativo, positionSide(request.side), new Date(createdAt));
    if (gate.ok) {
      const position = positionManager.open({
        positionId,
        orderId,
        ativo: order.ativo,
        side: positionSide(request.side),
        entryPrice: avgFillPrice,
        quantity: filledQty,
        stopPrice: request.stopLoss ?? request.stopPrice ?? null,
        targetPrice: request.targetPrice ?? null,
        setup: request.setup,
        regime: request.regime,
        openedAt: order.filledAt ?? createdAt
      });
      console.log(`[execution] position-linked order=${orderId} position=${position.positionId}`);
      // A posição permanece viva; os updates tick-like vêm de /execution/live.
      positionManager.updateIntrabar({
        ativo: order.ativo,
        price: avgFillPrice,
        timestamp: order.filledAt ?? createdAt,
        atr: request.microstructure?.atr,
        volumeRelative: request.microstructure?.volumeRelative
      });
    } else {
      console.warn(`[execution] position-open-blocked order=${orderId} ativo=${order.ativo} reason=${gate.reason}`);
    }
  }

  return order;
}

export function recordDecisionExecution(input: DecisionExecutionInput): ExecutionOrder | null {
  if (input.decisao !== "compra" && input.decisao !== "venda") return null;
  const quantity = Math.max(0, finite(input.positionSize));
  if (quantity <= 0) {
    console.warn(`[execution] decision-approved-but-no-size ${input.ativo} decisao=${input.decisao} price=${input.precoEntrada}`);
    return null;
  }
  console.log(`[decision-approved] ${input.ativo} ${input.decisao} qty=${quantity} price=${input.precoEntrada} setup=${input.setup ?? "-"}`);
  const order = submitOrder({
    ativo: input.ativo,
    side: input.decisao === "compra" ? "BUY" : "SELL",
    type: "MARKET",
    quantity,
    referencePrice: finite(input.precoEntrada),
    stopLoss: input.stopLoss ?? null,
    targetPrice: input.takeProfit ?? null,
    createdAt: input.timestamp,
    decisionId: input.decisionId ?? null,
    decisionTimestamp: input.timestamp,
    setup: input.setup ?? null,
    regime: input.regime ?? null,
    regimeConfidence: input.regimeConfidence ?? null,
    latencyProfile: input.latencyProfile,
    executionMode: input.executionMode,
    microstructure: {
      referencePrice: finite(input.precoEntrada),
      atr: input.atr,
      atrPct: input.atrPct,
      volumeRelative: input.volumeRelativo,
      momentum: input.momentum
    }
  });
  attachDecisionExecution(input, order);
  console.log(
    `[execution] ${input.ativo}: ${order.type} ${order.side} ${order.status} | avg=${order.avgFillPrice ?? "-"} | slip=${order.slippagePct}% | latency=${order.executionLatencyMs}ms | quality=${order.executionQuality}`
  );
  return order;
}

export function updateIntrabarFromMarketData(symbol: string, market: MarketData): void {
  const ativo = symbol.toUpperCase();
  const recent = market.slice(-2);
  for (const k of recent) {
    const ticks = klineToTicks(k);
    for (const tick of ticks) {
      positionManager.updateIntrabar({ ativo, ...tick });
    }
  }
}

export function getOpenPositionSymbols(): string[] {
  return [...new Set(positionManager.getActivePositions().map((p) => p.ativo))];
}

function klineToTicks(kline: Kline): Array<{ price: number; timestamp: string; atr?: number; volumeRelative?: number }> {
  const openTime = finite(kline[0]);
  const open = finite(kline[1]);
  const high = finite(kline[2]);
  const low = finite(kline[3]);
  const close = finite(kline[4]);
  const volume = finite(kline[5]);
  const atr = Math.max(0, high - low);
  const baseTs = openTime || Date.now();
  const sequence = close >= open ? [open, low, high, close] : [open, high, low, close];
  return sequence.map((price, i) => ({
    price,
    timestamp: new Date(baseTs + i * 15_000).toISOString(),
    atr,
    volumeRelative: volume > 0 ? 1 : 0.2
  }));
}

export function getLiveExecutionState(symbol?: string): Record<string, unknown> {
  const positions = positionManager.getActivePositions(symbol);
  const live = positions[0] ?? null;
  const allActive = positionManager.getActivePositions();
  const realizedRows = db.prepare("SELECT realized_pnl, closed_at, opened_at FROM execution_positions").all() as Array<Record<string, unknown>>;
  const initialBalance = getInitialBalance();
  const realizedPnl = round(realizedRows.reduce((sum, row) => sum + finite(row.realized_pnl), 0), 4);
  const floatingPnl = round(allActive.reduce((sum, pos) => sum + pos.floatingPnl, 0), 4);
  const capitalInUse = round(allActive.reduce((sum, pos) => sum + Math.abs(pos.entryPrice * pos.remainingQuantity), 0), 4);
  const riskNow = round(allActive.reduce((sum, pos) => {
    const stop = pos.stopPrice ?? pos.trailingStop;
    return stop ? sum + Math.abs(pos.entryPrice - stop) * pos.remainingQuantity : sum;
  }, 0), 4);
  const today = new Date().toISOString().slice(0, 10);
  const dailyReturn = round(realizedRows
    .filter((row) => String(row.closed_at ?? row.opened_at ?? "").startsWith(today))
    .reduce((sum, row) => sum + finite(row.realized_pnl), 0), 4);
  const currentEquity = round(initialBalance + realizedPnl + floatingPnl, 4);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const snapshots = db.prepare(`
    SELECT created_at, saldo_atual
    FROM portfolio_snapshots
    WHERE datetime(created_at) >= datetime(?)
    ORDER BY datetime(created_at) ASC
  `).all(new Date(weekAgo).toISOString()) as Array<Record<string, unknown>>;
  const weekBase = snapshots.length ? finite(snapshots[0].saldo_atual, initialBalance) : initialBalance;
  const allSnapshotRows = db.prepare("SELECT saldo_atual FROM portfolio_snapshots ORDER BY id ASC").all() as Array<Record<string, unknown>>;
  const historicalPeak = Math.max(initialBalance, currentEquity, ...allSnapshotRows.map((row) => finite(row.saldo_atual, initialBalance)));
  const drawdownAtual = historicalPeak > 0 ? round(((historicalPeak - currentEquity) / historicalPeak) * 100, 4) : 0;
  const capitalLivre = round(Math.max(0, currentEquity - capitalInUse), 4);
  const portfolio = {
    saldoInicial: initialBalance,
    saldoAtual: currentEquity,
    capitalLivre,
    capitalAlocado: capitalInUse,
    pnlRealizado: realizedPnl,
    pnlFlutuante: floatingPnl,
    drawdownAtual,
    retornoDiario: dailyReturn,
    retornoSemanal: round(currentEquity - weekBase, 4),
    exposureTotalPct: initialBalance > 0 ? round((capitalInUse / initialBalance) * 100, 2) : 0,
    riscoAgregado: riskNow,
    tradesAbertos: allActive.length
  };
  persistPortfolioSnapshot(portfolio);
  return {
    source: "execution-engine",
    latencyProfile: DEFAULT_LATENCY_PROFILE,
    livePosition: live,
    positions,
    openPositions: allActive,
    portfolio,
    updatedAt: nowIso()
  };
}

function persistPortfolioSnapshot(portfolio: {
  saldoInicial: number;
  saldoAtual: number;
  capitalLivre: number;
  capitalAlocado: number;
  pnlRealizado: number;
  pnlFlutuante: number;
  drawdownAtual: number;
  retornoDiario: number;
  retornoSemanal: number;
  exposureTotalPct: number;
  riscoAgregado: number;
  tradesAbertos: number;
}): void {
  try {
    db.prepare(`
      INSERT INTO portfolio_snapshots (
        created_at, saldo_inicial, saldo_atual, capital_livre, capital_alocado,
        pnl_realizado, pnl_flutuante, drawdown_atual, retorno_diario, retorno_semanal,
        exposure_total_pct, risco_agregado, trades_abertos, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowIso(),
      portfolio.saldoInicial,
      portfolio.saldoAtual,
      portfolio.capitalLivre,
      portfolio.capitalAlocado,
      portfolio.pnlRealizado,
      portfolio.pnlFlutuante,
      portfolio.drawdownAtual,
      portfolio.retornoDiario,
      portfolio.retornoSemanal,
      portfolio.exposureTotalPct,
      portfolio.riscoAgregado,
      portfolio.tradesAbertos,
      JSON.stringify({ source: "execution-live" })
    );
  } catch (err) {
    console.warn(`[execution] portfolio snapshot failed: ${err instanceof Error ? err.message : err}`);
  }
}

function parseMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.metadata_json;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getTradeTimeline(positionId?: string): Record<string, unknown> {
  const target = positionId ?? (positionManager.getActivePositions()[0]?.positionId);
  if (!target) return { source: "execution-engine", positionId: null, events: [] };
  return {
    source: "execution-engine",
    positionId: target,
    events: positionManager.getTimeline(target)
  };
}

export function getExecutionAnalytics(): Record<string, unknown> {
  const orderRows = db.prepare(`
    SELECT setup, regime, execution_quality, slippage_pct, slippage_cost, execution_latency_ms,
           missed_profit, adverse_excursion, favorable_excursion, metadata_json
    FROM execution_orders
    WHERE status IN ('FILLED', 'PARTIALLY_FILLED')
  `).all() as Array<Record<string, unknown>>;
  const positions = db.prepare(`
    SELECT setup, regime, status, realized_pnl, opened_at, closed_at
    FROM execution_positions
  `).all() as Array<Record<string, unknown>>;

  const avg = (values: number[]): number => values.length ? round(values.reduce((s, n) => s + n, 0) / values.length, 4) : 0;
  const groupSum = (rows: Array<Record<string, unknown>>, key: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const k = String(row[key] ?? "indefinido");
      out[k] = round((out[k] ?? 0) + finite(row.realized_pnl), 4);
    }
    return out;
  };
  const qualityBucket = (q: number): string => q >= 80 ? "A" : q >= 65 ? "B" : q >= 50 ? "C" : "D";
  const pnlByQuality: Record<string, number> = {};
  for (const pos of positions) {
    const setup = String(pos.setup ?? "indefinido");
    const related = orderRows.find((o) => String(o.setup ?? "indefinido") === setup);
    const bucket = qualityBucket(finite(related?.execution_quality, 0));
    pnlByQuality[bucket] = round((pnlByQuality[bucket] ?? 0) + finite(pos.realized_pnl), 4);
  }
  const holdTimes = positions
    .filter((p) => p.opened_at && p.closed_at)
    .map((p) => new Date(String(p.closed_at)).getTime() - new Date(String(p.opened_at)).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const metadataRows = orderRows.map(parseMetadata);

  return {
    source: "execution-engine",
    totalOrders: orderRows.length,
    avgSlippage: avg(orderRows.map((r) => finite(r.slippage_pct))),
    avgExecutionDelay: avg(orderRows.map((r) => finite(r.execution_latency_ms))),
    avgHoldTimeMs: avg(holdTimes),
    mae: avg(orderRows.map((r) => finite(r.adverse_excursion))),
    mfe: avg(orderRows.map((r) => finite(r.favorable_excursion))),
    missedProfit: avg(orderRows.map((r) => finite(r.missed_profit))),
    expectedFill: avg(metadataRows.map((m) => finite(m.expectedFillPrice))),
    actualFill: avg(metadataRows.map((m) => finite(m.actualFillPrice))),
    fillDeviation: avg(metadataRows.map((m) => finite(m.fillDeviationPct))),
    executionAlpha: avg(metadataRows.map((m) => finite(m.executionAlpha))),
    slippageAlpha: avg(metadataRows.map((m) => finite(m.slippageAlpha))),
    opportunityCost: avg(metadataRows.map((m) => finite(m.opportunityCost))),
    avgMarketImpact: avg(metadataRows.map((m) => finite(m.marketImpactPct))),
    avgLiquidityScore: avg(metadataRows.map((m) => finite(m.liquidityScore))),
    pnlByRegime: groupSum(positions, "regime"),
    pnlBySetup: groupSum(positions, "setup"),
    pnlByExecutionQuality: pnlByQuality,
    updatedAt: nowIso()
  };
}

function avg(values: number[]): number {
  const valid = values.filter((n) => Number.isFinite(n));
  return valid.length ? round(valid.reduce((sum, n) => sum + n, 0) / valid.length, 4) : 0;
}

function percentile(values: number[], pct: number): number {
  const valid = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const idx = clamp((valid.length - 1) * pct, 0, valid.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round(valid[lo], 4);
  return round(valid[lo] + (valid[hi] - valid[lo]) * (idx - lo), 4);
}

function sharpeLike(values: number[]): number {
  const valid = values.filter((n) => Number.isFinite(n));
  if (valid.length < 2) return 0;
  const mean = avg(valid);
  const variance = valid.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (valid.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? round((mean / sd) * Math.sqrt(valid.length), 4) : 0;
}

function profitFactor(values: number[]): number {
  const grossWin = values.filter((n) => n > 0).reduce((sum, n) => sum + n, 0);
  const grossLoss = Math.abs(values.filter((n) => n < 0).reduce((sum, n) => sum + n, 0));
  if (grossLoss <= 0) return grossWin > 0 ? 999 : 0;
  return round(grossWin / grossLoss, 4);
}

export function getExchangeConditions(): Record<string, unknown> {
  const last = getLastExchangeConditions();
  const recent = db.prepare(`
    SELECT slippage_pct, execution_latency_ms, execution_quality, metadata_json
    FROM execution_orders
    WHERE status IN ('FILLED', 'PARTIALLY_FILLED')
    ORDER BY datetime(created_at) DESC
    LIMIT 100
  `).all() as Array<Record<string, unknown>>;
  const metadataRows = recent.map(parseMetadata);
  return {
    source: "market-friction-engine",
    current: last,
    spreadAtualPct: finite(last.spreadPct),
    slippageMedioPct: avg(recent.map((r) => finite(r.slippage_pct))),
    latencyMs: avg(recent.map((r) => finite(r.execution_latency_ms))) || finite(last.latencyMs),
    liquidity: finite(last.liquidityScore, 100),
    executionQuality: avg(recent.map((r) => finite(r.execution_quality))) || finite(last.executionQuality, 100),
    marketStress: String(last.stressLabel ?? "LOW"),
    marketImpactPct: avg(metadataRows.map((m) => finite(m.marketImpactPct))),
    fillDeviationPct: avg(metadataRows.map((m) => finite(m.fillDeviationPct))),
    opportunityCost: avg(metadataRows.map((m) => finite(m.opportunityCost))),
    updatedAt: nowIso()
  };
}

export function getAdvancedPortfolioAnalytics(): Record<string, unknown> {
  const positions = db.prepare(`
    SELECT realized_pnl, setup, regime, opened_at, closed_at
    FROM execution_positions
    ORDER BY datetime(opened_at) ASC
  `).all() as Array<Record<string, unknown>>;
  const pnl = positions.map((p) => finite(p.realized_pnl)).filter((n) => Number.isFinite(n));
  const rolling = pnl.slice(-50);
  const pnlByRegime: Record<string, number> = {};
  const heatMapByHour: Record<string, number> = {};
  for (const row of positions) {
    const regime = String(row.regime ?? "indefinido");
    pnlByRegime[regime] = round((pnlByRegime[regime] ?? 0) + finite(row.realized_pnl), 4);
    const ts = String(row.closed_at ?? row.opened_at ?? "");
    const hour = Number.isFinite(new Date(ts).getTime()) ? String(new Date(ts).getHours()).padStart(2, "0") + ":00" : "indefinido";
    heatMapByHour[hour] = round((heatMapByHour[hour] ?? 0) + finite(row.realized_pnl), 4);
  }
  const var95 = Math.min(0, percentile(rolling, 0.05));
  return {
    source: "portfolio-quant-analytics",
    trades: pnl.length,
    simplifiedVaR95: round(Math.abs(var95), 4),
    rollingSharpe: sharpeLike(rolling),
    rollingExpectancy: avg(rolling),
    rollingProfitFactor: profitFactor(rolling),
    regimeAdjustedPnl: pnlByRegime,
    heatMapByHour,
    updatedAt: nowIso()
  };
}

export function getExecutionHealth(): Record<string, unknown> {
  const orders = db.prepare(`
    SELECT order_id, status, position_id, created_at, filled_at
    FROM execution_orders
    ORDER BY datetime(created_at) DESC
    LIMIT 500
  `).all() as Array<Record<string, unknown>>;
  const positions = db.prepare(`
    SELECT position_id, ativo, status, remaining_quantity, updated_at, closed_at
    FROM execution_positions
    ORDER BY datetime(updated_at) DESC
    LIMIT 500
  `).all() as Array<Record<string, unknown>>;
  const fills = db.prepare("SELECT order_id FROM execution_fills").all() as Array<Record<string, unknown>>;
  const fillSet = new Set(fills.map((f) => String(f.order_id)));
  const positionSet = new Set(positions.map((p) => String(p.position_id)));
  const now = Date.now();
  const filledOrders = orders.filter((o) => o.status === "FILLED" || o.status === "PARTIALLY_FILLED");
  const orphanOrders = filledOrders.filter((o) => o.position_id && !positionSet.has(String(o.position_id)));
  const ordersWithoutFills = filledOrders.filter((o) => !fillSet.has(String(o.order_id)));
  const stalePositions = positions.filter((p) => {
    const status = String(p.status);
    if (status !== "OPEN" && status !== "PARTIAL" && status !== "BREAKEVEN" && status !== "TRAILING" && status !== "CLOSING") return false;
    const updated = new Date(String(p.updated_at)).getTime();
    return Number.isFinite(updated) && now - updated > 10 * 60_000;
  });
  const invalidStates = positions.filter((p) => {
    const status = String(p.status);
    const remaining = finite(p.remaining_quantity);
    return (status === "CLOSED" || status === "STOPPED" || status === "CANCELLED") ? remaining > 0 : remaining < 0;
  });
  const recentOrders = orders.filter((o) => {
    const created = new Date(String(o.created_at)).getTime();
    return Number.isFinite(created) && now - created < 24 * 60 * 60_000;
  });
  const status = orphanOrders.length || ordersWithoutFills.length || invalidStates.length
    ? "DEGRADED"
    : stalePositions.length
      ? "STALE"
      : "OK";
  const latencyRows = db.prepare(`
    SELECT execution_latency_ms
    FROM execution_orders
    WHERE status IN ('FILLED', 'PARTIALLY_FILLED')
    ORDER BY datetime(created_at) DESC
    LIMIT 100
  `).all() as Array<Record<string, unknown>>;
  const avgLatency = latencyRows.length
    ? round(latencyRows.reduce((sum, row) => sum + finite(row.execution_latency_ms), 0) / latencyRows.length, 2)
    : 0;
  return {
    source: "execution-engine",
    status,
    engineStatus: status,
    recentOrders: recentOrders.length,
    openPositions: positions.filter((p) => ["OPEN", "PARTIAL", "BREAKEVEN", "TRAILING", "CLOSING"].includes(String(p.status))).length,
    avgLatencyMs: avgLatency,
    diagnostics: {
      orphanOrders: orphanOrders.length,
      ordersWithoutFills: ordersWithoutFills.length,
      stalePositions: stalePositions.length,
      invalidStates: invalidStates.length,
      portfolioConsistent: invalidStates.length === 0
    },
    updatedAt: nowIso()
  };
}
