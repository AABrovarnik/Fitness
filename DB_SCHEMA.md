# DB Schema (Fitness MVP)

Источник истины схемы: `src/db/db.ts`.

## Общие правила

- СУБД: SQLite.
- Временные поля хранятся как `TEXT` в формате ISO (`toISOString()`).
- Первичные ключи в большинстве таблиц: `TEXT` (id, как правило `nanoid`).
- Включены внешние ключи: `PRAGMA foreign_keys = ON`.

---

## 1) `users`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Идентификатор пользователя |
| `name` | `TEXT` | `NOT NULL` | Имя |
| `email` | `TEXT` | `NOT NULL`, `UNIQUE` | Email для входа |
| `phone` | `TEXT` |  | Телефон |
| `password_hash` | `TEXT` | `NOT NULL` | Хэш пароля |
| `role` | `TEXT` | `NOT NULL`, `CHECK IN ('client','admin')` | Роль |
| `status` | `TEXT` | `NOT NULL`, `DEFAULT 'active'` | Статус пользователя |
| `memory_enabled` | `INTEGER` | `NOT NULL`, `DEFAULT 1` | Использование долговременной памяти AI |
| `created_at` | `TEXT` | `NOT NULL` | Дата создания |

Связи:
- 1:1 с `client_profiles` (для роли `client`).
- 1:N с `memberships`, `bookings`, `visits`, `training_logs`, `user_memory`.

---

## 2) `client_profiles`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `user_id` | `TEXT` | `PRIMARY KEY`, `REFERENCES users(id) ON DELETE CASCADE` | Клиент |
| `preferred_days` | `TEXT` |  | Предпочтительные дни |
| `preferred_time` | `TEXT` |  | Предпочтительное время |
| `goal` | `TEXT` |  | Цель тренировок |
| `format` | `TEXT` |  | Формат (сам/с тренером/группа) |
| `interests` | `TEXT` |  | Интересы |
| `consent_pd` | `INTEGER` | `NOT NULL`, `DEFAULT 0` | Согласие на ПД |
| `birth_date` | `TEXT` |  | Дата рождения |

Связи:
- 1:1 с `users`.

---

## 3) `membership_types`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Идентификатор типа |
| `name` | `TEXT` | `NOT NULL` | Название |
| `description` | `TEXT` |  | Описание |
| `demo_price` | `INTEGER` | `NOT NULL` | Демо-цена |
| `duration_days` | `INTEGER` | `NOT NULL` | Длительность в днях |
| `visit_limit` | `INTEGER` |  | Лимит посещений (`NULL` = безлимит) |
| `freeze_rules` | `TEXT` |  | Правила заморозки |
| `active` | `INTEGER` | `NOT NULL`, `DEFAULT 1` | Активность |

Связи:
- 1:N с `memberships`.

---

## 4) `memberships`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Абонемент |
| `client_id` | `TEXT` | `NOT NULL`, `REFERENCES users(id) ON DELETE CASCADE` | Клиент |
| `type_id` | `TEXT` | `NOT NULL`, `REFERENCES membership_types(id)` | Тип абонемента |
| `starts_at` | `TEXT` | `NOT NULL` | Дата начала |
| `ends_at` | `TEXT` | `NOT NULL` | Дата окончания |
| `status` | `TEXT` | `NOT NULL`, `CHECK IN ('pending','active','frozen','expired','canceled')` | Статус |
| `visit_limit` | `INTEGER` |  | Лимит (может дублироваться из типа) |
| `visit_used` | `INTEGER` | `NOT NULL`, `DEFAULT 0` | Использовано посещений |

Связи:
- N:1 к `users`.
- N:1 к `membership_types`.

---

## 5) `trainers`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Тренер |
| `name` | `TEXT` | `NOT NULL` | Имя |
| `specialization` | `TEXT` | `NOT NULL` | Специализация |
| `description` | `TEXT` | `NOT NULL` | Описание |
| `active` | `INTEGER` | `NOT NULL`, `DEFAULT 1` | Активность |

Связи:
- 1:N с `schedule_events` (через `trainer_id`).

---

