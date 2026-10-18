import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { openDb, runMigrations, nowIso } from "./db.js";

const db = openDb();
runMigrations(db);

const password = "11111";
const hash = bcrypt.hashSync(password, 10);
const ts = nowIso();

db.exec(`
  DELETE FROM audit_logs;
  DELETE FROM messages;
  DELETE FROM conversations;
  DELETE FROM bookings;
  DELETE FROM visits;
  DELETE FROM training_logs;
  DELETE FROM memberships;
  DELETE FROM membership_types;
  DELETE FROM schedule_events;
  DELETE FROM trainers;
  DELETE FROM equipment;
  DELETE FROM user_memory;
  DELETE FROM client_profiles;
  DELETE FROM leads;
  DELETE FROM users;
  DELETE FROM club_settings;
`);

const users = [
  { id: nanoid(), name: "Администратор", email: "admin@fitclub.local", role: "admin", phone: "+7-900-000-00-00" },
  { id: nanoid(), name: "Иван Смирнов", email: "ivan.smirnov@fitclub.local", role: "client", phone: "+7-900-100-00-01" },
  { id: nanoid(), name: "Мария Волкова", email: "maria.volkova@fitclub.local", role: "client", phone: "+7-900-100-00-02" },
  { id: nanoid(), name: "Павел Орлов", email: "pavel.orlov@fitclub.local", role: "client", phone: "+7-900-100-00-03" },
  { id: nanoid(), name: "Елена Соколова", email: "elena.sokolova@fitclub.local", role: "client", phone: "+7-900-100-00-04" }
] as const;

const insertUser = db.prepare(`
  INSERT INTO users(id, name, email, phone, password_hash, role, status, memory_enabled, created_at)
  VALUES(@id, @name, @email, @phone, @password_hash, @role, 'active', 1, @created_at)
`);

for (const user of users) {
  insertUser.run({ ...user, password_hash: hash, created_at: ts });
}

const clients = users.filter((user) => user.role === "client");
const profiles = [
  { user_id: clients[0].id, preferred_days: "Будни", preferred_time: "После 18:00", goal: "Освоить тренажёрный зал", format: "trainer", interests: "Вводная тренировка", consent_pd: 1 },
  { user_id: clients[1].id, preferred_days: "Будни", preferred_time: "До 09:00", goal: "Групповые занятия", format: "group", interests: "Стретчинг, пилатес", consent_pd: 1 },
  { user_id: clients[2].id, preferred_days: "Будни", preferred_time: "12:00-14:00", goal: "Силовая выносливость", format: "group", interests: "Функциональные", consent_pd: 1 },
  { user_id: clients[3].id, preferred_days: "Выходные", preferred_time: "Утро", goal: "Вернуться к регулярности", format: "trainer", interests: "Спокойный темп", consent_pd: 1 }
];

const insertProfile = db.prepare(`
  INSERT INTO client_profiles(user_id, preferred_days, preferred_time, goal, format, interests, consent_pd)
  VALUES(@user_id, @preferred_days, @preferred_time, @goal, @format, @interests, @consent_pd)
`);
profiles.forEach((profile) => insertProfile.run(profile));

const mt = [
  { id: nanoid(), name: "Старт 30", description: "30 дней, 8 посещений", demo_price: 3900, duration_days: 30, visit_limit: 8, freeze_rules: "До 3 дней" },
  { id: nanoid(), name: "Свободный 30", description: "30 дней, без лимита", demo_price: 5400, duration_days: 30, visit_limit: null, freeze_rules: "До 5 дней" },
  { id: nanoid(), name: "Пробный 7", description: "7 дней, 3 посещения", demo_price: 1500, duration_days: 7, visit_limit: 3, freeze_rules: "Без заморозки" },
  { id: nanoid(), name: "Заморозка 60", description: "60 дней, 16 посещений", demo_price: 8900, duration_days: 60, visit_limit: 16, freeze_rules: "До 10 дней" }
];

const insertMt = db.prepare(`
  INSERT INTO membership_types(id, name, description, demo_price, duration_days, visit_limit, freeze_rules, active)
  VALUES(@id, @name, @description, @demo_price, @duration_days, @visit_limit, @freeze_rules, 1)
`);
mt.forEach((item) => insertMt.run(item));

const now = new Date();
const plusDays = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();
const minusDays = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();

const memberships = [
  { id: nanoid(), client_id: clients[0].id, type_id: mt[0].id, starts_at: minusDays(5), ends_at: plusDays(25), status: "active", visit_limit: 8, visit_used: 2 },
  { id: nanoid(), client_id: clients[1].id, type_id: mt[0].id, starts_at: minusDays(25), ends_at: plusDays(3), status: "active", visit_limit: 8, visit_used: 7 },
  { id: nanoid(), client_id: clients[2].id, type_id: mt[1].id, starts_at: minusDays(10), ends_at: plusDays(20), status: "active", visit_limit: null, visit_used: 0 },
  { id: nanoid(), client_id: clients[3].id, type_id: mt[2].id, starts_at: minusDays(1), ends_at: plusDays(6), status: "pending", visit_limit: 3, visit_used: 0 }
];

