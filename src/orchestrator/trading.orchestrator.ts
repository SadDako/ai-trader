import { getMarketData } from "../services/market.service";
import { tecnicoAgent } from "../agents/tecnico.agent";
import { analyzePatterns } from "../utils/patternAnalysis";
import { computeRSI } from "../utils/rsi";
import { computeScore } from "../utils/score";
import { analyzeTrend } from "../utils/trendAnalysis";
import { computeMomentum } from "../utils/momentum";
import { detectBreakout } from "../utils/breakout";
import { shouldForceExploration } from "../utils/forceExploration";
import { checkBootstrap } from "../utils/bootstrap";
import { checkInactivity, checkLowFrequency } from "../utils/inactivityCheck";
import { checkLossCooldown } from "../utils/lossCooldown";
import { updateMarketMemory, breakoutAtivo } from "../state/marketMemory";
import type { TecnicoAnalysis } from "../types/index";

export interface TradingCycleResult {
  ativo: string;
  decisao: string;
  confianca: number;
  analise: TecnicoAnalysis;
  precoEntrada: number;
  rsi: number;
  momentum: number;
  intensidade: number;
}

const DEFAULT_SYMBOL = "BTCUSDT";

const SCORE_LIBERA = 60;
const SCORE_MEDIO = 40;

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const RSI_LATERAL_LOW = 40;
const RSI_LATERAL_HIGH = 60;

function tendenciaProibida(tendenciaAtual: string, pior: string): boolean {
  return pior !== "indefinido" && tendenciaAtual === pior;
}

function resumirMotivos(detalhes: string[]): string {
  const curtos = detalhes.map((r) => {
    if (r.startsWith("tendência")) return "tendência adversa";
    return r;
  });
  return [...new Set(curtos)].join(" + ");
}

function motivosEsperarIA(rsi: number, tendencia: string): string[] {
  const motivos: string[] = ["sinal IA = esperar"];
  if (rsi >= RSI_LATERAL_LOW && rsi <= RSI_LATERAL_HIGH) motivos.push("RSI neutro");
  else if (rsi < RSI_OVERSOLD) motivos.push("RSI sobrevendido");
  else if (rsi > RSI_OVERBOUGHT) motivos.push("RSI sobrecomprado");
  if (tendencia === "lateral") motivos.push("tendência lateral");
  return motivos;
}

function descreverTendencia(tendencia: string, intensidade: number): string {
  if (tendencia === "alta") return `tendência alta (${intensidade}%)`;
  if (tendencia === "baixa") return `tendência baixa (${intensidade}%)`;
  return "tendência lateral";
}

function descreverRSI(rsi: number): string {
  if (rsi < RSI_OVERSOLD) return `RSI sobrevendido (${rsi})`;
  if (rsi < RSI_LATERAL_LOW) return `RSI baixo (${rsi})`;
  if (rsi > RSI_OVERBOUGHT) return `RSI sobrecomprado (${rsi})`;
  if (rsi > RSI_LATERAL_HIGH) return `RSI alto (${rsi})`;
  return `RSI neutro (${rsi})`;
}

function descreverMomentum(momentum: number): string {
  const v = momentum.toFixed(3);
  if (momentum > 0.05) return `momentum positivo (${v}%/c)`;
  if (momentum < -0.05) return `momentum negativo (${v}%/c)`;
  return `momentum estável (${v}%/c)`;
}

function descreverFatores(
  analise: TecnicoAnalysis,
  rsi: number,
  intensidade: number,
  momentum: number,
  score: number
): string {
  return [
    descreverTendencia(analise.tendencia, intensidade),
    descreverRSI(rsi),
    descreverMomentum(momentum),
    `score ${score}`
  ].join(" + ");
}

function rotuloConfianca(score: number): string {
  if (score >= SCORE_LIBERA) return "[CONFIANÇA ALTA] ";
  if (score >= SCORE_MEDIO) return "";
  return "[CONFIANÇA BAIXA] ";
}

