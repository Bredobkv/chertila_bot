require('dotenv').config();

const http = require('http');
const db = require('./database');

db.initDatabase();

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

const STAGE_COLORS = {
  pending_review: '#ffc107',
  awaiting_confirmation: '#9c27b0',
  priced: '#2196f3',
  in_progress: '#4caf50',
  done: '#2e7d32',
  rejected: '#f44336',
  cancelled: '#6c757d'
};

function formatMoney(value) {
  return `${value?.toFixed(2) || '0.00'} BYN`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('ru-RU');
}

function getDashboardHtml() {
  const stats = db.getStats();
  const dbStats = db.getDbStats();
  const orders = db.getAllOrders();
  const users = db.getAllUsers();
  const revenueStats = db.getRevenueStats(30);
  const ordersByDay = db.getOrdersByDay(7);
  const ordersByStage = db.getOrdersByStage();
  const ordersByLevel = db.getOrdersByLevel();
  const topUsers = db.getTopUsers(5);

  const chartDataDays = ordersByDay.map(d => d.count).join(',');
  const chartLabelsDays = ordersByDay.map(d => d.dayName).join('|');

  let stageChartData = '';
  for (const [stage, count] of Object.entries(ordersByStage)) {
    if (count > 0) {
      stageChartData += `${STAGES[stage] || stage}:${count},`;
    }
  }

  const recentOrders = orders.slice(0, 10);
  const ordersHtml = recentOrders.map((o) => `
    <tr>
      <td><strong>${o.id}</strong></td>
      <td>${o.client_id}</td>
      <td><span class="stage" style="background:${STAGE_COLORS[o.stage]}20;color:${STAGE_COLORS[o.stage]}">${STAGES[o.stage] || o.stage}</span></td>
      <td>${LEVELS[o.level] || o.level || '-'}</td>
      <td>${formatMoney(o.final_price || o.estimated_price)}</td>
      <td>${formatDate(o.created_at)}</td>
    </tr>
  `).join('');

  const topUsersHtml = topUsers.map((u, i) => `
    <div class="top-user">
      <span class="rank">${i + 1}</span>
      <div class="user-info">
        <strong>${u.first_name || ''} ${u.last_name || ''}</strong>
        <span>@${u.username || 'no username'}</span>
      </div>
      <div class="user-stats">
        <span>${u.order_count} заказов</span>
        <span>${formatMoney(u.total_spent)}</span>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chertila Bot — Статистика</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    header { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    h1 { 
      font-size: 28px; 
      background: linear-gradient(90deg, #00d9ff, #00ff88);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .refresh-btn {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .refresh-btn:hover { background: rgba(255,255,255,0.2); }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px;
      transition: transform 0.3s, box-shadow 0.3s;
    }
    .stat-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .stat-card h3 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #888;
      margin-bottom: 10px;
    }
    .stat-card .value {
      font-size: 36px;
      font-weight: 700;
      background: linear-gradient(90deg, #00d9ff, #00ff88);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .stat-card .value.revenue { color: #00ff88; }
    .stat-card .value.warning { color: #ffc107; }
    .stat-card .value.info { color: #00d9ff; }

    .charts-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .chart-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px;
    }
    .chart-card h2 {
      font-size: 18px;
      margin-bottom: 20px;
      color: #fff;
    }
    .chart-container { position: relative; height: 250px; }

    .content-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }
    @media (max-width: 900px) {
      .content-grid { grid-template-columns: 1fr; }
    }

    .section-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px;
    }
    .section-card h2 {
      font-size: 18px;
      margin-bottom: 20px;
      color: #fff;
    }

    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { color: #888; font-size: 12px; text-transform: uppercase; }
    td { font-size: 14px; }
    tr:hover { background: rgba(255,255,255,0.05); }
    .stage {
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
    }

    .top-user {
      display: flex;
      align-items: center;
      padding: 12px;
      border-radius: 10px;
      margin-bottom: 10px;
      background: rgba(255,255,255,0.03);
      transition: background 0.3s;
    }
    .top-user:hover { background: rgba(255,255,255,0.08); }
    .top-user .rank {
      width: 30px;
      height: 30px;
      background: linear-gradient(135deg, #00d9ff, #00ff88);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 14px;
      color: #1a1a2e;
      margin-right: 15px;
    }
    .top-user .user-info {
      flex: 1;
    }
    .top-user .user-info strong {
      display: block;
      font-size: 14px;
    }
    .top-user .user-info span {
      font-size: 12px;
      color: #888;
    }
    .top-user .user-stats {
      text-align: right;
    }
    .top-user .user-stats span {
      display: block;
      font-size: 12px;
    }
    .top-user .user-stats span:last-child {
      color: #00ff88;
      font-weight: 600;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 15px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #888; }
    .info-value { font-weight: 600; }

    .level-bars {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    .level-bar {
      display: flex;
      align-items: center;
    }
    .level-bar .label {
      width: 100px;
      font-size: 13px;
    }
    .level-bar .bar {
      flex: 1;
      height: 24px;
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      overflow: hidden;
      margin: 0 10px;
    }
    .level-bar .fill {
      height: 100%;
      background: linear-gradient(90deg, #00d9ff, #00ff88);
      border-radius: 12px;
      transition: width 0.5s ease;
    }
    .level-bar .count {
      width: 40px;
      text-align: right;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📊 Chertila Bot</h1>
      <button class="refresh-btn" onclick="location.reload()">🔄 Обновить</button>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <h3>Всего заказов</h3>
        <div class="value">${stats.total}</div>
      </div>
      <div class="stat-card">
        <h3>Активных</h3>
        <div class="value warning">${stats.active}</div>
      </div>
      <div class="stat-card">
        <h3>Ожидают подтверждения</h3>
        <div class="value info">${stats.awaitingConfirmation}</div>
      </div>
      <div class="stat-card">
        <h3>Завершено</h3>
        <div class="value">${stats.done}</div>
      </div>
      <div class="stat-card">
        <h3>Выручка (30 дней)</h3>
        <div class="value revenue">${formatMoney(revenueStats.totalRevenue)}</div>
      </div>
      <div class="stat-card">
        <h3>Средний чек</h3>
        <div class="value">${formatMoney(revenueStats.avgOrderValue)}</div>
      </div>
    </div>

    <div class="charts-row">
      <div class="chart-card">
        <h2>📈 Заказы по дням (7 дней)</h2>
        <div class="chart-container">
          <canvas id="ordersDayChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h2>🥧 Заказы по статусам</h2>
        <div class="chart-container">
          <canvas id="stageChart"></canvas>
        </div>
      </div>
    </div>

    <div class="content-grid">
      <div class="section-card">
        <h2>📋 Последние заказы</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Клиент</th>
              <th>Статус</th>
              <th>Пакет</th>
              <th>Цена</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            ${ordersHtml || '<tr><td colspan="6" style="text-align:center;color:#888">Нет заказов</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="section-card">
        <h2>🏆 Топ клиенты</h2>
        ${topUsersHtml || '<p style="color:#888">Нет данных</p>'}
      </div>
    </div>

    <div class="charts-row">
      <div class="section-card">
        <h2>💰 Выручка по уровням</h2>
        <div class="level-bars">
          ${Object.entries(ordersByLevel).map(([level, count]) => `
            <div class="level-bar">
              <span class="label">${LEVELS[level] || level}</span>
              <div class="bar">
                <div class="fill" style="width: ${(count / stats.total * 100) || 0}%"></div>
              </div>
              <span class="count">${count}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="section-card">
        <h2>💾 База данных</h2>
        <div class="info-row">
          <span class="info-label">Пользователи</span>
          <span class="info-value">${dbStats.users}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Профили</span>
          <span class="info-value">${dbStats.profiles}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Заказов</span>
          <span class="info-value">${dbStats.orders}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Вложений</span>
          <span class="info-value">${dbStats.attachments}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Логов</span>
          <span class="info-value">${dbStats.logs}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Размер БД</span>
          <span class="info-value">${dbStats.sizeFormatted}</span>
        </div>
        <p style="margin-top:20px;color:#666;font-size:12px">Обновлено: ${new Date().toLocaleString('ru-RU')}</p>
      </div>
    </div>
  </div>

  <script>
    const chartColors = {
      pending_review: '#ffc107',
      awaiting_confirmation: '#9c27b0',
      priced: '#2196f3',
      in_progress: '#4caf50',
      done: '#2e7d32',
      rejected: '#f44336',
      cancelled: '#6c757d'
    };

    new Chart(document.getElementById('ordersDayChart'), {
      type: 'bar',
      data: {
        labels: ['${chartLabelsDays}'],
        datasets: [{
          label: 'Заказы',
          data: [${chartDataDays}],
          backgroundColor: 'rgba(0, 217, 255, 0.6)',
          borderColor: '#00d9ff',
          borderWidth: 2,
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.1)' } },
          x: { ticks: { color: '#888' }, grid: { display: false } }
        }
      }
    });

    const stageLabels = Object.keys(${JSON.stringify(ordersByStage)});
    const stageData = Object.values(${JSON.stringify(ordersByStage)});
    const stageColors = stageLabels.map(s => chartColors[s] || '#666');

    new Chart(document.getElementById('stageChart'), {
      type: 'doughnut',
      data: {
        labels: stageLabels.map(s => '${STAGES}'[s] || s),
        datasets: [{
          data: stageData,
          backgroundColor: stageColors,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: '#ccc', padding: 15 } }
        }
      }
    });
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getDashboardHtml());
});

const os = require('os');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Дашборд доступен: http://localhost:${PORT}`);
  console.log(`🌐 Дашборд доступен: http://${localIp}:${PORT}`);
});