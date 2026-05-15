import axios from "axios";
import type { MarketData } from "../types/index.js";
import { recordBinanceFetch, recordError } from "../utils/healthMonitor.js";
import { logger } from "../utils/logger.js";

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const DEFAULT_LIMIT = 100;
const MIN_ACEITAVEL = 30;

export async function getMarketData(
  symbol = "BTCUSDT",
  interval = "1m",
  limit = DEFAULT_LIMIT
): Promise<MarketData> {
  const ativo = symbol.toUpperCase();
  const params = { symbol: ativo, interval, limit };

  const tentar = async (): Promise<MarketData> => {
    const { data } = await axios.get<MarketData>(BINANCE_KLINES, { params, timeout: 15_000 });
    if (!Array.isArray(data)) {
      throw new Error("Binance retornou payload não-array");
    }
    return data;
  };

  let data: MarketData;
  try {
    data = await tentar();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[market.service] ${ativo} primeira tentativa falhou: ${msg}. Retry...`);
    logger.warn("market.service", `${ativo} retry após falha`, msg);
    await new Promise((r) => setTimeout(r, 800));
    try {
      data = await tentar();
    } catch (retryErr) {
      recordError("market.service", retryErr);
      throw retryErr;
    }
  }

  // Filtra candles inválidos (close não-finito)
  const valid = data.filter((k) => {
    const close = Number(k[4]);
    const openTime = Number(k[0]);
    return Number.isFinite(close) && Number.isFinite(openTime);
  });

  if (valid.length < limit) {
    console.warn(
      `[market.service] ${ativo}: Binance retornou ${valid.length}/${limit} candles válidos.`
    );
    logger.warn("market.service", `${ativo} retornou ${valid.length}/${limit} candles`);
  }
  if (valid.length < MIN_ACEITAVEL) {
    const e = new Error(`${ativo}: amostra abaixo do mínimo (${valid.length} < ${MIN_ACEITAVEL})`);
    recordError("market.service", e);
    throw e;
  }

  recordBinanceFetch(ativo, valid.length);
  return valid;
}
