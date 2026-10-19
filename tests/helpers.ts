import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { runMigrations, type Db } from "../src/db/db.js";
import { hashPassword } from "../src/services/auth.js";
import type { Response } from "supertest";

export interface SeededUsers {
  adminId: string;
  clientAId: string;
  clientBId: string;
}

export function setupTestDb(): { db: Db; users: SeededUsers } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);

  db.prepare(`
    INSERT INTO club_settings(id, club_name, address, hours, phone, email, description, booking_cancel_hours, ai_welcome_text)
    VALUES(1, 'Test Club', 'Addr', '06:00-23:00', '+7', 'test@test.local', 'demo', 2, 'hello')
  `).run();

  const adminId = nanoid();
  const clientAId = nanoid();
  const clientBId = nanoid();

  const insertUser = db.prepare(`
    INSERT INTO users(id, name, email, phone, password_hash, role, status, memory_enabled, created_at)
    VALUES(?, ?, ?, ?, ?, ?, 'active', 1, datetime('now'))
  `);

  insertUser.run(adminId, "Admin", "admin@fitclub.local", "+7", hashPassword("11111"), "admin");
  insertUser.run(clientAId, "Client A", "a@fitclub.local", "+7", hashPassword("11111"), "client");
  insertUser.run(clientBId, "Client B", "b@fitclub.local", "+7", hashPassword("11111"), "client");

  db.prepare(`INSERT INTO client_profiles(user_id, preferred_days, preferred_time, goal, format, interests, consent_pd) VALUES(?, '', '', '', '', '', 1)`).run(clientAId);
  db.prepare(`INSERT INTO client_profiles(user_id, preferred_days, preferred_time, goal, format, interests, consent_pd) VALUES(?, '', '', '', '', '', 1)`).run(clientBId);

  const typeId = nanoid();
  db.prepare(`INSERT INTO membership_types(id, name, description, demo_price, duration_days, visit_limit, freeze_rules, active) VALUES(?, 'Type', 'desc', 1000, 30, 10, '', 1)`).run(typeId);

  const start = new Date(Date.now() - 3600000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  db.prepare(`INSERT INTO memberships(id, client_id, type_id, starts_at, ends_at, status, visit_limit, visit_used) VALUES(?, ?, ?, ?, ?, 'active', 10, 0)`).run(nanoid(), clientAId, typeId, start, end);
  db.prepare(`INSERT INTO memberships(id, client_id, type_id, starts_at, ends_at, status, visit_limit, visit_used) VALUES(?, ?, ?, ?, ?, 'active', 10, 0)`).run(nanoid(), clientBId, typeId, start, end);

  const trainerId = nanoid();
  db.prepare(`INSERT INTO trainers(id, name, specialization, description, active) VALUES(?, 'T', 'S', 'D', 1)`).run(trainerId);

  const eventStart = new Date(Date.now() + 4 * 3600000).toISOString();
  const eventEnd = new Date(Date.now() + 5 * 3600000).toISOString();
  db.prepare(`
    INSERT INTO schedule_events(id, type, title, starts_at, ends_at, trainer_id, resource_name, capacity, booking_enabled, status, level, description)
    VALUES('event-1', 'group', 'Test Event', ?, ?, ?, 'Hall', 1, 1, 'active', 'beginner', 'demo')
  `).run(eventStart, eventEnd, trainerId);

  return { db, users: { adminId, clientAId, clientBId } };
}

export function extractCsrfToken(page: Response): string {
  const match = page.text.match(/meta name="csrf-token" content="([^"]+)"/i);
  if (!match?.[1]) {
    throw new Error("CSRF token not found in page response");
  }
  return match[1];
}

