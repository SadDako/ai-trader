export type Kline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base asset volume
  string, // taker buy quote asset volume
  string  // ignore
];

export type MarketData = Kline[];

export interface TecnicoAnalysis {
  tendencia: "alta" | "baixa" | "lateral";
  forca: number;
  sinal: "compra" | "venda" | "neutro";
  justificativa: string;
}
