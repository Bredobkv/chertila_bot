require('dotenv').config();

const http = require('http');
const db = require('./database');
const url = require('url');
const querystring = require('querystring');

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

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDashboardHtml(page = 'stats', params = {}) {
  const stats = db.getStats();
  const dbStats = db.getDbStats();
  const orders = db.getAllOrders();
  const users = db.getAllUsers();
  const revenueStats = db.getRevenueStats(30);
  const ordersByDay = db.getOrdersByDay(7);
  const ordersByStage = db.getOrdersByStage();
  const ordersByLevel = db.getOrdersByLevel();
  const topUsers = db.getTopUsers(5);
  const logs = db.getLogs(50);

  let content = '';

  if (page === 'stats') {
    const chartDataDays = ordersByDay.map(d => d.count).join(',');
    const chartLabelsDays = ordersByDay.map(d => d.dayName).join('|');

    content = `
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
            datasets: [{ label: 'Заказы', data: [${chartDataDays}], backgroundColor: 'rgba(0, 217, 255, 0.6)', borderColor: '#00d9ff', borderWidth: 2, borderRadius: 8 }]
          },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.1)' } }, x: { ticks: { color: '#888' }, grid: { display: false } } } }
        });

        const stageLabels = Object.keys(${JSON.stringify(ordersByStage)});
        const stageData = Object.values(${JSON.stringify(ordersByStage)});
        const stageColors = stageLabels.map(s => chartColors[s] || '#666');

        new Chart(document.getElementById('stageChart'), {
          type: 'doughnut',
          data: {
            labels: stageLabels.map(s => '${STAGES}'[s] || s),
            datasets: [{ data: stageData, backgroundColor: stageColors, borderWidth: 0 }]
          },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#ccc', padding: 15 } } } }
        });
      </script>
    `;
  }

  if (page === 'orders') {
    const stageFilter = params.stage || '';
    const filteredOrders = stageFilter ? orders.filter(o => o.stage === stageFilter) : orders;
    
    content = `
      <div class="filters">
        <a href="?page=orders" class="filter-btn ${!stageFilter ? 'active' : ''}">Все</a>
        <a href="?page=orders&stage=pending_review" class="filter-btn ${stageFilter === 'pending_review' ? 'active' : ''}">На рассмотрении</a>
        <a href="?page=orders&stage=awaiting_confirmation" class="filter-btn ${stageFilter === 'awaiting_confirmation' ? 'active' : ''}">Ожидают</a>
        <a href="?page=orders&stage=priced" class="filter-btn ${stageFilter === 'priced' ? 'active' : ''}">Цена назначена</a>
        <a href="?page=orders&stage=in_progress" class="filter-btn ${stageFilter === 'in_progress' ? 'active' : ''}">В работе</a>
        <a href="?page=orders&stage=done" class="filter-btn ${stageFilter === 'done' ? 'active' : ''}">Готово</a>
        <a href="?page=orders&stage=rejected" class="filter-btn ${stageFilter === 'rejected' ? 'active' : ''}">Отклонён</a>
        <a href="?page=orders&stage=cancelled" class="filter-btn ${stageFilter === 'cancelled' ? 'active' : ''}">Отменён</a>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Клиент</th>
              <th>Задача</th>
              <th>Срок</th>
              <th>Пакет</th>
              <th>Цена</th>
              <th>Статус</th>
              <th>Создан</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${filteredOrders.map(o => `
              <tr>
                <td><strong>${escapeHtml(o.id)}</strong></td>
                <td>${o.client_id}</td>
                <td class="task-cell" title="${escapeHtml(o.task)}">${escapeHtml(o.task.substring(0, 30))}${o.task.length > 30 ? '...' : ''}</td>
                <td>${escapeHtml(o.deadline) || '-'}</td>
                <td>${LEVELS[o.level] || '-'}</td>
                <td>${formatMoney(o.final_price || o.estimated_price)}</td>
                <td><span class="stage" style="background:${STAGE_COLORS[o.stage]}20;color:${STAGE_COLORS[o.stage]}">${STAGES[o.stage] || o.stage}</span></td>
                <td>${formatDate(o.created_at)}</td>
                <td>
                  <a href="?page=order_edit&id=${escapeHtml(o.id)}" class="action-btn">✏️</a>
                  <a href="?page=orders&delete=${escapeHtml(o.id)}" class="action-btn danger" onclick="return confirm('Удалить заказ?')">🗑️</a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (page === 'order_edit') {
    const order = db.getOrder(params.id);
    content = `
      <div class="form-card">
        <h2>Редактирование заказа ${escapeHtml(params.id)}</h2>
        <form method="post" action="?page=order_save">
          <input type="hidden" name="id" value="${escapeHtml(params.id)}">
          <div class="form-group">
            <label>Задача</label>
            <textarea name="task">${escapeHtml(order?.task || '')}</textarea>
          </div>
          <div class="form-group">
            <label>Срок</label>
            <input type="text" name="deadline" value="${escapeHtml(order?.deadline || '')}">
          </div>
          <div class="form-group">
            <label>Пакет</label>
            <select name="level">
              <option value="">-</option>
              <option value="basic" ${order?.level === 'basic' ? 'selected' : ''}>Стандарт</option>
              <option value="strong" ${order?.level === 'strong' ? 'selected' : ''}>Усиленный</option>
              <option value="premium" ${order?.level === 'premium' ? 'selected' : ''}>Максимум</option>
            </select>
          </div>
          <div class="form-group">
            <label>Статус</label>
            <select name="stage">
              ${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${order?.stage === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Предварительная цена</label>
            <input type="number" step="0.01" name="estimated_price" value="${order?.estimated_price || ''}">
          </div>
          <div class="form-group">
            <label>Итоговая цена</label>
            <input type="number" step="0.01" name="final_price" value="${order?.final_price || ''}">
          </div>
          <div class="form-group">
            <label>Требования</label>
            <textarea name="requirements">${escapeHtml(order?.requirements || '')}</textarea>
          </div>
          <button type="submit" class="submit-btn">Сохранить</button>
          <a href="?page=orders" class="cancel-btn">Отмена</a>
        </form>
      </div>
    `;
  }

  if (page === 'users') {
    content = `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Username</th>
              <th>Имя</th>
              <th>Фамилия</th>
              <th>Профиль</th>
              <th>Заказов</th>
              <th>Создан</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => {
              const profile = db.getProfile(u.id);
              const userOrders = orders.filter(o => o.client_id === u.id);
              return `
                <tr>
                  <td>${u.id}</td>
                  <td>@${escapeHtml(u.username || '-')}</td>
                  <td>${escapeHtml(u.first_name || '-')}</td>
                  <td>${escapeHtml(u.last_name || '-')}</td>
                  <td>
                    ${profile ? `<span>${escapeHtml(profile.name || '-')}</span><br><span class="small">${escapeHtml(profile.phone || '-')}</span>` : '<span class="gray">Нет профиля</span>'}
                  </td>
                  <td>${userOrders.length}</td>
                  <td>${formatDate(u.created_at)}</td>
                  <td>
                    <a href="?page=user_edit&id=${u.id}" class="action-btn">✏️</a>
                    <a href="?page=users&delete=${u.id}" class="action-btn danger" onclick="return confirm('Удалить пользователя?')">🗑️</a>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (page === 'user_edit') {
    const user = db.getUser(params.id);
    const profile = db.getProfile(params.id);
    content = `
      <div class="form-card">
        <h2>Редактирование пользователя ${user?.id}</h2>
        <form method="post" action="?page=user_save">
          <input type="hidden" name="id" value="${user?.id}">
          <div class="form-group">
            <label>Telegram ID</label>
            <input type="text" value="${user?.id}" disabled>
          </div>
          <div class="form-group">
            <label>Username</label>
            <input type="text" value="${escapeHtml(user?.username || '')}" disabled>
          </div>
          <div class="form-group">
            <label>Имя</label>
            <input type="text" name="first_name" value="${escapeHtml(user?.first_name || '')}">
          </div>
          <div class="form-group">
            <label>Фамилия</label>
            <input type="text" name="last_name" value="${escapeHtml(user?.last_name || '')}">
          </div>
          <hr>
          <h3>Профиль</h3>
          <div class="form-group">
            <label>Имя (профиль)</label>
            <input type="text" name="name" value="${escapeHtml(profile?.name || '')}">
          </div>
          <div class="form-group">
            <label>Телефон</label>
            <input type="text" name="phone" value="${escapeHtml(profile?.phone || '')}">
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" name="email" value="${escapeHtml(profile?.email || '')}">
          </div>
          <div class="form-group">
            <label>Заметки</label>
            <textarea name="notes">${escapeHtml(profile?.notes || '')}</textarea>
          </div>
          <button type="submit" class="submit-btn">Сохранить</button>
          <a href="?page=users" class="cancel-btn">Отмена</a>
        </form>
      </div>
    `;
  }

  if (page === 'logs') {
    content = `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Действие</th>
              <th>Тип</th>
              <th>ID цели</th>
              <th>Админ</th>
              <th>Пользователь</th>
              <th>Детали</th>
              <th>Время</th>
            </tr>
          </thead>
          <tbody>
            ${logs.map(l => `
              <tr>
                <td>${l.id}</td>
                <td><span class="log-action">${escapeHtml(l.action)}</span></td>
                <td>${escapeHtml(l.target_type || '-')}</td>
                <td>${escapeHtml(l.target_id || '-')}</td>
                <td>${l.admin_id || '-'}</td>
                <td>${l.user_id || '-'}</td>
                <td class="task-cell">${escapeHtml(l.details || '-')}</td>
                <td>${formatDate(l.created_at)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (page === 'backup') {
    const backups = db.getBackupFiles();
    content = `
      <div class="section-card">
        <h2>📦 Бэкапы</h2>
        <form method="post" action="?page=backup_create" style="margin-bottom:20px">
          <button type="submit" class="submit-btn">Создать бэкап</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Файл</th>
              <th>Размер</th>
              <th>Создан</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${backups.length ? backups.map(b => `
              <tr>
                <td>${escapeHtml(b.name)}</td>
                <td>${b.sizeFormatted}</td>
                <td>${formatDate(b.created)}</td>
                <td>
                  <a href="?page=backup_restore&file=${encodeURIComponent(b.path)}" class="action-btn" onclick="return confirm('Восстановить из этого бэкапа?')">🔄 Восстановить</a>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="4">Нет бэкапов</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="section-card">
        <h2>🛠️ Утилиты</h2>
        <form method="post" action="?page=db_optimize" style="display:inline">
          <button type="submit" class="submit-btn">Оптимизировать БД</button>
        </form>
        <form method="post" action="?page=db_clear" style="display:inline;margin-left:10px">
          <button type="submit" class="submit-btn danger" onclick="return confirm('Очистить все данные?')">Очистить всё</button>
        </form>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chertila Bot — ${page === 'stats' ? 'Статистика' : page === 'orders' ? 'Заказы' : page === 'users' ? 'Пользователи' : page === 'logs' ? 'Логи' : page === 'backup' ? 'Бэкапы' : 'Админ'}</title>
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
    }
    .refresh-btn:hover { background: rgba(255,255,255,0.2); }
    
    nav { display: flex; gap: 10px; margin-bottom: 30px; flex-wrap: wrap; }
    nav a {
      padding: 12px 20px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: #aaa;
      text-decoration: none;
      transition: all 0.3s;
    }
    nav a:hover, nav a.active {
      background: rgba(0, 217, 255, 0.1);
      border-color: #00d9ff;
      color: #00d9ff;
    }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px;
    }
    .stat-card:hover { transform: translateY(-5px); box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
    .stat-card h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 10px; }
    .stat-card .value { font-size: 36px; font-weight: 700; background: linear-gradient(90deg, #00d9ff, #00ff88); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .stat-card .value.revenue { color: #00ff88; }
    .stat-card .value.warning { color: #ffc107; }
    .stat-card .value.info { color: #00d9ff; }

    .charts-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .chart-card, .section-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 24px;
    }
    .chart-card h2, .section-card h2 { font-size: 18px; margin-bottom: 20px; color: #fff; }
    .chart-container { position: relative; height: 250px; }

    .table-container { overflow-x: auto; background: rgba(255,255,255,0.05); border-radius: 16px; padding: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { color: #888; font-size: 12px; text-transform: uppercase; }
    td { font-size: 14px; }
    tr:hover { background: rgba(255,255,255,0.05); }
    .task-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stage { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; }
    .gray { color: #666; }
    .small { font-size: 12px; color: #888; }
    .log-action { background: rgba(0, 217, 255, 0.2); padding: 2px 8px; border-radius: 4px; font-size: 12px; }

    .filters { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .filter-btn { padding: 8px 16px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #aaa; text-decoration: none; font-size: 14px; }
    .filter-btn:hover, .filter-btn.active { background: rgba(0, 217, 255, 0.2); border-color: #00d9ff; color: #00d9ff; }

    .action-btn { text-decoration: none; padding: 4px 8px; }
    .action-btn:hover { opacity: 0.7; }
    .action-btn.danger:hover { color: #f44336; }

    .form-card { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 30px; max-width: 600px; }
    .form-card h2 { margin-bottom: 20px; }
    .form-card h3 { margin: 20px 0 10px; color: #00d9ff; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; color: #aaa; font-size: 14px; }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      padding: 12px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
    }
    .form-group textarea { min-height: 100px; resize: vertical; }
    .form-group input:disabled { opacity: 0.5; }
    hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 20px 0; }

    .submit-btn { background: linear-gradient(90deg, #00d9ff, #00ff88); color: #1a1a2e; padding: 12px 24px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; }
    .submit-btn:hover { opacity: 0.9; }
    .submit-btn.danger { background: #f44336; }
    .cancel-btn { display: inline-block; margin-left: 15px; color: #888; text-decoration: none; padding: 12px 0; }
    .cancel-btn:hover { color: #fff; }

    .info-row { display: flex; justify-content: space-between; padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .info-label { color: #888; }
    .info-value { font-weight: 600; }

    .level-bars { display: flex; flex-direction: column; gap: 15px; }
    .level-bar { display: flex; align-items: center; }
    .level-bar .label { width: 100px; font-size: 13px; }
    .level-bar .bar { flex: 1; height: 24px; background: rgba(255,255,255,0.1); border-radius: 12px; overflow: hidden; margin: 0 10px; }
    .level-bar .fill { height: 100%; background: linear-gradient(90deg, #00d9ff, #00ff88); border-radius: 12px; transition: width 0.5s ease; }
    .level-bar .count { width: 40px; text-align: right; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📊 Chertila Bot</h1>
      <button class="refresh-btn" onclick="location.reload()">🔄 Обновить</button>
    </header>

    <nav>
      <a href="?page=stats" class="${page === 'stats' ? 'active' : ''}">📈 Статистика</a>
      <a href="?page=orders" class="${page === 'orders' || page === 'order_edit' ? 'active' : ''}">📋 Заказы</a>
      <a href="?page=users" class="${page === 'users' || page === 'user_edit' ? 'active' : ''}">👥 Пользователи</a>
      <a href="?page=logs" class="${page === 'logs' ? 'active' : ''}">📜 Логи</a>
      <a href="?page=backup" class="${page === 'backup' ? 'active' : ''}">📦 Бэкапы</a>
    </nav>

    ${content}

    <p style="margin-top:30px;color:#666;font-size:12px;text-align:center">Обновлено: ${new Date().toLocaleString('ru-RU')}</p>
  </div>
</body>
</html>`;
}

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;
  const postData = parsedUrl.query;

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = querystring.parse(body);
      
      if (query.page === 'order_save' && params.id) {
        db.updateOrder(params.id, {
          task: params.task,
          deadline: params.deadline,
          level: params.level,
          stage: params.stage,
          estimatedPrice: params.estimated_price ? parseFloat(params.estimated_price) : null,
          finalPrice: params.final_price ? parseFloat(params.final_price) : null,
          requirements: params.requirements
        });
      }
      
      if (query.page === 'user_save' && params.id) {
        const userId = parseInt(params.id);
        db.saveProfile(userId, {
          name: params.name,
          phone: params.phone,
          email: params.email,
          notes: params.notes
        });
      }
      
      if (query.page === 'backup_create') {
        db.createBackup();
      }
      
      if (query.page === 'backup_restore' && params.file) {
        db.restoreFromBackup(params.file);
      }
      
      if (query.page === 'db_optimize') {
        db.optimizeDb();
      }
      
      if (query.page === 'db_clear') {
        db.clearAll();
      }
      
      res.writeHead(302, { 'Location': parsedUrl.pathname + '?page=' + (query.page?.replace('_save', '').replace('_create', '').replace('_restore', '').replace('_optimize', '').replace('_clear', '') || 'stats') });
      res.end();
    });
    return;
  }

  if (query.delete) {
    if (query.page === 'orders') {
      const stmt = db.getDb().prepare('DELETE FROM orders WHERE id = ?');
      stmt.run(query.delete);
    }
    if (query.page === 'users') {
      const userId = parseInt(query.delete);
      db.getDb().prepare('DELETE FROM attachments WHERE order_id IN (SELECT id FROM orders WHERE client_id = ?)').run(userId);
      db.getDb().prepare('DELETE FROM orders WHERE client_id = ?').run(userId);
      db.getDb().prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);
      db.getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
    res.writeHead(302, { 'Location': parsedUrl.pathname + '?page=' + query.page });
    res.end();
    return;
  }

  const page = query.page || 'stats';
  const html = getDashboardHtml(page, query);
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(handleRequest);

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