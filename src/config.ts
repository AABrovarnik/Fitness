import dotenv from "dotenv";

dotenv.config();

let runtimeAiApiKey = process.env.AI_API_KEY?.trim() || "";
let runtimeAiModel = (process.env.AI_MODEL?.trim() || "GPT-6 Luna");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./data/fitclub.db",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-secret",
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

export function getAiModel(): string {
  return runtimeAiModel;
}

export function setAiModel(value: string): void {
  runtimeAiModel = value.trim() || "GPT-6 Luna";
}
