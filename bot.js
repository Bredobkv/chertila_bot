require('dotenv').config();

const { Telegraf, session, Markup } = require('telegraf');
const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MIN_PRICE_BYN = 4;
const MAX_PRICE_BYN = 20;
const MAX_ACTIVE_ORDERS_PER_USER = 3;
const MAX_ORDERS_PER_DAY = 4;
const PRICE_MULTIPLIER_OVER_LIMIT = 2;
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const OVERDUE_HOURS = 24;

const DEADLINES = {
  monday: { label: 'Понедельник', factor: 1 },
  tuesday: { label: 'Вторник', factor: 1 },
  wednesday: { label: 'Среда', factor: 1 },
  thursday: { label: 'Четверг', factor: 1 },
  friday: { label: 'Пятница', factor: 1 },
  saturday: { label: 'Суббота', factor: 1 },
  sunday: { label: 'Воскресенье', factor: 1 },
  custom: { label: 'Указать дату', factor: 1 }
};

const LEVELS = {
  basic: { label: 'Стандарт', factor: 1, description: 'быстро и по делу' },
  strong: { label: 'Усиленный', factor: 1.2, description: 'глубже и точнее' },
  premium: { label: 'Максимум', factor: 1.45, description: 'максимальная проработка' }
};

const STAGES = {
  pending_review: '🕓 На рассмотрении',
  awaiting_confirmation: '⏳ Ожидает подтверждения',
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

function getUserName(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return `ID ${user.id}`;
}

function getUserUsername(user) {
  return user.username ? `@${user.username}` : '';
}

function getStageLabel(stage) {
  return STAGES[stage] || stage;
}

function getDeadlineLabel(deadline) {
  if (DEADLINES[deadline]) return DEADLINES[deadline].label;
  if (deadline.includes('.')) {
    const parts = deadline.split('.');
    if (parts.length === 3) {
      const date = new Date(parts[2], parts[1] - 1, parts[0]);
      return new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
    }
  }
  return deadline;
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
  if (hasRequirements) price += 1.5;
  if (attachmentsCount > 0) price += Math.min(attachmentsCount * 0.75, 2);
  
  const deadlineFactor = draft.deadlineDate ? draft.priceMultiplier || 1 : (DEADLINES[draft.deadline]?.factor || 1);
  price = price * deadlineFactor;
  price = price * (LEVELS[draft.level]?.factor || 1);
  price = Math.round(price * 2) / 2;

  return Math.min(MAX_PRICE_BYN, Math.max(MIN_PRICE_BYN, price));
}

function isAdmin(ctx) {
  console.log('isAdmin check:', ctx.from?.id, 'ADMIN_ID:', ADMIN_ID);
  return ctx.from?.id === ADMIN_ID;
}

function getMainKeyboard(adminMode) {
  const rows = [
    ['✨ Новый заказ', '📦 Мои заказы'],
    ['📊 Моя статистика', '👤 Профиль'],
    ['🎫 Промокод', 'ℹ️ Как это работает'],
    ['❌ Сбросить']
  ];
  if (adminMode) rows.unshift(['🛠 Админ-панель']);
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

  if (order.stage === 'awaiting_confirmation') {
    rows.push([Markup.button.callback('🔔 Напомнить', `admin:remind:${order.id}`)]);
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

  if (order.stage === 'awaiting_confirmation') {
    rows.unshift([
      Markup.button.callback('✅ Подтвердить', `user:confirm:${order.id}`),
      Markup.button.callback('❌ Отменить', `user:cancel:${order.id}`)
    ]);
  }

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

function buildOrderSummary(order, options = {}) {
  const lines = [];
  lines.push(`<b>${options.title || `Заказ ${order.id}`}</b>`);
  lines.push('');
  lines.push(`<b>Статус:</b> ${escapeHtml(getStageLabel(order.stage))}`);
  lines.push(`<b>Задача:</b> ${escapeHtml(order.task)}`);
  lines.push(`<b>Срок:</b> ${escapeHtml(getDeadlineLabel(order.deadline))}`);
  lines.push(`<b>Пакет:</b> ${escapeHtml(getLevelLabel(order.level))}`);
  lines.push(`<b>Требования:</b> ${escapeHtml(order.requirements || 'Без дополнительных требований')}`);
  lines.push(`<b>Вложения:</b> ${order.attachments?.length || 0}`);
  lines.push(`<b>Создан:</b> ${escapeHtml(formatDate(order.created_at || order.createdAt))}`);

  if (order.estimated_price || order.estimatedPrice) {
    lines.push(`<b>Предварительная оценка:</b> ${escapeHtml(formatMoney(order.estimated_price || order.estimatedPrice))}`);
  }

  if (order.final_price || order.finalPrice) {
    let priceText = formatMoney(order.final_price || order.finalPrice);
    if (order.price_multiplier === 2) priceText += ' (x2)';
    if (options.applyDiscount) priceText += ' (-15%)';
    lines.push(`<b>Финальная цена:</b> ${escapeHtml(priceText)}`);
  }

  if (options.includeClient) {
    const clientName = order.client_name || order.clientName || getUserName({ id: order.client_id, first_name: order.first_name, last_name: order.last_name, username: order.username });
    const clientUsername = order.client_username || order.clientUsername || '';
    lines.push(`<b>Клиент:</b> ${escapeHtml(clientName)} ${escapeHtml(clientUsername)} (${order.client_id})`);
  }

  if (order.profile_name || order.profile_phone) {
    const profileInfo = [];
    if (order.profile_name) profileInfo.push(escapeHtml(order.profile_name));
    if (order.profile_phone) profileInfo.push(escapeHtml(order.profile_phone));
    lines.push(`<b>Контакт:</b> ${profileInfo.join(' • ')}`);
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
      const price = order.final_price || order.estimated_price;
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
  const stats = db.getStats();

  return [
    '<b>Панель управления</b>',
    '',
    `Всего заказов: <b>${stats.total}</b>`,
    `Активных: <b>${stats.active}</b>`,
    `Новых: <b>${stats.pending}</b>`,
    `Ожидают подтверждения: <b>${stats.awaitingConfirmation}</b>`,
    `С ценой: <b>${stats.priced}</b>`,
    `В работе: <b>${stats.inProgress}</b>`,
    `Готовых: <b>${stats.done}</b>`,
    `Отклонённых: <b>${stats.rejected}</b>`,
    `Отменённых: <b>${stats.cancelled}</b>`,
    `Выручка: <b>${escapeHtml(formatMoney(stats.revenue))}</b>`
  ].join('\n');
}

function buildAdminPanelKeyboard() {
  const activeOrders = db.getActiveOrders().slice(0, 6);
  const rows = [
    [
      Markup.button.callback('📋 Заказы', 'admin:attention'),
      Markup.button.callback('🔍 Поиск', 'admin:search')
    ],
    [
      Markup.button.callback('📢 Рассылка', 'admin:broadcast'),
      Markup.button.callback('💾 БД', 'admin:database')
    ],
    [
      Markup.button.callback('📨 Написать клиенту', 'admin:send_to_client'),
      Markup.button.callback('🔄 Обновить', 'admin:panel')
    ],
    [Markup.button.callback('🧹 Сброс статистику', 'admin:reset')]
  ];

  activeOrders.forEach((order) => {
    rows.push([Markup.button.callback(`${order.id} • ${getStageLabel(order.stage).replace(/^[^\s]+\s/, '')}`, `admin:details:${order.id}`)]);
  });

  return Markup.inlineKeyboard(rows);
}

function buildAttentionOrdersText() {
  const orders = db.getAttentionOrders();

  if (!orders.length) {
    return '<b>Список актуальных заказов</b>\n\nСейчас нет незавершённых или невыданных заказов.';
  }

  return [
    '<b>Список актуальных заказов</b>',
    '',
    ...orders.map((order) => {
      const price = order.final_price || order.estimated_price;
      return `• <b>${order.id}</b> — ${escapeHtml(getStageLabel(order.stage))} — ${escapeHtml(formatDate(order.created_at))}`;
    })
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

function getBroadcastKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📢 Всем пользователям', 'broadcast:all')],
    [Markup.button.callback('🕓 На рассмотрении', 'broadcast:pending_review')],
    [Markup.button.callback('⏳ Ожидают подтверждения', 'broadcast:awaiting_confirmation')],
    [Markup.button.callback('💵 С ценой', 'broadcast:priced')],
    [Markup.button.callback('🚧 В работе', 'broadcast:in_progress')],
    [Markup.button.callback('✅ Завершённые', 'broadcast:done')],
    [Markup.button.callback('↩️ Назад', 'admin:panel')]
  ]);
}

function getSearchKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🕓 На рассмотрении', 'search:pending_review')],
    [Markup.button.callback('⏳ Ожидают подтверждения', 'search:awaiting_confirmation')],
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
      const price = order.final_price || order.estimated_price;
      return `• <b>${order.id}</b> — ${escapeHtml(getStageLabel(order.stage))} — ${escapeHtml(formatMoney(price))}`;
    }),
    results.length > 10 ? `\nПоказано 10 из ${results.length} результатов.` : ''
  ].join('\n');
}

function getDatabaseKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика БД', 'db:stats')],
    [Markup.button.callback('📥 Экспорт JSON', 'db:export')],
    [Markup.button.callback('📤 Импорт', 'db:import')],
    [Markup.button.callback('🗑 Очистить заказы', 'db:clear:orders')],
    [Markup.button.callback('🗑 Очистить всё', 'db:clear:all')],
    [Markup.button.callback('🔧 Оптимизировать', 'db:optimize')],
    [Markup.button.callback('📜 Логи', 'db:logs')],
    [Markup.button.callback('↩️ Назад', 'admin:panel')]
  ]);
}

function buildDbStatsText() {
  const stats = db.getDbStats();
  return [
    '<b>Статистика базы данных</b>',
    '',
    `Размер: <b>${stats.sizeFormatted}</b>`,
    `Пользователей: <b>${stats.users}</b>`,
    `Профилей: <b>${stats.profiles}</b>`,
    `Заказов: <b>${stats.orders}</b>`,
    `Вложений: <b>${stats.attachments}</b>`,
    `Записей в логах: <b>${stats.logs}</b>`
  ].join('\n');
}

function getDbConfirmKeyboard(action) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⚠️ Да, подтверждаю', `db:confirm:${action}`)],
    [Markup.button.callback('↩️ Отмена', 'db:stats')]
  ]);
}

function createDraft(user, profile = null) {
  return {
    task: '',
    deadline: '',
    deadlineDate: '',
    priceMultiplier: 1,
    requirements: '',
    level: '',
    attachments: [],
    clientId: user.id,
    clientName: profile?.name || getUserName(user),
    clientUsername: getUserUsername(user)
  };
}

function resetSession(ctx) {
  ctx.session = {};
}

async function sendHtml(ctx, text, extra = {}) {
  return ctx.reply(text, { parse_mode: 'HTML', ...extra });
}

