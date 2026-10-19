import express from "express";
import session from "express-session";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config, getAiModel, isAiKeyConfigured, setAiApiKey, setAiModel } from "./config.js";
import { openDb, runMigrations, nowIso, type Db } from "./db/db.js";
import { hashPassword, verifyPassword } from "./services/auth.js";
import { requireRole } from "./middleware/auth.js";
import { validateBooking, canCancelByClient, hasTrainerOrResourceConflict } from "./services/booking.js";
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

  app.use((req, res, next) => {
    const sessionRef = req.session as session.Session & Partial<session.SessionData> & { csrfToken?: string };
    if (!sessionRef.csrfToken) {
      sessionRef.csrfToken = randomBytes(24).toString("hex");
    }
    res.locals.csrfToken = sessionRef.csrfToken;
    next();
  });

  app.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next();
      return;
    }

    if (req.path === "/auth/login" || req.path === "/auth/register") {
      next();
      return;
    }

    const sessionRef = req.session as session.Session & Partial<session.SessionData> & { csrfToken?: string };
    const expected = sessionRef.csrfToken;
    const provided =
      String(req.headers["x-csrf-token"] ?? "") ||
      String((req.body as Record<string, unknown> | undefined)?._csrf ?? "");

    if (!expected || !provided || expected !== provided) {
      const wantsHtml = (req.headers.accept ?? "").includes("text/html");
      if (wantsHtml) {
        res.status(403).send("CSRF token missing or invalid.");
        return;
      }
      res.status(403).json({ error: "CSRF token missing or invalid." });
      return;
    }

    next();
  });

  app.set("view engine", "ejs");
  app.set("views", path.resolve("src/views"));
  app.use("/static", express.static(path.resolve("src/public")));

  app.use((req, res, next) => {
    res.locals.user = req.session.user;
    res.locals.formatDateTime = (value: string | number | Date) => {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      return new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
    };
    next();
  });

  const refreshMemberships = () => {
    db.prepare(`UPDATE memberships SET status = 'expired' WHERE status = 'active' AND ends_at < ?`).run(nowIso());
  };

  app.get("/", (_req, res) => {
    const settings = db.prepare(`SELECT * FROM club_settings WHERE id = 1`).get() as Record<string, unknown> | undefined;
    res.render("home", { settings });
  });

  app.get("/offers", (_req, res) => {
    const settings = db.prepare(`SELECT club_name FROM club_settings WHERE id = 1`).get() as { club_name: string } | undefined;
    const types = db.prepare(`SELECT name, description, demo_price, duration_days, visit_limit FROM membership_types WHERE active = 1 ORDER BY demo_price ASC`).all();
    res.render("offers", { settings, types });
  });

  app.get("/trainers", (_req, res) => {
    const settings = db.prepare(`SELECT club_name FROM club_settings WHERE id = 1`).get() as { club_name: string } | undefined;
    const trainers = db.prepare(`SELECT name, specialization, description FROM trainers WHERE active = 1 ORDER BY name`).all();
    res.render("trainers", { settings, trainers });
  });

  app.get("/schedule", (_req, res) => {
    const settings = db.prepare(`SELECT club_name FROM club_settings WHERE id = 1`).get() as { club_name: string } | undefined;
    const schedule = db.prepare(`
      SELECT s.title, s.type, s.starts_at, s.ends_at, s.capacity, t.name as trainer_name
      FROM schedule_events s
      LEFT JOIN trainers t ON t.id = s.trainer_id
      WHERE s.status = 'active'
      ORDER BY s.starts_at
      LIMIT 60
    `).all();
    res.render("schedule", { settings, schedule });
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

  app.post("/api/public/chat", async (req, res) => {
    const schema = z.object({ content: z.string().min(1).max(1000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректное сообщение." });
      return;
    }

    const settings = db.prepare(`SELECT club_name, ai_mode FROM club_settings WHERE id=1`).get() as
      | { club_name: string; ai_mode: "faq_only" | "llm_faq_fallback" }
      | undefined;

    const sessionRef = req.session as session.Session & Partial<session.SessionData> & { publicConversationId?: string };
    let conversationId = sessionRef.publicConversationId;
    let conversation = conversationId
      ? (db.prepare(`SELECT id FROM conversations WHERE id=? AND client_id IS NULL`).get(conversationId) as { id: string } | undefined)
      : undefined;

    if (!conversation) {
      conversationId = nanoid();
      const now = nowIso();
      db.prepare(`
        INSERT INTO conversations(id, client_id, guest_contact, topic, status, mode, created_at, updated_at)
        VALUES(?, NULL, NULL, 'Публичная консультация', 'in_progress', 'ai', ?, ?)
      `).run(conversationId, now, now);
      sessionRef.publicConversationId = conversationId;
      conversation = { id: conversationId };
    }

    const now = nowIso();
    db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'guest', NULL, ?, ?)`)
      .run(nanoid(), conversation.id, parsed.data.content, now);

    const response = await getAiReply(db, {
      mode: "consultant",
      input: parsed.data.content,
      userId: `guest:${conversation.id}`,
      conversationId: conversation.id,
      providerMode: settings?.ai_mode ?? "faq_only",
      clubName: settings?.club_name ?? "FitClub Personal"
    });

    const normalized = parsed.data.content.toLowerCase();
    const wantsBooking = /(запис|пробн|посет|купить|оплат|абонемент)/i.test(normalized);
    const wantsTrainer = /(нагруз|план|програм|тренер|силов|кардио|похуд|набор)/i.test(normalized);

    let scenario = "Если захотите, после регистрации я помогу продолжить консультацию в личном кабинете.";
    let route = "/register";
    if (wantsBooking) {
      scenario = "Похоже, вы готовы записаться: после регистрации я передам вас администратору для подтверждения слота.";
      route = "/register?intent=booking";
    } else if (wantsTrainer) {
      scenario = "Похоже, вы хотите подобрать нагрузки: после регистрации направим к тренеру для персонального плана.";
      route = "/register?intent=trainer";
    } else {
      scenario = "По фитнес-вопросам можно продолжать консультации с AI-консультантом, лучше после регистрации для сохранения контекста.";
      route = "/register?intent=consult";
    }

    const teaser = "Можем присылать новые тарифы и интересные программы — лучше зарегистрироваться, чтобы не потерять рекомендации.";
    const finalReply = `${response.text}\n\n${scenario}\n${teaser}`;

    db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'ai', NULL, ?, ?)`)
      .run(nanoid(), conversation.id, finalReply, nowIso());
    db.prepare(`UPDATE conversations SET updated_at=? WHERE id=?`).run(nowIso(), conversation.id);

    res.json({ ok: true, reply: finalReply, route });
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
    writeAudit(db, {
      actorType: "client",
      actorUserId: req.session.user!.id,
      action: "view_memory",
      entityType: "user_memory",
      entityId: undefined,
      targetUserId: req.session.user!.id,
      changeSummary: `rows=${rows.length}`
    });
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
    writeAudit(db, {
      actorType: "client",
      actorUserId: req.session.user!.id,
      action: "create_memory",
      entityType: "user_memory",
      entityId: id,
      targetUserId: req.session.user!.id,
      changeSummary: `category=${parsed.data.category}`
    });
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
    writeAudit(db, {
      actorType: "client",
      actorUserId: req.session.user!.id,
      action: "update_memory",
      entityType: "user_memory",
      entityId: req.params.id,
      targetUserId: req.session.user!.id,
      changeSummary: `category=${parsed.data.category}`
    });
    res.json({ ok: true });
  });

  app.delete("/api/client/memory/:id", requireRole("client"), (req, res) => {
    const row = db.prepare(`SELECT user_id FROM user_memory WHERE id=?`).get(req.params.id) as { user_id: string } | undefined;
    if (!row || row.user_id !== req.session.user!.id) {
      res.status(404).json({ error: "Запись не найдена." });
      return;
    }
    db.prepare(`DELETE FROM user_memory WHERE id=?`).run(req.params.id);
    writeAudit(db, {
      actorType: "client",
      actorUserId: req.session.user!.id,
      action: "delete_memory",
      entityType: "user_memory",
      entityId: req.params.id,
      targetUserId: req.session.user!.id,
      changeSummary: "single_record_deleted"
    });
    res.json({ ok: true });
  });

  app.delete("/api/client/memory", requireRole("client"), (req, res) => {
    const count = (db.prepare(`SELECT COUNT(*) as c FROM user_memory WHERE user_id=?`).get(req.session.user!.id) as { c: number }).c;
    db.prepare(`DELETE FROM user_memory WHERE user_id=?`).run(req.session.user!.id);
    writeAudit(db, {
      actorType: "client",
      actorUserId: req.session.user!.id,
      action: "clear_memory",
      entityType: "user_memory",
      entityId: undefined,
      targetUserId: req.session.user!.id,
      changeSummary: `deleted=${count}`
    });
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

  app.post("/api/client/chat/message", requireRole("client"), async (req, res) => {
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
      const settings = db.prepare(`SELECT club_name, ai_mode FROM club_settings WHERE id=1`).get() as { club_name: string; ai_mode: "faq_only" | "llm_faq_fallback" } | undefined;
      const providerMode = settings?.ai_mode ?? "faq_only";
      const response = await getAiReply(db, {
        mode,
        input: parsed.data.content,
        userId: req.session.user!.id,
        conversationId: conv.id,
        providerMode,
        clubName: settings?.club_name ?? "FitClub Personal"
      });
      const sourceLabel = response.source === "llm" ? "[LLM]" : response.source === "faq" ? "[FAQ]" : "[SAFE]";
      aiReply = `${sourceLabel} ${response.text}`;
      db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'ai', NULL, ?, ?)`).run(nanoid(), conv.id, aiReply, nowIso());
    }

    db.prepare(`UPDATE conversations SET status=?, mode=?, updated_at=? WHERE id=?`).run(newStatus, parsed.data.mode, nowIso(), conv.id);
    res.json({ ok: true, reply: aiReply });
  });

  app.get("/admin", requireRole("admin"), (_req, res) => {
    refreshMemberships();
    const stats = {
      clients: (db.prepare(`SELECT COUNT(*) as c FROM users WHERE role='client'`).get() as { c: number }).c,
      leadsNew: (db.prepare(`SELECT COUNT(*) as c FROM leads WHERE status='new'`).get() as { c: number }).c,
      conversations: (db.prepare(`SELECT COUNT(*) as c FROM conversations WHERE status IN ('new','waiting_admin','in_progress')`).get() as { c: number }).c
    };
    const expiring = db.prepare(`SELECT u.name, m.ends_at FROM memberships m JOIN users u ON u.id=m.client_id WHERE m.status='active' AND m.ends_at < ? ORDER BY m.ends_at LIMIT 20`).all(new Date(Date.now() + 14 * 86400000).toISOString());
    const bookings = db.prepare(`
      SELECT b.id, b.status, b.client_id, s.title, s.starts_at, u.name as client_name
      FROM bookings b
      JOIN schedule_events s ON s.id = b.event_id
      JOIN users u ON u.id = b.client_id
      WHERE b.status = 'booked'
      ORDER BY s.starts_at ASC
      LIMIT 30
    `).all();
    res.render("admin", { stats, expiring, bookings });
  });

  app.post("/api/admin/bookings/:id/status", requireRole("admin"), (req, res) => {
    const schema = z.object({ status: z.enum(["completed", "no_show", "canceled_by_admin"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Некорректный статус." });
      return;
    }

    const booking = db.prepare(`
      SELECT b.id, b.client_id, b.event_id, b.status, s.starts_at
      FROM bookings b
      JOIN schedule_events s ON s.id = b.event_id
      WHERE b.id = ?
    `).get(req.params.id) as { id: string; client_id: string; event_id: string; status: string; starts_at: string } | undefined;

    if (!booking) {
      res.status(404).json({ error: "Запись не найдена." });
      return;
    }
    if (booking.status !== "booked") {
      res.status(400).json({ error: "Изменение доступно только для записей в статусе booked." });
      return;
    }

    const targetStatus = parsed.data.status;

    db.exec("BEGIN");
    try {
      if (targetStatus === "completed") {
        const membership = db.prepare(`
          SELECT id, visit_limit, visit_used
          FROM memberships
          WHERE client_id = ? AND status = 'active' AND starts_at <= ? AND ends_at >= ?
          ORDER BY ends_at DESC
          LIMIT 1
        `).get(booking.client_id, booking.starts_at, booking.starts_at) as
          | { id: string; visit_limit: number | null; visit_used: number }
          | undefined;

        if (!membership) {
          db.exec("ROLLBACK");
          res.status(400).json({ error: "Нет активного абонемента на момент посещения." });
          return;
        }
        if (membership.visit_limit !== null && membership.visit_used >= membership.visit_limit) {
          db.exec("ROLLBACK");
          res.status(400).json({ error: "Лимит абонемента исчерпан." });
          return;
        }

        db.prepare(`UPDATE memberships SET visit_used = visit_used + 1 WHERE id = ?`).run(membership.id);
        db.prepare(`
          INSERT INTO visits(id, client_id, booking_id, visited_at, source, comment)
          VALUES(?, ?, ?, ?, 'admin_mark', 'Фактическое посещение подтверждено администратором')
        `).run(nanoid(), booking.client_id, booking.id, nowIso());
      }

      db.prepare(`UPDATE bookings SET status=? WHERE id=?`).run(targetStatus, booking.id);

      writeAudit(db, {
        actorType: "admin",
        actorUserId: req.session.user!.id,
        action: "update_booking_status",
        entityType: "booking",
        entityId: booking.id,
        targetUserId: booking.client_id,
        changeSummary: `status=${targetStatus}`
      });

      db.exec("COMMIT");
      res.json({ ok: true });
    } catch {
      db.exec("ROLLBACK");
      res.status(500).json({ error: "Не удалось обновить статус записи." });
    }
  });

  app.get("/admin/settings", requireRole("admin"), (req, res) => {
    const settings = db.prepare(`SELECT * FROM club_settings WHERE id = 1`).get() as {
      club_name: string;
      address: string;
      hours: string;
      phone: string;
      email: string;
      description: string;
      booking_cancel_hours: number;
      ai_welcome_text: string;
      ai_mode: "faq_only" | "llm_faq_fallback";
    } | undefined;

    res.render("admin_settings", {
      settings,
      aiKeyConfigured: isAiKeyConfigured(),
      aiModel: getAiModel(),
      aiMode: settings?.ai_mode ?? "faq_only",
      saved: req.query.saved === "1"
    });
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

    res.redirect("/admin/settings?saved=1");
  });

  app.post("/admin/settings/ai-model", requireRole("admin"), (req, res) => {
    const model = String(req.body.ai_model ?? "").trim();
    if (!model || model.length < 3 || model.length > 80) {
      res.status(400).send("Некорректное имя модели.");
      return;
    }

    setAiModel(model);
    writeAudit(db, {
      actorType: "admin",
      actorUserId: req.session.user!.id,
      action: "update_ai_model",
      entityType: "system_settings",
      entityId: "ai_model",
      changeSummary: `ai_model=${model}`
    });

    res.redirect("/admin/settings?saved=1");
  });

  app.post("/admin/settings/ai-mode", requireRole("admin"), (req, res) => {
    const mode = String(req.body.ai_mode ?? "").trim();
    if (mode !== "faq_only" && mode !== "llm_faq_fallback") {
      res.status(400).send("Некорректный режим AI.");
      return;
    }

    db.prepare(`UPDATE club_settings SET ai_mode=? WHERE id=1`).run(mode);
    writeAudit(db, {
      actorType: "admin",
      actorUserId: req.session.user!.id,
      action: "update_ai_mode",
      entityType: "system_settings",
      entityId: "ai_mode",
      changeSummary: `ai_mode=${mode}`
    });

    res.redirect("/admin/settings?saved=1");
  });
  app.post("/admin/settings/club", requireRole("admin"), (req, res) => {
    const schema = z.object({
      club_name: z.string().min(2).max(120),
      address: z.string().min(3).max(200),
      hours: z.string().min(3).max(80),
      phone: z.string().min(5).max(40),
      email: z.string().email(),
      description: z.string().min(3).max(400),
      booking_cancel_hours: z.coerce.number().int().min(1).max(48),
      ai_welcome_text: z.string().min(3).max(300)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Некорректные данные настроек клуба.");
      return;
    }

    db.prepare(`
      UPDATE club_settings
      SET club_name=?, address=?, hours=?, phone=?, email=?, description=?, booking_cancel_hours=?, ai_welcome_text=?
      WHERE id=1
    `).run(
      parsed.data.club_name,
      parsed.data.address,
      parsed.data.hours,
      parsed.data.phone,
      parsed.data.email,
      parsed.data.description,
      parsed.data.booking_cancel_hours,
      parsed.data.ai_welcome_text
    );

    writeAudit(db, {
      actorType: "admin",
      actorUserId: req.session.user!.id,
      action: "update_club_settings",
      entityType: "club_settings",
      entityId: "1",
      changeSummary: `hours=${parsed.data.hours}; phone_updated=true; email_updated=true`
    });

    res.redirect("/admin/settings?saved=1");
  });
  app.get("/admin/clients", requireRole("admin"), (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const sql = q
      ? `SELECT id, name, email, phone, status FROM users WHERE role='client' AND (name LIKE @q OR email LIKE @q OR phone LIKE @q) ORDER BY created_at DESC`
      : `SELECT id, name, email, phone, status FROM users WHERE role='client' ORDER BY created_at DESC`;
    const clients = q ? db.prepare(sql).all({ q: `%${q}%` }) : db.prepare(sql).all();
    res.render("admin_clients", { clients, q });
  });

  app.get("/admin/memberships", requireRole("admin"), (_req, res) => {
    refreshMemberships();
    const clients = db.prepare(`SELECT id, name, email FROM users WHERE role='client' AND status='active' ORDER BY name`).all();
    const types = db.prepare(`SELECT id, name, description, demo_price, duration_days, visit_limit, active FROM membership_types ORDER BY active DESC, name`).all();
    const memberships = db.prepare(`
      SELECT m.id, m.client_id, m.type_id, m.starts_at, m.ends_at, m.status, m.visit_limit, m.visit_used,
             u.name as client_name, mt.name as type_name
      FROM memberships m
      JOIN users u ON u.id = m.client_id
      JOIN membership_types mt ON mt.id = m.type_id
      ORDER BY m.ends_at DESC
      LIMIT 200
    `).all();

    res.render("admin_memberships", {
      clients,
      types,
      memberships,
      saved: _req.query.saved === "1"
    });
  });

  app.post("/admin/membership-types", requireRole("admin"), (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(80),
      description: z.string().min(2).max(300),
      demo_price: z.coerce.number().int().min(0).max(1000000),
      duration_days: z.coerce.number().int().min(1).max(366),
      visit_limit: z.string().optional(),
      freeze_rules: z.string().max(200).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Некорректные данные типа абонемента.");
      return;
    }

    const visitLimitRaw = String(parsed.data.visit_limit ?? "").trim();
    const visitLimit = visitLimitRaw ? Number(visitLimitRaw) : null;
    if (visitLimit !== null && (!Number.isFinite(visitLimit) || visitLimit < 1 || visitLimit > 1000)) {
      res.status(400).send("Некорректный лимит посещений.");
      return;
    }

    db.prepare(`
      INSERT INTO membership_types(id, name, description, demo_price, duration_days, visit_limit, freeze_rules, active)
      VALUES(?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      nanoid(),
      parsed.data.name,
      parsed.data.description,
      parsed.data.demo_price,
      parsed.data.duration_days,
      visitLimit,
      parsed.data.freeze_rules ?? ""
    );

    res.redirect("/admin/memberships?saved=1");
  });

  app.post("/admin/membership-types/:id/toggle", requireRole("admin"), (req, res) => {
    const row = db.prepare(`SELECT id, active FROM membership_types WHERE id=?`).get(req.params.id) as { id: string; active: number } | undefined;
    if (!row) {
      res.status(404).send("Тип абонемента не найден.");
      return;
    }
    db.prepare(`UPDATE membership_types SET active=? WHERE id=?`).run(row.active ? 0 : 1, row.id);
    res.redirect("/admin/memberships?saved=1");
  });

  app.post("/admin/memberships", requireRole("admin"), (req, res) => {
    const schema = z.object({
      client_id: z.string().min(3),
      type_id: z.string().min(3),
      starts_at: z.string().min(10),
      status: z.enum(["pending", "active", "frozen", "expired", "canceled"])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Некорректные данные абонемента.");
      return;
    }

    const type = db.prepare(`SELECT id, duration_days, visit_limit FROM membership_types WHERE id=? AND active=1`).get(parsed.data.type_id) as
      | { id: string; duration_days: number; visit_limit: number | null }
      | undefined;
    if (!type) {
      res.status(400).send("Тип абонемента недоступен.");
      return;
    }

    const startDate = new Date(parsed.data.starts_at);
    if (Number.isNaN(startDate.getTime())) {
      res.status(400).send("Некорректная дата начала.");
      return;
    }
    const endsAt = new Date(startDate.getTime() + type.duration_days * 86400000).toISOString();

    db.prepare(`
      INSERT INTO memberships(id, client_id, type_id, starts_at, ends_at, status, visit_limit, visit_used)
      VALUES(?, ?, ?, ?, ?, ?, ?, 0)
    `).run(nanoid(), parsed.data.client_id, parsed.data.type_id, startDate.toISOString(), endsAt, parsed.data.status, type.visit_limit);

    res.redirect("/admin/memberships?saved=1");
  });

  app.post("/admin/memberships/:id/status", requireRole("admin"), (req, res) => {
    const status = String(req.body.status ?? "");
    if (!["pending", "active", "frozen", "expired", "canceled"].includes(status)) {
      res.status(400).send("Некорректный статус.");
      return;
    }

    const exists = db.prepare(`SELECT id FROM memberships WHERE id=?`).get(req.params.id) as { id: string } | undefined;
    if (!exists) {
      res.status(404).send("Абонемент не найден.");
      return;
    }

    db.prepare(`UPDATE memberships SET status=? WHERE id=?`).run(status, req.params.id);
    res.redirect("/admin/memberships?saved=1");
  });

  app.get("/admin/schedule", requireRole("admin"), (req, res) => {
    const trainers = db.prepare(`SELECT id, name FROM trainers WHERE active=1 ORDER BY name`).all();
    const events = db.prepare(`
      SELECT s.id, s.type, s.title, s.starts_at, s.ends_at, s.trainer_id, s.resource_name, s.capacity, s.booking_enabled, s.status, t.name as trainer_name
      FROM schedule_events s
      LEFT JOIN trainers t ON t.id = s.trainer_id
      ORDER BY s.starts_at ASC
      LIMIT 300
    `).all();

    res.render("admin_schedule", {
      trainers,
      events,
      saved: req.query.saved === "1"
    });
  });

  app.post("/admin/schedule", requireRole("admin"), (req, res) => {
    const schema = z.object({
      type: z.string().min(2).max(40),
      title: z.string().min(2).max(120),
      starts_at: z.string().min(10),
      ends_at: z.string().min(10),
      trainer_id: z.string().optional(),
      resource_name: z.string().max(80).optional(),
      capacity: z.coerce.number().int().min(1).max(100),
      level: z.string().max(60).optional(),
      description: z.string().max(300).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Некорректные данные события.");
      return;
    }

    const startsAt = new Date(parsed.data.starts_at);
    const endsAt = new Date(parsed.data.ends_at);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      res.status(400).send("Некорректный интервал времени.");
      return;
    }

    const trainerId = String(parsed.data.trainer_id ?? "").trim() || null;
    const resourceName = String(parsed.data.resource_name ?? "").trim() || null;
    const conflict = hasTrainerOrResourceConflict(db, {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      trainerId,
      resourceName
    });

    if (conflict.conflict) {
      res.status(400).send(conflict.reason ?? "Конфликт по тренеру/ресурсу.");
      return;
    }

    db.prepare(`
      INSERT INTO schedule_events(id, type, title, starts_at, ends_at, trainer_id, resource_name, capacity, booking_enabled, status, level, description)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)
    `).run(
      nanoid(),
      parsed.data.type,
      parsed.data.title,
      startsAt.toISOString(),
      endsAt.toISOString(),
      trainerId,
      resourceName,
      parsed.data.capacity,
      parsed.data.level ?? "",
      parsed.data.description ?? ""
    );

    res.redirect("/admin/schedule?saved=1");
  });

  app.post("/admin/schedule/:id/status", requireRole("admin"), (req, res) => {
    const status = String(req.body.status ?? "");
    if (!["active", "canceled"].includes(status)) {
      res.status(400).send("Некорректный статус.");
      return;
    }

    const event = db.prepare(`SELECT id FROM schedule_events WHERE id=?`).get(req.params.id) as { id: string } | undefined;
    if (!event) {
      res.status(404).send("Событие не найдено.");
      return;
    }
    db.prepare(`UPDATE schedule_events SET status=? WHERE id=?`).run(status, req.params.id);
    res.redirect("/admin/schedule?saved=1");
  });

  app.get("/admin/equipment", requireRole("admin"), (req, res) => {
    const items = db.prepare(`SELECT id, name, zone, units_total, status FROM equipment ORDER BY zone, name`).all();
    res.render("admin_equipment", { items, saved: req.query.saved === "1" });
  });

  app.post("/admin/equipment", requireRole("admin"), (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(120),
      zone: z.string().min(2).max(80),
      units_total: z.coerce.number().int().min(1).max(1000),
      status: z.enum(["available", "maintenance"])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Некорректные данные оборудования.");
      return;
    }

    db.prepare(`INSERT INTO equipment(id, name, zone, units_total, status) VALUES(?, ?, ?, ?, ?)`).run(
      nanoid(),
      parsed.data.name,
      parsed.data.zone,
      parsed.data.units_total,
      parsed.data.status
    );
    res.redirect("/admin/equipment?saved=1");
  });

  app.post("/admin/equipment/:id", requireRole("admin"), (req, res) => {
    const schema = z.object({
      units_total: z.coerce.number().int().min(1).max(1000),
      status: z.enum(["available", "maintenance"])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).send("Некорректные данные оборудования.");
      return;
    }

    const exists = db.prepare(`SELECT id FROM equipment WHERE id=?`).get(req.params.id) as { id: string } | undefined;
    if (!exists) {
      res.status(404).send("Оборудование не найдено.");
      return;
    }

    db.prepare(`UPDATE equipment SET units_total=?, status=? WHERE id=?`).run(parsed.data.units_total, parsed.data.status, req.params.id);
    res.redirect("/admin/equipment?saved=1");
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
    res.json({ ok: true });
  });

  return app;
}















