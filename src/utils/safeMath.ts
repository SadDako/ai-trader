/**
 * Helpers de matemática defensiva.
 * Toda saída garantidamente Number.isFinite — sem NaN, sem Infinity, sem null.
 */

export function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function safeAdd(a: unknown, b: unknown): number {
  return safeNumber(a) + safeNumber(b);
}

export function safeSub(a: unknown, b: unknown): number {
  return safeNumber(a) - safeNumber(b);
}

export function safeMul(a: unknown, b: unknown): number {
  const r = safeNumber(a) * safeNumber(b);
  return Number.isFinite(r) ? r : 0;
}

export function safeDiv(a: unknown, b: unknown, fallback = 0): number {
  const num = safeNumber(a);
  const den = safeNumber(b);
  if (den === 0) return fallback;
  const r = num / den;
  return Number.isFinite(r) ? r : fallback;
}

export function clamp(value: unknown, min: number, max: number): number {
  const v = safeNumber(value, min);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export function clampNonNegative(value: unknown): number {
  const v = safeNumber(value, 0);
  return v < 0 ? 0 : v;
}

export function safeRound(value: unknown, decimals = 2): number {
  const v = safeNumber(value, 0);
  const factor = 10 ** decimals;
  const r = Math.round(v * factor) / factor;
  return Number.isFinite(r) ? r : 0;
}

/**
 * Garante que o saldo nunca abaixe de uma piso (default -100% — perda total da banca simulada),
 * nunca explode pra Infinity, nunca vira NaN.
 */
export function safeBalance(value: unknown, floor = -100, ceiling = 1_000_000): number {
  const v = safeNumber(value, 0);
  if (v < floor) return floor;
  if (v > ceiling) return ceiling;
  return v;
}

/**
 * Garante score 0-100, sempre finite.
 */
export function safeScore(value: unknown): number {
  return clamp(value, 0, 100);
}

/**
 * Garante confiança 0-100, sempre finite.
 */
export function safeConfidence(value: unknown): number {
  return clamp(value, 0, 100);
}