## 6) `equipment`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Ресурс/оборудование |
| `name` | `TEXT` | `NOT NULL` | Название |
| `zone` | `TEXT` | `NOT NULL` | Зона |
| `units_total` | `INTEGER` | `NOT NULL` | Количество |
| `status` | `TEXT` | `NOT NULL`, `CHECK IN ('available','maintenance')` | Состояние |

---

## 7) `schedule_events`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Событие расписания |
| `type` | `TEXT` | `NOT NULL` | Тип занятия |
| `title` | `TEXT` | `NOT NULL` | Название |
| `starts_at` | `TEXT` | `NOT NULL` | Начало |
| `ends_at` | `TEXT` | `NOT NULL` | Окончание |
| `trainer_id` | `TEXT` | `REFERENCES trainers(id)` | Тренер |
| `resource_name` | `TEXT` |  | Ресурс/зал |
| `capacity` | `INTEGER` | `NOT NULL` | Вместимость |
| `booking_enabled` | `INTEGER` | `NOT NULL`, `DEFAULT 1` | Можно ли бронировать |
| `status` | `TEXT` | `NOT NULL`, `CHECK IN ('active','canceled')` | Статус |
| `level` | `TEXT` |  | Уровень |
| `description` | `TEXT` |  | Описание |

Связи:
- N:1 к `trainers`.
- 1:N с `bookings`.

---

## 8) `bookings`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Запись |
| `client_id` | `TEXT` | `NOT NULL`, `REFERENCES users(id) ON DELETE CASCADE` | Клиент |
| `event_id` | `TEXT` | `NOT NULL`, `REFERENCES schedule_events(id) ON DELETE CASCADE` | Событие |
| `status` | `TEXT` | `NOT NULL`, `CHECK IN ('booked','canceled_by_client','canceled_by_admin','completed','no_show')` | Статус посещения |
| `created_at` | `TEXT` | `NOT NULL` | Создано |
| `canceled_at` | `TEXT` |  | Время отмены |

Дополнительно:
- `UNIQUE(client_id, event_id)` — клиент не может дважды записаться на одно событие.

Связи:
- N:1 к `users`.
- N:1 к `schedule_events`.
- 1:N с `visits` (через `booking_id`, опционально).

---

## 9) `visits`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Факт посещения |
| `client_id` | `TEXT` | `NOT NULL`, `REFERENCES users(id) ON DELETE CASCADE` | Клиент |
| `booking_id` | `TEXT` | `REFERENCES bookings(id)` | Связанная запись |
| `visited_at` | `TEXT` | `NOT NULL` | Время фактического визита |
| `source` | `TEXT` | `NOT NULL` | Источник фиксации |
| `comment` | `TEXT` |  | Комментарий |

Связи:
- N:1 к `users`.
- N:1 к `bookings` (опционально).

---

## 10) `training_logs`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Запись журнала |
| `client_id` | `TEXT` | `NOT NULL`, `REFERENCES users(id) ON DELETE CASCADE` | Клиент |
| `log_date` | `TEXT` | `NOT NULL` | Дата тренировки |
| `load_type` | `TEXT` | `NOT NULL` | Тип нагрузки |
| `duration_min` | `INTEGER` | `NOT NULL` | Длительность |
| `intensity` | `INTEGER` | `NOT NULL` | Интенсивность |
| `note` | `TEXT` |  | Заметка |

Связи:
- N:1 к `users`.

---

## 11) `conversations`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Диалог |
| `client_id` | `TEXT` |  | Клиент (для гостевых чатов `NULL`) |
| `guest_contact` | `TEXT` |  | Контакт гостя |
| `topic` | `TEXT` | `NOT NULL` | Тема |
| `status` | `TEXT` | `NOT NULL`, `CHECK IN ('new','waiting_admin','in_progress','closed')` | Статус диалога |
| `mode` | `TEXT` | `NOT NULL`, `CHECK IN ('ai','human','trainer')` | Режим |
| `created_at` | `TEXT` | `NOT NULL` | Создан |
| `updated_at` | `TEXT` | `NOT NULL` | Обновлён |

