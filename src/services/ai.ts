import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.js";
import { getAiApiKey, getAiModel } from "../config.js";

export type AgentMode = "consultant" | "trainer";
export type ProviderMode = "faq_only" | "llm_faq_fallback";

type FaqItem = {
  id: string;
  mode: "consultant" | "trainer" | "any";
  keywords: string[];
  answer: string;
  nextStep?: string;
};

type AiReplyRequest = {
  mode: AgentMode;
  input: string;
  userId: string;
  conversationId: string;
  providerMode: ProviderMode;
  clubName: string;
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
      LIMIT 6
    `)
    .all(conversationId) as { author_role: string; content: string }[];

  return rows
    .reverse()
    .map((row) => `${row.author_role}: ${row.content}`)
    .join("\n");
}

function buildRecentContextMemoryHint(db: Db, conversationId: string, currentInput: string): string | null {
  const rows = db
    .prepare(`
      SELECT author_role, content
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 12
    `)
    .all(conversationId) as { author_role: string; content: string }[];

  const normalized = currentInput.toLowerCase();
  const asksPrevious =
    /(предыдущ|прошл|последн|что я (писал|написал|сказал)|кодовое слово|напомни)/i.test(normalized);

  if (!asksPrevious) {
    return null;
  }

  const latestClientMessage = rows
    .find((row) => row.author_role === "client" && row.content.trim() !== "" && row.content.trim() !== currentInput.trim());

  if (!latestClientMessage) {
    return null;
  }

  return `В предыдущем вашем сообщении было: "${latestClientMessage.content}"`;
}

function safeFallback(mode: AgentMode, input: string, memoryHint: string): string {
  const generic = mode === "trainer"
    ? "Рекомендую начать с умеренной нагрузки: 5–7 минут разминки, 20–30 минут основной работы в комфортном темпе и заминка."
    : "Могу помочь с тарифами, расписанием, тренерами и записью в клуб.";

  return `${generic}${memoryHint ? ` Учитываю ваши предпочтения: ${memoryHint}.` : ""}${input ? "" : ""}`;
}

function getOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const asRecord = payload as Record<string, unknown>;
  if (typeof asRecord.output_text === "string" && asRecord.output_text.trim()) {
    return asRecord.output_text.trim();
  }

  const output = asRecord.output;
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) {
        return text.trim();
      }
    }
  }

  return null;
}

async function requestOpenAi(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const apiKey = getAiApiKey();
  if (!apiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: getAiModel(),
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      max_output_tokens: 350
    })
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as unknown;
  return getOutputText(payload);
}

export async function getAiReply(db: Db, req: AiReplyRequest): Promise<{ text: string; fallback: boolean; source: "faq" | "safety" | "llm" | "mock" }> {
  if (req.mode === "trainer") {
    const risky = /(боль|травм|головокруж|одышк|беремен|хронич|симптом)/i.test(req.input);
    if (risky) {
      return {
        text: "Я не могу давать рекомендации при симптомах или травме. Остановите упражнение и обратитесь к тренеру или врачу. При острых симптомах обратитесь за неотложной помощью.",
        fallback: false,
        source: "safety"
      };
    }
  }

  const memoryEnabled = db
    .prepare(`SELECT memory_enabled FROM users WHERE id = ? LIMIT 1`)
    .get(req.userId) as { memory_enabled: number } | undefined;

  const memoryRows = memoryEnabled?.memory_enabled
    ? (db
      .prepare(`SELECT category, fact FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 3`)
      .all(req.userId) as { category: string; fact: string }[])
    : [];

  const memoryHint = memoryRows.map((row) => `${row.category}: ${row.fact}`).join("; ");
  const context = latestContext(db, req.conversationId);
  const contextHint = buildRecentContextMemoryHint(db, req.conversationId, req.input);
  const faq = matchFaq(req.input, req.mode);

  if (req.providerMode === "faq_only") {
    if (faq) {
      return {
        text: `${faq.answer}${faq.nextStep ? ` ${faq.nextStep}` : ""}${contextHint ? ` ${contextHint}.` : ""}${memoryHint ? ` Учитываю ваши предпочтения: ${memoryHint}.` : ""}`,
        fallback: false,
        source: "faq"
      };
    }

    return {
      text: `${safeFallback(req.mode, req.input, memoryHint)}${contextHint ? ` ${contextHint}.` : ""} Это ответ в режиме FAQ-only.`,
      fallback: true,
      source: "mock"
    };
  }

  const systemPrompt = req.mode === "consultant" ? loadPrompt("consultant.txt") : loadPrompt("trainer.txt");
  const userPrompt = [
    `Клуб: ${req.clubName}`,
    memoryHint ? `Предпочтения пользователя: ${memoryHint}` : "",
    context ? `Последний контекст диалога:\n${context}` : "",
    `Текущий вопрос: ${req.input}`,
    "Ответь кратко и по делу на русском языке."
  ]
    .filter(Boolean)
    .join("\n\n");

  const llmText = await requestOpenAi(systemPrompt, userPrompt).catch(() => null);
  if (llmText) {
    return { text: llmText, fallback: false, source: "llm" };
  }

  if (faq) {
    return {
      text: `${faq.answer}${faq.nextStep ? ` ${faq.nextStep}` : ""}${contextHint ? ` ${contextHint}.` : ""}${memoryHint ? ` Учитываю ваши предпочтения: ${memoryHint}.` : ""} (LLM временно недоступен, включен fallback.)`,
      fallback: true,
      source: "faq"
    };
  }

  return {
    text: `${safeFallback(req.mode, req.input, memoryHint)}${contextHint ? ` ${contextHint}.` : ""} LLM временно недоступен, сработал безопасный fallback.`,
    fallback: true,
    source: "mock"
  };
}
