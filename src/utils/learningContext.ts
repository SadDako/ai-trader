import { db } from "../state/database.js";

const MIN_SAMPLES = 5;
const PESO_COMBINACAO = 0.6;   // ±30% no fator
const PESO_TENDENCIA = 0.2;    // ±10%
const PESO_RSI = 0.15;         // ±7.5%
const PESO_MOMENTUM = 0.15;    // ±7.5%
const FATOR_MIN = 0.5;
const FATOR_MAX = 1.5;

export type FaixaRSI = "sobrevendido" | "baixo" | "neutro" | "alto" | "sobrecomprado";
export type FaixaMomentum = "negativo" | "estavel" | "positivo";

export interface PatternStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface PerformanceAnalysis {
  porTendencia: Record<string, PatternStats>;
  porFaixaRSI: Record<string, PatternStats>;
  porMomentum: Record<string, PatternStats>;
  porCombinacao: Record<string, PatternStats>;
  totalAvaliados: number;
}

export interface ConfidenceContext {
  decisao: string;
  tendencia: string;
  rsi: number;
  momentum: number;
}

export interface ConfidenceAdjustment {
  fator: number;
  motivos: string[];
  amostras: number;
}

export function classifyRSI(rsi: number): FaixaRSI {
  if (!Number.isFinite(rsi)) return "neutro";
  if (rsi < 30) return "sobrevendido";
  if (rsi < 40) return "baixo";
  if (rsi <= 60) return "neutro";
  if (rsi <= 70) return "alto";
  return "sobrecomprado";
}

export function classifyMomentum(momentum: number): FaixaMomentum {
  if (!Number.isFinite(momentum)) return "estavel";
  if (momentum > 0.05) return "positivo";
  if (momentum < -0.05) return "negativo";
  return "estavel";
}

function emptyStats(): PatternStats {
  return { total: 0, wins: 0, losses: 0, winRate: 0 };
}

function bumpStat(map: Record<string, PatternStats>, key: string, won: boolean, lost: boolean): void {
  const s = map[key] ?? emptyStats();
  s.total += 1;
  if (won) s.wins += 1;
  if (lost) s.losses += 1;
  s.winRate = s.total > 0 ? s.wins / s.total : 0;
  map[key] = s;
}

interface RowEvaluated {
  ativo: string;
  decisao: string;
  tendencia: string;
  rsi: number;
  momentum: number;
  resultado: string;
}

const stmtEvaluated = db.prepare(`
  SELECT ativo, decisao, tendencia, rsi, momentum, resultado
  FROM decisions
  WHERE avaliada = 1
    AND (decisao = 'compra' OR decisao = 'venda')
    AND (resultado = 'lucro' OR resultado = 'prejuizo')
`);

export function analyzePerformance(): PerformanceAnalysis {
  const rows = stmtEvaluated.all() as unknown as RowEvaluated[];
  const result: PerformanceAnalysis = {
    porTendencia: Object.create(null),
    porFaixaRSI: Object.create(null),
    porMomentum: Object.create(null),
    porCombinacao: Object.create(null),
    totalAvaliados: rows.length
  };

  for (const r of rows) {
    const won = r.resultado === "lucro";
    const lost = r.resultado === "prejuizo";
    const rsiK = classifyRSI(r.rsi);
    const momK = classifyMomentum(r.momentum);

    bumpStat(result.porTendencia, r.tendencia, won, lost);
    bumpStat(result.porFaixaRSI, rsiK, won, lost);
    bumpStat(result.porMomentum, momK, won, lost);
    bumpStat(result.porCombinacao, `${r.decisao}:${r.tendencia}:${rsiK}:${momK}`, won, lost);
  }

  return result;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function applyDelta(
  fator: number,
  stats: PatternStats | undefined,
  peso: number,
  motivos: string[],
  rotulo: string
): { fator: number; amostras: number } {
  if (!stats || stats.total < MIN_SAMPLES) return { fator, amostras: 0 };
  const delta = (stats.winRate - 0.5) * peso;
  const novoFator = fator * (1 + delta);
  const sinal = delta >= 0 ? "+" : "";
  motivos.push(
    `${rotulo}: ${stats.wins}/${stats.total} (${(stats.winRate * 100).toFixed(0)}% wr) ${sinal}${(delta * 100).toFixed(1)}%`
  );
  return { fator: novoFator, amostras: stats.total };
}

export function computeConfidenceAdjustment(
  ctx: ConfidenceContext,
  perf?: PerformanceAnalysis
): ConfidenceAdjustment {
  const motivos: string[] = [];
  if (ctx.decisao !== "compra" && ctx.decisao !== "venda") {
    return { fator: 1, motivos: ["sem ajuste — decisão não-operacional"], amostras: 0 };
  }

  const analysis = perf ?? analyzePerformance();
  if (analysis.totalAvaliados < MIN_SAMPLES) {
    return {
      fator: 1,
      motivos: [`sem ajuste — apenas ${analysis.totalAvaliados} trades avaliados (mín ${MIN_SAMPLES})`],
      amostras: analysis.totalAvaliados
    };
  }

  const rsiK = classifyRSI(ctx.rsi);
  const momK = classifyMomentum(ctx.momentum);
  let fator = 1;
  let amostras = 0;

  // Padrão mais específico tem mais peso
  const combRes = applyDelta(
    fator,
    analysis.porCombinacao[`${ctx.decisao}:${ctx.tendencia}:${rsiK}:${momK}`],
    PESO_COMBINACAO,
    motivos,
    `combo ${ctx.decisao}/${ctx.tendencia}/${rsiK}/${momK}`
  );
  fator = combRes.fator;
  amostras = Math.max(amostras, combRes.amostras);

  const tRes = applyDelta(fator, analysis.porTendencia[ctx.tendencia], PESO_TENDENCIA, motivos, `tendência ${ctx.tendencia}`);
  fator = tRes.fator;
  amostras = Math.max(amostras, tRes.amostras);

  const rRes = applyDelta(fator, analysis.porFaixaRSI[rsiK], PESO_RSI, motivos, `RSI ${rsiK}`);
  fator = rRes.fator;
  amostras = Math.max(amostras, rRes.amostras);

  const mRes = applyDelta(fator, analysis.porMomentum[momK], PESO_MOMENTUM, motivos, `momentum ${momK}`);
  fator = mRes.fator;
  amostras = Math.max(amostras, mRes.amostras);

  fator = clamp(fator, FATOR_MIN, FATOR_MAX);

  if (motivos.length === 0) {
    motivos.push("sem ajuste — amostras insuficientes em todos os buckets");
  }

  return {
    fator: Math.round(fator * 1000) / 1000,
    motivos,
    amostras
  };
}