Связи:
- 1:N с `messages`.
- Опциональная логическая связь с `users` по `client_id` (без FK на уровне DDL).

---

## 12) `messages`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Сообщение |
| `conversation_id` | `TEXT` | `NOT NULL`, `REFERENCES conversations(id) ON DELETE CASCADE` | Диалог |
| `author_role` | `TEXT` | `NOT NULL` | Роль автора (`client/admin/ai/guest`) |
| `author_id` | `TEXT` |  | Идентификатор автора (если есть) |
| `content` | `TEXT` | `NOT NULL` | Текст |
| `created_at` | `TEXT` | `NOT NULL` | Время |

Связи:
- N:1 к `conversations`.

---

## 13) `user_memory`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Элемент памяти |
| `user_id` | `TEXT` | `NOT NULL`, `REFERENCES users(id) ON DELETE CASCADE` | Клиент |
| `category` | `TEXT` | `NOT NULL` | Категория |
| `fact` | `TEXT` | `NOT NULL` | Факт |
| `source` | `TEXT` | `NOT NULL` | Источник записи |
| `state` | `TEXT` | `NOT NULL`, `DEFAULT 'confirmed'` | Состояние |
| `created_at` | `TEXT` | `NOT NULL` | Создано |
| `updated_at` | `TEXT` | `NOT NULL` | Обновлено |

Индексы:
- `idx_user_memory_user_id` (`user_id`).

Связи:
- N:1 к `users`.

---

## 14) `leads`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Лид |
| `name` | `TEXT` | `NOT NULL` | Имя |
| `contact` | `TEXT` | `NOT NULL` | Контакт |
| `interest` | `TEXT` | `NOT NULL` | Интерес |
| `source` | `TEXT` | `NOT NULL` | Источник (например, `lead_magnet`) |
| `status` | `TEXT` | `NOT NULL` | Статус обработки |
| `created_at` | `TEXT` | `NOT NULL` | Время создания |

---

## 15) `audit_logs`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `TEXT` | `PRIMARY KEY` | Аудит-событие |
| `timestamp_utc` | `TEXT` | `NOT NULL` | Время события |
| `actor_type` | `TEXT` | `NOT NULL` | Кто совершил действие |
| `actor_user_id` | `TEXT` |  | ID оператора |
| `action` | `TEXT` | `NOT NULL` | Тип действия |
| `entity_type` | `TEXT` | `NOT NULL` | Сущность |
| `entity_id` | `TEXT` |  | ID сущности |
| `target_user_id` | `TEXT` |  | Затронутый пользователь |
| `change_summary` | `TEXT` |  | Краткое описание изменений |
| `reason` | `TEXT` |  | Причина |
| `request_id` | `TEXT` |  | Корреляция запроса |

---

## 16) `club_settings`

| Поле | Тип | Ограничения | Описание |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY`, `CHECK(id = 1)` | Singleton-настройки (ровно 1 строка) |
| `club_name` | `TEXT` | `NOT NULL` | Название клуба |
| `address` | `TEXT` | `NOT NULL` | Адрес |
| `hours` | `TEXT` | `NOT NULL` | Часы работы |
| `phone` | `TEXT` | `NOT NULL` | Телефон |
| `email` | `TEXT` | `NOT NULL` | Email |
| `description` | `TEXT` | `NOT NULL` | Описание |
| `booking_cancel_hours` | `INTEGER` | `NOT NULL`, `DEFAULT 2` | Минимум часов до начала для отмены клиентом |
| `ai_welcome_text` | `TEXT` | `NOT NULL` | Приветственный текст AI |
| `ai_mode` | `TEXT` | `NOT NULL`, `DEFAULT 'faq_only'` | Режим AI: `faq_only` / `llm_faq_fallback` |

---

## Миграции

В коде реализована точечная миграция:
- `runMigrations()` вызывает `initSchema()` и затем проверяет наличие `club_settings.ai_mode`.
- При отсутствии колонки выполняется:
  - `ALTER TABLE club_settings ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'faq_only'`.

См. `src/db/db.ts` (`runMigrations`, `ensureColumn`).
