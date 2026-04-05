require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Telegraf, session, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const STATE_FILE = path.join(__dirname, 'bot-state.json');
const MIN_PRICE_BYN = 4;
const MAX_PRICE_BYN = 20;
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const OVERDUE_HOURS = 24;

const DEADLINES = {
  urgent: { label: 'Срочно', factor: 1.55, description: 'максимальный приоритет' },
  today: { label: 'Сегодня', factor: 1.35, description: 'в течение дня' },
  tomorrow: { label: 'Завтра', factor: 1.15, description: 'до завтра' },
  week: { label: 'Без спешки', factor: 1, description: 'оптимальный тариф' }
};

const LEVELS = {
  basic: { label: 'Стандарт', factor: 1, description: 'быстро и по делу' },
  strong: { label: 'Усиленный', factor: 1.2, description: 'глубже и точнее' },
  premium: { label: 'Максимум', factor: 1.45, description: 'максимальная проработка' }
};

const STAGES = {
  pending_review: '🕓 На рассмотрении',
  priced: '💵 Цена назначена',
  in_progress: '🚧 В работе',
  done: '✅ Готово',
  rejected: '⛔ Отклонён',
  cancelled: '❌ Отменён'
};

function ensureEnv() {
  if (!BOT_TOKEN) {
    throw new Error('Нет BOT_TOKEN');
  }

  if (!Number.isInteger(ADMIN_ID) || ADMIN_ID <= 0) {
    throw new Error('Нет корректного ADMIN_ID');
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { seq: 1, orders: {}, profiles: {}, users: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      seq: Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 1,
      orders: raw.orders && typeof raw.orders === 'object' ? raw.orders : {},
      profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {},
      users: Array.isArray(raw.users) ? raw.users : []
    };
  } catch {
    return { seq: 1, orders: {}, profiles: {}, users: [] };
  }
}

const state = loadState();

function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(value) {
  return `${new Intl.NumberFormat('ru-BY', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value)} BYN`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function createOrderId(seq) {
  return `ORD-${String(seq).padStart(4, '0')}`;
}

function getUserName(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();

  if (fullName) {
    return fullName;
  }

  if (user.username) {
    return `@${user.username}`;
  }

  return `ID ${user.id}`;
}

function getUserUsername(user) {
  return user.username ? `@${user.username}` : '';
}

function getClientIdentity(order) {
  const parts = [];

  if (order.clientName) {
    parts.push(escapeHtml(order.clientName));
  }

  if (order.clientUsername && order.clientUsername !== order.clientName) {
    parts.push(escapeHtml(order.clientUsername));
  }

  parts.push(`(${order.clientId})`);

  return parts.join(' ');
}

function getStageLabel(stage) {
  if (stage === 'picked_up') {
    return STAGES.done;
  }

  return STAGES[stage] || stage;
}

function getDeadlineLabel(deadline) {
  return DEADLINES[deadline]?.label || deadline;
}

function getLevelLabel(level) {
  return LEVELS[level]?.label || level;
}

function getEstimatedPrice(draft) {
  const taskLength = draft.task.trim().length;
  const hasRequirements = Boolean(draft.requirements && draft.requirements !== 'Без дополнительных требований');
  const attachmentsCount = Array.isArray(draft.attachments) ? draft.attachments.length : 0;

  let price = 4;
  price += Math.min(taskLength / 40, 4.5);

  if (hasRequirements) {
    price += 1.5;
  }

  if (attachmentsCount > 0) {
    price += Math.min(attachmentsCount * 0.75, 2);
  }

  price = price * (DEADLINES[draft.deadline]?.factor || 1);
  price = price * (LEVELS[draft.level]?.factor || 1);
  price = Math.round(price * 2) / 2;

  return Math.min(MAX_PRICE_BYN, Math.max(MIN_PRICE_BYN, price));
}

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_ID;
}

function getMainKeyboard(adminMode) {
  const rows = [
    ['✨ Новый заказ', '📦 Мои заказы'],
    ['📊 Моя статистика', '👤 Профиль'],
    ['ℹ️ Как это работает', '❌ Сбросить']
  ];

  if (adminMode) {
    rows.unshift(['🛠 Админ-панель']);
  }

  return Markup.keyboard(rows).resize();
}

function getAttachmentControls() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Отправить заказ', 'draft:submit')],
    [Markup.button.callback('↩️ Вернуться к карточке', 'draft:summary')]
  ]);
}

function getAdminOrderControls(order) {
  const rows = [];

  if (order.stage === 'pending_review') {
    rows.push([
      Markup.button.callback('💵 Назначить цену', `admin:price:${order.id}`),
      Markup.button.callback('⛔ Отклонить', `admin:reject:${order.id}`)
    ]);
  }

  if (order.stage === 'priced') {
    rows.push([
      Markup.button.callback('🚧 В работу', `admin:start:${order.id}`),
      Markup.button.callback('✅ Завершить', `admin:done:${order.id}`)
    ]);
  }

  if (order.stage === 'in_progress') {
    rows.push([Markup.button.callback('✅ Завершить', `admin:done:${order.id}`)]);
  }

  rows.push([Markup.button.callback('🧾 Детали', `admin:details:${order.id}`)]);

  return Markup.inlineKeyboard(rows);
}

function getUserOrderControls(order) {
  const rows = [[Markup.button.callback('🔎 Обновить', `user:details:${order.id}`)]];

  if (['pending_review', 'priced', 'in_progress'].includes(order.stage)) {
    rows.push([Markup.button.callback('❌ Отменить заказ', `user:cancel:${order.id}`)]);
  }

  return Markup.inlineKeyboard(rows);
}

function getDraftSummaryKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📎 Добавить файлы', 'draft:attachments')],
    [Markup.button.callback('🚀 Отправить заказ', 'draft:submit')],
    [Markup.button.callback('🔁 Начать заново', 'draft:restart')]
  ]);
}

function getOrdersArray() {
  return Object.values(state.orders).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getOrdersByUser(userId) {
  return getOrdersArray().filter((order) => order.clientId === userId);
}

function getActiveOrders() {
  return getOrdersArray().filter((order) => ['pending_review', 'priced', 'in_progress'].includes(order.stage));
}

function getAttentionOrders() {
  return getOrdersArray().filter((order) => ['pending_review', 'priced', 'in_progress', 'done'].includes(order.stage));
}

function getStats() {
  const orders = getOrdersArray();
  const total = orders.length;
  const active = orders.filter((order) => ['pending_review', 'priced', 'in_progress'].includes(order.stage)).length;
  const completed = orders.filter((order) => ['done', 'picked_up'].includes(order.stage));
  const revenue = completed.reduce((sum, order) => sum + (order.finalPrice || 0), 0);

  return {
    total,
    active,
    done: completed.length,
    pending: orders.filter((order) => order.stage === 'pending_review').length,
    priced: orders.filter((order) => order.stage === 'priced').length,
    inProgress: orders.filter((order) => order.stage === 'in_progress').length,
    rejected: orders.filter((order) => order.stage === 'rejected').length,
    cancelled: orders.filter((order) => order.stage === 'cancelled').length,
    revenue
  };
}

function trackUser(user) {
  const userId = user.id;
  if (!state.users.includes(userId)) {
    state.users.push(userId);
    persistState();
  }
}

function searchOrders(query) {
  const q = query.toLowerCase().trim();
  const results = [];

  for (const order of Object.values(state.orders)) {
    if (order.id.toLowerCase().includes(q)) {
      results.push(order);
      continue;
    }
    if (order.clientName && order.clientName.toLowerCase().includes(q)) {
      results.push(order);
      continue;
    }
    if (order.clientUsername && order.clientUsername.toLowerCase().includes(q)) {
      results.push(order);
      continue;
    }
    if (getStageLabel(order.stage).toLowerCase().includes(q)) {
      results.push(order);
      continue;
    }
    if (order.task.toLowerCase().includes(q)) {
      results.push(order);
    }
  }

  return results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getUserStats(userId) {
  const orders = getOrdersByUser(userId);
  const completed = orders.filter((o) => ['done', 'picked_up'].includes(o.stage));
  const totalSpent = completed.reduce((sum, o) => sum + (o.finalPrice || 0), 0);
  const totalOrders = orders.length;

  return {
    totalOrders,
    completedOrders: completed.length,
    totalSpent,
    activeOrders: orders.filter((o) => ['pending_review', 'priced', 'in_progress'].includes(o.stage)).length
  };
}

function buildUserStatsText(userId) {
  const stats = getUserStats(userId);
  return [
    '<b>Твоя статистика</b>',
    '',
    `Всего заказов: <b>${stats.totalOrders}</b>`,
    `Активных: <b>${stats.activeOrders}</b>`,
    `Завершено: <b>${stats.completedOrders}</b>`,
    `Потрачено: <b>${escapeHtml(formatMoney(stats.totalSpent))}</b>`
  ].join('\n');
}

function getOverdueOrders() {
  const now = Date.now();
  const threshold = OVERDUE_HOURS * 60 * 60 * 1000;

  return getOrdersArray().filter((order) => {
    if (order.stage !== 'in_progress') return false;
    const updatedAt = new Date(order.updatedAt).getTime();
    return (now - updatedAt) > threshold;
  });
}

async function sendBroadcast(bot, message, filterStage = null) {
  let users = state.users;

  if (filterStage) {
    const ordersByStage = getOrdersArray().filter((o) => o.stage === filterStage);
    const userIds = new Set(ordersByStage.map((o) => o.clientId));
    users = users.filter((id) => userIds.has(id));
  }

  let success = 0;
  let failed = 0;

  for (const userId of users) {
    try {
      await bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
      success++;
    } catch {
      failed++;
    }
  }

  return { success, failed, total: users.length };
}

function buildOrderSummary(order, options = {}) {
  const lines = [];

  lines.push(`<b>${options.title || `Заказ ${order.id}`}</b>`);
  lines.push('');
  lines.push(`<b>Статус:</b> ${escapeHtml(getStageLabel(order.stage))}`);
  lines.push(`<b>Задача:</b> ${escapeHtml(order.task)}`);
  lines.push(`<b>Срок:</b> ${escapeHtml(getDeadlineLabel(order.deadline))}`);
  lines.push(`<b>Пакет:</b> ${escapeHtml(getLevelLabel(order.level))}`);
  lines.push(`<b>Требования:</b> ${escapeHtml(order.requirements || 'Без дополнительных требований')}`);
  lines.push(`<b>Вложения:</b> ${order.attachments.length}`);
  lines.push(`<b>Создан:</b> ${escapeHtml(formatDate(order.createdAt))}`);

  if (order.estimatedPrice) {
    lines.push(`<b>Предварительная оценка:</b> ${escapeHtml(formatMoney(order.estimatedPrice))}`);
  }

  if (order.finalPrice) {
    lines.push(`<b>Финальная цена:</b> ${escapeHtml(formatMoney(order.finalPrice))}`);
  }

  if (options.includeClient) {
    lines.push(`<b>Клиент:</b> ${getClientIdentity(order)}`);
  }

  return lines.join('\n');
}

function buildUserOrdersText(orders) {
  if (!orders.length) {
    return 'Пока заказов нет. Нажми <b>✨ Новый заказ</b>, и я соберу заявку в красивую карточку.';
  }

  return [
    '<b>Твои заказы</b>',
    '',
    ...orders.slice(0, 8).map((order) => {
      const price = order.finalPrice || order.estimatedPrice;
      return `• <b>${order.id}</b> — ${escapeHtml(getStageLabel(order.stage))} — ${escapeHtml(formatMoney(price))}`;
    })
  ].join('\n');
}

function buildUserOrdersKeyboard(orders) {
  const rows = orders.slice(0, 8).map((order) => [
    Markup.button.callback(`${order.id} • ${getStageLabel(order.stage).replace(/^[^\s]+\s/, '')}`, `user:details:${order.id}`)
  ]);

  rows.push([Markup.button.callback('🔄 Обновить список', 'user:list')]);

  return Markup.inlineKeyboard(rows);
}

function buildAdminPanelText() {
  const stats = getStats();

  return [
    '<b>Панель управления</b>',
    '',
    `Всего заказов: <b>${stats.total}</b>`,
    `Активных: <b>${stats.active}</b>`,
    `Новых: <b>${stats.pending}</b>`,
    `С ценой: <b>${stats.priced}</b>`,
    `В работе: <b>${stats.inProgress}</b>`,
    `Готовых: <b>${stats.done}</b>`,
    `Отклонённых: <b>${stats.rejected}</b>`,
    `Отменённых: <b>${stats.cancelled}</b>`,
    `Выручка: <b>${escapeHtml(formatMoney(stats.revenue))}</b>`
  ].join('\n');
}

function buildAttentionOrdersText() {
  const orders = getAttentionOrders();

  if (!orders.length) {
    return '<b>Список актуальных заказов</b>\n\nСейчас нет незавершённых или невыданных заказов.';
  }

  return [
    '<b>Список актуальных заказов</b>',
    '',
    ...orders.map((order) => {
      const price = order.finalPrice || order.estimatedPrice;
      return `• <b>${order.id}</b> — ${escapeHtml(getStageLabel(order.stage))} — ${escapeHtml(order.clientName)} — ${escapeHtml(formatMoney(price))}`;
    })
  ].join('\n');
}

function buildAdminPanelKeyboard() {
  const activeOrders = getActiveOrders().slice(0, 6);
  const rows = [
    [
      Markup.button.callback('📋 Заказы', 'admin:attention'),
      Markup.button.callback('🔍 Поиск', 'admin:search')
    ],
    [
      Markup.button.callback('📢 Рассылка', 'admin:broadcast'),
      Markup.button.callback('🔄 Обновить', 'admin:panel')
    ],
    [Markup.button.callback('🧹 Сброс статистику', 'admin:reset')]
  ];

  activeOrders.forEach((order) => {
    rows.push([Markup.button.callback(`${order.id} • ${getStageLabel(order.stage).replace(/^[^\s]+\s/, '')}`, `admin:details:${order.id}`)]);
  });

  return Markup.inlineKeyboard(rows);
}

function getBroadcastKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📢 Всем пользователям', 'broadcast:all')],
    [Markup.button.callback('🕓 На рассмотрении', 'broadcast:pending_review')],
    [Markup.button.callback('💵 С ценой', 'broadcast:priced')],
    [Markup.button.callback('🚧 В работе', 'broadcast:in_progress')],
    [Markup.button.callback('✅ Завершённые', 'broadcast:done')],
    [Markup.button.callback('↩️ Назад', 'admin:panel')]
  ]);
}

function getSearchKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🕓 На рассмотрении', 'search:pending_review')],
    [Markup.button.callback('💵 С ценой', 'search:priced')],
    [Markup.button.callback('🚧 В работе', 'search:in_progress')],
    [Markup.button.callback('✅ Завершённые', 'search:done')],
    [Markup.button.callback('↩️ Назад', 'admin:panel')]
  ]);
}

function buildSearchResultsText(results, query) {
  if (!results.length) {
    return `<b>Поиск: "${escapeHtml(query)}"</b>\n\nНичего не найдено.`;
  }

  return [
    `<b>Результаты поиска: "${escapeHtml(query)}"</b>`,
    '',
    ...results.slice(0, 10).map((order) => {
      const price = order.finalPrice || order.estimatedPrice;
      return `• <b>${order.id}</b> — ${escapeHtml(getStageLabel(order.stage))} — ${escapeHtml(order.clientName)} — ${escapeHtml(formatMoney(price))}`;
    }),
    results.length > 10 ? `\nПоказано 10 из ${results.length} результатов.` : ''
  ].join('\n');
}

function buildAttentionOrdersKeyboard(orders) {
  const rows = orders.slice(0, 12).map((order) => [
    Markup.button.callback(`${order.id} • ${getStageLabel(order.stage).replace(/^[^\s]+\s/, '')}`, `admin:details:${order.id}`)
  ]);

  rows.push([Markup.button.callback('🔄 Обновить список', 'admin:attention')]);
  rows.push([Markup.button.callback('↩️ В панель', 'admin:panel')]);

  return Markup.inlineKeyboard(rows);
}

function buildResetStatsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚠️ Да, сбросить всё', 'admin:reset:confirm')],
    [Markup.button.callback('↩️ Отмена', 'admin:panel')]
  ]);
}

