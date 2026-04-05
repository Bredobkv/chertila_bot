# chertila_bot

Telegram order management bot using Telegraf v4.

## Stack
- Node.js, plain JavaScript (no TypeScript)
- Telegraf for Telegram Bot API
- dotenv for env loading
- File-based state in `bot-state.json`

## Commands
```bash
npm start            # Start bot
npm run check        # Syntax check
npm run dashboard    # Start web dashboard (http://localhost:3000)
```

## Environment
```
BOT_TOKEN=<telegram bot token>
ADMIN_ID=<telegram user id of admin>
WEB_PORT=3000        # optional, dashboard port
```

## Key Files
- `bot.js` — single-file bot, all logic, handlers, and state management
- `dashboard.js` — web dashboard for admin (shows stats and orders table)
- `bot-state.json` — order data, profiles, and user list (auto-generated)
- `.env` — credentials (never commit)

## State Persistence
State is written to `bot-state.json` after every mutation via `persistState()`. The file contains:
- `seq` — order ID counter (ORD-0001, ORD-0002, ...)
- `orders` — map of order objects keyed by ID
- `profiles` — map of user profiles keyed by userId
- `users` — array of all user IDs (for broadcast)

## Order Flow
1. User registers with name via profile
2. User starts order → step through task → deadline → requirements → level
3. Draft submitted → saves to state → notifies admin
4. Admin sets price → order enters `priced` stage → notifies user
5. Admin starts work → `in_progress` → admin completes → `done`

## Registration
Users must fill in their name in the profile before they can create orders. Without a name, the "Новый заказ" button shows a registration prompt.

## Features
- **User profiles** — save name, phone, email, notes; auto-fills in orders
- **User stats** — 📊 shows order history, total spent
- **Admin search** — search orders by ID, client name, or status
- **Admin broadcast** — send messages to all users or filtered by order stage
- **Deadline reminders** — admin gets notified hourly about orders in progress >24h
- **Web dashboard** — visual stats and order table at http://localhost:3000

## Admin Actions
Admin is determined by `ADMIN_ID` in `.env`. Only this user sees:
- Admin panel with search, broadcast, stats
- All order details
- Web dashboard

## Development Notes
- The bot uses Telegraf sessions — ctx.session persists across user interactions
- Flow messages are edited in-place using `flowMessageId` in session
- Attachments (photos/documents) are stored as Telegram `file_id` references, not downloaded
- User tracking happens via middleware; all users who interact are tracked for broadcast
