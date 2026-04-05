# chertila_bot

Telegram order management bot using Telegraf v4 with SQLite database.

## Stack
- Node.js, plain JavaScript
- Telegraf for Telegram Bot API
- better-sqlite3 for database
- dotenv for env loading

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
- `bot.js` — main bot logic
- `database.js` — SQLite operations (all data storage)
- `dashboard.js` — web dashboard for admin
- `bot.db` — SQLite database file
- `backups/` — automatic backups directory
- `.env` — credentials (never commit)

## Database
SQLite database with tables:
- `users` — Telegram users
- `profiles` — user profiles (name, phone, email, notes)
- `orders` — all orders with stages
- `attachments` — order attachments
- `logs` — all operations log
- `seq` — order ID counter

Auto-backup every 2 days to `backups/` directory.

## Order Stages
```
pending_review → awaiting_confirmation → priced → in_progress → done
                                    ↓
                               rejected/cancelled
```

## Order Confirmation Flow
1. User creates order
2. Admin sets price
3. Order goes to `awaiting_confirmation` stage
4. User receives notification with Confirm/Cancel buttons
5. User confirms → order moves to `priced` → admin can start work

## Limits
- Max 3 active orders per user
- Max 4 orders per day for any deadline
- Over limit: price x2, user must confirm

## Registration
Users must fill name AND phone before creating orders.

## Admin Features
- Admin panel with orders, search, broadcast
- Database management: stats, export, import, clear, optimize, logs
- Automatic reminders for overdue and unconfirmed orders

## Deadline Selection
Days of week (Mon-Sun) + custom date input (DD.MM.YYYY)