function createDraft(user, profile = null) {
  return {
    task: '',
    deadline: '',
    requirements: '',
    level: '',
    attachments: [],
    clientId: user.id,
    clientName: profile?.name || getUserName(user),
    clientUsername: getUserUsername(user),
    clientPhone: profile?.phone || '',
    clientEmail: profile?.email || '',
    clientNotes: profile?.notes || ''
  };
}

function createDefaultProfile(user) {
  return {
    userId: user.id,
    name: getUserName(user),
    username: getUserUsername(user),
    phone: '',
    email: '',
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function getProfile(userId) {
  return state.profiles[userId] || null;
}

function saveProfile(userId, patch) {
  const existing = state.profiles[userId] || {};
  state.profiles[userId] = {
    ...existing,
    ...patch,
    userId,
    updatedAt: new Date().toISOString()
  };
  persistState();
  return state.profiles[userId];
}

function buildProfileText(profile) {
  const lines = [
    '<b>Профиль</b>',
    '',
    `<b>Имя:</b> ${escapeHtml(profile.name || 'Не указано')}`,
    `<b>Телефон:</b> ${escapeHtml(profile.phone || 'Не указан')}`,
    `<b>Email:</b> ${escapeHtml(profile.email || 'Не указан')}`,
    `<b>Заметки:</b> ${escapeHtml(profile.notes || 'Нет')}`
  ];
  return lines.join('\n');
}

function getProfileKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Изменить имя', 'profile:edit:name')],
    [Markup.button.callback('📱 Телефон', 'profile:edit:phone')],
    [Markup.button.callback('✉️ Email', 'profile:edit:email')],
    [Markup.button.callback('📝 Заметки', 'profile:edit:notes')],
    [Markup.button.callback('↩️ Назад', 'profile:back')]
  ]);
}

function getProfileEditKeyboard(field) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💾 Сохранить', `profile:save:${field}`)],
    [Markup.button.callback('↩️ Отмена', 'profile:view')]
  ]);
}

function resetSession(ctx) {
  ctx.session = {};
}

function createOrderFromDraft(draft) {
  const id = createOrderId(state.seq);
  state.seq += 1;

  const order = {
    id,
    clientId: draft.clientId,
    clientName: draft.clientName,
    clientUsername: draft.clientUsername || '',
    task: draft.task,
    deadline: draft.deadline,
    requirements: draft.requirements || 'Без дополнительных требований',
    level: draft.level,
    attachments: draft.attachments || [],
    estimatedPrice: getEstimatedPrice(draft),
    finalPrice: null,
    stage: 'pending_review',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  state.orders[id] = order;
  persistState();

  return order;
}

function updateOrder(orderId, patch) {
  const order = state.orders[orderId];

  if (!order) {
    return null;
  }

  state.orders[orderId] = {
    ...order,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  persistState();

  return state.orders[orderId];
}

function parsePrice(value) {
  const normalized = value.replace(',', '.').trim();

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const price = Math.round(Number(normalized) * 100) / 100;

  if (!Number.isFinite(price) || price < MIN_PRICE_BYN || price > MAX_PRICE_BYN) {
    return null;
  }

  return price;
}

async function sendHtml(ctx, text, extra = {}) {
  return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

async function deleteMessageSafe(ctx, messageId) {
  if (!ctx.chat?.id || !messageId) {
    return;
  }

  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch {}
}

async function deleteCurrentUserMessage(ctx) {
  const messageId = ctx.message?.message_id;

  if (!messageId) {
    return;
  }

  try {
    await ctx.deleteMessage(messageId);
  } catch {}
}

async function clearFlowMessage(ctx) {
  const messageId = ctx.session?.flowMessageId;

  if (!messageId) {
    return;
  }

  await deleteMessageSafe(ctx, messageId);
  delete ctx.session.flowMessageId;
}

async function showFlowMessage(ctx, text, extra = {}) {
  const messageId = ctx.session?.flowMessageId;
  const options = { parse_mode: 'HTML', ...extra };

  if (messageId && ctx.chat?.id) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, { parse_mode: 'HTML' });
      if (extra.reply_markup) {
        await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, messageId, undefined, extra.reply_markup);
      }
      return { message_id: messageId };
    } catch {
      await deleteMessageSafe(ctx, messageId);
    }
  }

  const message = await ctx.reply(text, options);
  ctx.session.flowMessageId = message.message_id;

  return message;
}

async function showWelcome(ctx) {
  await clearFlowMessage(ctx);
  resetSession(ctx);

  const adminMode = isAdmin(ctx);
  const text = adminMode
    ? '<b>Добро пожаловать в продвинутую админ-панель</b>\n\nУправляй заказами, ценами, статусами и смотри сводку в одном месте.'
    : '<b>Привет!</b>\n\nЯ собираю заказ в удобную карточку, считаю предварительную цену, принимаю файлы и показываю статус без лишних сообщений.';

  return sendHtml(ctx, text, getMainKeyboard(adminMode));
}

async function showHelp(ctx) {
  return sendHtml(
    ctx,
    [
      '<b>Как это работает</b>',
      '',
      '1. Нажми <b>✨ Новый заказ</b> и кратко опиши задачу.',
      '2. Выбери срок и уровень проработки.',
      '3. При необходимости добавь требования и файлы.',
      '4. Получи оценку, а затем отслеживай статус в разделе <b>📦 Мои заказы</b>.'
    ].join('\n')
  );
}

