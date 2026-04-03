require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Telegraf, session, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const STATE_FILE = path.join(__dirname, 'bot-state.json');
const MIN_PRICE_BYN = 4;
const MAX_PRICE_BYN = 20;

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
    return { seq: 1, orders: {} };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      seq: Number.isInteger(raw.seq) && raw.seq > 0 ? raw.seq : 1,
      orders: raw.orders && typeof raw.orders === 'object' ? raw.orders : {}
    };
  } catch {
    return { seq: 1, orders: {} };
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
  const activeOrders = getActiveOrders().slice(0, 8);
  const rows = [
    [
      Markup.button.callback('📋 Актуальные заказы', 'admin:attention'),
      Markup.button.callback('🔄 Обновить панель', 'admin:panel')
    ],
    [Markup.button.callback('🧹 Сбросить статистику', 'admin:reset')]
  ];

  activeOrders.forEach((order) => {
    rows.push([Markup.button.callback(`${order.id} • ${getStageLabel(order.stage).replace(/^[^\s]+\s/, '')}`, `admin:details:${order.id}`)]);
  });

  return Markup.inlineKeyboard(rows);
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

function createDraft(user) {
  return {
    task: '',
    deadline: '',
    requirements: '',
    level: '',
    attachments: [],
    clientId: user.id,
    clientName: getUserName(user),
    clientUsername: getUserUsername(user)
  };
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
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, options);
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

async function startDraft(ctx) {
  await clearFlowMessage(ctx);
  ctx.session.flow = 'create_order';
  ctx.session.step = 'task';
  ctx.session.draft = createDraft(ctx.from);
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

    return next();
  });

  bot.start(showWelcome);
  bot.hears('🏠 Главное меню', showWelcome);
  bot.hears('ℹ️ Как это работает', showHelp);
  bot.hears('✨ Новый заказ', startDraft);
  bot.hears('📦 Мои заказы', showOrdersForUser);
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
