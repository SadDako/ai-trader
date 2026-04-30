import { buildTecnicoPrompt } from "../prompts/tecnico.prompt.js";
import { callAI } from "../services/ai.service.js";
import type { MarketData, TecnicoAnalysis } from "../types/index.js";

export async function tecnicoAgent(data: MarketData): Promise<TecnicoAnalysis> {
  const prompt = buildTecnicoPrompt(data);
  return callAI<TecnicoAnalysis>(prompt, data);
}
