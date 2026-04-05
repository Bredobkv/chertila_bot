require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.WEB_PORT || 3000;
const STATE_FILE = path.join(__dirname, 'bot-state.json');

const LEVELS = {
  basic: 'Стандарт',
  strong: 'Усиленный',
  premium: 'Максимум'
};

const STAGES = {
  pending_review: 'На рассмотрении',
  priced: 'Цена назначена',
  in_progress: 'В работе',
  done: 'Готово',
  rejected: 'Отклонён',
  cancelled: 'Отменён'
};

const DEADLINES = {
  urgent: 'Срочно',
  today: 'Сегодня',
  tomorrow: 'Завтра',
  week: 'Без спешки'
};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { seq: 1, orders: {}, profiles: {}, users: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seq: 1, orders: {}, profiles: {}, users: [] };
  }
}

function getStats() {
  const state = loadState();
  const orders = Object.values(state.orders);
  const completed = orders.filter((o) => ['done', 'picked_up'].includes(o.stage));
  const revenue = completed.reduce((sum, o) => sum + (o.finalPrice || 0), 0);

  return {
    total: orders.length,
    active: orders.filter((o) => ['pending_review', 'priced', 'in_progress'].includes(o.stage)).length,
    done: completed.length,
    pending: orders.filter((o) => o.stage === 'pending_review').length,
    priced: orders.filter((o) => o.stage === 'priced').length,
    inProgress: orders.filter((o) => o.stage === 'in_progress').length,
    revenue
  };
}

function formatMoney(value) {
  return `${value.toFixed(2)} BYN`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString('ru-RU');
}

function getDashboardHtml() {
  const state = loadState();
  const stats = getStats();
  const orders = Object.values(state.orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const users = state.users || [];

  const ordersHtml = orders.map((o) => `
    <tr>
      <td><strong>${o.id}</strong></td>
      <td>${o.clientName}</td>
      <td><span class="stage stage-${o.stage}">${STAGES[o.stage] || o.stage}</span></td>
      <td>${DEADLINES[o.deadline] || o.deadline}</td>
      <td>${LEVELS[o.level] || o.level}</td>
      <td>${formatMoney(o.finalPrice || o.estimatedPrice || 0)}</td>
      <td>${formatDate(o.createdAt)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chertila Bot - Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { color: #2c3e50; margin-bottom: 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 14px; color: #666; text-transform: uppercase; }
    .stat-card .value { font-size: 28px; font-weight: bold; color: #2c3e50; }
    .stat-card .value.revenue { color: #27ae60; }
    .orders-section { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .orders-section h2 { margin-bottom: 15px; color: #2c3e50; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover { background: #fafafa; }
    .stage { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .stage-pending_review { background: #fff3cd; color: #856404; }
    .stage-priced { background: #cce5ff; color: #004085; }
    .stage-in_progress { background: #d4edda; color: #155724; }
    .stage-done { background: #d1e7dd; color: #0f5132; }
    .stage-rejected { background: #f8d7da; color: #721c24; }
    .stage-cancelled { background: #e2e3e5; color: #383d41; }
    .info { color: #666; font-size: 14px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Chertila Bot Dashboard</h1>

    <div class="stats">
      <div class="stat-card">
        <h3>Всего заказов</h3>
        <div class="value">${stats.total}</div>
      </div>
      <div class="stat-card">
        <h3>Активных</h3>
        <div class="value">${stats.active}</div>
      </div>
      <div class="stat-card">
        <h3>Завершено</h3>
        <div class="value">${stats.done}</div>
      </div>
      <div class="stat-card">
        <h3>Выручка</h3>
        <div class="value revenue">${formatMoney(stats.revenue)}</div>
      </div>
    </div>

    <div class="orders-section">
      <h2>Последние заказы (${orders.length})</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Клиент</th>
            <th>Статус</th>
            <th>Срок</th>
            <th>Пакет</th>
            <th>Цена</th>
            <th>Создан</th>
          </tr>
        </thead>
        <tbody>
          ${ordersHtml || '<tr><td colspan="7" style="text-align:center;">Нет заказов</td></tr>'}
        </tbody>
      </table>
      <p class="info">Всего пользователей: ${users.length}</p>
    </div>
  </div>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getDashboardHtml());
});

server.listen(PORT, () => {
  console.log(`🌐 Dashboard доступен на http://localhost:${PORT}`);
});
