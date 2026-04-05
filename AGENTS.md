# chertila_bot

Telegram order management bot using Telegraf v4.

## Stack
- Node.js, plain JavaScript (no TypeScript)
- Telegraf for Telegram Bot API
- dotenv for env loading
- File-based state in `bot-state.json`

## Commands
```bash
npm start          # Start bot (node bot.js)
npm run check      # Syntax check (node --check bot.js)
```

## Environment
```
BOT_TOKEN=<telegram bot token>
ADMIN_ID=<telegram user id of admin>
```

## Key Files
- `bot.js` — single-file bot, all logic, handlers, and state management
- `bot-state.json` — order data and sequence counter (auto-generated)
- `.env` — credentials (never commit)

## State Persistence
State is written to `bot-state.json` after every mutation via `persistState()`. The file contains:
- `seq` — order ID counter (ORD-0001, ORD-0002, ...)
- `orders` — map of order objects keyed by ID

## Order Flow
1. User starts order → `startDraft` → step through task → deadline → requirements → level
2. Draft submitted → `createOrderFromDraft` → saves to state → notifies admin
3. Admin sets price → order enters `priced` stage → notifies user
4. Admin starts work → `in_progress` → admin completes → `done`

## Admin Actions
Admin is determined by `ADMIN_ID` in `.env`. Only this user sees the admin panel and can:
- Set price (`admin:price`)
- Start/reject/complete orders
- View attention orders and stats
- Reset all state

## Development Notes
- The bot uses Telegraf sessions — ctx.session persists across user interactions
- Flow messages are edited in-place using `flowMessageId` in session
- Attachments (photos/documents) are stored as Telegram `file_id` references, not downloaded
