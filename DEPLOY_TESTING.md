# Deploy на тестовый хостинг (Render / Railway)

Ниже — быстрый способ получить публичную ссылку для тестирования MVP.

## Вариант 1: Render (рекомендуется для SQLite)

Почему: можно подключить постоянный диск, чтобы база не сбрасывалась после рестарта.

### Шаги

1. Откройте [Render Dashboard](https://dashboard.render.com/).
2. Нажмите **New +** → **Blueprint**.
3. Выберите репозиторий `AABrovarnik/Fitness`.
4. Render подхватит файл `render.yaml` автоматически.
5. Подтвердите создание сервиса.
6. После первого деплоя зайдите в Shell/Console сервиса и выполните:
   - `npm run seed`
7. Откройте публичный URL сервиса (например, `https://fitness-mvp.onrender.com`).

### Важные переменные (уже заложены в `render.yaml`)

- `NODE_ENV=production`
- `PORT=10000`
- `DB_PATH=/opt/render/project/src/data/fitclub.db`
- `SESSION_SECRET` (генерируется Render)
- `CLUB_TIMEZONE=Europe/Moscow`
- `AI_MODEL=gpt-4.1-mini`
- `AI_API_KEY` (нужно задать вручную в настройках сервиса)

---

## Вариант 2: Railway

Подходит для быстрого запуска, но для SQLite может потребоваться volume (иначе данные могут быть эфемерными).

### Шаги

1. Откройте [Railway](https://railway.app/).
2. Нажмите **New Project** → **Deploy from GitHub repo**.
3. Выберите `AABrovarnik/Fitness`.
4. Railway подхватит `railway.json`.
5. В Variables задайте:
   - `NODE_ENV=production`
   - `DB_PATH=./data/fitclub.db` (или путь на volume, если подключён)
   - `SESSION_SECRET=<случайная строка>`
   - `CLUB_TIMEZONE=Europe/Moscow`
   - `AI_MODEL=gpt-4.1-mini`
   - `AI_API_KEY=<ваш ключ OpenAI>`
6. После деплоя выполните одноразово `npm run seed` в встроенной консоли.
7. Откройте выданный Railway URL.

---

## Демо-аккаунты после `npm run seed`

- Пароль для всех: `11111`
- Администратор: `admin@fitclub.local`
- Клиент: `ivan.smirnov@fitclub.local` (и другие из seed)

---

## Где искать ссылку после деплоя

- **Render:** `Dashboard` → ваш сервис → поле **URL**.
- **Railway:** `Project` → `Service` → вкладка **Settings / Domains**.

---

## Типичные проблемы

- `Cannot GET /offers` или другие маршруты: проверить, что задеплоен **последний commit**.
- Чат отвечает только fallback: проверить `AI_API_KEY` и режим AI в админке.
- Данные «пропадают» после перезапуска: подключить persistent disk/volume для SQLite.