async function deleteMessageSafe(ctx, messageId) {
  if (!ctx.chat?.id || !messageId) return;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch {}
}

async function clearFlowMessage(ctx) {
  const messageId = ctx.session?.flowMessageId;
  if (!messageId) return;
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
  console.log('showWelcome called, user id:', ctx.from.id, 'ADMIN_ID:', ADMIN_ID);
  await clearFlowMessage(ctx);
  resetSession(ctx);
  db.createUser(ctx.from);
  
  const adminMode = isAdmin(ctx);
  console.log('adminMode:', adminMode);
  const text = adminMode
    ? '<b>Добро пожаловать в продвинутую админ-панель</b>\n\nУправляй заказами, ценами, статусами и смотри сводку в одном месте.'
    : '<b>Привет!</b>\n\nЯ собираю заказ в удобную карточку, считаю предварительную цену, принимаю файлы и показываю статус без лишних сообщений.';

  return sendHtml(ctx, text, getMainKeyboard(adminMode));
}

async function showHelp(ctx) {
  return sendHtml(ctx, [
    '<b>Как это работает</b>',
    '',
    '1. Нажми <b>✨ Новый заказ</b> и кратко опиши задачу.',
    '2. Выбери срок и уровень проработки.',
    '3. При необходимости добавь требования и файлы.',
    '4. Получи оценку, затем подтверди цену.',
    '5. Отслеживай статус в разделе <b>📦 Мои заказы</b>.'
  ].join('\n'));
}

async function showProfile(ctx) {
  const profile = db.getProfile(ctx.from.id);
  const text = profile ? buildProfileText(profile) : '<b>Профиль</b>\n\nДля оформления заказов необходимо заполнить имя и телефон.';
  const extra = profile ? getProfileKeyboard() : Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Заполнить профиль', 'profile:create')]
  ]);
  return sendHtml(ctx, text, extra);
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

async function showProfileEdit(ctx, field) {
  const profile = db.getProfile(ctx.from.id);
  const fieldLabels = { name: 'имя', phone: 'телефон', email: 'email', notes: 'заметки' };
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
  db.saveProfile(userId, { [field]: value });
  
  ctx.session.flow = null;
  delete ctx.session.editField;

  const updatedProfile = db.getProfile(userId);
  return showFlowMessage(ctx, 'Профиль сохранён.', getProfileKeyboard());
}

