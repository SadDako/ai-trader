import axios from "axios";
import type { MarketData } from "../types/index.js";

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";

export async function getMarketData(
  symbol = "BTCUSDT",
  interval = "1m",
  limit = 50
): Promise<MarketData> {
  const { data } = await axios.get<MarketData>(BINANCE_KLINES, {
    params: { symbol, interval, limit },
    timeout: 15_000
  });
  return data;
}
