require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'bot.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

let db = null;

let migrationRan = false;

function getDb() {
  if (!db) {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
    if (!migrationRan) {
      migrationRan = true;
      try {
        runMigrations(db);
      } catch (e) {
        console.log('Migration error:', e.message);
      }
    }
  }
  return db;
}

function runMigrations(database) {
  try {
    const tableInfo = database.prepare("PRAGMA table_info(profiles)").all();
    const hasUntil = tableInfo.find(c => c.name === 'promo_discount_until');
    const hasDiscount = tableInfo.find(c => c.name === 'promo_discount');
    console.log('Current columns:', tableInfo.map(c => c.name));
    
    if (!hasUntil) {
      database.exec("ALTER TABLE profiles ADD COLUMN promo_discount_until TEXT");
      console.log('Added promo_discount_until column');
    }
    if (!hasDiscount) {
      database.exec("ALTER TABLE profiles ADD COLUMN promo_discount REAL");
      console.log('Added promo_discount column');
    }
  } catch (e) {
    console.log('Migration error (safe to ignore if columns exist):', e.message);
  }
}

function initDatabase() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY,
      name TEXT,
      phone TEXT,
      email TEXT,
      notes TEXT,
      promo_discount_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      client_id INTEGER,
      task TEXT,
      deadline TEXT,
      level TEXT,
      requirements TEXT,
      estimated_price REAL,
      final_price REAL,
      stage TEXT DEFAULT 'pending_review',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME,
      FOREIGN KEY (client_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      type TEXT,
      file_id TEXT,
      file_name TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      admin_id INTEGER,
      user_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seq (
      name TEXT PRIMARY KEY,
      value INTEGER DEFAULT 1
    );

    INSERT OR IGNORE INTO seq (name, value) VALUES ('order_seq', 1);
  `);

  return database;
}

function addLog(action, targetType, targetId, adminId = null, userId = null, details = null) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO logs (action, target_type, target_id, admin_id, user_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(action, targetType, targetId, adminId, userId, details);
}

const PROMOCODES_FILE = path.join(__dirname, 'promocodes.json');
const PROMO_DISCOUNT = 0.15;
const PROMO_DAYS = 2;

let cachedPromocodes = null;
let promocodesLastLoaded = 0;

function loadPromocodes() {
  const now = Date.now();
  if (cachedPromocodes && now - promocodesLastLoaded < 60000) {
    return cachedPromocodes;
  }
  
  try {
    if (!fs.existsSync(PROMOCODES_FILE)) {
      cachedPromocodes = new Set();
      return cachedPromocodes;
    }
    
    const content = fs.readFileSync(PROMOCODES_FILE, 'utf-8');
    const codes = content.split('\n')
      .map(line => line.trim().toUpperCase())
      .filter(line => line.length > 0);
    
    cachedPromocodes = new Set(codes);
    promocodesLastLoaded = now;
    return cachedPromocodes;
  } catch (e) {
    console.error('Failed to load promocodes:', e);
    cachedPromocodes = new Set();
    return cachedPromocodes;
  }
}

function validatePromocode(code) {
  try {
    console.log('Validating promo code:', code);
    console.log('PROMOCODES_FILE:', PROMOCODES_FILE);
    
    if (!fs.existsSync(PROMOCODES_FILE)) {
      console.log('File does not exist!');
      return { valid: false, error: 'Промокод недействителен' };
    }
    
    const content = fs.readFileSync(PROMOCODES_FILE, 'utf-8');
    console.log('File content:', content);
    const promocodes = JSON.parse(content);
    
    const normalized = code.trim().toUpperCase();
    console.log('Normalized:', normalized);
    const discount = promocodes[normalized];
    console.log('Discount:', discount);
    
    if (discount === undefined) {
      return { valid: false, error: 'Промокод недействителен' };
    }
    
    delete promocodes[normalized];
    fs.writeFileSync(PROMOCODES_FILE, JSON.stringify(promocodes, null, 2));
    console.log('Promo code used, remaining:', promocodes);
    
    return { valid: true, discount: discount / 100, days: PROMO_DAYS };
  } catch (e) {
    console.error('validatePromocode error:', e);
    return { valid: false, error: 'Ошибка проверки промокода' };
  }
}

function applyPromoDiscount(userId, discount) {
  const database = getDb();
  const expiresAt = new Date(Date.now() + PROMO_DAYS * 24 * 60 * 60 * 1000).toISOString();
  
  const existing = database.prepare('SELECT promo_discount_until FROM profiles WHERE user_id = ?').get(userId);
  
  if (existing) {
    database.prepare('UPDATE profiles SET promo_discount_until = ?, promo_discount = ? WHERE user_id = ?').run(expiresAt, discount, userId);
  } else {
    database.prepare('INSERT INTO profiles (user_id, promo_discount_until, promo_discount) VALUES (?, ?, ?)').run(userId, expiresAt, discount);
  }
}

function getPromoDiscountAmount(userId) {
  const database = getDb();
  const profile = database.prepare('SELECT promo_discount_until FROM profiles WHERE user_id = ?').get(userId);
  
  if (!profile || !profile.promo_discount_until) return 0;
  
  const until = new Date(profile.promo_discount_until);
  if (until.getTime() > Date.now()) {
    return profile.promo_discount || PROMO_DISCOUNT;
  }
  return 0;
}

function createUser(user) {
  const database = getDb();
  const existing = database.prepare('SELECT id FROM users WHERE id = ?').get(user.id);
  
  if (!existing) {
    const stmt = database.prepare(`
      INSERT INTO users (id, username, first_name, last_name)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(user.id, user.username || null, user.first_name || null, user.last_name || null);
    addLog('user_registered', 'user', String(user.id), null, user.id, `New user: ${user.username || user.first_name}`);
  }
  
  return getUser(user.id);
}

