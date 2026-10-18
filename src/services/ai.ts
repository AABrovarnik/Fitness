import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.js";
import { config, getAiApiKey } from "../config.js";

export type AgentMode = "consultant" | "trainer";

function loadPrompt(fileName: string): string {
  const full = path.resolve("prompts", fileName);
  if (!fs.existsSync(full)) {
    return "";
  }
  return fs.readFileSync(full, "utf8");
}

export function getAiReply(db: Db, mode: AgentMode, input: string, userId: string): { text: string; fallback: boolean } {
  if (config.aiModel !== "GPT-6 Luna") {
    return {
      text: "Сервис AI временно недоступен: ожидается модель GPT-6 Luna. Передайте вопрос администратору.",
      fallback: true
    };
  }

  if (!getAiApiKey()) {
    return {
      text: "AI сейчас работает в безопасном демо-режиме без внешнего API. Я могу подсказать базовую информацию и передать вопрос администратору.",
      fallback: true
    };
  }

  const prompt = mode === "consultant" ? loadPrompt("consultant.txt") : loadPrompt("trainer.txt");
  const memoryRows = db
    .prepare(`SELECT category, fact FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 3`)
    .all(userId) as { category: string; fact: string }[];

  const memoryHint = memoryRows.map((row) => `${row.category}: ${row.fact}`).join("; ");
  const lead = mode === "trainer" ? "AI-тренер" : "AI-консультант";
  const safeInput = input.trim();

  if (mode === "trainer") {
    const risky = /(боль|травм|головокруж|одышк|беремен|хронич|симптом)/i.test(safeInput);
    if (risky) {
      return {
        text: "Я не могу давать рекомендации при симптомах или травме. Остановите упражнение и обратитесь к тренеру или врачу. При острых симптомах обратитесь за неотложной помощью.",
        fallback: false
      };
    }
  }

  const answer = `${lead}: ${safeInput}. ${memoryHint ? `Учтены ваши предпочтения: ${memoryHint}. ` : ""}Это демонстрационный ответ на базе правил клуба.`;
  void prompt;

  return { text: answer, fallback: false };
}