async function showProfile(ctx) {
  const profile = getProfile(ctx.from.id);
  const isRegistered = profile && profile.name && profile.name.trim().length >= 2;
  const text = profile ? buildProfileText(profile) : '<b>Профиль</b>\n\nДля оформления заказов необходимо зарегистрироваться — указать ваше имя.';
  const extra = profile ? getProfileKeyboard() : Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Заполнить профиль', 'profile:create')]
  ]);
  return sendHtml(ctx, text, extra);
}

async function showProfileEdit(ctx, field) {
  const profile = getProfile(ctx.from.id);
  const fieldLabels = {
    name: 'имя',
    phone: 'телефон',
    email: 'email',
    notes: 'заметки'
  };
  const fieldValues = {
    name: profile?.name || '',
    phone: profile?.phone || '',
    email: profile?.email || '',
    notes: profile?.notes || ''
  };

  ctx.session.flow = 'profile_edit';
  ctx.session.editField = field;

  return showFlowMessage(
    ctx,
    `<b>Введите ${fieldLabels[field]}</b>\n\nТекущее значение: ${escapeHtml(fieldValues[field]) || 'не указано'}`
  );
}

async function saveProfileField(ctx, field, value) {
  const userId = ctx.from.id;
  const profile = getProfile(userId) || createDefaultProfile(ctx.from);

  saveProfile(userId, { [field]: value, username: getUserUsername(ctx.from) });

  ctx.session.flow = null;
  delete ctx.session.editField;

  const updatedProfile = getProfile(userId);
  return showFlowMessage(ctx, 'Профиль сохранён.', getProfileKeyboard());
}

async function startDraft(ctx) {
  const profile = getProfile(ctx.from.id);
  if (!profile || !profile.name || profile.name.trim().length < 2) {
    return sendHtml(
      ctx,
      '<b>Регистрация required</b>\n\nДля создания заказа необходимо заполнить профиль. Нажмите <b>👤 Профиль</b> и укажите ваше имя.',
      getMainKeyboard(isAdmin(ctx))
    );
  }

  await clearFlowMessage(ctx);
  ctx.session.flow = 'create_order';
  ctx.session.step = 'task';
  ctx.session.draft = createDraft(ctx.from, profile);
  delete ctx.session.adminAction;

  return showFlowMessage(
    ctx,
    '<b>Новый заказ</b>\n\nОпиши задачу одним сообщением. Чем конкретнее описание, тем точнее оценка.'
  );
}

async function askDeadline(ctx) {
  return showFlowMessage(
    ctx,
    '<b>Выбери срок</b>\n\nСрочные задачи оцениваются выше, спокойные сроки дают лучший тариф.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Срочно', 'draft:deadline:urgent'), Markup.button.callback('Сегодня', 'draft:deadline:today')],
      [Markup.button.callback('Завтра', 'draft:deadline:tomorrow'), Markup.button.callback('Без спешки', 'draft:deadline:week')]
    ])
  );
}

async function askRequirementsChoice(ctx) {
  return showFlowMessage(
    ctx,
    '<b>Есть дополнительные требования?</b>\n\nМожно приложить структуру, критерии, пример оформления или любые детали.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Да, отправлю текст', 'draft:req:text')],
      [Markup.button.callback('Нет, пропустить', 'draft:req:skip')]
    ])
  );
}

async function askLevel(ctx) {
  return showFlowMessage(
    ctx,
    '<b>Выбери уровень проработки</b>',
    Markup.inlineKeyboard([
      [Markup.button.callback('Стандарт', 'draft:level:basic')],
      [Markup.button.callback('Усиленный', 'draft:level:strong')],
      [Markup.button.callback('Максимум', 'draft:level:premium')]
    ])
  );
}

async function showDraftSummary(ctx) {
  const draft = ctx.session.draft;
  const summary = [
    '<b>Карточка заказа</b>',
    '',
    `<b>Задача:</b> ${escapeHtml(draft.task)}`,
    `<b>Срок:</b> ${escapeHtml(getDeadlineLabel(draft.deadline))}`,
    `<b>Пакет:</b> ${escapeHtml(getLevelLabel(draft.level))}`,
    `<b>Требования:</b> ${escapeHtml(draft.requirements || 'Без дополнительных требований')}`,
    `<b>Вложения:</b> ${draft.attachments.length}`,
    `<b>Оценка:</b> ${escapeHtml(formatMoney(getEstimatedPrice(draft)))}`
  ].join('\n');

  return showFlowMessage(ctx, summary, getDraftSummaryKeyboard());
}

async function showOrdersForUser(ctx) {
  const orders = getOrdersByUser(ctx.from.id);
  const text = buildUserOrdersText(orders);
  const extra = orders.length ? buildUserOrdersKeyboard(orders) : {};

  return sendHtml(ctx, text, extra);
}

async function showOrderDetailsToUser(ctx, order) {
  return sendHtml(ctx, buildOrderSummary(order), getUserOrderControls(order));
}

async function showAdminPanel(ctx) {
  return sendHtml(ctx, buildAdminPanelText(), buildAdminPanelKeyboard());
}

async function showAttentionOrders(ctx) {
  const orders = getAttentionOrders();
  const extra = orders.length ? buildAttentionOrdersKeyboard(orders) : buildAdminPanelKeyboard();

  return sendHtml(ctx, buildAttentionOrdersText(), extra);
}

async function showOrderDetailsToAdmin(ctx, order) {
  return sendHtml(
    ctx,
    buildOrderSummary(order, { includeClient: true, title: `Заказ ${order.id}` }),
    getAdminOrderControls(order)
  );
}

