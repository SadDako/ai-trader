import { trainModel, type TrainResult, MIN_TRAIN_SAMPLES } from "./trainModel.js";
import { invalidateModelCache, getCurrentModelMeta } from "./predictSignal.js";
import { countTotal } from "../state/decisionsRepo.js";
import { logger } from "../utils/logger.js";

const RETRAIN_INTERVAL_HOURS = 4;
const RETRAIN_DELTA_SAMPLES = 200;

interface RetrainState {
  lastTrainAt: number | null;
  lastTrainSampleCount: number;
  inProgress: boolean;
  lastResult: TrainResult | null;
}

const state: RetrainState = {
  lastTrainAt: null,
  lastTrainSampleCount: 0,
  inProgress: false,
  lastResult: null
};

function refreshFromMeta(): void {
  const meta = getCurrentModelMeta();
  if (meta) {
    state.lastTrainAt = new Date(meta.trainedAt).getTime();
    state.lastTrainSampleCount = meta.sampleCount;
  }
}

export async function maybeRetrain(force = false): Promise<TrainResult | null> {
  if (state.inProgress) return null;
  refreshFromMeta();

  const now = Date.now();
  const totalAtual = countTotal();
  const horasDesdeUltimo = state.lastTrainAt ? (now - state.lastTrainAt) / 3_600_000 : Infinity;
  const deltaSamples = totalAtual - state.lastTrainSampleCount;

  const motivo: string[] = [];
  if (force) motivo.push("force=true");
  if (!state.lastTrainAt) motivo.push("primeira execução");
  if (horasDesdeUltimo >= RETRAIN_INTERVAL_HOURS) motivo.push(`${horasDesdeUltimo.toFixed(1)}h desde último`);
  if (deltaSamples >= RETRAIN_DELTA_SAMPLES) motivo.push(`+${deltaSamples} samples`);

  if (motivo.length === 0) return null;
  if (totalAtual < MIN_TRAIN_SAMPLES) {
    logger.info("ml.autoRetrain", `aguardando ${MIN_TRAIN_SAMPLES} samples (atual: ${totalAtual})`);
    return null;
  }

  state.inProgress = true;
  logger.info("ml.autoRetrain", `iniciando retrain: ${motivo.join(" + ")}`);
  try {
    const result = trainModel();
    state.lastResult = result;
    if (result.ok && result.meta) {
      state.lastTrainAt = new Date(result.meta.trainedAt).getTime();
      state.lastTrainSampleCount = result.meta.sampleCount;
      invalidateModelCache();
    }
    return result;
  } finally {
    state.inProgress = false;
  }
}

export function getRetrainStatus() {
  refreshFromMeta();
  return {
    lastTrainAt: state.lastTrainAt ? new Date(state.lastTrainAt).toISOString() : null,
    lastTrainSampleCount: state.lastTrainSampleCount,
    inProgress: state.inProgress,
    intervalHours: RETRAIN_INTERVAL_HOURS,
    deltaThreshold: RETRAIN_DELTA_SAMPLES,
    minSamples: MIN_TRAIN_SAMPLES,
    lastResult: state.lastResult
  };
}

let timer: NodeJS.Timeout | null = null;

export function startAutoRetrainLoop(): void {
  if (timer) clearInterval(timer);
  // Tenta logo no boot e depois a cada 30 minutos
  setTimeout(() => { void maybeRetrain(false); }, 5_000);
  timer = setInterval(() => { void maybeRetrain(false); }, 30 * 60_000);
}

export function stopAutoRetrainLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