export async function runTradingCycle(symbol: string = DEFAULT_SYMBOL): Promise<TradingCycleResult> {
  const ativo = symbol.toUpperCase();

  console.log(`[orchestrator] Coletando dados de ${ativo}...`);
  const market = await getMarketData(ativo);

  console.log(`[orchestrator] ${market.length} candles recebidos. Executando análise técnica...`);
  const analise = await tecnicoAgent(market);

  const closes = market.map((k) => Number(k[4]));
  const ultimoClose = closes[closes.length - 1];
  const precoEntrada = Number.isFinite(ultimoClose) ? ultimoClose : 0;

  const { rsi } = computeRSI(closes);
  const { intensidade } = analyzeTrend(closes);
  const { momentum } = computeMomentum(closes);
  const { breakout } = detectBreakout(closes);

  updateMarketMemory(ativo, { tendencia: analise.tendencia, breakout });

  let sinalEfetivo: string = analise.sinal;
  if (breakout === "alta" && sinalEfetivo === "esperar") sinalEfetivo = "compra";
  else if (breakout === "baixa" && sinalEfetivo === "esperar") sinalEfetivo = "venda";

  const direcao = sinalEfetivo === "compra" ? "compra" : sinalEfetivo === "venda" ? "venda" : null;
  const { score } = computeScore({ closes, direcao });

  const padroes = analyzePatterns();
  const fatoresBase = descreverFatores(analise, rsi, intensidade, momentum, score);
  const fatores = breakout !== "nenhum" ? `${fatoresBase} + breakout=${breakout}` : fatoresBase;

  let decisaoFinal = sinalEfetivo;
  const operacional = decisaoFinal === "compra" || decisaoFinal === "venda";

  const boot = checkBootstrap();
  const inativo = checkInactivity(ativo);
  const lowFreq = checkLowFrequency(ativo);

  if (operacional) {
    const motivosBloqueio: string[] = [];

    if (!boot.ativo && !inativo.ativa && !lowFreq.ativa && tendenciaProibida(analise.tendencia, padroes.piorTendencia)) {
      motivosBloqueio.push(`tendência "${analise.tendencia}" historicamente ruim`);
    }

    const tagBoot = boot.ativo
      ? `[BOOTSTRAP ${boot.total}/${boot.limite}] `
      : inativo.ativa
        ? `[INATIVIDADE ${inativo.ciclosEsperar} ciclos] `
        : lowFreq.ativa
          ? `[BAIXA FREQUÊNCIA ${lowFreq.ciclosSemOperacao} ciclos sem op] `
          : "";

    if (motivosBloqueio.length > 0) {
      console.log(
        `[orchestrator] ${ativo}: ${tagBoot}ESPERAR (sinal IA: ${decisaoFinal}) → ${fatores}. Bloqueado por: ${resumirMotivos(motivosBloqueio)} | detalhes: ${motivosBloqueio.join("; ")}.`
      );
      decisaoFinal = "esperar";
    } else {
      console.log(
        `[orchestrator] ${ativo}: ${tagBoot}${rotuloConfianca(score)}${decisaoFinal.toUpperCase()}: ${fatores}.`
      );
    }
  } else {
    const motivos = motivosEsperarIA(rsi, analise.tendencia);
    console.log(
      `[orchestrator] ${ativo}: ESPERAR: ${fatores}. Motivo: ${motivos.join(" + ")}.`
    );
  }

  if (decisaoFinal === "esperar") {
    const janela = breakoutAtivo(ativo);
    if (janela) {
      const direcaoJanela = janela.direcao === "alta" ? "compra" : "venda";
      console.log(
        `[orchestrator] ${ativo}: ${direcaoJanela.toUpperCase()} [JANELA-BREAKOUT]: ${fatores}. Breakout ${janela.direcao} há ${janela.ciclosDesdeBreakout} ciclo(s), dentro da janela de oportunidade.`
      );
      decisaoFinal = direcaoJanela;
    }
  }

  if (decisaoFinal === "esperar") {
    const forcado = shouldForceExploration(ativo, momentum);
    if (forcado) {
      console.log(
        `[orchestrator] ${ativo}: FORÇA EXPLORAÇÃO → ${forcado.toUpperCase()} (a cada 10 ciclos sem operações recentes, geração de dados).`
      );
      decisaoFinal = forcado;
    }
  }

  const cooldown = checkLossCooldown(ativo);
  if (cooldown.ativa && (decisaoFinal === "compra" || decisaoFinal === "venda")) {
    console.log(
      `[orchestrator] ${ativo}: COOLDOWN PÓS-PERDA → esperar (${cooldown.ciclosRestantes}/${cooldown.limite} ciclos restantes).`
    );
    decisaoFinal = "esperar";
  }

  return {
    ativo,
    decisao: decisaoFinal,
    confianca: score,
    analise,
    precoEntrada,
    rsi,
    momentum,
    intensidade
  };
}