const insertMembership = db.prepare(`
  INSERT INTO memberships(id, client_id, type_id, starts_at, ends_at, status, visit_limit, visit_used)
  VALUES(@id, @client_id, @type_id, @starts_at, @ends_at, @status, @visit_limit, @visit_used)
`);
memberships.forEach((row) => insertMembership.run(row));

const trainers = [
  { id: nanoid(), name: "Анна Миронова", specialization: "Функциональный тренинг", description: "Работа с новичками и безопасной прогрессией" },
  { id: nanoid(), name: "Денис Литвинов", specialization: "Силовые программы", description: "Техника базовых движений" },
  { id: nanoid(), name: "Ольга Власова", specialization: "Мобильность и восстановление", description: "Мягкие группы и гибкость" }
];

const insertTrainer = db.prepare(`
  INSERT INTO trainers(id, name, specialization, description, active)
  VALUES(@id, @name, @specialization, @description, 1)
`);
trainers.forEach((item) => insertTrainer.run(item));

const equipment = [
  { id: nanoid(), name: "Беговая дорожка", zone: "Кардио", units_total: 4, status: "available" },
  { id: nanoid(), name: "Велотренажёр", zone: "Кардио", units_total: 3, status: "available" },
  { id: nanoid(), name: "Гребной тренажёр", zone: "Кардио", units_total: 2, status: "maintenance" }
];
const insertEq = db.prepare(`
  INSERT INTO equipment(id, name, zone, units_total, status)
  VALUES(@id, @name, @zone, @units_total, @status)
`);
equipment.forEach((item) => insertEq.run(item));

const insertEvent = db.prepare(`
  INSERT INTO schedule_events(id, type, title, starts_at, ends_at, trainer_id, resource_name, capacity, booking_enabled, status, level, description)
  VALUES(@id, @type, @title, @starts_at, @ends_at, @trainer_id, @resource_name, @capacity, 1, 'active', @level, @description)
`);

for (let day = 0; day < 7; day++) {
  const date = new Date(now.getTime() + day * 86400000);
  const start1 = new Date(date);
  start1.setHours(8, 0, 0, 0);
  const end1 = new Date(date);
  end1.setHours(9, 0, 0, 0);

  const start2 = new Date(date);
  start2.setHours(19, 0, 0, 0);
  const end2 = new Date(date);
  end2.setHours(20, 0, 0, 0);

  insertEvent.run({
    id: nanoid(),
    type: "group",
    title: "Функциональная группа",
    starts_at: start1.toISOString(),
    ends_at: end1.toISOString(),
    trainer_id: trainers[0].id,
    resource_name: "Зал А",
    capacity: 12,
    level: "Начальный",
    description: "Демо-группа"
  });

  insertEvent.run({
    id: nanoid(),
    type: "intro",
    title: "Вводная тренировка",
    starts_at: start2.toISOString(),
    ends_at: end2.toISOString(),
    trainer_id: trainers[1].id,
    resource_name: "Зал B",
    capacity: 1,
    level: "Любой",
    description: "Индивидуальная вводная"
  });
}

const conv = nanoid();
db.prepare(`INSERT INTO conversations(id, client_id, topic, status, mode, created_at, updated_at) VALUES(?, ?, ?, 'in_progress', 'ai', ?, ?)`).run(conv, clients[0].id, "Вопрос о цене", ts, ts);
db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'client', ?, ?, ?)`).run(nanoid(), conv, clients[0].id, "Сколько стоит стартовый тариф?", ts);
db.prepare(`INSERT INTO messages(id, conversation_id, author_role, author_id, content, created_at) VALUES(?, ?, 'ai', NULL, ?, ?)`).run(nanoid(), conv, "Демо-тариф «Старт 30» — 3900 ₽. Это демонстрационная цена.", ts);

for (const [i, leadName] of ["Андрей", "Светлана", "Игорь"].entries()) {
  db.prepare(`INSERT INTO leads(id, name, contact, interest, source, status, created_at) VALUES(?, ?, ?, ?, 'lead_magnet', ?, ?)`).run(
    nanoid(),
    leadName,
    `+7-900-200-00-0${i + 1}`,
    ["Пробное", "Консультация", "Челлендж"][i],
    ["new", "in_progress", "closed"][i],
    ts
  );
}

db.prepare(`
  INSERT INTO club_settings(id, club_name, address, hours, phone, email, description, booking_cancel_hours, ai_welcome_text)
  VALUES(1, 'FitClub Personal', 'Москва, Демо-улица, 1', '06:00–23:00', '+7-900-300-00-00', 'info@fitclub.local', 'Демо-прототип фитнес-клуба', 2, 'Здравствуйте! Я помогу по расписанию, тарифам и записи.')
`).run();

console.log("Seed complete. Demo password for all accounts: 11111");