function getUser(userId) {
  const database = getDb();
  return database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function getAllUsers() {
  const database = getDb();
  return database.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

function getProfile(userId) {
  const database = getDb();
  return database.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
}

function saveProfile(userId, patch) {
  const database = getDb();
  const existing = database.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
  
  if (existing) {
    const fields = ['name', 'phone', 'email', 'notes'];
    const updates = [];
    const values = [];
    
    for (const field of fields) {
      if (patch[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(patch[field]);
      }
    }
    updates.push(`updated_at = datetime('now')`);
    values.push(userId);
    
    const stmt = database.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE user_id = ?`);
    stmt.run(...values);
  } else {
    const stmt = database.prepare(`
      INSERT INTO profiles (user_id, name, phone, email, notes)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      userId,
      patch.name || null,
      patch.phone || null,
      patch.email || null,
      patch.notes || null
    );
  }
  
  return getProfile(userId);
}

function getNextOrderId() {
  const database = getDb();
  const row = database.prepare('SELECT value FROM seq WHERE name = ?').get('order_seq');
  const id = `ORD-${String(row.value).padStart(4, '0')}`;
  database.prepare('UPDATE seq SET value = value + 1 WHERE name = ?').run('order_seq');
  return id;
}

function createOrder(draft) {
  const database = getDb();
  const id = getNextOrderId();
  
  const stmt = database.prepare(`
    INSERT INTO orders (id, client_id, task, deadline, level, requirements, estimated_price, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review')
  `);
  stmt.run(
    id,
    draft.clientId,
    draft.task,
    draft.deadline,
    draft.level,
    draft.requirements || 'Без дополнительных требований',
    draft.estimatedPrice
  );
  
  if (draft.attachments && draft.attachments.length > 0) {
    const attachStmt = database.prepare(`
      INSERT INTO attachments (order_id, type, file_id, file_name)
      VALUES (?, ?, ?, ?)
    `);
    for (const att of draft.attachments) {
      attachStmt.run(id, att.type, att.fileId, att.fileName || null);
    }
  }
  
  addLog('order_created', 'order', id, null, draft.clientId, `New order: ${draft.task.substring(0, 50)}`);
  
  return getOrder(id);
}

function getOrder(orderId) {
  const database = getDb();
  return database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function getOrderWithAttachments(orderId) {
  const database = getDb();
  const order = database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  
  const attachments = database.prepare('SELECT * FROM attachments WHERE order_id = ?').all(orderId);
  order.attachments = attachments;
  
  const profile = database.prepare('SELECT name, phone, promo_discount, promo_discount_until FROM profiles WHERE user_id = ?').get(order.client_id);
  if (profile) {
    order.profile_name = profile.name;
    order.profile_phone = profile.phone;
    if (profile.promo_discount_until) {
      const until = new Date(profile.promo_discount_until);
      if (until.getTime() > Date.now()) {
        order.promo_discount = profile.promo_discount;
      }
    }
  }
  
  return order;
}

function getAllOrders() {
  const database = getDb();
  return database.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
}

function getOrdersByUser(userId) {
  const database = getDb();
  return database.prepare('SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC').all(userId);
}

function getActiveOrdersByUser(userId) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM orders 
    WHERE client_id = ? AND stage IN ('pending_review', 'priced', 'awaiting_confirmation', 'in_progress')
    ORDER BY created_at DESC
  `).all(userId);
}

function getActiveOrders() {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM orders 
    WHERE stage IN ('pending_review', 'priced', 'awaiting_confirmation', 'in_progress')
    ORDER BY created_at DESC
  `).all();
}

function getAttentionOrders() {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM orders 
    WHERE stage IN ('pending_review', 'priced', 'awaiting_confirmation', 'in_progress', 'done')
    ORDER BY created_at DESC
  `).all();
}

function updateOrder(orderId, patch) {
  const database = getDb();
  const fields = ['task', 'deadline', 'level', 'requirements', 'estimated_price', 'final_price', 'stage', 'confirmed_at'];
  const updates = [];
  const values = [];
  
  for (const field of fields) {
    const camel = field.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    if (patch[camel] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(patch[camel]);
    }
  }
  
  if (updates.length === 0) return getOrder(orderId);
  
  updates.push(`updated_at = datetime('now')`);
  values.push(orderId);
  
  const stmt = database.prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);
  
  return getOrder(orderId);
}

function setOrderPrice(orderId, price) {
  const database = getDb();
  const order = database.prepare('SELECT client_id FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  
  const discount = getPromoDiscountAmount(order.client_id);
  let finalPrice = price;
  let discountText = '';
  if (discount > 0) {
    finalPrice = price * (1 - discount);
    discountText = ` (${Math.round(discount * 100)}% discount applied)`;
  }
  
  database.prepare(`
    UPDATE orders 
    SET final_price = ?, stage = 'awaiting_confirmation', updated_at = datetime('now')
    WHERE id = ?
  `).run(finalPrice, orderId);
  
  addLog('price_set', 'order', orderId, null, null, `Price: ${price}${discountText}`);
  return getOrder(orderId);
}

function confirmOrder(orderId, userId) {
  const database = getDb();
  database.prepare(`
    UPDATE orders 
    SET stage = 'priced', confirmed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND client_id = ?
  `).run(orderId, userId);
  
  addLog('order_confirmed', 'order', orderId, null, userId);
  return getOrder(orderId);
}

function getOrdersByDeadline(dateStr) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM orders 
    WHERE deadline = ? AND stage IN ('pending_review', 'priced', 'awaiting_confirmation', 'in_progress')
    ORDER BY created_at DESC
  `).all(dateStr);
}

