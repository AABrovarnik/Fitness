import express from "express";
import session from "express-session";
import path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config, isAiKeyConfigured, setAiApiKey } from "./config.js";
import { openDb, runMigrations, nowIso, type Db } from "./db/db.js";
import { hashPassword, verifyPassword } from "./services/auth.js";
import { requireRole } from "./middleware/auth.js";
import { validateBooking, canCancelByClient } from "./services/booking.js";
import { getAiReply } from "./services/ai.js";
import { writeAudit } from "./services/audit.js";

export function createApp(dbArg?: Db) {
  const db = dbArg ?? openDb();
  runMigrations(db);

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 8 }
    })
  );

  app.set("view engine", "ejs");
  app.set("views", path.resolve("src/views"));
  app.use("/static", express.static(path.resolve("src/public")));

  app.use((req, res, next) => {
    res.locals.user = req.session.user;
    next();
  });

  const refreshMemberships = () => {
    db.prepare(`UPDATE memberships SET status = 'expired' WHERE status = 'active' AND ends_at < ?`).run(nowIso());
  };

  app.get("/", (_req, res) => {
    const settings = db.prepare(`SELECT * FROM club_settings WHERE id = 1`).get() as Record<string, unknown> | undefined;
    const trainers = db.prepare(`SELECT name, specialization, description FROM trainers WHERE active = 1 LIMIT 4`).all();
    const schedule = db.prepare(`SELECT title, starts_at, ends_at, capacity FROM schedule_events WHERE status = 'active' ORDER BY starts_at LIMIT 8`).all();
    const types = db.prepare(`SELECT name, description, demo_price FROM membership_types WHERE active = 1`).all();
    res.render("home", { settings, trainers, schedule, types });
  });

  app.get("/login", (_req, res) => res.render("login", { error: null }));
  app.get("/register", (_req, res) => res.render("register", { error: null }));

  app.post("/auth/login", (req, res) => {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("login", { error: "Проверьте email и пароль." });
      return;
    }

    const user = db.prepare(`SELECT * FROM users WHERE email = ? LIMIT 1`).get(parsed.data.email) as
      | { id: string; role: "client" | "admin"; name: string; email: string; password_hash: string; status: string }
      | undefined;

    if (!user || !verifyPassword(parsed.data.password, user.password_hash) || user.status !== "active") {
      res.status(401).render("login", { error: "Неверные данные входа." });
      return;
    }

    req.session.user = { id: user.id, role: user.role, name: user.name, email: user.email };
    res.redirect(user.role === "admin" ? "/admin" : "/client");
  });

  app.post("/auth/register", (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(80),
      email: z.string().email(),
      phone: z.string().min(6).max(30),
      password: z.string().min(5)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("register", { error: "Проверьте корректность формы." });
      return;
    }

    const exists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(parsed.data.email) as { id: string } | undefined;
    if (exists) {
      res.status(409).render("register", { error: "Пользователь с таким email уже есть." });
      return;
    }

    const userId = nanoid();
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO users(id, name, email, phone, password_hash, role, status, memory_enabled, created_at)
      VALUES(?, ?, ?, ?, ?, 'client', 'active', 1, ?)
    `).run(userId, parsed.data.name, parsed.data.email, parsed.data.phone, hashPassword(parsed.data.password), createdAt);

    db.prepare(`
      INSERT INTO client_profiles(user_id, preferred_days, preferred_time, goal, format, interests, consent_pd)
      VALUES(?, '', '', '', 'self', '', 1)
    `).run(userId);

    req.session.user = { id: userId, role: "client", name: parsed.data.name, email: parsed.data.email };
    res.redirect("/client");
  });

  app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
  });

  app.post("/api/public/lead", (req, res) => {
    const schema = z.object({ name: z.string().min(2), contact: z.string().min(4), interest: z.string().min(2) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректная заявка." });
      return;
    }

    const now = nowIso();
    const leadId = nanoid();
    db.prepare(`INSERT INTO leads(id, name, contact, interest, source, status, created_at) VALUES(?, ?, ?, ?, 'lead_magnet', 'new', ?)`)
      .run(leadId, parsed.data.name, parsed.data.contact, parsed.data.interest, now);

    const convId = nanoid();
    db.prepare(`
      INSERT INTO conversations(id, client_id, guest_contact, topic, status, mode, created_at, updated_at)
      VALUES(?, NULL, ?, ?, 'new', 'human', ?, ?)
    `).run(convId, parsed.data.contact, `Лид-магнит: ${parsed.data.interest}`, now, now);

    db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'guest', NULL, ?, ?)`)
      .run(nanoid(), convId, `Новая заявка: ${parsed.data.name}. Интерес: ${parsed.data.interest}`, now);

    res.json({ ok: true });
  });

  app.get("/client", requireRole("client"), (req, res) => {
    refreshMemberships();
    const userId = req.session.user!.id;
    const membership = db.prepare(`SELECT m.*, mt.name as type_name FROM memberships m JOIN membership_types mt ON mt.id = m.type_id WHERE m.client_id = ? ORDER BY m.ends_at DESC LIMIT 1`).get(userId);
    const nextBooking = db.prepare(`
      SELECT b.id, b.status, s.title, s.starts_at
      FROM bookings b JOIN schedule_events s ON s.id = b.event_id
      WHERE b.client_id = ? AND b.status = 'booked' AND s.starts_at > ?
      ORDER BY s.starts_at LIMIT 1
    `).get(userId, nowIso());
    res.render("client", { membership, nextBooking });
  });

  app.get("/client/profile", requireRole("client"), (req, res) => {
    const profile = db.prepare(`SELECT u.name, u.email, u.phone, u.memory_enabled, p.* FROM users u JOIN client_profiles p ON p.user_id = u.id WHERE u.id = ?`).get(req.session.user!.id);
    res.render("client_profile", { profile, saved: req.query.saved === "1" });
  });

  app.post("/client/profile", requireRole("client"), (req, res) => {
    const schema = z.object({
      preferred_days: z.string().max(120),
      preferred_time: z.string().max(120),
      goal: z.string().max(200),
      format: z.string().max(40),
      interests: z.string().max(200),
      memory_enabled: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Ошибка формы");
      return;
    }
    const userId = req.session.user!.id;
    db.prepare(`UPDATE client_profiles SET preferred_days=?, preferred_time=?, goal=?, format=?, interests=? WHERE user_id=?`)
      .run(parsed.data.preferred_days, parsed.data.preferred_time, parsed.data.goal, parsed.data.format, parsed.data.interests, userId);
    db.prepare(`UPDATE users SET memory_enabled=? WHERE id=?`).run(parsed.data.memory_enabled ? 1 : 0, userId);
    res.redirect("/client/profile?saved=1");
  });

  app.get("/client/bookings", requireRole("client"), (req, res) => {
    const events = db.prepare(`SELECT * FROM schedule_events WHERE status='active' ORDER BY starts_at LIMIT 30`).all();
    const mine = db.prepare(`
      SELECT b.id, b.status, s.title, s.starts_at, s.ends_at
      FROM bookings b JOIN schedule_events s ON s.id = b.event_id
      WHERE b.client_id = ? ORDER BY s.starts_at DESC
    `).all(req.session.user!.id);
    res.render("client_bookings", { events, mine, now: nowIso() });
  });

  app.post("/api/client/bookings", requireRole("client"), (req, res) => {
    const eventId = String(req.body.event_id ?? "");
    const clientId = req.session.user!.id;
    const check = validateBooking(db, clientId, eventId);
    if (!check.ok) {
      res.status(400).json({ error: check.reason });
      return;
    }
    db.prepare(`INSERT INTO bookings(id, client_id, event_id, status, created_at) VALUES(?, ?, ?, 'booked', ?)`)
      .run(nanoid(), clientId, eventId, nowIso());
    res.json({ ok: true });
  });

  app.post("/api/client/bookings/:id/cancel", requireRole("client"), (req, res) => {
    const booking = db.prepare(`
      SELECT b.id, b.client_id, b.status, s.starts_at
      FROM bookings b JOIN schedule_events s ON s.id = b.event_id
      WHERE b.id = ?
    `).get(req.params.id) as { id: string; client_id: string; status: string; starts_at: string } | undefined;

    if (!booking || booking.client_id !== req.session.user!.id) {
      res.status(404).json({ error: "Запись не найдена." });
      return;
    }
    if (booking.status !== "booked") {
      res.status(400).json({ error: "Нельзя отменить запись в текущем статусе." });
      return;
    }
    if (!canCancelByClient(booking.starts_at, new Date(), 2)) {
      res.status(400).json({ error: "Отмена доступна не позднее чем за 2 часа до начала." });
      return;
    }

    db.prepare(`UPDATE bookings SET status='canceled_by_client', canceled_at=? WHERE id=?`).run(nowIso(), booking.id);
    res.json({ ok: true });
  });

  app.get("/client/history", requireRole("client"), (req, res) => {
    const items = db.prepare(`SELECT * FROM training_logs WHERE client_id=? ORDER BY log_date DESC`).all(req.session.user!.id);
    res.render("client_history", { items });
  });

  app.post("/api/client/history", requireRole("client"), (req, res) => {
    const schema = z.object({
      log_date: z.string(),
      load_type: z.string().min(2),
      duration_min: z.coerce.number().int().min(5).max(300),
      intensity: z.coerce.number().int().min(1).max(10),
      note: z.string().max(300).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректные данные" });
      return;
    }
    db.prepare(`INSERT INTO training_logs(id, client_id, log_date, load_type, duration_min, intensity, note) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
      nanoid(),
      req.session.user!.id,
      parsed.data.log_date,
      parsed.data.load_type,
      parsed.data.duration_min,
      parsed.data.intensity,
      parsed.data.note ?? ""
    );
    res.json({ ok: true });
  });

  app.get("/client/memory", requireRole("client"), (req, res) => {
    const rows = db.prepare(`SELECT * FROM user_memory WHERE user_id=? ORDER BY updated_at DESC`).all(req.session.user!.id);
    res.render("client_memory", { rows });
  });

  app.post("/api/client/memory", requireRole("client"), (req, res) => {
    const schema = z.object({ category: z.string().min(2).max(40), fact: z.string().min(2).max(200) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректные данные." });
      return;
    }

    const forbidden = /(диагноз|симптом|парол|карт|платеж|беремен|травм)/i.test(parsed.data.fact);
    if (forbidden) {
      res.status(400).json({ error: "Эта категория данных не сохраняется в долгосрочной памяти." });
      return;
    }

    const id = nanoid();
    db.prepare(`
      INSERT INTO user_memory(id, user_id, category, fact, source, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'manual', 'confirmed', ?, ?)
    `).run(id, req.session.user!.id, parsed.data.category, parsed.data.fact, nowIso(), nowIso());
    res.json({ ok: true, id });
  });

  app.put("/api/client/memory/:id", requireRole("client"), (req, res) => {
    const schema = z.object({ category: z.string().min(2).max(40), fact: z.string().min(2).max(200) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректные данные." });
      return;
    }

    const row = db.prepare(`SELECT user_id FROM user_memory WHERE id=?`).get(req.params.id) as { user_id: string } | undefined;
    if (!row || row.user_id !== req.session.user!.id) {
      res.status(404).json({ error: "Запись не найдена." });
      return;
    }

    db.prepare(`UPDATE user_memory SET category=?, fact=?, updated_at=? WHERE id=?`).run(parsed.data.category, parsed.data.fact, nowIso(), req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/client/memory/:id", requireRole("client"), (req, res) => {
    const row = db.prepare(`SELECT user_id FROM user_memory WHERE id=?`).get(req.params.id) as { user_id: string } | undefined;
    if (!row || row.user_id !== req.session.user!.id) {
      res.status(404).json({ error: "Запись не найдена." });
      return;
    }
    db.prepare(`DELETE FROM user_memory WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/client/memory", requireRole("client"), (req, res) => {
    db.prepare(`DELETE FROM user_memory WHERE user_id=?`).run(req.session.user!.id);
    res.json({ ok: true });
  });

  app.get("/client/chat", requireRole("client"), (req, res) => {
    const userId = req.session.user!.id;
    let conversation = db.prepare(`SELECT * FROM conversations WHERE client_id=? ORDER BY updated_at DESC LIMIT 1`).get(userId) as
      | { id: string; mode: string; topic: string; status: string }
      | undefined;

    if (!conversation) {
      const now = nowIso();
      const id = nanoid();
      db.prepare(`INSERT INTO conversations(id, client_id, topic, status, mode, created_at, updated_at) VALUES(?, ?, 'Общий вопрос', 'in_progress', 'ai', ?, ?)`).run(id, userId, now, now);
      conversation = { id, mode: "ai", topic: "Общий вопрос", status: "in_progress" };
    }

    const messages = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at`).all(conversation.id);
    res.render("client_chat", { conversation, messages });
  });

  app.post("/api/client/chat/message", requireRole("client"), (req, res) => {
    const schema = z.object({ conversation_id: z.string().min(3), content: z.string().min(1).max(1000), mode: z.enum(["ai", "trainer", "human"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректное сообщение." });
      return;
    }

    const conv = db.prepare(`SELECT * FROM conversations WHERE id=? AND client_id=?`).get(parsed.data.conversation_id, req.session.user!.id) as
      | { id: string; mode: string }
      | undefined;
    if (!conv) {
      res.status(404).json({ error: "Диалог не найден." });
      return;
    }

    const now = nowIso();
    db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'client', ?, ?, ?)`).run(nanoid(), conv.id, req.session.user!.id, parsed.data.content, now);

    let aiReply = "Сообщение передано администратору.";
    let newStatus = parsed.data.mode === "human" ? "waiting_admin" : "in_progress";

    if (parsed.data.mode !== "human") {
      const mode = parsed.data.mode === "trainer" ? "trainer" : "consultant";
      aiReply = getAiReply(db, mode, parsed.data.content, req.session.user!.id).text;
      db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'ai', NULL, ?, ?)`).run(nanoid(), conv.id, aiReply, nowIso());
    }

    db.prepare(`UPDATE conversations SET status=?, mode=?, updated_at=? WHERE id=?`).run(newStatus, parsed.data.mode, nowIso(), conv.id);
    res.json({ ok: true, reply: aiReply });
  });

  app.get("/admin", requireRole("admin"), (req, res) => {
    refreshMemberships();
    const stats = {
      clients: (db.prepare(`SELECT COUNT(*) as c FROM users WHERE role='client'`).get() as { c: number }).c,
      leadsNew: (db.prepare(`SELECT COUNT(*) as c FROM leads WHERE status='new'`).get() as { c: number }).c,
      conversations: (db.prepare(`SELECT COUNT(*) as c FROM conversations WHERE status IN ('new','waiting_admin','in_progress')`).get() as { c: number }).c
    };
    const expiring = db.prepare(`SELECT u.name, m.ends_at FROM memberships m JOIN users u ON u.id=m.client_id WHERE m.status='active' AND m.ends_at < ? ORDER BY m.ends_at LIMIT 20`).all(new Date(Date.now() + 14 * 86400000).toISOString());
    const keySaved = req.query.key_saved === "1";
    res.render("admin", { stats, expiring, aiKeyConfigured: isAiKeyConfigured(), keySaved });
  });

  app.post("/admin/settings/ai-key", requireRole("admin"), (req, res) => {
    const aiKey = String(req.body.ai_api_key ?? "").trim();
    if (!aiKey) {
      res.status(400).send("Ключ не может быть пустым.");
      return;
    }
    if (aiKey.length < 20) {
      res.status(400).send("Похоже, ключ слишком короткий.");
      return;
    }

    setAiApiKey(aiKey);
    writeAudit(db, {
      actorType: "admin",
      actorUserId: req.session.user!.id,
      action: "update_ai_key",
      entityType: "system_settings",
      entityId: "ai_api_key",
      changeSummary: "ai_api_key_updated=true"
    });

    res.redirect("/admin?key_saved=1");
  });
  app.get("/admin/clients", requireRole("admin"), (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const sql = q
      ? `SELECT id, name, email, phone, status FROM users WHERE role='client' AND (name LIKE @q OR email LIKE @q OR phone LIKE @q) ORDER BY created_at DESC`
      : `SELECT id, name, email, phone, status FROM users WHERE role='client' ORDER BY created_at DESC`;
    const clients = q ? db.prepare(sql).all({ q: `%${q}%` }) : db.prepare(sql).all();
    res.render("admin_clients", { clients, q });
  });

  app.get("/admin/conversations", requireRole("admin"), (_req, res) => {
    const conversations = db.prepare(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100`).all();
    res.render("admin_conversations", { conversations });
  });

  app.post("/api/admin/conversations/:id/reply", requireRole("admin"), (req, res) => {
    const content = String(req.body.content ?? "").trim();
    if (!content) {
      res.status(400).json({ error: "Пустой ответ." });
      return;
    }
    const conv = db.prepare(`SELECT id, client_id FROM conversations WHERE id=?`).get(req.params.id) as { id: string; client_id: string | null } | undefined;
    if (!conv) {
      res.status(404).json({ error: "Диалог не найден." });
      return;
    }
    db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'admin', ?, ?, ?)`)
      .run(nanoid(), conv.id, req.session.user!.id, content, nowIso());
    db.prepare(`UPDATE conversations SET status='in_progress', mode='human', updated_at=? WHERE id=?`).run(nowIso(), conv.id);
    res.json({ ok: true });
  });

  app.post("/api/admin/user-memory/:id", requireRole("admin"), (req, res) => {
    const row = db.prepare(`SELECT id, user_id, category FROM user_memory WHERE id=?`).get(req.params.id) as { id: string; user_id: string; category: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "Запись не найдена." });
      return;
    }
    const fact = String(req.body.fact ?? "").trim();
    if (!fact) {
      res.status(400).json({ error: "Пустое значение." });
      return;
    }
    db.prepare(`UPDATE user_memory SET fact=?, updated_at=? WHERE id=?`).run(fact, nowIso(), row.id);
    writeAudit(db, {
      actorType: "admin",
      actorUserId: req.session.user!.id,
      action: "edit_memory",
      entityType: "user_memory",
      entityId: row.id,
      targetUserId: row.user_id,
      changeSummary: `category=${row.category}; fact_updated=true`
    });
    res.json({ ok: true });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, model: config.aiModel });
  });

  return app;
}


