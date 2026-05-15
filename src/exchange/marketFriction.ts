export type SmartExecutionMode = "AGGRESSIVE" | "BALANCED" | "PASSIVE";

export interface FrictionInput {
  ativo: string;
  side: "BUY" | "SELL";
  referencePrice: number;
  quantity: number;
  atr?: number;
  atrPct?: number;
  volumeRelative?: number;
  momentum?: number;
  regime?: string | null;
  stressScore?: number;
  mode?: SmartExecutionMode;
}

export interface OrderBookPressure {
  bidPressure: number;
  askPressure: number;
  imbalance: number;
  absorption: number;
  liquidityVacuum: number;
}

export interface FrictionResult {
  mode: SmartExecutionMode;
  spreadPct: number;
  expectedSlippagePct: number;
  actualSlippagePct: number;
  latencyMs: number;
  latencyDriftMs: number;
  liquidityScore: number;
  liquidityHoleRisk: number;
  fakeFillRisk: number;
  fillProbability: number;
  fillRatios: number[];
  pressure: OrderBookPressure;
  marketImpactPct: number;
  expectedFillPrice: number;
  actualFillPrice: number;
  fillDeviationPct: number;
  executionAlpha: number;
  slippageAlpha: number;
  opportunityCost: number;
  executionQuality: number;
  regimeTransition: {
    phase: "STABLE" | "COMPRESSION" | "EXPANSION" | "BULL_TRAP" | "BEAR_TRAP" | "VOLATILITY_EXPLOSION";
    risk: number;
  };
  stressLabel: "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
  reasons: string[];
}

let lastConditions: (FrictionResult & { ativo: string; updatedAt: string }) | null = null;

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

function stressLabel(score: number): FrictionResult["stressLabel"] {
  if (score >= 80) return "EXTREME";
  if (score >= 58) return "HIGH";
  if (score >= 32) return "MEDIUM";
  return "LOW";
}

function inferTransition(input: {
  atrPct: number;
  volume: number;
  momentum: number;
  stress: number;
  side: "BUY" | "SELL";
}): FrictionResult["regimeTransition"] {
  const absMom = Math.abs(input.momentum);
  if (input.atrPct > 0.45 || input.stress >= 82) return { phase: "VOLATILITY_EXPLOSION", risk: round(clamp(input.atrPct * 120 + input.stress * 0.25, 0, 100), 2) };
  if (input.atrPct < 0.06 && input.volume < 0.75) return { phase: "COMPRESSION", risk: round(clamp(55 + (0.75 - input.volume) * 35, 0, 100), 2) };
  if (input.atrPct > 0.18 && input.volume > 1.2 && absMom > 0.1) return { phase: "EXPANSION", risk: round(clamp(45 + input.atrPct * 80 + absMom * 10, 0, 100), 2) };
  if (input.side === "BUY" && input.momentum < -0.08 && input.atrPct > 0.12) return { phase: "BULL_TRAP", risk: round(clamp(45 + absMom * 12, 0, 100), 2) };
  if (input.side === "SELL" && input.momentum > 0.08 && input.atrPct > 0.12) return { phase: "BEAR_TRAP", risk: round(clamp(45 + absMom * 12, 0, 100), 2) };
  return { phase: "STABLE", risk: round(clamp(input.stress * 0.35 + input.atrPct * 40, 0, 100), 2) };
}

function pressure(input: FrictionInput, atrPct: number, volume: number, stress: number): OrderBookPressure {
  const mom = finite(input.momentum);
  const directionBias = clamp(mom / 2, -1, 1);
  const liquidityVacuum = clamp((1 - volume) * 0.45 + atrPct * 1.8 + stress / 180, 0, 1);
  const absorption = clamp(volume * 0.35 + (1 - liquidityVacuum) * 0.45 - Math.abs(directionBias) * 0.18, 0, 1);
  const bidPressure = clamp(0.5 + directionBias * 0.25 + (input.side === "BUY" ? 0.05 : -0.02) - liquidityVacuum * 0.12, 0, 1);
  const askPressure = clamp(1 - bidPressure + (input.side === "SELL" ? 0.04 : 0), 0, 1);
  return {
    bidPressure: round(bidPressure, 4),
    askPressure: round(askPressure, 4),
    imbalance: round(bidPressure - askPressure, 4),
    absorption: round(absorption, 4),
    liquidityVacuum: round(liquidityVacuum, 4)
  };
}

