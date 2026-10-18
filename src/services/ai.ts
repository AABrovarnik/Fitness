import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.js";
import { getAiApiKey, getAiModel } from "../config.js";

export type AgentMode = "consultant" | "trainer";

type FaqItem = {
  id: string;
  mode: "consultant" | "trainer" | "any";
  keywords: string[];
  answer: string;
  nextStep?: string;
};

function loadPrompt(fileName: string): string {
  const full = path.resolve("prompts", fileName);
  if (!fs.existsSync(full)) {
    return "";
  }
  return fs.readFileSync(full, "utf8");
}

function loadFaq(): FaqItem[] {
  const full = path.resolve("data", "faq.json");
  if (!fs.existsSync(full)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(full, "utf8")) as FaqItem[];
  } catch {
    return [];
  }
}

function matchFaq(input: string, mode: AgentMode): FaqItem | null {
  const normalized = input.toLowerCase();
  const items = loadFaq().filter((item) => item.mode === "any" || item.mode === mode);

  let best: { item: FaqItem; score: number } | null = null;
  for (const item of items) {
    const score = item.keywords.reduce((acc, keyword) => acc + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { item, score };
    }
  }

  return best?.item ?? null;
}

function latestContext(db: Db, conversationId: string): string {
  const rows = db
    .prepare(`
      SELECT author_role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 4
    `)
    .all(conversationId) as { author_role: string; content: string }[];

  return rows.reverse().map((row) => `${row.author_role}: ${row.content}`).join(" | ");
}

export function getAiReply(
  db: Db,
  mode: AgentMode,
  input: string,
  userId: string,
  conversationId: string
): { text: string; fallback: boolean; source: "faq" | "safety" | "mock" } {
  if (getAiModel() !== "GPT-6 Luna") {
    return {
      text: "Сервис AI временно недоступен: ожидается модель GPT-6 Luna. Передайте вопрос администратору.",
      fallback: true,
      source: "mock"
    };
  }

  if (mode === "trainer") {
    const risky = /(боль|травм|головокруж|одышк|беремен|хронич|симптом)/i.test(input);
    if (risky) {
      return {
        text: "Я не могу давать рекомендации при симптомах или травме. Остановите упражнение и обратитесь к тренеру или врачу. При острых симптомах обратитесь за неотложной помощью.",
        fallback: false,
        source: "safety"
      };
    }
  }

  const prompt = mode === "consultant" ? loadPrompt("consultant.txt") : loadPrompt("trainer.txt");
  void prompt;

  const memoryRows = db
    .prepare(`SELECT category, fact FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 3`)
    .all(userId) as { category: string; fact: string }[];

  const memoryHint = memoryRows.map((row) => `${row.category}: ${row.fact}`).join("; ");
  const ctx = latestContext(db, conversationId);
  const faq = matchFaq(input, mode);

  if (faq) {
    const text = `${faq.answer}${faq.nextStep ? ` ${faq.nextStep}` : ""}${memoryHint ? ` Учитываю ваши предпочтения: ${memoryHint}.` : ""}`;
    return { text, fallback: false, source: "faq" };
  }

  const keyConfigured = Boolean(getAiApiKey());
  const generic = mode === "trainer"
    ? "Рекомендую начать с умеренной нагрузки: 5–7 минут разминки, 20–30 минут основной работы в комфортном темпе и заминка."
    : "Могу помочь с тарифами, расписанием, тренерами и записью в клуб.";

  const transparency = keyConfigured
    ? "Ключ AI настроен, но в этом MVP ответы сейчас формируются по безопасным правилам и базе типовых ответов."
    : "AI API ключ не задан, поэтому работает безопасный режим с базой типовых ответов.";

  const focus = ctx
    ? `Опираюсь на ваш последний контекст диалога: ${ctx.slice(0, 220)}${ctx.length > 220 ? "…" : ""}.`
    : "";

  return {
    text: `${generic} ${focus} ${transparency}`.trim(),
    fallback: true,
    source: "mock"
  };
}
