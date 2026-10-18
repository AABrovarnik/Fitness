import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type Db = DatabaseSync;

export function openDb(dbPath = config.dbPath): Db {
  const absolute = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const db = new DatabaseSync(absolute);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function initSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('client','admin')),
      status TEXT NOT NULL DEFAULT 'active',
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferred_days TEXT,
      preferred_time TEXT,
      goal TEXT,
      format TEXT,
      interests TEXT,
      consent_pd INTEGER NOT NULL DEFAULT 0,
      birth_date TEXT
    );

    CREATE TABLE IF NOT EXISTS membership_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      demo_price INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      visit_limit INTEGER,
      freeze_rules TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type_id TEXT NOT NULL REFERENCES membership_types(id),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','active','frozen','expired','canceled')),
      visit_limit INTEGER,
      visit_used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trainers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      specialization TEXT NOT NULL,
      description TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      zone TEXT NOT NULL,
      units_total INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available','maintenance'))
    );

    CREATE TABLE IF NOT EXISTS schedule_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      trainer_id TEXT REFERENCES trainers(id),
      resource_name TEXT,
      capacity INTEGER NOT NULL,
      booking_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('active','canceled')),
      level TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES schedule_events(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('booked','canceled_by_client','canceled_by_admin','completed','no_show')),
      created_at TEXT NOT NULL,
      canceled_at TEXT,
      UNIQUE(client_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      booking_id TEXT REFERENCES bookings(id),
      visited_at TEXT NOT NULL,
      source TEXT NOT NULL,
      comment TEXT
    );

    CREATE TABLE IF NOT EXISTS training_logs (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log_date TEXT NOT NULL,
      load_type TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      intensity INTEGER NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      guest_contact TEXT,
      topic TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('new','waiting_admin','in_progress','closed')),
      mode TEXT NOT NULL CHECK(mode IN ('ai','human','trainer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      author_role TEXT NOT NULL,
      author_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      fact TEXT NOT NULL,
      source TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      interest TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp_utc TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      target_user_id TEXT,
      change_summary TEXT,
      reason TEXT,
      request_id TEXT
    );

    CREATE TABLE IF NOT EXISTS club_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      club_name TEXT NOT NULL,
      address TEXT NOT NULL,
      hours TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      description TEXT NOT NULL,
      booking_cancel_hours INTEGER NOT NULL DEFAULT 2,
      ai_welcome_text TEXT NOT NULL
    );
  `);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function runMigrations(db: Db): void {
  initSchema(db);
}