async function startDraft(ctx) {
  const profile = db.getProfile(ctx.from.id);
  const isRegistered = profile && profile.name && profile.name.trim().length >= 2 && profile.phone && profile.phone.trim().length >= 3;
  
  if (!isRegistered) {
    let message = '<b>Регистрация</b>\n\nДля создания заказа необходимо заполнить профиль. Нажмите <b>👤 Профиль</b>.';
    
    if (profile && profile.name && profile.name.trim().length >= 2 && (!profile.phone || !profile.phone.trim())) {
      message = '<b>Регистрация</b>\n\nНеобходимо указать номер телефона. Нажмите <b>👤 Профиль</b> → <b>📱 Телефон</b>.';
    } else if (!profile || !profile.name || profile.name.trim().length < 2) {
      message = '<b>Регистрация</b>\n\nНеобходимо указать имя. Нажмите <b>👤 Профиль</b> → <b>✏️ Изменить имя</b>.';
    }
    
    return sendHtml(ctx, message, getMainKeyboard(isAdmin(ctx)));
  }

  const activeOrders = db.getActiveOrdersByUser(ctx.from.id);
  if (activeOrders.length >= MAX_ACTIVE_ORDERS_PER_USER) {
    return sendHtml(ctx, `<b>Лимит заказов</b>\n\nУ вас уже ${activeOrders.length} активных заказов. Дождитесь завершения текущих заказов.`, getMainKeyboard(isAdmin(ctx)));
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

function askDeadline(ctx) {
  return showFlowMessage(
    ctx,
    '<b>Выберите день</b>\n\nКогда нужно выполнить заказ?',
    Markup.inlineKeyboard([
      [Markup.button.callback('Понедельник', 'draft:deadline:monday'), Markup.button.callback('Вторник', 'draft:deadline:tuesday'), Markup.button.callback('Среда', 'draft:deadline:wednesday')],
      [Markup.button.callback('Четверг', 'draft:deadline:thursday'), Markup.button.callback('Пятница', 'draft:deadline:friday')],
      [Markup.button.callback('Суббота', 'draft:deadline:saturday'), Markup.button.callback('Воскресенье', 'draft:deadline:sunday')],
      [Markup.button.callback('📅 Указать дату', 'draft:deadline:custom')]
    ])
  );
}

function askCustomDate(ctx) {
  ctx.session.step = 'custom_date';
  return showFlowMessage(
    ctx,
    '<b>Укажите дату</b>\n\nВведите дату в формате ДД.ММ.ГГГГ, например: <code>15.04.2025</code>'
  );
}

function askRequirementsChoice(ctx) {
  return showFlowMessage(
    ctx,
    '<b>Есть дополнительные требования?</b>\n\nМожно приложить структуру, критерии, пример оформления или любые детали.',
    Markup.inlineKeyboard([
      [Markup.button.callback('Да, отправлю текст', 'draft:req:text')],
      [Markup.button.callback('Нет, пропустить', 'draft:req:skip')]
    ])
  );
}

function askLevel(ctx) {
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

function showDraftSummary(ctx) {
  const draft = ctx.session.draft;
  const price = getEstimatedPrice(draft);
  
  let priceWarning = '';
  if (draft.priceMultiplier === PRICE_MULTIPLIER_OVER_LIMIT) {
    priceWarning = '\n⚠️ <b>Внимание:</b> Из-за высокой нагрузки цена умножена на x2!';
  }
  
  const summary = [
    '<b>Карточка заказа</b>',
    '',
    `<b>Задача:</b> ${escapeHtml(draft.task)}`,
    `<b>Срок:</b> ${escapeHtml(draft.deadlineDate || getDeadlineLabel(draft.deadline))}`,
    `<b>Пакет:</b> ${escapeHtml(getLevelLabel(draft.level))}`,
    `<b>Требования:</b> ${escapeHtml(draft.requirements || 'Без дополнительных требований')}`,
    `<b>Вложения:</b> ${draft.attachments.length}`,
    `<b>Оценка:</b> ${escapeHtml(formatMoney(price))}${priceWarning}`
  ].join('\n');

  return showFlowMessage(ctx, summary, getDraftSummaryKeyboard());
}

async function showOrdersForUser(ctx) {
  const orders = db.getOrdersByUser(ctx.from.id);
  const text = buildUserOrdersText(orders);
  const extra = orders.length ? buildUserOrdersKeyboard(orders) : {};

  return sendHtml(ctx, text, extra);
}

async function showOrderDetailsToUser(ctx, order) {
  const fullOrder = db.getOrderWithAttachments(order.id);
  return sendHtml(ctx, buildOrderSummary(fullOrder), getUserOrderControls(fullOrder));
}

async function showAdminPanel(ctx) {
  return sendHtml(ctx, buildAdminPanelText(), buildAdminPanelKeyboard());
}

async function showAttentionOrders(ctx) {
  const orders = db.getAttentionOrders();
  const extra = orders.length ? buildAttentionOrdersKeyboard(orders) : buildAdminPanelKeyboard();

  return sendHtml(ctx, buildAttentionOrdersText(), extra);
}

async function showOrderDetailsToAdmin(ctx, order) {
  const fullOrder = db.getOrderWithAttachments(order.id);
  return sendHtml(
    ctx,
    buildOrderSummary(fullOrder, { includeClient: true, title: `Заказ ${order.id}` }),
    getAdminOrderControls(fullOrder)
  );
}

async function notifyAdminAboutOrder(bot, order) {
  const fullOrder = db.getOrderWithAttachments(order.id);
  
  await bot.telegram.sendMessage(
    ADMIN_ID,
    buildOrderSummary(fullOrder, { includeClient: true, title: `Новый заказ ${fullOrder.id}` }),
    { parse_mode: 'HTML', ...getAdminOrderControls(fullOrder) }
  );

  for (const attachment of fullOrder.attachments || []) {
    if (attachment.type === 'photo') {
      await bot.telegram.sendPhoto(ADMIN_ID, attachment.file_id, { caption: `Вложение к ${order.id}` });
    }
    if (attachment.type === 'document') {
      await bot.telegram.sendDocument(ADMIN_ID, attachment.file_id, { caption: `Вложение к ${order.id}` });
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

  await bot.telegram.sendMessage(order.client_id, lines.join('\n'), {
    parse_mode: 'HTML',
    ...getUserOrderControls(order)
  });
}

async function submitDraft(bot, ctx) {
  const draft = ctx.session.draft;
  const order = db.createOrder({
    ...draft,
    estimatedPrice: getEstimatedPrice(draft)
  });
  
  await clearFlowMessage(ctx);
  resetSession(ctx);

  await notifyAdminAboutOrder(bot, order);

  return sendHtml(
    ctx,
    [
      '<b>Заказ отправлен</b>',
      '',
      `Номер: <b>${order.id}</b>`,
      `Предварительная оценка: <b>${escapeHtml(formatMoney(order.estimated_price))}</b>`,
      'Статус уже доступен в разделе <b>📦 Мои заказы</b>.'
    ].join('\n'),
    getMainKeyboard(isAdmin(ctx))
  );
}

function getUserStatsText(userId) {
  const stats = db.getUserStats(userId);
  return [
    '<b>Твоя статистика</b>',
    '',
    `Всего заказов: <b>${stats.totalOrders}</b>`,
    `Активных: <b>${stats.activeOrders}</b>`,
    `Завершено: <b>${stats.completedOrders}</b>`,
    `Потрачено: <b>${escapeHtml(formatMoney(stats.totalSpent))}</b>`
  ].join('\n');
}

function createBot() {
  ensureEnv();
  db.initDatabase();
  db.startBackupScheduler();

  const bot = new Telegraf(BOT_TOKEN);
  bot.use(session());
  bot.use((ctx, next) => {
    if (!ctx.session) ctx.session = {};
    if (ctx.from) db.createUser(ctx.from);
    return next();
  });

  bot.start(showWelcome);
  bot.hears('🏠 Главное меню', showWelcome);
  bot.hears('ℹ️ Как это работает', showHelp);
  bot.hears('✨ Новый заказ', startDraft);
  bot.hears('📦 Мои заказы', showOrdersForUser);
  bot.hears('👤 Профиль', showProfile);
  bot.hears('📊 Моя статистика', async (ctx) => {
    return sendHtml(ctx, getUserStatsText(ctx.from.id), getMainKeyboard(isAdmin(ctx)));
  });
  bot.hears('❌ Сбросить', async (ctx) => {
    await clearFlowMessage(ctx);
    resetSession(ctx);
    return sendHtml(ctx, 'Текущее действие сброшено. Можно начать заново.', getMainKeyboard(isAdmin(ctx)));
  });
  bot.hears('🛠 Админ-панель', async (ctx) => {
    if (!isAdmin(ctx)) return;
    return showAdminPanel(ctx);
  });
  bot.hears('🎫 Промокод', async (ctx) => {
    ctx.session.awaitingPromo = true;
    return sendHtml(ctx, '<b>🎫 Введите промокод</b>\n\nВведите промокод для активации скидки 15% на 2 дня.', 
      Markup.inlineKeyboard([[Markup.button.callback('↩️ Отмена', 'cancel:promo')]]));
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (isAdmin(ctx) && ctx.session.adminAction?.type === 'set_price') {
      const price = parsePrice(text);
      if (!price) {
        return sendHtml(ctx, `Введите цену в диапазоне от <b>${MIN_PRICE_BYN}</b> до <b>${MAX_PRICE_BYN}</b> BYN, например <b>9.5</b>.`);
      }

      const order = db.setOrderPrice(ctx.session.adminAction.orderId, price);
      if (!order) {
        resetSession(ctx);
        return sendHtml(ctx, 'Заказ уже недоступен.');
      }

      delete ctx.session.adminAction;

      await notifyUserAboutStage(
        bot,
        order,
        'Новая цена назначена',
        ['\nПожалуйста, подтвердите заказ или отмените его.']
      );

      return sendHtml(ctx, `Цена для <b>${order.id}</b> сохранена: <b>${escapeHtml(formatMoney(price))}</b>.`, getAdminOrderControls(order));
    }

    if (ctx.session.flow === 'profile_edit') {
      const field = ctx.session.editField;
      if (field && ['name', 'phone', 'email', 'notes'].includes(field)) {
        return saveProfileField(ctx, field, text);
      }
    }

    if (ctx.session.awaitingPromo) {
      delete ctx.session.awaitingPromo;
      const result = db.validatePromocode(text);
      
      if (!result.valid) {
        return sendHtml(ctx, `<b>❌ Ошибка:</b> ${result.error}`, getMainKeyboard(isAdmin(ctx)));
      }
      
      db.applyPromoDiscount(ctx.from.id);
      
      return sendHtml(ctx, 
        `<b>✅ Промокод активирован!</b>\n\nСкидка <b>15%</b> действует 2 дня. Все заказы в этот период будут со скидкой.`,
        getMainKeyboard(isAdmin(ctx))
      );
    }

    if (ctx.session.flow === 'admin_search') {
      const results = db.searchOrders(text);
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

    if (ctx.session.flow === 'admin_send_message') {
      const orderId = text.trim();
      const order = db.getOrder(orderId);
      if (!order) {
        return sendHtml(ctx, 'Заказ не найден. Введите корректный ID заказа.', Markup.inlineKeyboard([[Markup.button.callback('↩️ Отмена', 'admin:panel')]]));
      }
      ctx.session.targetOrderId = orderId;
      ctx.session.flow = 'admin_send_message_text';
      return sendHtml(ctx, `<b>📨 Сощение для заказа ${orderId}</b>\n\nКлиент: ${escapeHtml(order.task)}\n\nВведите текст сообщения:`, Markup.inlineKeyboard([[Markup.button.callback('↩️ Отмена', 'admin:panel')]]));
    }

    if (ctx.session.flow === 'admin_send_message_text') {
      const orderId = ctx.session.targetOrderId;
      const order = db.getOrder(orderId);
      if (!order) {
        resetSession(ctx);
        return sendHtml(ctx, 'Заказ не найден.', buildAdminPanelKeyboard());
      }
      
      await bot.telegram.sendMessage(
        order.client_id,
        `<b>📨 Сообщение от администратора:</b>\n\n${escapeHtml(text)}`,
        { parse_mode: 'HTML', ...getMainKeyboard(false) }
      );
      
      resetSession(ctx);
      return sendHtml(ctx, `<b>✅ Сообщение отправлено клиенту заказа ${orderId}</b>`, buildAdminPanelKeyboard());
    }

    if (ctx.session.step === 'custom_date') {
      const datePattern = /^(\d{2})\.(\d{2})\.(\d{4})$/;
      const match = text.match(datePattern);
      
      if (!match) {
        return showFlowMessage(ctx, 'Неверный формат. Введите дату в формате ДД.ММ.ГГГГ, например: <code>15.04.2025</code>');
      }
      
      const day = parseInt(match[1]);
      const month = parseInt(match[2]);
      const year = parseInt(match[3]);
      
      if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2024) {
        return showFlowMessage(ctx, 'Неверная дата. Введите корректную дату в формате ДД.ММ.ГГГГ');
      }
      
      ctx.session.draft.deadline = 'custom';
      ctx.session.draft.deadlineDate = text;
      ctx.session.step = 'requirements_choice';

      const ordersToday = db.getOrdersCountByDeadline(text);
      if (ordersToday >= MAX_ORDERS_PER_DAY) {
        ctx.session.draft.priceMultiplier = PRICE_MULTIPLIER_OVER_LIMIT;
        await showFlowMessage(ctx, `⚠️ <b>Внимание!</b>\n\nНа ${text} уже запланировано ${ordersToday} заказов. При оформлении цена будет умножена на x2!`, Markup.inlineKeyboard([
          [Markup.button.callback('✅ Продолжить', 'draft:req:skip')],
          [Markup.button.callback('↩️ Выбрать другую дату', 'draft:deadline:back')]
        ]));
        return;
      }

      return askRequirementsChoice(ctx);
    }

    if (ctx.session.flow !== 'create_order') return;

    if (ctx.session.step === 'task') {
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

      if (text.length < 10) {
        return showFlowMessage(ctx, 'Опиши задачу чуть подробнее, минимум 10 символов.');
      }

      ctx.session.draft.task = text;
      ctx.session.step = 'deadline';

      return askDeadline(ctx);
    }

    if (ctx.session.step === 'requirements') {
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

      if (text.length < 4) {
        return showFlowMessage(ctx, 'Добавь больше деталей, чтобы требования было полезно учесть.');
      }

      ctx.session.draft.requirements = text;
      ctx.session.step = 'level';

      return askLevel(ctx);
    }

    if (ctx.session.step === 'attachments') {
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      return showFlowMessage(
        ctx,
        'Сейчас можно отправлять только фото или документы. Когда закончишь, нажми <b>🚀 Отправить заказ</b> под сообщением.',
        getAttachmentControls()
      );
    }
  });

  bot.on('document', async (ctx) => {
    if (ctx.session.flow !== 'create_order' || ctx.session.step !== 'attachments') return;

    ctx.session.draft.attachments.push({
      type: 'document',
      fileId: ctx.message.document.file_id,
      fileName: ctx.message.document.file_name || 'Документ'
    });

    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    return showFlowMessage(
      ctx,
      `Документ добавлен. Вложений в заказе: <b>${ctx.session.draft.attachments.length}</b>.`,
      getAttachmentControls()
    );
  });

  bot.on('photo', async (ctx) => {
    if (ctx.session.flow !== 'create_order' || ctx.session.step !== 'attachments') return;

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    ctx.session.draft.attachments.push({
      type: 'photo',
      fileId: photo.file_id
    });

    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    return showFlowMessage(
      ctx,
      `Фото добавлено. Вложений в заказе: <b>${ctx.session.draft.attachments.length}</b>.`,
      getAttachmentControls()
    );
  });

  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    await ctx.answerCbQuery();

    if (data === 'cancel:promo') {
      delete ctx.session.awaitingPromo;
      return sendHtml(ctx, 'Ввод промокода отменён.', getMainKeyboard(isAdmin(ctx)));
    }

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
      if (ctx.session.flow !== 'create_order') return sendHtml(ctx, 'Черновик уже сброшен.');
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

    if (data === 'draft:deadline:back') {
      ctx.session.step = 'deadline';
      return askDeadline(ctx);
    }

    if (data.startsWith('draft:deadline:')) {
      if (ctx.session.flow !== 'create_order') return;
      
      const deadline = data.split(':')[2];
      
      if (deadline === 'custom') {
        return askCustomDate(ctx);
      }
      
      ctx.session.draft.deadline = deadline;
      ctx.session.draft.deadlineDate = '';
      ctx.session.draft.priceMultiplier = 1;
      ctx.session.step = 'requirements_choice';

      return askRequirementsChoice(ctx);
    }

    if (data === 'draft:req:skip') {
      if (ctx.session.flow !== 'create_order') return;
      ctx.session.draft.requirements = 'Без дополнительных требований';
      ctx.session.step = 'level';
      return askLevel(ctx);
    }

    if (data === 'draft:req:text') {
      if (ctx.session.flow !== 'create_order') return;
      ctx.session.step = 'requirements';
      return showFlowMessage(ctx, 'Отправь требования одним сообщением. Я добавлю их в карточку заказа.');
    }

    if (data.startsWith('draft:level:')) {
      if (ctx.session.flow !== 'create_order') return;
      ctx.session.draft.level = data.split(':')[2];
      ctx.session.step = 'summary';
      return showDraftSummary(ctx);
    }

    if (data === 'profile:create') {
      const profile = db.getProfile(ctx.from.id);
      if (!profile) {
        db.saveProfile(ctx.from.id, {
          name: getUserName(ctx.from),
          phone: '',
          email: '',
          notes: ''
        });
      }
      return showProfile(ctx);
    }

    if (data === 'profile:view' || data === 'profile:back') {
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

    if (data === 'user:list') {
      return showOrdersForUser(ctx);
    }

    if (data.startsWith('user:details:')) {
      const order = db.getOrder(data.split(':')[2]);
      if (!order || order.client_id !== ctx.from.id) {
        return sendHtml(ctx, 'Заказ не найден.');
      }
      return showOrderDetailsToUser(ctx, order);
    }

    if (data.startsWith('user:confirm:')) {
      const orderId = data.split(':')[2];
      const order = db.getOrder(orderId);
      if (!order || order.client_id !== ctx.from.id) {
        return sendHtml(ctx, 'Заказ не найден.');
      }
      if (order.stage !== 'awaiting_confirmation') {
        return sendHtml(ctx, 'Этот заказ не ожидает подтверждения.');
      }
      
      const confirmedOrder = db.confirmOrder(orderId, ctx.from.id);
      await notifyAdminAboutOrder(bot, confirmedOrder);
      
      return sendHtml(ctx, 'Заказ подтверждён! Ожидайте начала работы.', getMainKeyboard(isAdmin(ctx)));
    }

    if (data.startsWith('user:cancel:')) {
      const orderId = data.split(':')[2];
      const order = db.getOrder(orderId);
      if (!order || order.client_id !== ctx.from.id) {
        return sendHtml(ctx, 'Заказ не найден.');
      }
      if (!['pending_review', 'awaiting_confirmation', 'priced', 'in_progress'].includes(order.stage)) {
        return sendHtml(ctx, 'Этот заказ уже нельзя отменить.');
      }

      const cancelledOrder = db.updateOrder(orderId, { stage: 'cancelled' });
      db.addLog('order_cancelled', 'order', orderId, null, ctx.from.id, 'Cancelled by user');

      await bot.telegram.sendMessage(
        ADMIN_ID,
        `<b>Клиент отменил заказ ${cancelledOrder.id}</b>\n\n${buildOrderSummary(cancelledOrder, { includeClient: true })}`,
        { parse_mode: 'HTML' }
      );

      return sendHtml(ctx, 'Заказ отменён.', getMainKeyboard(isAdmin(ctx)));
    }

    if (data === 'admin:panel') {
      if (!isAdmin(ctx)) return;
      return showAdminPanel(ctx);
    }

    if (data === 'admin:send_to_client') {
      if (!isAdmin(ctx)) return;
      ctx.session.flow = 'admin_send_message';
      return sendHtml(ctx, '<b>📨 Отправить сообщение клиенту</b>\n\nВведите ID заказа, которому нужно отправить сообщение:', Markup.inlineKeyboard([[Markup.button.callback('↩️ Отмена', 'admin:panel')]]));
    }

    if (data === 'admin:attention') {
      if (!isAdmin(ctx)) return;
      const orders = db.getAttentionOrders();
      return sendHtml(ctx, buildAttentionOrdersText(), buildAttentionOrdersKeyboard(orders));
    }

    if (data === 'admin:reset') {
      if (!isAdmin(ctx)) return;
      return sendHtml(ctx, '<b>Сброс статистики</b>\n\nЭто удалит все заказы и обнулит статистику.', buildResetStatsKeyboard());
    }

    if (data === 'admin:reset:confirm') {
      if (!isAdmin(ctx)) return;
      db.clearOrders();
      resetSession(ctx);
      return sendHtml(ctx, 'Вся статистика и номера заказов сброшены.', buildAdminPanelKeyboard());
    }

    if (data === 'admin:database') {
      if (!isAdmin(ctx)) return;
      return sendHtml(ctx, '<b>Управление базой данных</b>', getDatabaseKeyboard());
    }

    if (data === 'db:stats') {
      if (!isAdmin(ctx)) return;
      return sendHtml(ctx, buildDbStatsText(), getDatabaseKeyboard());
    }

    if (data === 'db:export') {
      if (!isAdmin(ctx)) return;
      const backupPath = db.createBackup();
      const jsonData = db.exportToJson();
      const fs = require('fs');
      const exportFile = require('path').join(__dirname, `export-${Date.now()}.json`);
      fs.writeFileSync(exportFile, JSON.stringify(jsonData, null, 2));
      await ctx.replyWithDocument({ source: exportFile }, { caption: '<b>Экспорт базы данных</b>', parse_mode: 'HTML' });
      fs.unlinkSync(exportFile);
      return;
    }

    if (data.startsWith('db:clear:')) {
      if (!isAdmin(ctx)) return;
      const target = data.split(':')[2];
      const messages = {
        orders: '<b>Очистка заказов</b>\n\nЭто удалит все заказы и вложения. Пользователи и профили сохранятся.',
        all: '<b>Очистка всей базы</b>\n\nЭто удалит ВСЕ данные: пользователей, профили, заказы и логи.'
      };
      return sendHtml(ctx, messages[target] || 'Неизвестное действие', getDbConfirmKeyboard(data.split(':')[2]));
    }

    if (data.startsWith('db:confirm:')) {
      if (!isAdmin(ctx)) return;
      const action = data.split(':')[2];
      if (action === 'orders') db.clearOrders();
      if (action === 'all') db.clearAll();
      return sendHtml(ctx, '<b>Готово!</b> Операция выполнена.', getDatabaseKeyboard());
    }

    if (data === 'db:optimize') {
      if (!isAdmin(ctx)) return;
      db.optimizeDb();
      return sendHtml(ctx, '<b>База данных оптимизирована!</b>', getDatabaseKeyboard());
    }

    if (data === 'db:logs') {
      if (!isAdmin(ctx)) return;
      const logs = db.getLogs(20);
      const lines = ['<b>Последние действия</b>', ''];
      logs.forEach(log => {
        lines.push(`• <code>${formatDate(log.created_at)}</code> — ${escapeHtml(log.action)} (${escapeHtml(log.target_type || '-')})`);
      });
      return sendHtml(ctx, lines.join('\n'), getDatabaseKeyboard());
    }

    if (data === 'db:import') {
      if (!isAdmin(ctx)) return;
      ctx.session.flow = 'db_import';
      return sendHtml(ctx, '<b>Импорт базы данных</b>\n\nОтправьте файл резервной копии (.json) для восстановления.');
    }

    if (data.startsWith('admin:details:')) {
      if (!isAdmin(ctx)) return;
      const order = db.getOrder(data.split(':')[2]);
      if (!order) return sendHtml(ctx, 'Заказ не найден.');
      return showOrderDetailsToAdmin(ctx, order);
    }

    if (data.startsWith('admin:price:')) {
      if (!isAdmin(ctx)) return;
      const order = db.getOrder(data.split(':')[2]);
      if (!order) return sendHtml(ctx, 'Заказ не найден.');

      ctx.session.adminAction = { type: 'set_price', orderId: order.id };
      return sendHtml(ctx, `Введите цену для <b>${order.id}</b> от <b>${MIN_PRICE_BYN}</b> до <b>${MAX_PRICE_BYN}</b> BYN.`);
    }

    if (data.startsWith('admin:reject:')) {
      if (!isAdmin(ctx)) return;
      const orderId = data.split(':')[2];
      const order = db.updateOrder(orderId, { stage: 'rejected' });
      if (!order) return sendHtml(ctx, 'Заказ не найден.');

      await notifyUserAboutStage(bot, order, 'Заказ отклонён');
      return sendHtml(ctx, `Заказ <b>${order.id}</b> отклонён.`);
    }

    if (data.startsWith('admin:start:')) {
      if (!isAdmin(ctx)) return;
      const orderId = data.split(':')[2];
      const order = db.updateOrder(orderId, { stage: 'in_progress' });
      if (!order) return sendHtml(ctx, 'Заказ не найден.');

      await notifyUserAboutStage(bot, order, 'Заказ взят в работу');
      return showOrderDetailsToAdmin(ctx, order);
    }

    if (data.startsWith('admin:done:')) {
      if (!isAdmin(ctx)) return;
      const orderId = data.split(':')[2];
      const order = db.updateOrder(orderId, { stage: 'done' });
      if (!order) return sendHtml(ctx, 'Заказ не найден.');

      await notifyUserAboutStage(bot, order, 'Заказ завершён');
      return showOrderDetailsToAdmin(ctx, order);
    }

    if (data.startsWith('admin:remind:')) {
      if (!isAdmin(ctx)) return;
      const order = db.getOrder(data.split(':')[2]);
      if (!order) return sendHtml(ctx, 'Заказ не найден.');

      await notifyUserAboutStage(bot, order, 'Напоминание', ['\nПожалуйста, подтвердите или отмените заказ.']);
      return sendHtml(ctx, 'Напоминание отправлено.');
    }

    if (data === 'admin:search') {
      if (!isAdmin(ctx)) return;
      ctx.session.flow = 'admin_search';
      return showFlowMessage(ctx, '<b>Поиск заказов</b>\n\nВведите ID заказа или текст для поиска.');
    }

    if (data === 'admin:broadcast') {
      if (!isAdmin(ctx)) return;
      return sendHtml(ctx, '<b>Рассылка</b>\n\nВыберите получателей или введите сообщение для всех пользователей.', getBroadcastKeyboard());
    }

    if (data.startsWith('search:')) {
      if (!isAdmin(ctx)) return;
      const stage = data.split(':')[1];
      const results = db.getAllOrders().filter(o => o.stage === stage);
      return sendHtml(ctx, buildSearchResultsText(results, `статус: ${getStageLabel(stage)}`), getSearchKeyboard());
    }

    if (data.startsWith('broadcast:')) {
      if (!isAdmin(ctx)) return;
      const filterStage = data.split(':')[1];
      ctx.session.flow = 'admin_broadcast';
      ctx.session.broadcastFilter = filterStage === 'all' ? null : filterStage;
      return showFlowMessage(ctx, '<b>Введите текст рассылки</b>\n\nСообщение будет отправлено выбранным пользователям.');
    }
  });

  bot.on('document', async (ctx) => {
    if (isAdmin(ctx) && ctx.session.flow === 'db_import') {
      const file = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const https = require('https');
      const fs = require('fs');
      const path = require('path');
      const tempFile = path.join(__dirname, `temp-restore-${Date.now()}.json`);
      
      https.get(file.href, async (res) => {
        const stream = fs.createWriteStream(tempFile);
        res.pipe(stream);
        stream.on('finish', async () => {
          try {
            db.restoreFromBackup(tempFile);
            resetSession(ctx);
            await sendHtml(ctx, '<b>База данных восстановлена!</b>', buildAdminPanelKeyboard());
          } catch (err) {
            await sendHtml(ctx, `<b>Ошибка восстановления:</b> ${escapeHtml(err.message)}`, getDatabaseKeyboard());
          }
          fs.unlinkSync(tempFile);
        });
      });
      return;
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

async function sendBroadcast(bot, message, filterStage = null) {
  let users;
  
  if (filterStage) {
    const orders = db.getAllOrders().filter(o => o.stage === filterStage);
    const userIds = new Set(orders.map(o => o.client_id));
    users = Array.from(userIds);
  } else {
    users = db.getAllUsers().map(u => u.id);
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

function parsePrice(value) {
  const normalized = value.replace(',', '.').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const price = Math.round(Number(normalized) * 100) / 100;
  if (!Number.isFinite(price) || price < MIN_PRICE_BYN || price > MAX_PRICE_BYN) return null;
  return price;
}

async function startBot() {
  const bot = createBot();
  await bot.launch();
  console.log('🚀 Бот работает');

  setInterval(async () => {
    const orders = db.getActiveOrders();
    const now = Date.now();
    const threshold = OVERDUE_HOURS * 60 * 60 * 1000;

    const overdue = orders.filter(order => {
      const updatedAt = new Date(order.updated_at).getTime();
      return order.stage === 'in_progress' && (now - updatedAt) > threshold;
    });

    if (overdue.length > 0) {
      const list = overdue.map(o => `• ${o.id}`).join('\n');
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `<b>⚠️ Просроченные заказы</b>\n\nЗаказы в работе более ${OVERDUE_HOURS} часов:\n\n${list}`,
        { parse_mode: 'HTML' }
      );
    }

    const awaiting = orders.filter(o => o.stage === 'awaiting_confirmation');
    if (awaiting.length > 0) {
      const list = awaiting.map(o => `• ${o.id}`).join('\n');
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `<b>⏳ Заказы ожидают подтверждения</b>\n\n${list}`,
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

process.on('SIGINT', () => {
  db.closeDb();
  process.exit(0);
});

module.exports = { createBot };
