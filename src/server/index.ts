import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computePerformance } from "../utils/performance.js";

const PORT = Number(process.env.WEB_PORT ?? 3000);
const DECISIONS_FILE = resolve(process.cwd(), "data", "decisions.json");
const PUBLIC_DIR = resolve(process.cwd(), "public");

interface RawDecision {
  [key: string]: unknown;
}

function readDecisions(): RawDecision[] {
  if (!existsSync(DECISIONS_FILE)) return [];
  try {
    const raw = readFileSync(DECISIONS_FILE, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RawDecision[]) : [];
  } catch {
    return [];
  }
}

const app = express();

app.use(express.static(PUBLIC_DIR));

app.get("/decisions", (_req, res) => {
  res.json(readDecisions());
});

app.get("/performance", (_req, res) => {
  res.json(computePerformance());
});

app.listen(PORT, () => {
  console.log(`[web] Dashboard em http://localhost:${PORT}`);
});
