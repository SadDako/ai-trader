import dotenv from "dotenv";
import type { MarketData } from "../types/index.js";
import { computeRSI } from "../utils/rsi.js";
import { analyzeTrend } from "../utils/trendAnalysis.js";
import { computeMomentum } from "../utils/momentum.js";
import { detectBreakout } from "../utils/breakout.js";

dotenv.config({ override: true });

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 60_000;

const RSI_BAIXO = 40;
const RSI_ALTO = 60;

export type Tendencia = "alta" | "baixa" | "lateral";
export type Sinal = "compra" | "venda" | "esperar";

export interface AIResponse {
  tendencia: Tendencia;
  forca: number;
  sinal: Sinal;
  justificativa: string;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicResponse {
  content?: AnthropicTextBlock[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const MOMENTUM_THRESHOLD = 0.05;

type Voto = "compra" | "venda" | "neutro";

function votarRSI(rsi: number): Voto {
  if (rsi < RSI_BAIXO) return "compra";
  if (rsi > RSI_ALTO) return "venda";
  return "neutro";
}

function votarTendencia(tendencia: Tendencia): Voto {
  if (tendencia === "alta") return "compra";
  if (tendencia === "baixa") return "venda";
  return "neutro";
}

function votarMomentum(momentum: number): Voto {
  if (momentum > MOMENTUM_THRESHOLD) return "compra";
  if (momentum < -MOMENTUM_THRESHOLD) return "venda";
  return "neutro";
}

function buildFallback(market?: MarketData, motivo: string = "erro na IA"): AIResponse {
  if (!market || market.length < 2) {
    return {
      tendencia: "lateral",
      forca: 50,
      sinal: "esperar",
      justificativa: `fallback (${motivo}): sem dados suficientes pra inferir mercado`
    };
  }

  const closes = market.map((k) => Number(k[4])).filter((n) => Number.isFinite(n));
  if (closes.length < 2) {
    return {
      tendencia: "lateral",
      forca: 50,
      sinal: "esperar",
      justificativa: `fallback (${motivo}): closes inválidos`
    };
  }

  const { rsi } = computeRSI(closes);
  const { tendencia, intensidade } = analyzeTrend(closes);
  const { momentum } = computeMomentum(closes);
  const { breakout } = detectBreakout(closes);

  let sinal: Sinal;
  let racionalSinal: string;

  if (tendencia === "alta" && rsi > 50) {
    sinal = "compra";
    racionalSinal = `estratégia base: SMA9 > SMA21 (tendência alta) + RSI ${rsi} > 50 → compra`;
  } else if (tendencia === "baixa" && rsi < 50) {
    sinal = "venda";
    racionalSinal = `estratégia base: SMA9 < SMA21 (tendência baixa) + RSI ${rsi} < 50 → venda`;
  } else if (breakout === "alta") {
    sinal = "compra";
    racionalSinal = `breakout de alta complementar → compra`;
  } else if (breakout === "baixa") {
    sinal = "venda";
    racionalSinal = `breakout de baixa complementar → venda`;
  } else {
    sinal = "esperar";
    racionalSinal = `sinais conflitantes (tendência=${tendencia}, RSI=${rsi}) → esperar`;
  }

  const breakoutAlinhado =
    (breakout === "alta" && sinal === "compra") || (breakout === "baixa" && sinal === "venda");
  const baseStrategyAlinhada =
    (tendencia === "alta" && rsi > 50 && sinal === "compra") ||
    (tendencia === "baixa" && rsi < 50 && sinal === "venda");

  let baseForca: number;
  if (sinal === "esperar") baseForca = 35;
  else if (baseStrategyAlinhada && breakoutAlinhado) baseForca = 75;
  else if (baseStrategyAlinhada) baseForca = 65;
  else if (breakoutAlinhado) baseForca = 55;
  else baseForca = 50;

  const bonusIntensidade = intensidade * 3;
  const bonusMomentum = Math.abs(momentum) * 5;
  const forca = Math.round(clamp(baseForca + bonusIntensidade + bonusMomentum, 10, 95));

  const rsiEstado = rsi < 30 ? "sobrevendido" : rsi > 70 ? "sobrecomprado" : rsi < RSI_BAIXO ? "baixo" : rsi > RSI_ALTO ? "alto" : "neutro";
  const momentumEstado = momentum > MOMENTUM_THRESHOLD ? "positivo" : momentum < -MOMENTUM_THRESHOLD ? "negativo" : "estável";

  return {
    tendencia,
    forca,
    sinal,
    justificativa: `fallback (${motivo}): RSI=${rsi} (${rsiEstado}), tendência=${tendencia} via SMA9/SMA21 (intensidade ${intensidade}%), momentum=${momentum}%/candle (${momentumEstado}), breakout=${breakout}. ${racionalSinal}.`
  };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text.trim();
}

function isTendencia(v: unknown): v is Tendencia {
  return v === "alta" || v === "baixa" || v === "lateral";
}

function isSinal(v: unknown): v is Sinal {
  return v === "compra" || v === "venda" || v === "esperar";
}

function safeParse(raw: string): AIResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (
    isTendencia(obj.tendencia) &&
    typeof obj.forca === "number" &&
    Number.isFinite(obj.forca) &&
    isSinal(obj.sinal) &&
    typeof obj.justificativa === "string"
  ) {
    return {
      tendencia: obj.tendencia,
      forca: obj.forca,
      sinal: obj.sinal,
      justificativa: obj.justificativa
    };
  }
  return null;
}

export async function callAI<T = AIResponse>(prompt: string, market?: MarketData): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[ai.service] ANTHROPIC_API_KEY ausente — usando fallback.");
    return buildFallback(market, "ANTHROPIC_API_KEY ausente") as T;
  }

  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[ai.service] HTTP ${res.status}: ${body}`);
      return buildFallback(market, `HTTP ${res.status}`) as T;
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((b): b is AnthropicTextBlock => b?.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      console.error("[ai.service] Resposta vazia da API.");
      return buildFallback(market, "resposta vazia") as T;
    }

    const parsed = safeParse(text);
    if (!parsed) {
      console.error(`[ai.service] JSON inválido. Resposta bruta: ${text}`);
      return buildFallback(market, "JSON inválido") as T;
    }
    return parsed as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ai.service] Falha na requisição: ${msg}`);
    return buildFallback(market, msg) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}