async function notifyAdminAboutOrder(bot, order) {
  await bot.telegram.sendMessage(
    ADMIN_ID,
    buildOrderSummary(order, { includeClient: true, title: `Новый заказ ${order.id}` }),
    { parse_mode: 'HTML', ...getAdminOrderControls(order) }
  );

  for (const attachment of order.attachments) {
    if (attachment.type === 'photo') {
      await bot.telegram.sendPhoto(ADMIN_ID, attachment.fileId, {
        caption: `Вложение к ${order.id}`
      });
    }

    if (attachment.type === 'document') {
      await bot.telegram.sendDocument(ADMIN_ID, attachment.fileId, {
        caption: `Вложение к ${order.id}`
      });
    }
  }
}

async function notifyUserAboutStage(bot, order, title, extraLines = []) {
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    '',
    buildOrderSummary(order),
    ...extraLines
  ];

  await bot.telegram.sendMessage(order.clientId, lines.join('\n'), {
    parse_mode: 'HTML',
    ...getUserOrderControls(order)
  });
}

async function submitDraft(bot, ctx) {
  const draft = ctx.session.draft;
  const order = createOrderFromDraft(draft);
  await clearFlowMessage(ctx);
  resetSession(ctx);

  await notifyAdminAboutOrder(bot, order);

  return sendHtml(
    ctx,
    [
      '<b>Заказ отправлен</b>',
      '',
      `Номер: <b>${order.id}</b>`,
      `Предварительная оценка: <b>${escapeHtml(formatMoney(order.estimatedPrice))}</b>`,
      'Статус уже доступен в разделе <b>📦 Мои заказы</b>.'
    ].join('\n'),
    getMainKeyboard(isAdmin(ctx))
  );
}

