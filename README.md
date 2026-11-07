# PRYANIK CLICKER ONLINE — стартовый проект

Монорепозиторий: React/Vite-клиент, Express API и схема Supabase.
Сайт и Telegram Mini App используют одну авторизацию и одну базу игроков.

## Стек
- Client: React + Vite
- API: Node.js + Express
- Database: Supabase Postgres
- Telegram Mini App: проверка `initData` на сервере
- Website: Telegram Login Widget (legacy widget) для входа на сайте
- Session: подписанный JWT приложения

## 1. Подготовка
1. Создай проект в Supabase.
2. Открой SQL Editor и выполни `supabase/schema.sql`.
3. Создай Telegram-бота через @BotFather.
4. Для сайта настрой домен и Telegram Login Widget через @BotFather (`/setdomain`).
5. Скопируй `server/.env.example` в `server/.env` и заполни секреты.
6. Скопируй `client/.env.example` в `client/.env`.

## 2. Запуск локально
В одном терминале:
```bash
cd server
npm install
cp .env.example .env
npm run dev
```
В другом:
```bash
cd client
npm install
cp .env.example .env
npm run dev
```
Клиент будет на http://localhost:5173, API на http://localhost:4000.

## 3. Переменные сервера
- `TELEGRAM_BOT_TOKEN` — токен бота, только сервер.
- `TELEGRAM_BOT_USERNAME` — username без `@`.
- `APP_JWT_SECRET` — длинный случайный секрет, минимум 32 символа.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — только сервер, никогда не помещать в клиент.
- `CLIENT_ORIGIN` — адрес сайта, локально `http://localhost:5173`.
- `PORT` — обычно 4000.
- `ADMIN_TELEGRAM_ID=1806446591` — единственный Telegram ID администратора; меняется только в серверных переменных окружения.

## 4. Админ-панель и предложения игроков
- В профиле отображается кнопка админки только для Telegram ID `1806446591`; сервер повторно проверяет ID на каждом admin API запросе.
- В админке можно создавать промокоды, смотреть лимит/использования и включать/отключать коды.
- Игроки отправляют идеи в разделе «Написать разработчику»; предложения сохраняются в таблице `developer_suggestions`.
- Не добавляй Telegram Bot Token, Supabase Service Role Key или JWT secret в клиент и не публикуй `.env`.

## 5. Telegram Mini App
В BotFather создай Mini App / настрой Main Mini App и укажи URL развернутого клиента.
В Telegram Web App клиент получает `Telegram.WebApp.initData`; он отправляется API.
API проверяет подпись Telegram по bot token и только после проверки выдаёт JWT приложения.

## 6. Сайт
На сайте отображается Telegram Login Widget. Для production домен сайта нужно привязать к боту через BotFather.
Widget передаёт подписанные Telegram данные в API; API проверяет hash и `auth_date`.

## 7. Важно перед публичным запуском
Это рабочий стартовый каркас, но не законченная production-платформа. Перед запуском для широкой аудитории:
- добавь rate limiting на все игровые endpoint'ы;
- настрой HTTPS и точные CORS origins;
- добавь CAPTCHA/антибот-проверки при необходимости;
- проверь RLS и права Supabase;
- вынеси секреты в защищённые переменные хостинга;
- проведи нагрузочное и security-тестирование;
- не используй service role key в браузере.
Игровые RPC вызываются только сервером с service-role ключом и валидированным JWT приложения.

## 8. Публикация в интернете (после настройки Supabase и Telegram)
Проект состоит из двух частей, поэтому клиент и API публикуются отдельно.

### A. API на Render
1. Загрузи папку проекта в свой GitHub-репозиторий.
2. На Render создай **New → Web Service**, подключи репозиторий и укажи Root Directory `server`.
3. Build Command: `npm install`; Start Command: `npm start`.
4. В Environment добавь все переменные из `server/.env.example`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `APP_JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_TELEGRAM_ID`, `CLIENT_ORIGIN`.
5. После деплоя скопируй публичный HTTPS URL API, например `https://твой-api.onrender.com`.

### B. Сайт на Vercel
1. Создай новый проект на Vercel из того же GitHub-репозитория.
2. Укажи Root Directory `client`.
3. Build Command: `npm run build`; Output Directory: `dist`.
4. В Environment Variables добавь `VITE_API_URL` (HTTPS URL API из Render), `VITE_TELEGRAM_BOT_USERNAME` (username бота без @), `VITE_ADMIN_TELEGRAM_ID=1806446591`.
5. Нажми Deploy и скопируй HTTPS адрес сайта.

### C. Связать сервисы и Telegram
1. Вернись в Render и поставь `CLIENT_ORIGIN` равным точному HTTPS адресу сайта Vercel, затем перезапусти API.
2. В BotFather настрой домен сайта для Telegram Login Widget и Main Mini App URL на адрес сайта Vercel.
3. Открой сайт и проверь вход Telegram; затем открой Mini App из Telegram.
4. Проверь, что у обычного тестового аккаунта нет кнопки админки, а у Telegram ID `1806446591` она есть. Админские API маршруты независимо проверяют ID на сервере.

**Важно:** это инструкция для самостоятельной публикации. Пока ты не создашь Supabase-проект, Telegram-бота и аккаунты хостингов и не внесёшь секреты, игра не будет публично работать. Не присылай мне Bot Token или Supabase Service Role Key и не вставляй их в клиентский код.
