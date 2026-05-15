import { RandomForestRegression } from "ml-random-forest";
import { encodeFeaturesFromContext, type PredictionContext } from "./featureEncoder.js";
import { loadPersistedModel, getModelMeta, type ModelMeta } from "./modelManager.js";
import { safeRound, clamp } from "../utils/safeMath.js";
import { logger } from "../utils/logger.js";

export interface PredictionResult {
  probability_profit: number;   // 0..1
  confidence: number;           // 0..1 (distância de 0.5 normalizada)
  model_version: string | null;
  source: "model" | "heuristic" | "no_model";
  notes?: string;
}

let cachedModel: RandomForestRegression | null = null;
let cachedVersion: string | null = null;

function tryLoadModel(): { model: RandomForestRegression; meta: ModelMeta } | null {
  const persisted = loadPersistedModel();
  if (!persisted) return null;
  if (cachedModel && cachedVersion === persisted.meta.version) {
    return { model: cachedModel, meta: persisted.meta };
  }
  try {
    const model = RandomForestRegression.load(persisted.modelJson as Record<string, unknown> as never);
    cachedModel = model;
    cachedVersion = persisted.meta.version;
    return { model, meta: persisted.meta };
  } catch (err) {
    logger.error("ml", `load modelo falhou: ${err instanceof Error ? err.message : err}`);
    cachedModel = null;
    cachedVersion = null;
    return null;
  }
}

/**
 * Fallback heurístico baseado em RSI + tendência + edge score.
 * Usa quando modelo não treinou ainda ou falhou ao carregar.
 */
function heuristicProbability(ctx: PredictionContext): PredictionResult {
  let p = 0.5;
  // Direção alinhada com tendência
  if (ctx.direcao === "compra" && ctx.tendencia === "alta") p += 0.05;
  if (ctx.direcao === "venda" && ctx.tendencia === "baixa") p += 0.05;
  if (ctx.direcao === "compra" && ctx.tendencia === "baixa") p -= 0.08;
  if (ctx.direcao === "venda" && ctx.tendencia === "alta") p -= 0.08;
  // RSI extremo a favor (compra em sobrevenda, venda em sobrecompra)
  const rsi = typeof ctx.rsi === "number" ? ctx.rsi : 50;
  if (ctx.direcao === "compra" && rsi < 35) p += 0.07;
  if (ctx.direcao === "venda" && rsi > 65) p += 0.07;
  // Edge score histórico
  const edge = typeof ctx.edgeScore === "number" ? ctx.edgeScore : 50;
  p += ((edge - 50) / 100) * 0.1;

  p = clamp(p, 0, 1);
  return {
    probability_profit: safeRound(p, 4),
    confidence: safeRound(Math.abs(p - 0.5) * 2, 4),
    model_version: null,
    source: "heuristic",
    notes: "modelo indisponível — usando heurística baseada em RSI/tendência/edge"
  };
}

// Se o modelo está degenerado (base rate < 5%), ele só prediz a classe majoritária.
// Nesse caso usamos heurística — a probabilidade do modelo seria sempre ~baseRate.
const BASE_RATE_MIN_PCT = 5;
const BASE_RATE_MAX_PCT = 95;

export function predictTradeProbability(ctx: PredictionContext): PredictionResult {
  const loaded = tryLoadModel();
  if (!loaded) {
    return heuristicProbability(ctx);
  }
  if (loaded.meta.baseRate < BASE_RATE_MIN_PCT || loaded.meta.baseRate > BASE_RATE_MAX_PCT) {
    const h = heuristicProbability(ctx);
    h.model_version = loaded.meta.version;
    h.notes = `modelo degenerado (baseRate=${loaded.meta.baseRate}% — fora de [${BASE_RATE_MIN_PCT}, ${BASE_RATE_MAX_PCT}]) — usando heurística`;
    return h;
  }
  const x = encodeFeaturesFromContext(ctx);
  let raw = 0.5;
  try {
    const out = loaded.model.predict([x]) as unknown as number[];
    if (Array.isArray(out) && out.length > 0 && Number.isFinite(out[0])) {
      raw = out[0];
    }
  } catch (err) {
    logger.error("ml", `predict falhou, fallback heurístico: ${err instanceof Error ? err.message : err}`);
    return heuristicProbability(ctx);
  }
  const probability = clamp(raw, 0, 1);
  const confidence = clamp(Math.abs(probability - 0.5) * 2, 0, 1);
  return {
    probability_profit: safeRound(probability, 4),
    confidence: safeRound(confidence, 4),
    model_version: loaded.meta.version,
    source: "model"
  };
}

export function getCurrentModelMeta(): ModelMeta | null {
  return getModelMeta();
}

export function invalidateModelCache(): void {
  cachedModel = null;
  cachedVersion = null;
}