function createBot() {
  ensureEnv();

  const bot = new Telegraf(BOT_TOKEN);
  bot.use(session());
  bot.use((ctx, next) => {
    if (!ctx.session) {
      ctx.session = {};
    }
    if (ctx.from) {
      trackUser(ctx.from);
    }
    return next();
  });

  bot.start(showWelcome);
  bot.hears('🏠 Главное меню', showWelcome);
  bot.hears('ℹ️ Как это работает', showHelp);
  bot.hears('✨ Новый заказ', startDraft);
  bot.hears('📦 Мои заказы', showOrdersForUser);
  bot.hears('👤 Профиль', showProfile);
  bot.hears('📊 Моя статистика', async (ctx) => {
    return sendHtml(ctx, buildUserStatsText(ctx.from.id), getMainKeyboard(isAdmin(ctx)));
  });
  bot.hears('❌ Сбросить', async (ctx) => {
    await clearFlowMessage(ctx);
    resetSession(ctx);
    return sendHtml(ctx, 'Текущее действие сброшено. Можно начать заново.', getMainKeyboard(isAdmin(ctx)));
  });
  bot.hears('🛠 Админ-панель', async (ctx) => {
    if (!isAdmin(ctx)) {
      return;
    }

    return showAdminPanel(ctx);
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (isAdmin(ctx) && ctx.session.adminAction?.type === 'set_price') {
      const price = parsePrice(text);

      if (!price) {
        return sendHtml(ctx, `Введите цену в диапазоне от <b>${MIN_PRICE_BYN}</b> до <b>${MAX_PRICE_BYN}</b> BYN, например <b>9.5</b>.`);
      }

      const order = updateOrder(ctx.session.adminAction.orderId, {
        stage: 'priced',
        finalPrice: price
      });

      if (!order) {
        resetSession(ctx);
        return sendHtml(ctx, 'Заказ уже недоступен.');
      }

      delete ctx.session.adminAction;

      await notifyUserAboutStage(
        bot,
        order,
        'Цена по заказу назначена',
        ['\nАдминистратор подтвердил заказ и назначил цену.']
      );

      return sendHtml(
        ctx,
        `Цена для <b>${order.id}</b> сохранена: <b>${escapeHtml(formatMoney(price))}</b>.`,
        getAdminOrderControls(order)
      );
    }

    if (ctx.session.flow === 'profile_edit') {
      const field = ctx.session.editField;
      if (field && ['name', 'phone', 'email', 'notes'].includes(field)) {
        return saveProfileField(ctx, field, text);
      }
    }

    if (ctx.session.flow === 'admin_search') {
      const results = searchOrders(text);
      resetSession(ctx);
      return sendHtml(ctx, buildSearchResultsText(results, text), getSearchKeyboard());
    }

    if (ctx.session.flow === 'admin_broadcast') {
      const filterStage = ctx.session.broadcastFilter || null;
      const result = await sendBroadcast(bot, text, filterStage);
      resetSession(ctx);
      return sendHtml(
        ctx,
        `<b>Рассылка отправлена</b>\n\nДоставлено: ${result.success}\nНе доставлено: ${result.failed}\nВсего получателей: ${result.total}`,
        buildAdminPanelKeyboard()
      );
    }

    if (ctx.session.flow !== 'create_order') {
      return;
    }

    if (ctx.session.step === 'task') {
      await deleteCurrentUserMessage(ctx);

      if (text.length < 10) {
        return showFlowMessage(ctx, 'Опиши задачу чуть подробнее, минимум 10 символов.');
      }

      ctx.session.draft.task = text;
      ctx.session.step = 'deadline';

      return askDeadline(ctx);
    }

    if (ctx.session.step === 'requirements') {
      await deleteCurrentUserMessage(ctx);

      if (text.length < 4) {
        return showFlowMessage(ctx, 'Добавь больше деталей, чтобы требования было полезно учесть.');
      }

      ctx.session.draft.requirements = text;
      ctx.session.step = 'level';

      return askLevel(ctx);
    }

    if (ctx.session.step === 'attachments') {
      await deleteCurrentUserMessage(ctx);

      return showFlowMessage(
        ctx,
        'Сейчас можно отправлять только фото или документы. Когда закончишь, нажми <b>🚀 Отправить заказ</b> под сообщением.',
        getAttachmentControls()
      );
    }
  });

  bot.on('document', async (ctx) => {
    if (ctx.session.flow !== 'create_order' || ctx.session.step !== 'attachments') {
      return;
    }

    ctx.session.draft.attachments.push({
      type: 'document',
      fileId: ctx.message.document.file_id,
      fileName: ctx.message.document.file_name || 'Документ'
    });

    await deleteCurrentUserMessage(ctx);

    return showFlowMessage(
      ctx,
      `Документ добавлен. Вложений в заказе: <b>${ctx.session.draft.attachments.length}</b>.`,
      getAttachmentControls()
    );
  });

  bot.on('photo', async (ctx) => {
    if (ctx.session.flow !== 'create_order' || ctx.session.step !== 'attachments') {
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];

    ctx.session.draft.attachments.push({
      type: 'photo',
      fileId: photo.file_id
    });

    await deleteCurrentUserMessage(ctx);

    return showFlowMessage(
      ctx,
      `Фото добавлено. Вложений в заказе: <b>${ctx.session.draft.attachments.length}</b>.`,
      getAttachmentControls()
    );
  });

  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    await ctx.answerCbQuery();

    if (data === 'draft:attachments') {
      if (ctx.session.flow !== 'create_order') {
        return sendHtml(ctx, 'Сначала начни новый заказ через <b>✨ Новый заказ</b>.');
      }

      ctx.session.step = 'attachments';

      return showFlowMessage(
        ctx,
        'Отправь документы или фото одним или несколькими сообщениями. Когда всё будет готово, нажми кнопку ниже.',
        getAttachmentControls()
      );
    }

    if (data === 'draft:summary') {
      if (ctx.session.flow !== 'create_order') {
        return sendHtml(ctx, 'Черновик уже сброшен.');
      }

      ctx.session.step = 'summary';
      return showDraftSummary(ctx);
    }

    if (data === 'draft:submit') {
      if (ctx.session.flow !== 'create_order' || !ctx.session.draft?.task || !ctx.session.draft?.deadline || !ctx.session.draft?.level) {
        return showFlowMessage(ctx, 'Черновик ещё не заполнен полностью.');
      }

      return submitDraft(bot, ctx);
    }

    if (data === 'draft:restart') {
      return startDraft(ctx);
    }

    if (data.startsWith('draft:deadline:')) {
      if (ctx.session.flow !== 'create_order') {
        return;
      }

      ctx.session.draft.deadline = data.split(':')[2];
      ctx.session.step = 'requirements_choice';

      return askRequirementsChoice(ctx);
    }

    if (data === 'draft:req:skip') {
      if (ctx.session.flow !== 'create_order') {
        return;
      }

      ctx.session.draft.requirements = 'Без дополнительных требований';
      ctx.session.step = 'level';

      return askLevel(ctx);
    }

    if (data === 'draft:req:text') {
      if (ctx.session.flow !== 'create_order') {
        return;
      }

      ctx.session.step = 'requirements';

      return showFlowMessage(ctx, 'Отправь требования одним сообщением. Я добавлю их в карточку заказа.');
    }

    if (data.startsWith('draft:level:')) {
      if (ctx.session.flow !== 'create_order') {
        return;
      }

      ctx.session.draft.level = data.split(':')[2];
      ctx.session.step = 'summary';

      return showDraftSummary(ctx);
    }

    if (data === 'profile:create') {
      const profile = getProfile(ctx.from.id);
      if (!profile) {
        const newProfile = saveProfile(ctx.from.id, createDefaultProfile(ctx.from));
      }
      return showProfile(ctx);
    }

    if (data === 'profile:view') {
      return showProfile(ctx);
    }

    if (data === 'profile:back') {
      resetSession(ctx);
      return showWelcome(ctx);
    }

    if (data.startsWith('profile:edit:')) {
      const field = data.split(':')[2];
      if (['name', 'phone', 'email', 'notes'].includes(field)) {
        return showProfileEdit(ctx, field);
      }
    }

    if (data.startsWith('profile:save:')) {
      return sendHtml(ctx, 'Введите новое значение в сообщении.');
    }

    if (data === 'admin:search') {
      if (!isAdmin(ctx)) return;
      ctx.session.flow = 'admin_search';
      return showFlowMessage(ctx, '<b>Поиск заказов</b>\n\nВведите ID заказа, имя клиента или статус для поиска.');
    }

    if (data === 'admin:broadcast') {
      if (!isAdmin(ctx)) return;
      return sendHtml(ctx, '<b>Рассылка</b>\n\nВыберите получателей или введите сообщение для всех пользователей.', getBroadcastKeyboard());
    }

    if (data.startsWith('search:')) {
      if (!isAdmin(ctx)) return;
      const stage = data.split(':')[1];
      const results = getOrdersArray().filter((o) => o.stage === stage);
      return sendHtml(ctx, buildSearchResultsText(results, `статус: ${getStageLabel(stage)}`), getSearchKeyboard());
    }

    if (data.startsWith('broadcast:')) {
      if (!isAdmin(ctx)) return;
      const filterStage = data.split(':')[1];
      if (filterStage === 'all') {
        ctx.session.flow = 'admin_broadcast';
        ctx.session.broadcastFilter = null;
      } else {
        ctx.session.flow = 'admin_broadcast';
        ctx.session.broadcastFilter = filterStage;
      }
      return showFlowMessage(ctx, '<b>Введите текст рассылки</b>\n\nСообщение будет отправлено выбранным пользователям.');
    }

    if (data === 'user:list') {
      return showOrdersForUser(ctx);
    }

    if (data.startsWith('user:details:')) {
      const order = state.orders[data.split(':')[2]];

      if (!order || order.clientId !== ctx.from.id) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      return showOrderDetailsToUser(ctx, order);
    }

    if (data.startsWith('user:cancel:')) {
      const orderId = data.split(':')[2];
      const order = state.orders[orderId];

      if (!order || order.clientId !== ctx.from.id) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      if (!['pending_review', 'priced', 'in_progress'].includes(order.stage)) {
        return sendHtml(ctx, 'Этот заказ уже нельзя отменить.');
      }

      const cancelledOrder = updateOrder(orderId, { stage: 'cancelled' });

      await bot.telegram.sendMessage(
        ADMIN_ID,
        `<b>Клиент отменил заказ ${cancelledOrder.id}</b>\n\n${buildOrderSummary(cancelledOrder, { includeClient: true })}`,
        { parse_mode: 'HTML' }
      );

      return sendHtml(ctx, 'Заказ отменён.', getMainKeyboard(isAdmin(ctx)));
    }

    if (data === 'admin:panel') {
      if (!isAdmin(ctx)) {
        return;
      }

      return showAdminPanel(ctx);
    }

    if (data === 'admin:attention') {
      if (!isAdmin(ctx)) {
        return;
      }

      return showAttentionOrders(ctx);
    }

    if (data === 'admin:reset') {
      if (!isAdmin(ctx)) {
        return;
      }

      return sendHtml(
        ctx,
        '<b>Сброс статистики</b>\n\nЭто удалит все заказы, обнулит статистику и вернёт нумерацию заказов к началу.',
        buildResetStatsKeyboard()
      );
    }

    if (data === 'admin:reset:confirm') {
      if (!isAdmin(ctx)) {
        return;
      }

      state.orders = {};
      state.seq = 1;
      persistState();
      resetSession(ctx);

      return sendHtml(ctx, 'Вся статистика и номера заказов сброшены.', buildAdminPanelKeyboard());
    }

    if (data.startsWith('admin:details:')) {
      if (!isAdmin(ctx)) {
        return;
      }

      const order = state.orders[data.split(':')[2]];

      if (!order) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      return showOrderDetailsToAdmin(ctx, order);
    }

    if (data.startsWith('admin:price:')) {
      if (!isAdmin(ctx)) {
        return;
      }

      const order = state.orders[data.split(':')[2]];

      if (!order) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      ctx.session.adminAction = {
        type: 'set_price',
        orderId: order.id
      };

      return sendHtml(
        ctx,
        `Введи цену для <b>${order.id}</b> одним сообщением в белорусских рублях от <b>${MIN_PRICE_BYN}</b> до <b>${MAX_PRICE_BYN}</b> BYN, например <b>${order.estimatedPrice}</b>.`
      );
    }

    if (data.startsWith('admin:reject:')) {
      if (!isAdmin(ctx)) {
        return;
      }

      const orderId = data.split(':')[2];
      const order = updateOrder(orderId, { stage: 'rejected' });

      if (!order) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      await notifyUserAboutStage(bot, order, 'Заказ отклонён');

      return sendHtml(ctx, `Заказ <b>${order.id}</b> отклонён.`);
    }

    if (data.startsWith('admin:start:')) {
      if (!isAdmin(ctx)) {
        return;
      }

      const orderId = data.split(':')[2];
      const order = updateOrder(orderId, { stage: 'in_progress' });

      if (!order) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      await notifyUserAboutStage(bot, order, 'Заказ взят в работу');

      return showOrderDetailsToAdmin(ctx, order);
    }

    if (data.startsWith('admin:done:')) {
      if (!isAdmin(ctx)) {
        return;
      }

      const orderId = data.split(':')[2];
      const order = updateOrder(orderId, { stage: 'done' });

      if (!order) {
        return sendHtml(ctx, 'Заказ не найден.');
      }

      await notifyUserAboutStage(bot, order, 'Заказ завершён');

      return showOrderDetailsToAdmin(ctx, order);
    }
  });

  bot.catch(async (error, ctx) => {
    console.error('Bot error:', error);

    if (ctx?.reply) {
      await sendHtml(ctx, 'Произошла ошибка. Попробуй повторить действие ещё раз.');
    }
  });

  return bot;
}

async function startBot() {
  const bot = createBot();
  await bot.launch();
  console.log('🚀 Бот работает в усиленном режиме');

  setInterval(async () => {
    const overdue = getOverdueOrders();
    if (overdue.length > 0) {
      const list = overdue.map((o) => `• ${o.id} — ${o.clientName}`).join('\n');
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `<b>⚠️ Просроченные заказы</b>\n\nЗаказы в работе более ${OVERDUE_HOURS} часов:\n\n${list}`,
        { parse_mode: 'HTML' }
      );
    }
  }, REMINDER_INTERVAL_MS);
}

if (require.main === module) {
  startBot().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEADLINES,
  LEVELS,
  STAGES,
  createOrderId,
  getEstimatedPrice,
  getStageLabel,
  parsePrice,
  createBot
};
