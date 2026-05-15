import { RandomForestRegression } from "ml-random-forest";
import { buildDataset } from "../utils/datasetBuilder.js";
import { encodeFeatures, encodeTarget, FEATURE_COUNT } from "./featureEncoder.js";
import { saveModel, type ModelMeta } from "./modelManager.js";
import { safeRound } from "../utils/safeMath.js";
import { logger } from "../utils/logger.js";

export const MIN_TRAIN_SAMPLES = 500;
const TEST_RATIO = 0.2;
const N_ESTIMATORS = 80;
const MAX_DEPTH = 8;

export interface TrainResult {
  ok: boolean;
  error?: string;
  meta?: ModelMeta;
}

function shuffleSeeded<T>(arr: T[], seed: number): T[] {
  // Mulberry32 PRNG — determinístico
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function trainModel(): TrainResult {
  const allSamples = buildDataset();
  // Apenas amostras avaliadas com label binário válido
  const labeled = allSamples
    .map((s) => {
      const x = encodeFeatures(s);
      const y = encodeTarget(s);
      if (!x || y === null) return null;
      return { x, y };
    })
    .filter((v): v is { x: number[]; y: number } => v !== null);

  if (labeled.length < MIN_TRAIN_SAMPLES) {
    const msg = `amostras insuficientes (${labeled.length} < ${MIN_TRAIN_SAMPLES})`;
    logger.warn("ml", msg);
    return { ok: false, error: msg };
  }

  // Shuffle determinístico (timestamp inicial como seed) + split 80/20
  const shuffled = shuffleSeeded(labeled, Math.floor(Date.now() / 1000));
  const splitIdx = Math.floor(shuffled.length * (1 - TEST_RATIO));
  const train = shuffled.slice(0, splitIdx);
  const test = shuffled.slice(splitIdx);

  const Xtr = train.map((p) => p.x);
  const ytr = train.map((p) => p.y);
  const Xte = test.map((p) => p.x);
  const yte = test.map((p) => p.y);

  const baseRate = ytr.length > 0 ? ytr.reduce((a, b) => a + b, 0) / ytr.length : 0;

  // RandomForestRegression: target binário 0/1, predict retorna probabilidade ~0..1
  const rf = new RandomForestRegression({
    nEstimators: N_ESTIMATORS,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    treeOptions: { maxDepth: MAX_DEPTH, minNumSamples: 5 }
  });

  try {
    rf.train(Xtr, ytr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("ml", `train falhou: ${msg}`);
    return { ok: false, error: `train falhou: ${msg}` };
  }

  // Avaliação no test set
  let preds: number[] = [];
  try {
    preds = rf.predict(Xte) as unknown as number[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `predict falhou: ${msg}` };
  }

  let correct = 0;
  let truePos = 0;
  let falsePos = 0;
  let falseNeg = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = Number.isFinite(preds[i]) ? preds[i] : 0.5;
    const cls = p > 0.5 ? 1 : 0;
    const y = yte[i];
    if (cls === y) correct += 1;
    if (cls === 1 && y === 1) truePos += 1;
    if (cls === 1 && y === 0) falsePos += 1;
    if (cls === 0 && y === 1) falseNeg += 1;
  }
  const accuracy = preds.length > 0 ? correct / preds.length : 0;
  const precision = truePos + falsePos > 0 ? truePos / (truePos + falsePos) : 0;
  const recall = truePos + falseNeg > 0 ? truePos / (truePos + falseNeg) : 0;

  let modelJson: unknown;
  try {
    modelJson = rf.toJSON();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `toJSON falhou: ${msg}` };
  }

  const meta: ModelMeta = {
    version: new Date().toISOString(),
    algorithm: "ml-random-forest@regression",
    trainedAt: new Date().toISOString(),
    sampleCount: labeled.length,
    trainSize: train.length,
    testSize: test.length,
    accuracy: safeRound(accuracy * 100, 2),
    precision: safeRound(precision * 100, 2),
    recall: safeRound(recall * 100, 2),
    baseRate: safeRound(baseRate * 100, 2),
    featureCount: FEATURE_COUNT,
    notes: `nEstimators=${N_ESTIMATORS}, maxDepth=${MAX_DEPTH}`
  };

  saveModel(modelJson, meta);
  logger.info("ml", "treino concluído", meta);
  return { ok: true, meta };
}
