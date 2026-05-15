import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

const MODELS_DIR = resolve(process.cwd(), "data", "models");
const CURRENT_PATH = resolve(MODELS_DIR, "current.json");

if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true });

export interface ModelMeta {
  version: string;             // ISO timestamp
  algorithm: string;           // "ml-random-forest@regression"
  trainedAt: string;
  sampleCount: number;
  trainSize: number;
  testSize: number;
  accuracy: number;            // % no test set
  precision: number;
  recall: number;
  baseRate: number;            // % de positivos no train (sanity)
  featureCount: number;
  notes?: string;
}

export interface PersistedModel {
  meta: ModelMeta;
  modelJson: unknown;          // saída do RandomForest.toJSON()
}

interface CurrentPointer {
  version: string;
  file: string;
  meta: ModelMeta;
}

function safeFilename(version: string): string {
  return "rf-" + version.replace(/[:.]/g, "-") + ".json";
}

export function saveModel(modelJson: unknown, meta: ModelMeta): { path: string } {
  const filename = safeFilename(meta.version);
  const filePath = resolve(MODELS_DIR, filename);
  const payload: PersistedModel = { meta, modelJson };
  writeFileSync(filePath, JSON.stringify(payload), "utf-8");
  const pointer: CurrentPointer = { version: meta.version, file: filename, meta };
  writeFileSync(CURRENT_PATH, JSON.stringify(pointer, null, 2), "utf-8");
  logger.info("ml", `modelo salvo ${filename}`, {
    accuracy: meta.accuracy,
    samples: meta.sampleCount
  });
  return { path: filePath };
}

export function getCurrentPointer(): CurrentPointer | null {
  if (!existsSync(CURRENT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CURRENT_PATH, "utf-8")) as CurrentPointer;
  } catch (err) {
    logger.error("ml", `pointer corrompido: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function loadPersistedModel(): PersistedModel | null {
  const ptr = getCurrentPointer();
  if (!ptr) return null;
  const filePath = resolve(MODELS_DIR, ptr.file);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedModel;
    if (!parsed || !parsed.meta || !parsed.modelJson) return null;
    return parsed;
  } catch (err) {
    logger.error("ml", `falha ao carregar modelo: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function getModelMeta(): ModelMeta | null {
  const ptr = getCurrentPointer();
  return ptr ? ptr.meta : null;
}

export const MODELS_DIR_PATH = MODELS_DIR;