function fillRatios(mode: SmartExecutionMode, fillProbability: number, vacuum: number): number[] {
  const cap = clamp(fillProbability - vacuum * 0.25, 0.08, 1);
  if (mode === "AGGRESSIVE") {
    if (cap > 0.88) return [1];
    return [round(cap * 0.7, 8), round(cap * 0.3, 8)].filter((n) => n > 0.01);
  }
  if (mode === "PASSIVE") {
    if (cap < 0.35) return [round(cap, 8)];
    return [round(cap * 0.35, 8), round(cap * 0.35, 8), round(cap * 0.3, 8)].filter((n) => n > 0.01);
  }
  if (cap > 0.82) return [round(cap * 0.55, 8), round(cap * 0.45, 8)];
  return [round(cap * 0.5, 8), round(cap * 0.3, 8), round(cap * 0.2, 8)].filter((n) => n > 0.01);
}

export function simulateMarketFriction(input: FrictionInput): FrictionResult {
  const mode = input.mode ?? "BALANCED";
  const referencePrice = Math.max(0.00000001, finite(input.referencePrice, 0));
  const quantity = Math.max(0, finite(input.quantity, 0));
  const atrPct = Math.max(0, finite(input.atrPct, referencePrice > 0 ? (finite(input.atr) / referencePrice) * 100 : 0));
  const volume = Math.max(0.03, finite(input.volumeRelative, 1));
  const momentum = finite(input.momentum);
  const stress = clamp(finite(input.stressScore, 0), 0, 100);
  const notional = referencePrice * quantity;
  const normalizedSize = clamp(notional / 1_000, 0, 20);
  const modeSlipFactor = mode === "AGGRESSIVE" ? 1.25 : mode === "PASSIVE" ? 0.72 : 1;
  const modeLatencyFactor = mode === "AGGRESSIVE" ? 0.72 : mode === "PASSIVE" ? 1.45 : 1;
  const p = pressure(input, atrPct, volume, stress);
  const transition = inferTransition({ atrPct, volume, momentum, stress, side: input.side });

  const baseSpread = referencePrice >= 10_000 ? 0.012 : 0.018;
  const spreadPct = round(clamp(
    baseSpread +
    atrPct * 0.14 +
    Math.max(0, 1 - volume) * 0.08 +
    Math.abs(momentum) * 0.018 +
    stress * 0.002 +
    p.liquidityVacuum * 0.08,
    0.006,
    2.4
  ), 5);
  const marketImpactPct = round(clamp(normalizedSize ** 0.72 * 0.012 * (1 + p.liquidityVacuum * 2.2) * (1 + atrPct), 0, 1.6), 5);
  const expectedSlippagePct = round(clamp(
    (spreadPct / 2 + atrPct * 0.18 + Math.max(0, 1 - volume) * 0.16 + Math.abs(momentum) * 0.028 + marketImpactPct) * modeSlipFactor,
    0.003,
    3.5
  ), 5);
  const adversePressure = input.side === "BUY" ? Math.max(0, p.askPressure - p.bidPressure) : Math.max(0, p.bidPressure - p.askPressure);
  const actualSlippagePct = round(clamp(
    expectedSlippagePct * (1 + adversePressure * 0.8 + p.liquidityVacuum * 0.7 + transition.risk / 240) + Math.random() * (0.01 + atrPct * 0.015),
    0.003,
    5
  ), 5);
  const latencyDriftMs = Math.round((atrPct * 900 + stress * 6 + p.liquidityVacuum * 350 + normalizedSize * 12) * modeLatencyFactor);
  const latencyMs = Math.round(clamp(120 * modeLatencyFactor + latencyDriftMs + Math.random() * 120, 40, 4_000));
  const liquidityScore = round(clamp(100 - p.liquidityVacuum * 70 - Math.max(0, 1 - volume) * 22 - marketImpactPct * 8, 0, 100), 2);
  const liquidityHoleRisk = round(clamp(p.liquidityVacuum * 85 + Math.max(0, 1 - volume) * 25 + transition.risk * 0.2, 0, 100), 2);
  const fakeFillRisk = round(clamp((mode === "PASSIVE" ? 18 : 5) + transition.risk * 0.22 + p.liquidityVacuum * 18 - p.absorption * 10, 0, 100), 2);
  const fillProbability = round(clamp(
    (mode === "AGGRESSIVE" ? 0.98 : mode === "PASSIVE" ? 0.68 : 0.86) -
    liquidityHoleRisk / 180 -
    fakeFillRisk / 260 +
    p.absorption * 0.12,
    0.05,
    1
  ), 4);
  const ratios = fillRatios(mode, fillProbability, p.liquidityVacuum);
  const sign = input.side === "BUY" ? 1 : -1;
  const expectedFillPrice = round(referencePrice * (1 + sign * expectedSlippagePct / 100), 8);
  const actualFillPrice = round(referencePrice * (1 + sign * actualSlippagePct / 100), 8);
  const fillDeviationPct = round(actualSlippagePct - expectedSlippagePct, 5);
  const opportunityCost = round(referencePrice * quantity * Math.max(0, (100 - fillProbability * 100) / 100) * (atrPct / 100 + 0.0005), 4);
  const executionAlpha = round((expectedFillPrice - actualFillPrice) * sign * quantity, 4);
  const slippageAlpha = round(expectedSlippagePct - actualSlippagePct, 5);
  const executionQuality = round(clamp(
    100 - actualSlippagePct * 16 - latencyMs / 90 - liquidityHoleRisk * 0.18 - fakeFillRisk * 0.12 - opportunityCost / Math.max(1, notional) * 500,
    0,
    100
  ), 2);
  const reasons: string[] = [];
  if (liquidityHoleRisk > 55) reasons.push("liquidity hole risk");
  if (fakeFillRisk > 45) reasons.push("fake fill risk");
  if (marketImpactPct > 0.25) reasons.push("market impact elevado");
  if (transition.phase !== "STABLE") reasons.push(`regime transition: ${transition.phase}`);
  if (Math.abs(momentum) > 0.15) reasons.push("momentum forte piorando execução");

  const result: FrictionResult = {
    mode,
    spreadPct,
    expectedSlippagePct,
    actualSlippagePct,
    latencyMs,
    latencyDriftMs,
    liquidityScore,
    liquidityHoleRisk,
    fakeFillRisk,
    fillProbability,
    fillRatios: ratios,
    pressure: p,
    marketImpactPct,
    expectedFillPrice,
    actualFillPrice,
    fillDeviationPct,
    executionAlpha,
    slippageAlpha,
    opportunityCost,
    executionQuality,
    regimeTransition: transition,
    stressLabel: stressLabel(stress),
    reasons
  };
  lastConditions = { ...result, ativo: input.ativo.toUpperCase(), updatedAt: new Date().toISOString() };
  return result;
}

export function getLastExchangeConditions(): Record<string, unknown> {
  if (lastConditions) return { ...lastConditions };
  return {
    ativo: null,
    mode: "BALANCED",
    spreadPct: 0,
    expectedSlippagePct: 0,
    actualSlippagePct: 0,
    latencyMs: 0,
    liquidityScore: 100,
    executionQuality: 100,
    stressLabel: "LOW",
    updatedAt: new Date().toISOString()
  };
}
