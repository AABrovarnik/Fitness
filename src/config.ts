import dotenv from "dotenv";

dotenv.config();

let runtimeAiApiKey = process.env.AI_API_KEY?.trim() || "";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./data/fitclub.db",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-secret",
  aiModel: process.env.AI_MODEL ?? "GPT-6 Luna",
  clubTimezone: process.env.CLUB_TIMEZONE ?? "Europe/Moscow",
  nodeEnv: process.env.NODE_ENV ?? "development"
};

export function getAiApiKey(): string {
  return runtimeAiApiKey;
}

export function setAiApiKey(value: string): void {
  runtimeAiApiKey = value.trim();
}

export function isAiKeyConfigured(): boolean {
  return runtimeAiApiKey.length > 0;
}
