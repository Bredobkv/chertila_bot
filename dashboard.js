require('dotenv').config();

const http = require('http');
const db = require('./database');

const PORT = process.env.WEB_PORT || 3000;

const LEVELS = {
  basic: 'Стандарт',
  strong: 'Усиленный',
  premium: 'Максимум'
};

const STAGES = {
  pending_review: 'На рассмотрении',
  awaiting_confirmation: 'Ожидает подтверждения',
  priced: 'Цена назначена',
  in_progress: 'В работе',
  done: 'Готово',
  rejected: 'Отклонён',
  cancelled: 'Отменён'
};

function formatMoney(value) {
  return `${value?.toFixed(2) || '0.00'} BYN`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('ru-RU');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getDashboardHtml() {
  const stats = db.getStats();
  const dbStats = db.getDbStats();
  const orders = db.getAllOrders();
  const users = db.getAllUsers();

  const ordersHtml = orders.map((o) => `
    <tr>
      <td><strong>${o.id}</strong></td>
      <td>${o.client_id}</td>
      <td><span class="stage stage-${o.stage}">${STAGES[o.stage] || o.stage}</span></td>
      <td>${LEVELS[o.level] || o.level || '-'}</td>
      <td>${formatMoney(o.final_price || o.estimated_price)}</td>
      <td>${formatDate(o.created_at)}</td>
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
    h2 { color: #2c3e50; margin: 20px 0 10px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 14px; color: #666; text-transform: uppercase; }
    .stat-card .value { font-size: 28px; font-weight: bold; color: #2c3e50; }
    .stat-card .value.revenue { color: #27ae60; }
    .stat-card .value.small { font-size: 20px; }
    .orders-section { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f8f9fa; font-weight: 600; color: #555; }
    tr:hover { background: #fafafa; }
    .stage { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .stage-pending_review { background: #fff3cd; color: #856404; }
    .stage-awaiting_confirmation { background: #e2d5f3; color: #6a4c93; }
    .stage-priced { background: #cce5ff; color: #004085; }
    .stage-in_progress { background: #d4edda; color: #155724; }
    .stage-done { background: #d1e7dd; color: #0f5132; }
    .stage-rejected { background: #f8d7da; color: #721c24; }
    .stage-cancelled { background: #e2e3e5; color: #383d41; }
    .info { color: #666; font-size: 14px; margin-top: 10px; }
    .db-section { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .db-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    .db-stat { background: #f8f9fa; padding: 10px; border-radius: 4px; text-align: center; }
    .db-stat .label { font-size: 12px; color: #666; }
    .db-stat .val { font-size: 18px; font-weight: bold; color: #2c3e50; }
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
        <h3>Ожидают</h3>
        <div class="value">${stats.awaitingConfirmation}</div>
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

    <div class="db-section">
      <h2>📦 База данных</h2>
      <div class="db-stats">
        <div class="db-stat">
          <div class="label">Размер БД</div>
          <div class="val">${dbStats.sizeFormatted}</div>
        </div>
        <div class="db-stat">
          <div class="label">Пользователи</div>
          <div class="val">${dbStats.users}</div>
        </div>
        <div class="db-stat">
          <div class="label">Профили</div>
          <div class="val">${dbStats.profiles}</div>
        </div>
        <div class="db-stat">
          <div class="label">Заказов</div>
          <div class="val">${dbStats.orders}</div>
        </div>
        <div class="db-stat">
          <div class="label">Вложений</div>
          <div class="val">${dbStats.attachments}</div>
        </div>
        <div class="db-stat">
          <div class="label">Логов</div>
          <div class="val">${dbStats.logs}</div>
        </div>
      </div>
    </div>

    <div class="orders-section">
      <h2>Последние заказы (${orders.length})</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Клиент ID</th>
            <th>Статус</th>
            <th>Пакет</th>
            <th>Цена</th>
            <th>Создан</th>
          </tr>
        </thead>
        <tbody>
          ${ordersHtml || '<tr><td colspan="6" style="text-align:center;">Нет заказов</td></tr>'}
        </tbody>
      </table>
      <p class="info">Всего пользователей: ${users.length} | Обновлено: ${new Date().toLocaleString('ru-RU')}</p>
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