function getOrdersCountByDeadline(dateStr) {
  const database = getDb();
  const result = database.prepare(`
    SELECT COUNT(*) as count FROM orders 
    WHERE deadline = ? AND stage IN ('pending_review', 'priced', 'awaiting_confirmation', 'in_progress')
  `).get(dateStr);
  return result.count;
}

function searchOrders(query) {
  const database = getDb();
  const q = `%${query}%`;
  
  return database.prepare(`
    SELECT * FROM orders 
    WHERE id LIKE ? OR task LIKE ? OR stage LIKE ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(q, q, q);
}

function getStats() {
  const database = getDb();
  const orders = database.prepare('SELECT * FROM orders').all();
  const completed = orders.filter(o => ['done', 'picked_up'].includes(o.stage));
  const revenue = completed.reduce((sum, o) => sum + (o.final_price || 0), 0);
  
  return {
    total: orders.length,
    active: orders.filter(o => ['pending_review', 'priced', 'awaiting_confirmation', 'in_progress'].includes(o.stage)).length,
    done: completed.length,
    pending: orders.filter(o => o.stage === 'pending_review').length,
    awaitingConfirmation: orders.filter(o => o.stage === 'awaiting_confirmation').length,
    priced: orders.filter(o => o.stage === 'priced').length,
    inProgress: orders.filter(o => o.stage === 'in_progress').length,
    rejected: orders.filter(o => o.stage === 'rejected').length,
    cancelled: orders.filter(o => o.stage === 'cancelled').length,
    revenue
  };
}

function getUserStats(userId) {
  const database = getDb();
  const orders = database.prepare('SELECT * FROM orders WHERE client_id = ?').all(userId);
  const completed = orders.filter(o => ['done', 'picked_up'].includes(o.stage));
  const totalSpent = completed.reduce((sum, o) => sum + (o.final_price || 0), 0);
  
  return {
    totalOrders: orders.length,
    completedOrders: completed.length,
    totalSpent,
    activeOrders: orders.filter(o => ['pending_review', 'priced', 'awaiting_confirmation', 'in_progress'].includes(o.stage)).length
  };
}

function getDbStats() {
  const database = getDb();
  const users = database.prepare('SELECT COUNT(*) as count FROM users').get();
  const profiles = database.prepare('SELECT COUNT(*) as count FROM profiles').get();
  const orders = database.prepare('SELECT COUNT(*) as count FROM orders').get();
  const attachments = database.prepare('SELECT COUNT(*) as count FROM attachments').get();
  const logs = database.prepare('SELECT COUNT(*) as count FROM logs').get();
  
  const stats = fs.statSync(DB_FILE);
  
  return {
    users: users.count,
    profiles: profiles.count,
    orders: orders.count,
    attachments: attachments.count,
    logs: logs.count,
    sizeBytes: stats.size,
    sizeFormatted: formatBytes(stats.size)
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getLogs(limit = 50) {
  const database = getDb();
  return database.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function clearOrders() {
  const database = getDb();
  database.prepare('DELETE FROM attachments').run();
  database.prepare('DELETE FROM orders').run();
  database.prepare('UPDATE seq SET value = 1 WHERE name = ?').run('order_seq');
  addLog('orders_cleared', 'orders', null, null, null, 'All orders and attachments deleted');
}

function clearUsers() {
  const database = getDb();
  database.prepare('DELETE FROM attachments').run();
  database.prepare('DELETE FROM orders').run();
  database.prepare('DELETE FROM profiles').run();
  database.prepare('DELETE FROM users').run();
  database.prepare('UPDATE seq SET value = 1 WHERE name = ?').run('order_seq');
  addLog('users_cleared', 'users', null, null, null, 'All users, profiles, orders deleted');
}

function clearAll() {
  const database = getDb();
  database.exec(`
    DELETE FROM logs;
    DELETE FROM attachments;
    DELETE FROM orders;
    DELETE FROM profiles;
    DELETE FROM users;
    UPDATE seq SET value = 1 WHERE name = 'order_seq';
  `);
  addLog('database_cleared', 'database', null, null, null, 'Entire database cleared');
}

function optimizeDb() {
  const database = getDb();
  database.exec('VACUUM');
  addLog('db_optimized', 'database', null, null, null, 'Database vacuumed');
}

function checkIntegrity() {
  const database = getDb();
  const result = database.prepare('PRAGMA integrity_check').get();
  return result.integrity_check === 'ok';
}

function getTableSchema(tableName) {
  const database = getDb();
  return database.prepare(`PRAGMA table_info(${tableName})`).all();
}

function exportToJson() {
  const database = getDb();
  return {
    exportDate: new Date().toISOString(),
    users: database.prepare('SELECT * FROM users').all(),
    profiles: database.prepare('SELECT * FROM profiles').all(),
    orders: database.prepare('SELECT * FROM orders').all(),
    attachments: database.prepare('SELECT * FROM attachments').all(),
    logs: database.prepare('SELECT * FROM logs').all()
  };
}

function createBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `backup-${timestamp}.json`);
  
  const data = exportToJson();
  fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');
  
  addLog('backup_created', 'database', null, null, null, `Backup: ${path.basename(backupFile)}`);
  
  return backupFile;
}

function restoreFromBackup(backupFile) {
  const data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  const database = getDb();
  
  database.exec('BEGIN TRANSACTION');
  
  try {
    database.exec('DELETE FROM attachments');
    database.exec('DELETE FROM orders');
    database.exec('DELETE FROM profiles');
    database.exec('DELETE FROM users');
    database.exec('DELETE FROM logs');
    
    const insertUser = database.prepare(`
      INSERT INTO users (id, username, first_name, last_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const u of data.users || []) {
      insertUser.run(u.id, u.username, u.first_name, u.last_name, u.created_at);
    }
    
    const insertProfile = database.prepare(`
      INSERT INTO profiles (user_id, name, phone, email, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const p of data.profiles || []) {
      insertProfile.run(p.user_id, p.name, p.phone, p.email, p.notes, p.updated_at);
    }
    
    const insertOrder = database.prepare(`
      INSERT INTO orders (id, client_id, task, deadline, level, requirements, estimated_price, final_price, stage, created_at, updated_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const o of data.orders || []) {
      insertOrder.run(o.id, o.client_id, o.task, o.deadline, o.level, o.requirements, o.estimated_price, o.final_price, o.stage, o.created_at, o.updated_at, o.confirmed_at);
    }
    
    const insertAttachment = database.prepare(`
      INSERT INTO attachments (id, order_id, type, file_id, file_name)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const a of data.attachments || []) {
      insertAttachment.run(a.id, a.order_id, a.type, a.file_id, a.file_name);
    }
    
    database.exec('COMMIT');
    addLog('backup_restored', 'database', null, null, null, `Restored from: ${path.basename(backupFile)}`);
    
    return true;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function getBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) {
    return [];
  }
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const stats = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        name: f,
        path: path.join(BACKUP_DIR, f),
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        created: stats.mtime
      };
    })
    .sort((a, b) => b.created - a.created);
}

let backupTimer = null;

function startBackupScheduler() {
  if (backupTimer) return;
  
  createBackup();
  
  backupTimer = setInterval(() => {
    createBackup();
    console.log(`💾 Автоматический бэкап создан: ${new Date().toLocaleString('ru-RU')}`);
  }, BACKUP_INTERVAL_MS);
  
  console.log(`💾 Бэкап запланирован каждые 2 дня`);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  createUser,
  getUser,
  getAllUsers,
  getProfile,
  saveProfile,
  createOrder,
  getOrder,
  getOrderWithAttachments,
  getAllOrders,
  getOrdersByUser,
  getActiveOrdersByUser,
  getActiveOrders,
  getAttentionOrders,
  updateOrder,
  setOrderPrice,
  confirmOrder,
  getOrdersByDeadline,
  getOrdersCountByDeadline,
  searchOrders,
  getStats,
  getUserStats,
  getDbStats,
  getLogs,
  clearOrders,
  clearUsers,
  clearAll,
  optimizeDb,
  checkIntegrity,
  getTableSchema,
  exportToJson,
  createBackup,
  restoreFromBackup,
  getBackupFiles,
  startBackupScheduler,
  closeDb,
  addLog,
  validatePromocode,
  applyPromoDiscount,
  getPromoDiscountAmount
};
