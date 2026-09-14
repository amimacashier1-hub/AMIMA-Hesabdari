const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { createDashboardCore } = require('./core/dashboard.cjs');
const { createCoreContext } = require('./core/context.cjs');

let db = null;
let NativeDatabase = null;
let dbPath = null;
let mainWindow = null;
let autoBackupTimer = null;
let sessionUser = null;
const PERMISSIONS = {
  DASHBOARD_VIEW:'dashboard.view', SALES_CREATE:'sales.create', SALES_RETURN:'sales.return',
  PRODUCTS_MANAGE:'products.manage', INVENTORY_MANAGE:'inventory.manage', REPORTS_VIEW:'reports.view',
  CUSTOMERS_MANAGE:'customers.manage', CASH_MANAGE:'cash.manage', ACCOUNTING_VIEW:'accounting.view',
  AUDIT_VIEW:'audit.view', BACKUP_CREATE:'backup.create', BACKUP_RESTORE:'backup.restore',
  BACKUP_SETTINGS:'backup.settings', SYNC_MANAGE:'sync.manage', USERS_MANAGE:'users.manage'
};
const CHANNEL_PERMISSIONS = {
  'products:save':PERMISSIONS.PRODUCTS_MANAGE,'products:archive':PERMISSIONS.PRODUCTS_MANAGE,'categories:save':PERMISSIONS.PRODUCTS_MANAGE,'categories:archive':PERMISSIONS.PRODUCTS_MANAGE,
  'stock:adjust':PERMISSIONS.INVENTORY_MANAGE,
  'suppliers:save':PERMISSIONS.INVENTORY_MANAGE,'suppliers:payment':PERMISSIONS.INVENTORY_MANAGE,'suppliers:list':PERMISSIONS.INVENTORY_MANAGE,'suppliers:ledger':PERMISSIONS.INVENTORY_MANAGE,'suppliers:summary':PERMISSIONS.INVENTORY_MANAGE,
  'purchase:new':PERMISSIONS.INVENTORY_MANAGE,'purchase:add-item':PERMISSIONS.INVENTORY_MANAGE,'purchase:remove-item':PERMISSIONS.INVENTORY_MANAGE,'purchase:set-discount':PERMISSIONS.INVENTORY_MANAGE,'purchase:pay':PERMISSIONS.INVENTORY_MANAGE,'purchase:get':PERMISSIONS.INVENTORY_MANAGE,'purchase:list-open':PERMISSIONS.INVENTORY_MANAGE,'purchase:payments':PERMISSIONS.INVENTORY_MANAGE,
  'invoice:new':PERMISSIONS.SALES_CREATE,'invoice:add-item':PERMISSIONS.SALES_CREATE,'invoice:remove-item':PERMISSIONS.SALES_CREATE,'invoice:set-discount':PERMISSIONS.SALES_CREATE,'invoice:pay':PERMISSIONS.SALES_CREATE,'invoice:set-customer':PERMISSIONS.SALES_CREATE,'invoice:cancel':PERMISSIONS.SALES_CREATE,
  'invoice:return':PERMISSIONS.SALES_RETURN,
  'customers:save':PERMISSIONS.CUSTOMERS_MANAGE,'customers:payment':PERMISSIONS.CUSTOMERS_MANAGE,'customers:settle':PERMISSIONS.CUSTOMERS_MANAGE,
  'cash:open':PERMISSIONS.CASH_MANAGE,'cash:move':PERMISSIONS.CASH_MANAGE,'cash:close':PERMISSIONS.CASH_MANAGE,
  'accounting:entries':PERMISSIONS.ACCOUNTING_VIEW,'accounting:entry':PERMISSIONS.ACCOUNTING_VIEW,'accounting:trial-balance':PERMISSIONS.ACCOUNTING_VIEW,
  'audit:list':PERMISSIONS.AUDIT_VIEW,'audit:summary':PERMISSIONS.AUDIT_VIEW,
  'backup:create':PERMISSIONS.BACKUP_CREATE,'backup:create-auto':PERMISSIONS.BACKUP_CREATE,'backup:health':PERMISSIONS.BACKUP_CREATE,'backup:list':PERMISSIONS.BACKUP_CREATE,
  'backup:restore':PERMISSIONS.BACKUP_RESTORE,'backup:set-settings':PERMISSIONS.BACKUP_SETTINGS,
  'sync:config':PERMISSIONS.SYNC_MANAGE,'sync:set-config':PERMISSIONS.SYNC_MANAGE,'sync:status':PERMISSIONS.SYNC_MANAGE,'sync:preview':PERMISSIONS.SYNC_MANAGE,'sync:run':PERMISSIONS.SYNC_MANAGE,'sync:conflicts':PERMISSIONS.SYNC_MANAGE,'sync:resolve':PERMISSIONS.SYNC_MANAGE
};

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'database');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupDir() {
  const dir = path.join(app.getPath('userData'), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupSettings() {
  const enabled = rows("SELECT value FROM app_meta WHERE key='auto_backup_enabled'")[0]?.value;
  const interval = rows("SELECT value FROM app_meta WHERE key='auto_backup_interval_hours'")[0]?.value;
  return {
    enabled: enabled !== '0',
    intervalHours: Math.max(1, Number(interval || 6))
  };
}

function setMeta(key, value) {
  db.run("INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, String(value)]);
}

function backupFileName(prefix='hesabdari') {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  return `${prefix}-${stamp}.sqlite`;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}
function backupManifestPath(file) { return `${file}.manifest.json`; }
function writeBackupManifest(file, kind='manual') {
  const stat = fs.statSync(file);
  const manifest = { protocol:'hesabdari-backup-v2', kind, file:path.basename(file), size:stat.size, sha256:sha256File(file), createdAt:new Date().toISOString() };
  fs.writeFileSync(backupManifestPath(file), JSON.stringify(manifest,null,2),'utf8');
  return manifest;
}
function validateBackupFile(source) {
  if (!fs.existsSync(source)) throw new Error('فایل پشتیبان پیدا نشد');
  const stat=fs.statSync(source);
  if (stat.size < 4096) throw new Error('فایل پشتیبان بسیار کوچک یا ناقص است');
  const manifestFile=backupManifestPath(source);
  if (fs.existsSync(manifestFile)) {
    let m; try { m=JSON.parse(fs.readFileSync(manifestFile,'utf8')); } catch (_) { throw new Error('فایل Manifest پشتیبان خراب است'); }
    if (m.protocol!=='hesabdari-backup-v2') throw new Error('نسخه Manifest پشتیبانی نمی‌شود');
    if (Number(m.size)!==stat.size || String(m.sha256)!==sha256File(source)) throw new Error('هش یا اندازه فایل پشتیبان با Manifest مطابقت ندارد');
  }
  const check=new NativeDatabaseAdapter(source);
  try {
    check.run('PRAGMA foreign_keys = ON');
    const integrity=check.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    if(integrity!=='ok') throw new Error('SQLite integrity_check ناموفق است');
    const fk=check.exec('PRAGMA foreign_key_check');
    if(fk.length && fk[0].values.length) throw new Error(`فایل پشتیبان ${fk[0].values.length} خطای Foreign Key دارد`);
    const required=['products','invoices','invoice_items','stock_movements','payments','customers','suppliers','supplier_ledger','purchase_invoices','purchase_items','purchase_payments','customer_ledger','cash_registers','cash_movements','accounting_entries','accounting_lines','audit_log','sync_outbox','app_meta','roles','permissions','role_permissions','users','price_change_history'];
    const tables=new Set(check.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.map(r=>r[0])||[]);
    const missing=required.filter(t=>!tables.has(t));
    if(missing.length) throw new Error(`ساختار پشتیبان ناقص است: ${missing.join(', ')}`);
    return {valid:true,size:stat.size,sha256:sha256File(source),integrity:'ok',foreignKeys:0,manifest:fs.existsSync(manifestFile)};
  } finally { try{check.close()}catch(_){} }
}

async function createBackupAt(dest) {
  if (!dbPath || !db) throw new Error('پایگاه داده آماده نیست');
  const target = path.resolve(dest);
  if (target === path.resolve(dbPath)) throw new Error('مسیر پشتیبان نمی‌تواند همان فایل دیتابیس فعال باشد');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    await db.raw.backup(target);
    validateBackupFile(target);
    writeBackupManifest(target, path.dirname(target)===backupDir() ? 'automatic-or-local' : 'manual');
    return target;
  } catch (err) {
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
    throw new Error(`پشتیبان‌گیری SQLite ناموفق بود: ${err.message}`);
  }
}

async function createAutomaticBackup() {
  try {
    const settings = backupSettings();
    if (!settings.enabled) return null;
    const dest = path.join(backupDir(), backupFileName('auto'));
    await createBackupAt(dest);
    cleanupOldBackups(30);
    return dest;
  } catch (err) {
    console.error('Automatic backup failed:', err);
    return null;
  }
}

function cleanupOldBackups(maxFiles=30) {
  const files = fs.readdirSync(backupDir())
    .filter(name => /\.sqlite$/i.test(name))
    .map(name => ({ name, full: path.join(backupDir(), name), mtime: fs.statSync(path.join(backupDir(), name)).mtimeMs }))
    .sort((a,b)=>b.mtime-a.mtime);
  for (const f of files.slice(maxFiles)) {
    try { fs.unlinkSync(f.full); } catch (_) {}
  }
}

function startAutoBackupTimer() {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  const settings = backupSettings();
  if (!settings.enabled) return;
  autoBackupTimer = setInterval(createAutomaticBackup, settings.intervalHours * 60 * 60 * 1000);
}

      function ledgerStock(productId) {
  const r = rows('SELECT COALESCE(SUM(quantity),0) AS stock FROM stock_movements WHERE product_id=?',[productId])[0];
  return Number(r?.stock || 0);
}

function inventoryValue(productId) {
  const r=rows('SELECT COALESCE(SUM(total_cost),0) value, COALESCE(SUM(quantity),0) qty FROM stock_movements WHERE product_id=?',[productId])[0];
  return {quantity:Number(r?.qty||0), value:money(r?.value||0)};
}
function movingAverageCost(productId) {
  const v=inventoryValue(productId);
  if (v.quantity <= 0) return 0;
  return Number(v.value || 0) / v.quantity;
}
function movementCost(productId, movementType, quantity, explicitUnitCost=null) {
  const qty=Math.abs(Number(quantity)||0);
  if (!(qty>0)) return {unitCost:0,totalCost:0};
  if (explicitUnitCost != null && Number(explicitUnitCost)>=0) {
    const unitCost=Number(explicitUnitCost); return {unitCost,totalCost:unitCost*qty};
  }
  const inbound=new Set(['PURCHASE','OPENING','ADJUST_IN','RETURN_IN']);
  const outbound=new Set(['ADJUST_OUT','WASTE']);
  const unitCost=inbound.has(movementType) ? Number(rows('SELECT purchase_price FROM products WHERE id=?',[productId])[0]?.purchase_price||0) : outbound.has(movementType) ? movingAverageCost(productId) : movingAverageCost(productId);
  return {unitCost,totalCost:unitCost*qty};
}

function syncProductStockFromLedger(productId, updatedAt) {
  const stock = ledgerStock(productId);
  db.run('UPDATE products SET stock=?,updated_at=? WHERE id=?',[stock, updatedAt || new Date().toISOString(), productId]);
  return stock;
}

function assertStockInvariant(productId) {
  const p = rows('SELECT stock FROM products WHERE id=?',[productId])[0];
  if (!p) return true;
  const ledger = ledgerStock(productId);
  if (Math.abs(Number(p.stock || 0) - ledger) > 0.000001) {
    throw new Error(`ناسازگاری موجودی کالا ${productId}: snapshot=${p.stock}, ledger=${ledger}`);
  }
  return true;
}

function migrateMoneyToToman() {
  if (rows("SELECT 1 FROM app_meta WHERE key='money_toman_v1'").length) return;
  const tables = [
    ['products',['purchase_price','sale_price_per_unit']],
    ['customers',['balance']],
    ['suppliers',['balance']],
    ['product_tiers',['price_per_unit']],
    ['price_change_history',['old_price','new_price']],
    ['invoices',['subtotal','discount','total']],
    ['invoice_items',['unit_price','purchase_unit_price','amount']],
    ['stock_movements',['unit_cost','total_cost']],
    ['payments',['amount']],
    ['purchase_invoices',['subtotal','discount','total','paid_amount','due_amount']],
    ['purchase_items',['purchase_unit_price','discount','amount','effective_unit_cost']],
    ['purchase_payments',['amount']],
    ['supplier_ledger',['amount','balance_after']],
    ['customer_ledger',['amount','balance_after']],
    ['cash_registers',['opening_cash','discrepancy']],
    ['cash_movements',['amount']],
    ['sales_return_items',['unit_price','refund_amount']],
    ['refunds',['amount']],
    ['accounting_lines',['debit','credit']]
  ];
  withTransaction(()=>{
    for (const [table, cols] of tables) {
      const exists = rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]).length;
      if (!exists) continue;
      for (const col of cols) db.run(`UPDATE ${table} SET ${col}=ROUND(COALESCE(${col},0)/10,0)`);
    }
    setMeta('money_toman_v1','1');
  });
}

function initDatabase() {
  NativeDatabase = require('better-sqlite3');
  dbPath = path.join(dataDir(), 'hesabdari.sqlite');
  db = new NativeDatabaseAdapter(dbPath);
  db.raw.pragma('foreign_keys = ON');
  db.raw.pragma('journal_mode = WAL');
  db.raw.pragma('synchronous = NORMAL');
  createSchema();
  try { migrateSyncTokenStorage(); } catch (_) {}
}

class NativeDatabaseAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    // Packaged Electron apps keep the native better-sqlite3 addon outside app.asar.
    // Pass the unpacked .node path explicitly so startup does not depend on ASAR/native-module resolution.
    const candidates = [
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    ];
    const nativeBinding = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
    this.raw = nativeBinding ? new NativeDatabase(filePath, { nativeBinding }) : new NativeDatabase(filePath);
  }
  run(sql, params=[]) { const values = Array.isArray(params) ? params : [params]; if (!values.length && /;/.test(sql.trim().replace(/;\s*$/, ''))) { return this.raw.exec(sql); } return this.raw.prepare(sql).run(...values); }
  prepare(sql) {
    const raw = this.raw.prepare(sql);
    let params = [];
    return {
      bind(p=[]) { params = Array.isArray(p) ? p : [p]; },
      step() { if (!this._iter) this._iter = raw.iterate(...params); const n = this._iter.next(); this._current = n.done ? null : n.value; return !n.done; },
      getAsObject() { return this._current || {}; },
      free() { this._iter = null; this._current = null; }
    };
  }
  exec(sql) {
    const trimmed = sql.trim();
    if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) {
      const rowsOut = this.raw.prepare(sql).all();
      const columns = rowsOut.length ? Object.keys(rowsOut[0]) : [];
      return [{ columns, values: rowsOut.map(r => columns.map(c => r[c])) }];
    }
    this.raw.exec(sql);
    return [];
  }
  export() { return fs.readFileSync(this.filePath); }
  close() { this.raw.close(); }
}
function createSchema() {
  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL, permission_id TEXT NOT NULL, PRIMARY KEY(role_id,permission_id),
      FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY(permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, role_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      purchase_price REAL DEFAULT 0,
      sale_price_per_unit REAL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'گرم',
      stock REAL DEFAULT 0,
      min_stock REAL DEFAULT 0,
      category_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS product_tiers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      min_qty REAL NOT NULL,
      max_qty REAL,
      price_per_unit REAL NOT NULL,
      tier_order INTEGER NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS price_change_history (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, product_id TEXT NOT NULL, price_type TEXT NOT NULL,
      tier_order INTEGER, old_price REAL NOT NULL, new_price REAL NOT NULL, percentage REAL NOT NULL,
      created_at TEXT NOT NULL, user_id TEXT, note TEXT,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_change_history(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_price_history_batch ON price_change_history(batch_id, created_at);

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_no INTEGER UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT,
      customer_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      unit_price REAL NOT NULL,
      purchase_unit_price REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL,
      tier_order INTEGER,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      invoice_id TEXT,
      movement_type TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      cost_method TEXT NOT NULL DEFAULT 'MOVING_AVERAGE',
      created_at TEXT NOT NULL,
      note TEXT,
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

    CREATE TABLE IF NOT EXISTS supplier_ledger (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
      amount REAL NOT NULL CHECK(amount > 0),
      balance_after REAL NOT NULL DEFAULT 0,
      reference_type TEXT,
      reference_id TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier_date ON supplier_ledger(supplier_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_supplier_ledger_reference ON supplier_ledger(reference_type, reference_id);

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id TEXT PRIMARY KEY,
      purchase_no INTEGER UNIQUE NOT NULL,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      due_amount REAL NOT NULL DEFAULT 0,
      payment_method TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier ON purchase_invoices(supplier_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_status ON purchase_invoices(status);

    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT PRIMARY KEY,
      purchase_invoice_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity > 0),
      unit TEXT NOT NULL,
      purchase_unit_price REAL NOT NULL CHECK(purchase_unit_price >= 0),
      discount REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      effective_unit_cost REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_items_invoice ON purchase_items(purchase_invoice_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_product ON purchase_items(product_id);

    CREATE TABLE IF NOT EXISTS purchase_payments (
      id TEXT PRIMARY KEY,
      purchase_invoice_id TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY(purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_payments_invoice ON purchase_payments(purchase_invoice_id);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_ledger (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
      amount REAL NOT NULL CHECK(amount > 0),
      balance_after REAL NOT NULL DEFAULT 0,
      reference_type TEXT,
      reference_id TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer_date ON customer_ledger(customer_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_customer_ledger_reference ON customer_ledger(reference_type, reference_id);

    CREATE TABLE IF NOT EXISTS cash_registers (
      id TEXT PRIMARY KEY,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      opening_cash REAL NOT NULL DEFAULT 0,
      closing_cash REAL,
      expected_cash REAL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      register_id TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(register_id) REFERENCES cash_registers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cash_movements_register_date ON cash_movements(register_id, created_at, id);

    CREATE TABLE IF NOT EXISTS sales_returns (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, return_no INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'COMPLETED', subtotal REAL NOT NULL DEFAULT 0,
      refund_total REAL NOT NULL DEFAULT 0, refund_method TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    );
    CREATE TABLE IF NOT EXISTS sales_return_items (
      id TEXT PRIMARY KEY, return_id TEXT NOT NULL, invoice_item_id TEXT NOT NULL, product_id TEXT NOT NULL,
      product_name TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, unit_price REAL NOT NULL,
      refund_amount REAL NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(return_id) REFERENCES sales_returns(id) ON DELETE CASCADE,
      FOREIGN KEY(invoice_item_id) REFERENCES invoice_items(id), FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, return_id TEXT NOT NULL, method TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id), FOREIGN KEY(return_id) REFERENCES sales_returns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS accounting_entries (
      id TEXT PRIMARY KEY,
      entry_no INTEGER UNIQUE NOT NULL,
      entry_type TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'admin-local'
    );
    CREATE TABLE IF NOT EXISTS accounting_lines (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      account_code TEXT NOT NULL,
      account_name TEXT NOT NULL,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      note TEXT,
      FOREIGN KEY(entry_id) REFERENCES accounting_entries(id) ON DELETE CASCADE,
      CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    );
    CREATE INDEX IF NOT EXISTS idx_accounting_entries_date ON accounting_entries(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_accounting_entries_ref ON accounting_entries(reference_type, reference_id);
    CREATE INDEX IF NOT EXISTS idx_accounting_lines_account ON accounting_lines(account_code, entry_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL DEFAULT 'admin-local',
      actor_name TEXT NOT NULL DEFAULT 'مدیر سیستم',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      reference_type TEXT,
      reference_id TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_date ON audit_log(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_ref ON audit_log(reference_type, reference_id, created_at);

    CREATE TABLE IF NOT EXISTS sync_device (
      id TEXT PRIMARY KEY,
      device_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT 'صندوق فروش',
      api_url TEXT NOT NULL DEFAULT '',
      api_token TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      last_push_at TEXT,
      last_pull_at TEXT,
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      local_version INTEGER NOT NULL DEFAULT 1,
      base_server_version INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(entity_type, entity_id, operation, local_version)
    );

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      local_version INTEGER,
      server_version INTEGER,
      local_payload_json TEXT,
      server_payload_json TEXT,
      resolution TEXT NOT NULL DEFAULT 'PENDING',
      resolved_payload_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_created ON stock_movements(created_at);
    CREATE INDEX IF NOT EXISTS idx_stock_type ON stock_movements(movement_type);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity ON sync_outbox(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status ON sync_conflicts(resolution, created_at);
  `);

  const invoiceCols = db.exec("PRAGMA table_info(invoices)")[0]?.values || [];
  if (!invoiceCols.some(r => r[1] === 'customer_id')) db.run("ALTER TABLE invoices ADD COLUMN customer_id TEXT");

  const stockCols = db.exec("PRAGMA table_info(stock_movements)")[0]?.values || [];
  if (!stockCols.some(r => r[1] === 'note')) db.run("ALTER TABLE stock_movements ADD COLUMN note TEXT");
  if (!stockCols.some(r => r[1] === 'unit_cost')) db.run("ALTER TABLE stock_movements ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0");
  if (!stockCols.some(r => r[1] === 'total_cost')) db.run("ALTER TABLE stock_movements ADD COLUMN total_cost REAL NOT NULL DEFAULT 0");
  if (!stockCols.some(r => r[1] === 'cost_method')) db.run("ALTER TABLE stock_movements ADD COLUMN cost_method TEXT NOT NULL DEFAULT 'MOVING_AVERAGE'");
  if (!stockCols.some(r => r[1] === 'source_type')) db.run("ALTER TABLE stock_movements ADD COLUMN source_type TEXT");
  if (!stockCols.some(r => r[1] === 'source_id')) db.run("ALTER TABLE stock_movements ADD COLUMN source_id TEXT");
  db.run("CREATE INDEX IF NOT EXISTS idx_stock_source ON stock_movements(source_type, source_id)");

  const cashMovementCols = db.exec("PRAGMA table_info(cash_movements)")[0]?.values || [];
  if (!cashMovementCols.some(r => r[1] === 'direction')) db.run("ALTER TABLE cash_movements ADD COLUMN direction TEXT NOT NULL DEFAULT 'OUT'");
  if (!cashMovementCols.some(r => r[1] === 'category')) db.run("ALTER TABLE cash_movements ADD COLUMN category TEXT NOT NULL DEFAULT 'GENERAL'");
  if (!cashMovementCols.some(r => r[1] === 'reference_type')) db.run("ALTER TABLE cash_movements ADD COLUMN reference_type TEXT");
  if (!cashMovementCols.some(r => r[1] === 'reference_id')) db.run("ALTER TABLE cash_movements ADD COLUMN reference_id TEXT");
  db.run("UPDATE cash_movements SET direction='IN', category=CASE WHEN movement_type='SALE' THEN 'SALE' WHEN movement_type='IN' THEN 'GENERAL' ELSE category END WHERE movement_type IN ('SALE','IN')");
  db.run("UPDATE cash_movements SET direction='OUT', category=CASE WHEN movement_type='OUT' THEN 'GENERAL' ELSE category END WHERE movement_type='OUT'");
  db.run("UPDATE cash_movements SET direction='IN', category=CASE WHEN movement_type='SALE' THEN 'SALE' WHEN movement_type='IN' THEN 'GENERAL' ELSE category END WHERE movement_type IN ('SALE','IN')");
  db.run("UPDATE cash_movements SET direction='OUT', category=CASE WHEN movement_type='OUT' THEN 'GENERAL' ELSE category END WHERE movement_type='OUT'");
  const cashRegisterCols = db.exec("PRAGMA table_info(cash_registers)")[0]?.values || [];
  if (!cashRegisterCols.some(r => r[1] === 'discrepancy')) db.run("ALTER TABLE cash_registers ADD COLUMN discrepancy REAL NOT NULL DEFAULT 0");

  // Legacy product_tiers used NOT NULL max_qty. Rebuild the table once so the final tier can be open-ended.
  const tierCols = db.exec("PRAGMA table_info(product_tiers)")[0]?.values || [];
  const maxQtyCol = tierCols.find(r => r[1] === 'max_qty');
  if (maxQtyCol && Number(maxQtyCol[3]) === 1) {
    db.run(`
      BEGIN TRANSACTION;
      CREATE TABLE product_tiers_new (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL, min_qty REAL NOT NULL, max_qty REAL,
        price_per_unit REAL NOT NULL, tier_order INTEGER NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
      INSERT INTO product_tiers_new(id,product_id,min_qty,max_qty,price_per_unit,tier_order)
        SELECT id,product_id,min_qty,max_qty,price_per_unit,tier_order FROM product_tiers;
      DROP TABLE product_tiers;
      ALTER TABLE product_tiers_new RENAME TO product_tiers;
      COMMIT;
    `);
  }

  const now = new Date().toISOString();
  if (!rows("SELECT 1 FROM sync_device LIMIT 1").length) {
    const deviceId = crypto.randomUUID();
    db.run("INSERT INTO sync_device(id,device_id,name,created_at,updated_at) VALUES(?,?,?,?,?)", [newId('syncdev'),deviceId,'صندوق فروش',now,now]);
  }

  const outboxCols = db.exec("PRAGMA table_info(sync_outbox)")[0]?.values || [];
  if (!outboxCols.some(r => r[1] === 'base_server_version')) db.run("ALTER TABLE sync_outbox ADD COLUMN base_server_version INTEGER NOT NULL DEFAULT 0");
  db.run("CREATE INDEX IF NOT EXISTS idx_sync_outbox_base_version ON sync_outbox(entity_type, entity_id, base_server_version)");
  // Migrate the legacy final tier (1..10000) to an open-ended tier.
  db.run("UPDATE product_tiers SET max_qty=NULL WHERE max_qty=10000 AND NOT EXISTS (SELECT 1 FROM product_tiers p2 WHERE p2.product_id=product_tiers.product_id AND p2.min_qty>product_tiers.min_qty)");

  // Money convention v1: all application financial amounts are stored and calculated in Toman.
  // IMPORTANT: migrate existing/legacy data BEFORE seeding a fresh database.
  // Otherwise the built-in seed prices (already in Toman) would be divided by 10.
  migrateMoneyToToman();

  const count = db.exec("SELECT COUNT(*) AS c FROM categories")[0]?.values[0][0] || 0;
  if (count === 0) {
    seedData();
  }

  // Inventory valuation v3: stock movements carry immutable cost snapshots.
  // Backfill legacy movements once; after this point COGS is derived from movement costs.
  if (!rows("SELECT 1 FROM app_meta WHERE key='inventory_cost_v3_migrated'").length) {
    withTransaction(() => {
      const legacyMoves = rows(`SELECT sm.id,sm.product_id,sm.invoice_id,sm.movement_type,sm.quantity,sm.unit_cost,sm.total_cost,
        p.purchase_price FROM stock_movements sm JOIN products p ON p.id=sm.product_id
        WHERE COALESCE(sm.total_cost,0)=0 AND sm.quantity<>0 ORDER BY sm.created_at,sm.id`);
      for (const m of legacyMoves) {
        let unitCost = 0;
        if (m.movement_type === 'SALE') {
          const it = rows('SELECT purchase_unit_price FROM invoice_items WHERE invoice_id=? AND product_id=? ORDER BY id LIMIT 1',[m.invoice_id,m.product_id])[0];
          unitCost = Number(it?.purchase_unit_price || m.purchase_price || 0);
        } else if (m.movement_type === 'RETURN_IN') {
          const it = rows(`SELECT ii.purchase_unit_price FROM sales_return_items ri JOIN invoice_items ii ON ii.id=ri.invoice_item_id WHERE ri.product_id=? AND ri.quantity>0 ORDER BY ri.created_at DESC LIMIT 1`,[m.product_id])[0];
          unitCost = Number(it?.purchase_unit_price || m.purchase_price || 0);
        } else unitCost = Number(m.purchase_price || 0);
        const total = Number(m.quantity) * unitCost;
        db.run('UPDATE stock_movements SET unit_cost=?,total_cost=?,cost_method=? WHERE id=?',[money(unitCost),money(total),'MIGRATION_V3',m.id]);
      }
      setMeta('inventory_cost_v3_migrated','1');
    });
  }

  // Legacy stock reconciliation: every stored stock value must have an auditable ledger origin.
  // Older versions could have stock without a corresponding movement. Create an OPENING movement,
  // or a one-time ADJUST_IN/ADJUST_OUT reconciliation for mismatched legacy balances.
  for (const product of rows('SELECT id,name,stock FROM products')) {
    const ledger = Number(rows('SELECT COALESCE(SUM(quantity),0) total FROM stock_movements WHERE product_id=?',[product.id])[0]?.total || 0);
    const stored = Number(product.stock || 0);
    const delta = stored - ledger;
    if (Math.abs(delta) > 0.000001) {
      const type = delta > 0 ? 'OPENING' : 'ADJUST_OUT';
      db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",[newId('mov'),product.id,null,type,delta,Number(product.purchase_price||0),Math.abs(delta)*Number(product.purchase_price||0),'MIGRATION_V3',now,'تطبیق موجودی اولیه نسخه قدیمی']);
    }
  }

  // Stock v2: the ledger is the single source of truth; products.stock is only a materialized cache.
  // Rebuild the cache from the ledger after the legacy reconciliation above.
  withTransaction(() => {
    const stamp = new Date().toISOString();
    for (const product of rows('SELECT id FROM products')) syncProductStockFromLedger(product.id, stamp);
    db.run("INSERT OR REPLACE INTO app_meta(key,value) VALUES('stock_ledger_authoritative_v2','1')");
  });

  // Customer account migration: reconstruct a real ledger from legacy account sales/returns,
  // then reconcile any remaining legacy balance as an explicit opening adjustment.
  if (!rows("SELECT 1 FROM app_meta WHERE key='customer_ledger_v1_migrated'").length) {
    withTransaction(() => {
      for (const c of rows('SELECT * FROM customers ORDER BY created_at, id')) {
        const existing = Number(rows('SELECT COUNT(*) c FROM customer_ledger WHERE customer_id=?',[c.id])[0]?.c || 0);
        if (existing > 0) continue;
        let running = 0;
        const accountSales = rows(`
          SELECT p.id, p.amount, p.created_at, i.id invoice_id, i.invoice_no
          FROM payments p JOIN invoices i ON i.id=p.invoice_id
          WHERE i.customer_id=? AND p.method='ACCOUNT'
          ORDER BY p.created_at, p.id`, [c.id]);
        for (const x of accountSales) {
          const amount = money(x.amount); if (amount <= 0) continue; running = money(running + amount);
          db.run(`INSERT INTO customer_ledger(id,customer_id,entry_type,direction,amount,balance_after,reference_type,reference_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [newId('cled'),c.id,'SALE_CREDIT','DEBIT',amount,running,'PAYMENT',x.id,`فروش اعتباری فاکتور ${x.invoice_no}`,x.created_at]);
        }
        const accountReturns = rows(`
          SELECT r.id, r.amount, r.created_at, sr.return_no, sr.invoice_id
          FROM refunds r JOIN sales_returns sr ON sr.id=r.return_id
          WHERE r.method='ACCOUNT' AND sr.invoice_id IN (SELECT id FROM invoices WHERE customer_id=?)
          ORDER BY r.created_at, r.id`, [c.id]);
        for (const x of accountReturns) {
          const amount = money(x.amount); if (amount <= 0) continue; running = money(running - amount);
          db.run(`INSERT INTO customer_ledger(id,customer_id,entry_type,direction,amount,balance_after,reference_type,reference_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [newId('cled'),c.id,'SALES_RETURN','CREDIT',amount,running,'REFUND',x.id,`برگشت از فروش ${x.return_no}`,x.created_at]);
        }
        const legacy = money(c.balance);
        const diff = money(legacy - running);
        if (Math.abs(diff) > 0.000001) {
          const debit = diff > 0; const amount = Math.abs(diff); running = money(running + (debit ? amount : -amount));
          db.run(`INSERT INTO customer_ledger(id,customer_id,entry_type,direction,amount,balance_after,reference_type,reference_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [newId('cled'),c.id,'OPENING_ADJUSTMENT',debit?'DEBIT':'CREDIT',amount,running,'MIGRATION',c.id,'تطبیق مانده حساب نسخه قدیمی',now]);
        }
        db.run('UPDATE customers SET balance=?,updated_at=? WHERE id=?',[running,now,c.id]);
      }
      setMeta('customer_ledger_v1_migrated','1');
    });
  }

  // Phase 13: local users/roles/permissions migration. Existing installations receive a secure local admin.
  const permissionLabels = {
    'dashboard.view':'مشاهده پیشخوان','sales.create':'فروش و صدور فاکتور','sales.return':'مرجوعی فروش','products.manage':'مدیریت کالا و قیمت','inventory.manage':'مدیریت انبار','reports.view':'گزارش‌ها','customers.manage':'مدیریت مشتری و دریافت','cash.manage':'عملیات صندوق','accounting.view':'مشاهده حسابداری','audit.view':'مشاهده ردیابی','backup.create':'ایجاد/مشاهده پشتیبان','backup.restore':'بازیابی پشتیبان','backup.settings':'تنظیمات پشتیبان','sync.manage':'همگام‌سازی و تنظیمات آمیما','users.manage':'مدیریت کاربران'
  };
  const nowUsers = new Date().toISOString();
  for (const [name,display_name] of Object.entries(permissionLabels)) db.run('INSERT OR IGNORE INTO permissions(id,name,display_name) VALUES(?,?,?)',[name,name,display_name]);
  db.run('INSERT OR IGNORE INTO roles(id,name,display_name,created_at) VALUES(?,?,?,?)',['role-admin','admin','مدیر سیستم',nowUsers]);
  db.run('INSERT OR IGNORE INTO roles(id,name,display_name,created_at) VALUES(?,?,?,?)',['role-cashier','cashier','صندوق‌دار',nowUsers]);
  const adminPerms=Object.keys(permissionLabels);
  const cashierPerms=['dashboard.view','sales.create','sales.return','reports.view','customers.manage','cash.manage'];
  for (const perm of adminPerms) db.run('INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES(?,?)',['role-admin',perm]);
  for (const perm of cashierPerms) db.run('INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES(?,?)',['role-cashier',perm]);
  if (!rows("SELECT 1 FROM users WHERE username='admin'").length) {
    const salt=crypto.randomBytes(16).toString('hex');
    const hash=crypto.scryptSync('admin1234',salt,32,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('hex');
    db.run('INSERT INTO users(id,username,display_name,password_hash,active,role_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',[newId('usr'),'admin','مدیر سیستم',`scrypt$16384$8$1$${salt}$${hash}`,1,'role-admin',nowUsers,nowUsers]);
  }
  if (!rows("SELECT 1 FROM app_meta WHERE key='permissions_v1_migrated'").length) setMeta('permissions_v1_migrated','1');

  if (!rows("SELECT 1 FROM app_meta WHERE key='auto_backup_enabled'").length) setMeta('auto_backup_enabled', '1');
  if (!rows("SELECT 1 FROM app_meta WHERE key='auto_backup_interval_hours'").length) setMeta('auto_backup_interval_hours', '6');
  if (!rows("SELECT 1 FROM app_meta WHERE key='sync_protocol'").length) setMeta('sync_protocol', 'amima-pos-sync-v1');
  if (!rows("SELECT 1 FROM app_meta WHERE key='invoice_sequence'").length) { const maxNo=Number(rows("SELECT COALESCE(MAX(invoice_no),0) m FROM invoices")[0]?.m||0); setMeta('invoice_sequence', String(maxNo)); }
  if (!rows("SELECT 1 FROM app_meta WHERE key='purchase_sequence'").length) { const maxNo=Number(rows("SELECT COALESCE(MAX(purchase_no),0) m FROM purchase_invoices")[0]?.m||0); setMeta('purchase_sequence', String(maxNo)); }
}

function seedData() {
  const now = new Date().toISOString();
  const cat = 'cat-herbal';
  db.run("INSERT INTO categories(id,name,created_at) VALUES(?,?,?)", [cat, 'گیاهان دارویی', now]);
  const samples = [
    ['p-gol','گل گاوزبان',30000,80000,1000,'گرم',10000,150,'1'],
    ['p-senjed','سنجد',20000,40000,700,'گرم',8000,150,'2'],
    ['p-dar','دارچین',150000,220000,300,'گرم',3000,100,'3'],
    ['p-zanj','زنجبیل',120000,180000,500,'گرم',5000,100,'4']
  ];
  for (const [id,name,buy,sale,stock,unit,minStock] of samples) {
    db.run(
      "INSERT INTO products(id,name,purchase_price,sale_price_per_unit,unit,stock,min_stock,category_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [id,name,buy,sale,unit,stock,minStock,cat,now,now]
    );
    const tiers = [
      [1,150,sale],
      [151,350,Math.round(sale*0.90)],
      [351,600,Math.round(sale*0.84)],
      [601,950,Math.round(sale*0.78)],
      [951,null,Math.round(sale*0.72)]
    ];
    tiers.forEach((t,i)=>db.run(
      "INSERT INTO product_tiers(id,product_id,min_qty,max_qty,price_per_unit,tier_order) VALUES(?,?,?,?,?,?)",
      [`${id}-t${i+1}`,id,t[0],t[1],t[2],i+1]
    ));
  }
  const invoiceId = newId('inv');
  db.run("INSERT INTO invoices(id,invoice_no,status,created_at,updated_at) VALUES(?,?,?,?,?)",
    [invoiceId,nextInvoiceNo(),'OPEN',now,now]);
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nextInvoiceNo() {
  const current = Number(rows("SELECT value FROM app_meta WHERE key='invoice_sequence'")[0]?.value || 0);
  const next = current + 1;
  setMeta('invoice_sequence', String(next));
  return next;
}
function nextReturnNo() {
  const row = rows("SELECT value FROM app_meta WHERE key='return_sequence'")[0];
  const next = Number(row?.value || 0) + 1;
  db.run("INSERT INTO app_meta(key,value) VALUES('return_sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(next)]);
  return next;
}


function rows(sql, params=[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out=[];
  while(stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function saveDb() {
  if (!db) return;
  try { db.raw.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
}

function money(n) {
  return Math.round(Number(n)||0);
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localMonthKey(date = new Date()) {
  return localDateKey(date).slice(0, 7);
}

function assertFiniteNonNegative(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} نامعتبر است`);
  return n;
}

function assertPositive(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} نامعتبر است`);
  return n;
}

function withTransaction(work) {
  db.run('BEGIN TRANSACTION');
  try {
    const result = work();
    db.run('COMMIT');
    saveDb();
    return result;
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (_) {}
    throw err;
  }
}


// Business Core context bootstrap.
// فعلاً فقط Context ساخته می‌شود؛ Handlerهای فعلی دست‌نخورده‌اند.
let dashboardCore = null;

function createBusinessCoreContext() {
  return createCoreContext({
    db,
    rows,
    money,
    newId,
    withTransaction,
    localDateKey,
    localMonthKey,
    currentActor,
    auditLog,
    queueSync,
    insertCashMovement,
    invoiceDetail
  });
}

function tierFor(productId, qty) {
  const q = Number(qty);
  if (!(q > 0)) return null;
  const tiers = rows(
    "SELECT tier_order,min_qty,max_qty,price_per_unit FROM product_tiers WHERE product_id=? ORDER BY min_qty ASC,tier_order ASC",
    [productId]
  );
  return tiers.find(t => {
    const min = Number(t.min_qty);
    const max = t.max_qty === null || t.max_qty === undefined || Number(t.max_qty) === 0 ? null : Number(t.max_qty);
    return q >= min && (max === null || q <= max);
  }) || null;
}

function repriceInvoiceProduct(invoiceId, productId) {
  const p = rows("SELECT * FROM products WHERE id=? AND active=1", [productId])[0];
  if (!p) throw new Error('کالا پیدا نشد');
  const totalRow = rows("SELECT COALESCE(SUM(quantity),0) qty FROM invoice_items WHERE invoice_id=? AND product_id=?", [invoiceId, productId])[0];
  const totalQty = Number(totalRow?.qty || 0);
  if (!(totalQty > 0)) return;
  const existing = rows("SELECT tier_order,unit_price FROM invoice_items WHERE invoice_id=? AND product_id=? LIMIT 1", [invoiceId,productId])[0];
  if (existing && Number(existing.tier_order) === -1) {
    const manual = money(existing.unit_price);
    db.run("UPDATE invoice_items SET unit_price=?, amount=ROUND(quantity * ?,0), tier_order=-1 WHERE invoice_id=? AND product_id=?", [manual, manual, invoiceId, productId]);
    return;
  }
  const tier = tierFor(productId, totalQty);
  const price = money(tier ? tier.price_per_unit : p.sale_price_per_unit);
  db.run("UPDATE invoice_items SET unit_price=?, amount=ROUND(quantity * ?,0), tier_order=? WHERE invoice_id=? AND product_id=?", [price, price, tier?.tier_order || null, invoiceId, productId]);
}

function invoiceDetail(invoiceId) {
  const inv = rows("SELECT * FROM invoices WHERE id=?", [invoiceId])[0];
  if (!inv) return null;
  const items = rows("SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY rowid", [invoiceId]);
  return { ...inv, items };
}

function encryptSyncToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('رمزنگاری امن سیستم‌عامل برای ذخیره توکن در دسترس نیست');
  return `dpapi:${safeStorage.encryptString(value).toString('base64')}`;
}
function decryptSyncToken(stored) {
  const value = String(stored || '');
  if (!value) return '';
  if (!value.startsWith('dpapi:')) return value;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('رمزنگاری امن سیستم‌عامل برای خواندن توکن در دسترس نیست');
  return safeStorage.decryptString(Buffer.from(value.slice(6), 'base64'));
}
function migrateSyncTokenStorage() {
  const r = rows("SELECT id,api_token FROM sync_device LIMIT 1")[0];
  if (!r || !r.api_token || String(r.api_token).startsWith('dpapi:') || !safeStorage.isEncryptionAvailable()) return;
  db.run("UPDATE sync_device SET api_token=?,updated_at=? WHERE id=?", [encryptSyncToken(r.api_token),new Date().toISOString(),r.id]);
}
function syncConfig(includeSecret=false) {
  const r = rows("SELECT * FROM sync_device LIMIT 1")[0];
  if (!r) return null;
  const out = { ...r, enabled: Number(r.enabled) === 1 };
  delete out.api_token;
  out.token_configured = !!r.api_token;
  if (includeSecret) out.api_token = decryptSyncToken(r.api_token);
  return out;
}
function syncToken() {
  const r = rows("SELECT api_token FROM sync_device LIMIT 1")[0];
  return decryptSyncToken(r?.api_token || '');
}
function syncSafeId(entityType, id) {
  return `${entityType}:${id}`;
}

function canonicalPayload(entityType, id) {
  const queries = {
    category: ["SELECT * FROM categories WHERE id=?", [id]],
    product: ["SELECT * FROM products WHERE id=?", [id]],
    customer: ["SELECT * FROM customers WHERE id=?", [id]],
    invoice: ["SELECT * FROM invoices WHERE id=?", [id]],
    invoice_item: ["SELECT * FROM invoice_items WHERE id=?", [id]],
    stock_movement: ["SELECT * FROM stock_movements WHERE id=?", [id]],
    payment: ["SELECT * FROM payments WHERE id=?", [id]],
    cash_register: ["SELECT * FROM cash_registers WHERE id=?", [id]],
    cash_movement: ["SELECT * FROM cash_movements WHERE id=?", [id]],
    customer_ledger: ["SELECT * FROM customer_ledger WHERE id=?", [id]],
    accounting_entry: ["SELECT * FROM accounting_entries WHERE id=?", [id]],
    audit_log: ["SELECT * FROM audit_log WHERE id=?", [id]],
    sales_return: ["SELECT * FROM sales_returns WHERE id=?", [id]],
    sales_return_item: ["SELECT * FROM sales_return_items WHERE id=?", [id]],
    refund: ["SELECT * FROM refunds WHERE id=?", [id]]
  };
  const q = queries[entityType];
  if (!q) return null;
  const row = rows(q[0], q[1])[0];
  if (!row) return null;
  if (entityType === 'product') row.tiers = rows("SELECT min_qty,max_qty,price_per_unit,tier_order FROM product_tiers WHERE product_id=? ORDER BY tier_order", [id]);
  if (entityType === 'invoice') row.items = rows("SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY rowid", [id]);
  if (entityType === 'invoice') row.payments = rows("SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at", [id]);
  if (entityType === 'accounting_entry') row.lines = rows("SELECT * FROM accounting_lines WHERE entry_id=? ORDER BY rowid", [id]);
  if (entityType === 'sales_return') row.items = rows("SELECT * FROM sales_return_items WHERE return_id=? ORDER BY created_at,id", [id]);
  return row;
}

function queueSync(entityType, entityId, operation='UPSERT', payload=null) {
  if (!db) return;
  const now = new Date().toISOString();
  const body = payload || canonicalPayload(entityType, entityId) || (operation === 'DELETE' ? { id: entityId, entity_type: entityType } : null);
  if (!body) return;
  const versionRow = rows("SELECT COALESCE(MAX(local_version),0)+1 v FROM sync_outbox WHERE entity_type=? AND entity_id=?", [entityType, entityId])[0];
  const version = Number(versionRow?.v || 1);
  const baseRow = rows("SELECT value FROM sync_state WHERE key=?", [`server_version:${entityType}:${entityId}`])[0];
  const baseServerVersion = Number(baseRow?.value || 0);
  db.run(`INSERT OR IGNORE INTO sync_outbox(id,entity_type,entity_id,operation,local_version,base_server_version,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, 'PENDING',?,?)`,
    [newId('sync'), entityType, entityId, operation, version, baseServerVersion, JSON.stringify(body), now, now]);
}

function queueEntityTree(entityType, entityId) {
  queueSync(entityType, entityId);
  if (entityType === 'product') {
    rows("SELECT id FROM product_tiers WHERE product_id=?", [entityId]).forEach(r => queueSync('product', entityId));
  }
}

function buildSyncBundle() {
  const cfg = syncConfig();
  const pending = rows("SELECT * FROM sync_outbox WHERE status IN ('PENDING','RETRY') ORDER BY created_at LIMIT 500");
  const conflicts = rows("SELECT * FROM sync_conflicts WHERE resolution='PENDING' ORDER BY created_at DESC LIMIT 100");
  return {
    protocol: 'amima-pos-sync-v2',
    device: cfg ? { device_id: cfg.device_id, name: cfg.name } : null,
    generated_at: new Date().toISOString(),
    changes: pending.map(x => ({ id:x.id, entity_type:x.entity_type, entity_id:x.entity_id, operation:x.operation, local_version:x.local_version, base_server_version:x.base_server_version, payload:JSON.parse(x.payload_json) })),
    conflicts
  };
}

function httpJson(urlString, method, body, token, extraHeaders={}) {
  return new Promise((resolve,reject)=>{
    let url;
    try { url = new URL(urlString); } catch (_) { return reject(new Error('آدرس API نامعتبر است')); }
    const lib = url.protocol === 'https:' ? https : http;
    const data = body == null ? '' : JSON.stringify(body);
    const req = lib.request({hostname:url.hostname,port:url.port || (url.protocol==='https:'?443:80),path:url.pathname+url.search,method,headers:{'Content-Type':'application/json','Accept':'application/json','Content-Length':Buffer.byteLength(data), ...(token?{'Authorization':`Bearer ${token}`}: {}), ...extraHeaders},timeout:15000}, res=>{
      let raw=''; res.setEncoding('utf8'); res.on('data',c=>raw+=c); res.on('end',()=>{let parsed=null;try{parsed=raw?JSON.parse(raw):{};}catch(_){parsed={raw};} if(res.statusCode>=200&&res.statusCode<300)resolve(parsed);else reject(new Error(`API ${res.statusCode}: ${parsed?.message||'خطای سرور'}`));});
    });
    req.on('timeout',()=>req.destroy(new Error('زمان اتصال به API تمام شد'))); req.on('error',reject); if(data)req.write(data); req.end();
  });
}

function applyServerChanges(changes=[]) {
  const applied=[];
  for (const ch of changes) {
    const type=String(ch.entity_type||''); const id=String(ch.entity_id||''); const serverVersion=Number(ch.server_version||0); const payload=ch.payload||{};
    if(!type||!id) continue;
    const knownServerVersion = Number(rows("SELECT value FROM sync_state WHERE key=?", [`server_version:${type}:${id}`])[0]?.value || 0);
    if (serverVersion > 0 && serverVersion <= knownServerVersion) { applied.push(id); continue; }
    if (ch.operation==='DELETE' && type==='invoice_item') { db.run("DELETE FROM invoice_items WHERE id=?", [id]); applied.push(id); continue; }
    // Append-only/ledger entities are identified by their stable local IDs; re-applying is a no-op.
    if(['customer_ledger','accounting_entry','audit_log','sales_return','sales_return_item','refund','cash_movement','stock_movement','payment','invoice_item'].includes(type) && ch.operation==='UPSERT' && rows(`SELECT id FROM ${type==='customer_ledger'?'customer_ledger':type==='accounting_entry'?'accounting_entries':type==='audit_log'?'audit_log':type==='sales_return'?'sales_returns':type==='sales_return_item'?'sales_return_items':type==='refund'?'refunds':type==='cash_movement'?'cash_movements':type==='stock_movement'?'stock_movements':type==='payment'?'payments':'invoice_items'} WHERE id=?`,[id]).length){
      applied.push(id); continue;
    }
    const existingConflict=rows("SELECT id FROM sync_conflicts WHERE entity_type=? AND entity_id=? AND resolution='PENDING' LIMIT 1",[type,id])[0];
    if(existingConflict) continue;
    const localPending=rows("SELECT * FROM sync_outbox WHERE entity_type=? AND entity_id=? AND status IN ('PENDING','RETRY') ORDER BY local_version DESC LIMIT 1",[type,id])[0];
    if(localPending && serverVersion && Number(localPending.base_server_version||0) < serverVersion){
      db.run("INSERT INTO sync_conflicts(id,entity_type,entity_id,local_version,server_version,local_payload_json,server_payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",[newId('conf'),type,id,localPending.local_version,serverVersion,localPending.payload_json,JSON.stringify(payload),new Date().toISOString()]);
      continue;
    }
    const now=new Date().toISOString();
    if(ch.operation==='DELETE') {
      if(type==='product') db.run("UPDATE products SET active=0,updated_at=? WHERE id=?",[now,id]);
      else if(type==='customer') db.run("DELETE FROM customers WHERE id=?",[id]);
      applied.push(id); continue;
    }
    if(type==='product'){
      const tiers=Array.isArray(payload.tiers)?payload.tiers:[];
      const exists=rows("SELECT id FROM products WHERE id=?",[id]).length>0;
      if(exists) db.run("UPDATE products SET name=?,purchase_price=?,sale_price_per_unit=?,unit=?,min_stock=?,category_id=?,active=?,updated_at=? WHERE id=?",[payload.name,payload.purchase_price,payload.sale_price_per_unit,payload.unit,payload.min_stock,payload.category_id,payload.active??1,now,id]);
      else db.run("INSERT INTO products(id,name,purchase_price,sale_price_per_unit,unit,stock,min_stock,category_id,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[id,payload.name,payload.purchase_price,payload.sale_price_per_unit,payload.unit,0,payload.min_stock||0,payload.category_id||null,payload.active??1,payload.created_at||now,now]);
      db.run("DELETE FROM product_tiers WHERE product_id=?",[id]); tiers.forEach((t,i)=>db.run("INSERT INTO product_tiers(id,product_id,min_qty,max_qty,price_per_unit,tier_order) VALUES(?,?,?,?,?,?)",[newId('tier'),id,t.min_qty,t.max_qty,t.price_per_unit,t.tier_order||i+1]));
    } else if(type==='invoice') {
      const exists=rows("SELECT id FROM invoices WHERE id=?",[id]).length>0;
      if(exists) db.run("UPDATE invoices SET invoice_no=?,status=?,subtotal=?,discount=?,total=?,payment_method=?,customer_id=?,created_at=?,updated_at=?,closed_at=? WHERE id=?",[payload.invoice_no,payload.status,payload.subtotal||0,payload.discount||0,payload.total||0,payload.payment_method||null,payload.customer_id||null,payload.created_at||now,payload.updated_at||now,payload.closed_at||null,id]);
      else db.run("INSERT INTO invoices(id,invoice_no,status,subtotal,discount,total,payment_method,customer_id,created_at,updated_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[id,payload.invoice_no,payload.status||'OPEN',payload.subtotal||0,payload.discount||0,payload.total||0,payload.payment_method||null,payload.customer_id||null,payload.created_at||now,payload.updated_at||now,payload.closed_at||null]);
      if(Array.isArray(payload.items)) { for(const it of payload.items) { const itemExists=rows("SELECT id FROM invoice_items WHERE id=?",[it.id]).length>0; if(!itemExists) db.run("INSERT INTO invoice_items(id,invoice_id,product_id,product_name,quantity,unit,unit_price,purchase_unit_price,amount,tier_order) VALUES(?,?,?,?,?,?,?,?,?,?)",[it.id,id,it.product_id,it.product_name,it.quantity,it.unit,it.unit_price,it.purchase_unit_price||0,it.amount,it.tier_order||null]); } }
    } else if(type==='payment') {
      if(!rows("SELECT id FROM payments WHERE id=?",[id]).length) db.run("INSERT INTO payments(id,invoice_id,method,amount,created_at) VALUES(?,?,?,?,?)",[id,payload.invoice_id,payload.method,payload.amount,payload.created_at||now]);
    } else if(type==='invoice_item') {
      if(!rows("SELECT id FROM invoice_items WHERE id=?",[id]).length) db.run("INSERT INTO invoice_items(id,invoice_id,product_id,product_name,quantity,unit,unit_price,purchase_unit_price,amount,tier_order) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,payload.invoice_id,payload.product_id,payload.product_name,payload.quantity,payload.unit,payload.unit_price,payload.purchase_unit_price||0,payload.amount,payload.tier_order||null]);
    } else if(type==='stock_movement') {
      const exists = rows("SELECT id FROM stock_movements WHERE id=?",[id]).length > 0;
      if(!exists) {
        const productId=payload.product_id;
        const p=rows("SELECT stock FROM products WHERE id=?",[productId])[0];
        if(!p) throw new Error(`کالای گردش ${productId} در صندوق پیدا نشد`);
        const delta=Number(payload.quantity||0);
        if(ledgerStock(productId)+delta<0) throw new Error(`اعمال گردش ${id} باعث منفی شدن موجودی می‌شود`);
        db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note,source_type,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",[id,productId,payload.invoice_id||null,payload.movement_type,delta,Number(payload.unit_cost||0),Number(payload.total_cost||0),'SYNC_V3',payload.created_at||now,payload.note||null,payload.source_type||null,payload.source_id||null]);
        syncProductStockFromLedger(productId, now);
      }
    } else if(type==='category'){
      db.run("INSERT INTO categories(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",[id,payload.name,payload.created_at||now]);
    } else if(type==='customer'){
      const ledgerExists=rows("SELECT 1 FROM customer_ledger WHERE customer_id=? LIMIT 1",[id]).length>0;
      const ledgerBalance=ledgerExists ? Number(rows("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) b FROM customer_ledger WHERE customer_id=?",[id])[0]?.b||0) : Number(payload.balance||0);
      db.run("INSERT INTO customers(id,name,phone,balance,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,balance=?,updated_at=excluded.updated_at",[id,payload.name,payload.phone||null,ledgerBalance,payload.created_at||now,payload.updated_at||now,ledgerBalance]);
    } else if(type==='customer_ledger'){
      const cid=payload.customer_id; if(!cid) throw new Error('گردش مشتری بدون customer_id');
      if(!rows("SELECT id FROM customers WHERE id=?",[cid]).length) db.run("INSERT INTO customers(id,name,phone,balance,created_at,updated_at) VALUES(?,?,?,?,?,?)",[cid,payload.customer_name||'مشتری همگام‌شده',payload.customer_phone||null,0,payload.created_at||now,payload.created_at||now]);
      db.run("INSERT OR IGNORE INTO customer_ledger(id,customer_id,entry_type,direction,amount,balance_after,reference_type,reference_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,cid,payload.entry_type,payload.direction,payload.amount,payload.balance_after||0,payload.reference_type||null,payload.reference_id||null,payload.note||'',payload.created_at||now]);
      const bal=Number(rows("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) b FROM customer_ledger WHERE customer_id=?",[cid])[0]?.b||0); db.run("UPDATE customers SET balance=?,updated_at=? WHERE id=?",[money(bal),now,cid]);
    } else if(type==='cash_register'){
      db.run("INSERT INTO cash_registers(id,opened_at,closed_at,opening_cash,closing_cash,expected_cash,status,note,discrepancy) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET opened_at=excluded.opened_at,closed_at=excluded.closed_at,opening_cash=excluded.opening_cash,closing_cash=excluded.closing_cash,expected_cash=excluded.expected_cash,status=excluded.status,note=excluded.note,discrepancy=excluded.discrepancy",[id,payload.opened_at||now,payload.closed_at||null,payload.opening_cash||0,payload.closing_cash??null,payload.expected_cash??null,payload.status||'OPEN',payload.note||'',payload.discrepancy||0]);
    } else if(type==='cash_movement'){
      const rid=payload.register_id; if(!rid) throw new Error('گردش صندوق بدون register_id');
      if(!rows("SELECT id FROM cash_registers WHERE id=?",[rid]).length) db.run("INSERT INTO cash_registers(id,opened_at,opening_cash,status,note,discrepancy) VALUES(?,?,?,?,?,0)",[rid,payload.created_at||now,0,'OPEN','همگام‌شده']);
      db.run("INSERT OR IGNORE INTO cash_movements(id,register_id,movement_type,amount,note,created_at,direction,category,reference_type,reference_id) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,rid,payload.movement_type,payload.amount,payload.note||'',payload.created_at||now,payload.direction||'IN',payload.category||'GENERAL',payload.reference_type||null,payload.reference_id||null]);
    } else if(type==='accounting_entry'){
      db.run("INSERT OR IGNORE INTO accounting_entries(id,entry_no,entry_type,reference_type,reference_id,description,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",[id,payload.entry_no||nextAccountingEntryNo(),payload.entry_type,payload.reference_type||null,payload.reference_id||null,payload.description||'',payload.created_at||now,payload.created_by||'sync']);
      if(Array.isArray(payload.lines)){ for(const l of payload.lines){ db.run("INSERT OR IGNORE INTO accounting_lines(id,entry_id,account_code,account_name,debit,credit,note) VALUES(?,?,?,?,?,?,?)",[l.id||newId('jline'),id,l.account_code,l.account_name,l.debit||0,l.credit||0,l.note||'']); } }
    } else if(type==='audit_log'){
      db.run("INSERT OR IGNORE INTO audit_log(id,actor_id,actor_name,action,entity_type,entity_id,reference_type,reference_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,payload.actor_id||'sync',payload.actor_name||'همگام‌سازی',payload.action||'SYNC',payload.entity_type||'SYSTEM',payload.entity_id||null,payload.reference_type||null,payload.reference_id||null,payload.details_json||null,payload.created_at||now]);
    } else if(type==='sales_return'){
      db.run("INSERT OR IGNORE INTO sales_returns(id,invoice_id,return_no,status,subtotal,refund_total,refund_method,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)",[id,payload.invoice_id,payload.return_no,payload.status||'COMPLETED',payload.subtotal||0,payload.refund_total||0,payload.refund_method,payload.note||'',payload.created_at||now]);
    } else if(type==='sales_return_item'){
      db.run("INSERT OR IGNORE INTO sales_return_items(id,return_id,invoice_item_id,product_id,product_name,quantity,unit,unit_price,refund_amount,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,payload.return_id,payload.invoice_item_id,payload.product_id,payload.product_name,payload.quantity,payload.unit,payload.unit_price,payload.refund_amount,payload.created_at||now]);
    } else if(type==='refund'){
      db.run("INSERT OR IGNORE INTO refunds(id,invoice_id,return_id,method,amount,created_at) VALUES(?,?,?,?,?,?)",[id,payload.invoice_id,payload.return_id,payload.method,payload.amount,payload.created_at||now]);
    }
    applied.push(id);
  }
  return applied;
}

function hashPassword(password){
  const value=String(password||''); if(value.length<6) throw new Error('رمز عبور باید حداقل ۶ کاراکتر باشد');
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(value,salt,32,{N:16384,r:8,p:1,maxmem:32*1024*1024}).toString('hex');
  return `scrypt$16384$8$1$${salt}$${hash}`;
}
function verifyPassword(password,stored){
  try{ const parts=String(stored||'').split('$'); if(parts.length!==6||parts[0]!=='scrypt') return false; const N=Number(parts[1]),r=Number(parts[2]),q=Number(parts[3]); const salt=parts[4],expected=Buffer.from(parts[5],'hex'); const actual=crypto.scryptSync(String(password||''),salt,expected.length,{N,r,p:q,maxmem:32*1024*1024}); return crypto.timingSafeEqual(actual,expected); }catch(_){ return false; }
}
function userPermissions(userId){
  return rows(`SELECT p.name FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id JOIN permissions p ON p.id=rp.permission_id WHERE u.id=? AND u.active=1`,[userId]).map(x=>x.name);
}
function hasPermission(permission){ return !!sessionUser && sessionUser.permissions.includes(permission); }
function requirePermission(permission){ if(!sessionUser) throw new Error('ابتدا وارد حساب کاربری شوید'); if(!hasPermission(permission)) throw new Error('دسترسی شما برای این عملیات مجاز نیست'); }
function installPermissionGate(){
  const original=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>original(channel,async(event,...args)=>{ if(!['auth:login','auth:logout','auth:current'].includes(channel) && !sessionUser) throw new Error('ابتدا وارد حساب کاربری شوید'); const perm=CHANNEL_PERMISSIONS[channel]; if(perm) requirePermission(perm); return handler(event,...args); });
}
installPermissionGate();

ipcMain.handle('auth:login', (_e,{username,password})=>{
  const u=rows(`SELECT u.*,r.name role_name,r.display_name role_display_name FROM users u JOIN roles r ON r.id=u.role_id WHERE lower(u.username)=lower(?) LIMIT 1`,[String(username||'').trim()])[0];
  if(!u || !u.active || !verifyPassword(password,u.password_hash)) throw new Error('نام کاربری یا رمز عبور نادرست است');
  sessionUser={id:u.id,username:u.username,displayName:u.display_name,roleId:u.role_id,roleName:u.role_name,roleDisplayName:u.role_display_name,permissions:userPermissions(u.id)};
  auditLog('LOGIN','USER',u.id,{username:u.username},'USER',u.id);
  return {...sessionUser,passwordHash:undefined};
});
ipcMain.handle('auth:logout',()=>{ const u=sessionUser; if(u) auditLog('LOGOUT','USER',u.id,{username:u.username},'USER',u.id); sessionUser=null; return true; });
ipcMain.handle('auth:current',()=>sessionUser?{...sessionUser}:null);
ipcMain.handle('users:list',()=>{ requirePermission(PERMISSIONS.USERS_MANAGE); return rows(`SELECT u.id,u.username,u.display_name,u.active,u.role_id,u.created_at,u.updated_at,r.name role_name,r.display_name role_display_name FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.username`); });
ipcMain.handle('users:create',(_e,{username,displayName,password,roleName='cashier'})=>{
  requirePermission(PERMISSIONS.USERS_MANAGE); const un=String(username||'').trim().toLowerCase(), dn=String(displayName||'').trim(); if(!/^[a-z0-9_.-]{3,40}$/.test(un)) throw new Error('نام کاربری باید ۳ تا ۴۰ کاراکتر انگلیسی باشد');
  const role=rows('SELECT id,name,display_name FROM roles WHERE name=?',[roleName])[0]; if(!role) throw new Error('نقش کاربر پیدا نشد'); if(rows('SELECT 1 FROM users WHERE username=?',[un]).length) throw new Error('این نام کاربری قبلاً ثبت شده است'); const now=new Date().toISOString(),id=newId('usr');
  db.run('INSERT INTO users(id,username,display_name,password_hash,active,role_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',[id,un,dn||un,hashPassword(password),1,role.id,now,now]); auditLog('USER_CREATE','USER',id,{username:un,role:role.name},'USER',id,now); return rows('SELECT u.id,u.username,u.display_name,u.active,u.role_id,r.name role_name,r.display_name role_display_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?',[id])[0];
});
ipcMain.handle('users:set-password',(_e,{userId,password})=>{ requirePermission(PERMISSIONS.USERS_MANAGE); if(!rows('SELECT 1 FROM users WHERE id=?',[userId]).length) throw new Error('کاربر پیدا نشد'); db.run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?',[hashPassword(password),new Date().toISOString(),userId]); auditLog('USER_PASSWORD_CHANGE','USER',userId,null,'USER',userId); return true; });
ipcMain.handle('users:set-active',(_e,{userId,active})=>{ requirePermission(PERMISSIONS.USERS_MANAGE); if(sessionUser&&userId===sessionUser.id&&!active) throw new Error('نمی‌توانید حساب کاربری خودتان را غیرفعال کنید'); db.run('UPDATE users SET active=?,updated_at=? WHERE id=?',[active?1:0,new Date().toISOString(),userId]); auditLog(active?'USER_ENABLE':'USER_DISABLE','USER',userId,{active:!!active},'USER',userId); return true; });

ipcMain.handle('sync:config', () => syncConfig());
ipcMain.handle('sync:set-config', (_e,{apiUrl,apiToken,name,enabled}) => {
  const url=String(apiUrl||'').trim(); const suppliedToken=String(apiToken||'').trim(); const cleanName=String(name||'صندوق فروش').trim()||'صندوق فروش';
  if(url){ try { const u=new URL(url); if(u.protocol!=='https:') throw new Error(); } catch(_) { throw new Error('برای امنیت Sync، آدرس API باید با https:// شروع شود'); } }
  const now=new Date().toISOString(); return withTransaction(()=>{const c=syncConfig(true); const existing=rows("SELECT api_token FROM sync_device WHERE id=?",[c.id])[0]?.api_token||''; const token=suppliedToken ? encryptSyncToken(suppliedToken) : existing; db.run("UPDATE sync_device SET api_url=?,api_token=?,name=?,enabled=?,updated_at=? WHERE id=?",[url,token,cleanName,enabled?1:0,now,c.id]);return syncConfig();});
});
ipcMain.handle('sync:status', () => ({config:syncConfig(),pending:Number(rows("SELECT COUNT(*) c FROM sync_outbox WHERE status IN ('PENDING','RETRY')")[0]?.c||0),conflicts:Number(rows("SELECT COUNT(*) c FROM sync_conflicts WHERE resolution='PENDING'")[0]?.c||0),lastChanges:rows("SELECT id,entity_type,entity_id,operation,status,retry_count,last_error,updated_at FROM sync_outbox ORDER BY updated_at DESC LIMIT 20")}));
ipcMain.handle('sync:preview', () => buildSyncBundle());
ipcMain.handle('sync:run', async () => {
  const cfg=syncConfig(); if(!cfg?.enabled) throw new Error('همگام‌سازی فعال نیست'); if(!cfg.api_url) throw new Error('آدرس API تنظیم نشده است'); if(!/^https:\/\//i.test(cfg.api_url)) throw new Error('Sync فقط از HTTPS پشتیبانی می‌کند'); const token=syncToken(); if(!token) throw new Error('توکن Sync تنظیم نشده است');
  const now=new Date().toISOString();
  const syncBundle=buildSyncBundle();
  const pushIdempotencyKey=crypto.createHash('sha256').update(JSON.stringify(syncBundle.changes)).digest('hex');
  try {
    const push=await httpJson(cfg.api_url.replace(/\/$/,'')+'/api/v1/pos/sync/push','POST',syncBundle,token,{'X-Sync-Protocol':'amima-pos-sync-v2','X-Device-ID':cfg.device_id,'Idempotency-Key':pushIdempotencyKey});
    withTransaction(()=>{
      (push.acknowledged||[]).forEach(x=>db.run("UPDATE sync_outbox SET status='SYNCED',last_error=NULL,updated_at=? WHERE id=?",[now,x.id]));
      (push.conflicts||[]).forEach(x=>db.run("INSERT INTO sync_conflicts(id,entity_type,entity_id,local_version,server_version,local_payload_json,server_payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",[newId('conf'),x.entity_type,x.entity_id,x.local_version||null,x.server_version||null,x.local_payload?JSON.stringify(x.local_payload):null,x.server_payload?JSON.stringify(x.server_payload):null,now]));
      db.run("UPDATE sync_device SET last_push_at=?,last_error=NULL,updated_at=? WHERE id=?",[now,now,cfg.id]);
    });
    const pull=await httpJson(cfg.api_url.replace(/\/$/,'')+'/api/v1/pos/sync/pull','POST',{device_id:cfg.device_id,protocol:'amima-pos-sync-v2'},token,{'X-Sync-Protocol':'amima-pos-sync-v2','X-Device-ID':cfg.device_id,'Idempotency-Key':crypto.randomUUID?crypto.randomUUID():newId('idem')});
    const applied=withTransaction(()=>{ const ids=applyServerChanges(pull.changes||[]); (pull.changes||[]).forEach(x=>{ if(x.entity_type&&x.entity_id&&x.server_version!=null) db.run("INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[`server_version:${x.entity_type}:${x.entity_id}`,String(x.server_version)]); }); return ids; });
    withTransaction(()=>db.run("UPDATE sync_device SET last_pull_at=?,last_sync_at=?,last_error=NULL,updated_at=? WHERE id=?",[now,now,now,cfg.id]));
    return {ok:true,pushed:(push.acknowledged||[]).length,pulled:(pull.changes||[]).length,applied,conflicts:Number(rows("SELECT COUNT(*) c FROM sync_conflicts WHERE resolution='PENDING'")[0]?.c||0)};
  } catch(err){ withTransaction(()=>db.run("UPDATE sync_device SET last_error=?,updated_at=? WHERE id=?",[String(err.message||err),now,cfg.id])); throw err; }
});
ipcMain.handle('sync:conflicts', () => rows("SELECT * FROM sync_conflicts WHERE resolution='PENDING' ORDER BY created_at DESC LIMIT 100"));
ipcMain.handle('sync:resolve', (_e,{id,resolution}) => {
  const allowed=['KEEP_LOCAL','KEEP_SERVER']; if(!allowed.includes(resolution)) throw new Error('روش حل تعارض نامعتبر است');
  const c=rows("SELECT * FROM sync_conflicts WHERE id=? AND resolution='PENDING'",[id])[0]; if(!c) throw new Error('تعارض پیدا نشد');
  return withTransaction(()=>{ if(resolution==='KEEP_SERVER'){ applyServerChanges([{entity_type:c.entity_type,entity_id:c.entity_id,server_version:c.server_version,payload:c.server_payload_json?JSON.parse(c.server_payload_json):{},operation:'UPSERT'}]); } db.run("UPDATE sync_conflicts SET resolution=?,resolved_at=?,resolved_payload_json=? WHERE id=?",[resolution,new Date().toISOString(),resolution==='KEEP_LOCAL'?c.local_payload_json:c.server_payload_json,id]); return true; });
});

ipcMain.handle('app:get-dashboard', () => {
  const today = localDateKey();
  const salesToday = rows("SELECT COALESCE(SUM(total),0) total, COUNT(*) count FROM invoices WHERE status='PAID' AND date(closed_at,'localtime')=?", [today])[0];
  const month = localMonthKey();
  const salesMonth = rows("SELECT COALESCE(SUM(total),0) total FROM invoices WHERE status='PAID' AND strftime('%Y-%m',closed_at,'localtime')=?", [month])[0];
  const best = rows(`
    SELECT product_id, product_name, SUM(quantity) qty, SUM(amount) amount
    FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
    WHERE i.status='PAID' AND strftime('%Y-%m',i.closed_at,'localtime')=?
    GROUP BY product_id, product_name ORDER BY qty DESC LIMIT 5
  `,[month]);
  const low = rows("SELECT * FROM products WHERE active=1 AND stock <= min_stock ORDER BY stock ASC LIMIT 8");
  const open = rows("SELECT * FROM invoices WHERE status='OPEN' ORDER BY invoice_no");
  return { salesToday, salesMonth, best, low, open };
});

ipcMain.handle('products:list', () => rows(`
  SELECT p.*, c.name category_name
  FROM products p LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.active=1 ORDER BY p.name
`));

ipcMain.handle('products:search', (_e, q) => rows(`
  SELECT p.*, c.name category_name
  FROM products p LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.active=1 AND p.name LIKE ? ORDER BY p.name LIMIT 30
`, [`%${String(q||'').trim()}%`]));

ipcMain.handle('products:bulk-reprice', (_e, payload={}) => {
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE); const percentage=Number(payload.percentage);
  if(!Number.isFinite(percentage)||percentage<=0||percentage>1000) throw new Error('درصد تغییر قیمت باید بیشتر از صفر و حداکثر ۱۰۰۰٪ باشد');
  const direction=payload.direction==='decrease'?-1:1, signedPct=percentage*direction, factor=1+signedPct/100; if(factor<=0) throw new Error('کاهش قیمت نمی‌تواند قیمت را صفر یا منفی کند');
  const note=String(payload.note||'').trim()||`تغییر گروهی قیمت ${signedPct>0?'+':''}${signedPct}%`, now=new Date().toISOString(), batchId=newId('pricebatch');
  return withTransaction(()=>{const ps=rows('SELECT id,name,sale_price_per_unit FROM products WHERE active=1 ORDER BY name');let changedPrices=0;for(const product of ps){
    const oldBase=Number(product.sale_price_per_unit||0),newBase=money(oldBase*factor);
    if(newBase!==oldBase){db.run('UPDATE products SET sale_price_per_unit=?,updated_at=? WHERE id=?',[newBase,now,product.id]);db.run('INSERT INTO price_change_history(id,batch_id,product_id,price_type,tier_order,old_price,new_price,percentage,created_at,user_id,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[newId('pricehist'),batchId,product.id,'BASE',null,oldBase,newBase,signedPct,now,sessionUser?.id||null,note]);changedPrices++;}
    for(const tier of rows('SELECT id,tier_order,price_per_unit FROM product_tiers WHERE product_id=? ORDER BY tier_order',[product.id])){const oldPrice=Number(tier.price_per_unit||0),newPrice=money(oldPrice*factor);if(newPrice!==oldPrice){db.run('UPDATE product_tiers SET price_per_unit=? WHERE id=?',[newPrice,tier.id]);db.run('INSERT INTO price_change_history(id,batch_id,product_id,price_type,tier_order,old_price,new_price,percentage,created_at,user_id,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[newId('pricehist'),batchId,product.id,'TIER',tier.tier_order,oldPrice,newPrice,signedPct,now,sessionUser?.id||null,note]);changedPrices++;}}
    queueSync('product',product.id); auditLog('PRODUCT_BULK_REPRICE','PRODUCT',product.id,{batchId,productName:product.name,percentage:signedPct,baseOld:oldBase,baseNew:newBase,note},'PRODUCT',product.id,now);
  } return {batchId,percentage:signedPct,affectedProducts:ps.length,changedPrices,totalHistory:changedPrices,createdAt:now};});
});
ipcMain.handle('products:price-history', (_e, opts={}) => {requirePermission(PERMISSIONS.PRODUCTS_MANAGE);const limit=Math.min(200,Math.max(1,Number(opts.limit||50)));return rows(`SELECT h.*,p.name product_name FROM price_change_history h JOIN products p ON p.id=h.product_id ORDER BY h.created_at DESC,h.rowid DESC LIMIT ${limit}`);});

function validateProductTiers(inputTiers, salePrice) {
  const tiers = Array.isArray(inputTiers) ? inputTiers.map(t => ({...t})) : [];
  const STEP = 0.1;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const minQty = assertPositive(t.min_qty, `حداقل بازه ${i + 1}`);
    const rawMax = t.max_qty === null || t.max_qty === '' || Number(t.max_qty) === 0 ? null : assertPositive(t.max_qty, `حداکثر بازه ${i + 1}`);
    const tierPrice = assertFiniteNonNegative(t.price_per_unit, `قیمت پله ${i + 1}`);
    if (rawMax !== null && rawMax < minQty) throw new Error(`بازه قیمت ${i + 1} نامعتبر است`);
    if (i > 0) {
      const prevMax = tiers[i - 1].max_qty === null || tiers[i - 1].max_qty === '' || Number(tiers[i - 1].max_qty) === 0 ? null : Number(tiers[i - 1].max_qty);
      if (prevMax === null) throw new Error('پس از بازه نامحدود، بازه دیگری مجاز نیست');
      if (minQty <= prevMax) throw new Error('بازه‌های قیمت پله‌ای نباید هم‌پوشانی داشته باشند');
      if (Math.abs(minQty - (prevMax + STEP)) > 1e-9) throw new Error(`بین پله ${i} و ${i + 1} فاصله قیمتی وجود دارد؛ پله بعدی باید از ${prevMax + STEP} شروع شود`);
    }
    t.min_qty = minQty; t.max_qty = rawMax; t.price_per_unit = tierPrice;
  }
  if (tiers.length && !tiers[0].price_per_unit) tiers[0].price_per_unit = salePrice;
  if (tiers.length) {
    if (Number(tiers[0].min_qty) > 1) throw new Error('اولین پله قیمت باید از مقدار ۱ یا کمتر شروع شود');
    const lastMax = tiers[tiers.length - 1].max_qty;
    if (lastMax !== null && lastMax !== '' && Number(lastMax) !== 0) throw new Error('آخرین پله باید بازه نامحدود داشته باشد (تا = ∞)');
  }
  return tiers;
}

ipcMain.handle('products:save', (_e, p) => {
  const now = new Date().toISOString();
  const id = p.id || newId('prod');
  const name = String(p.name || '').trim();
  if (!name) throw new Error('نام کالا الزامی است');
  const purchasePrice = assertFiniteNonNegative(p.purchase_price, 'قیمت خرید');
  const salePrice = assertFiniteNonNegative(p.sale_price_per_unit, 'قیمت فروش');
  const minStock = assertFiniteNonNegative(p.min_stock, 'حداقل موجودی');
  const unit = String(p.unit || 'گرم').trim();
  if (!unit) throw new Error('واحد کالا نامعتبر است');

  const tiers = validateProductTiers(p.tiers, salePrice);

  const categoryId = p.category_id || null;
  const categoryName = categoryId ? String(p.category_name || '').trim() : '';
  if (categoryId && !categoryName) throw new Error('نام دسته‌بندی نامعتبر است');

  return withTransaction(() => {
    if (categoryId) {
      const exists = rows('SELECT id FROM categories WHERE id=?',[categoryId])[0];
      if (exists) db.run('UPDATE categories SET name=? WHERE id=?',[categoryName,categoryId]);
      else db.run('INSERT INTO categories(id,name,created_at) VALUES(?,?,?)',[categoryId,categoryName,now]);
      queueSync('category', categoryId);
    }
    let openingStock = 0;
    if (p.id) {
      const existing = rows('SELECT id FROM products WHERE id=?',[id])[0];
      if (!existing) throw new Error('کالا پیدا نشد');
      // موجودی دیگر در فرم ویرایش کالا قابل تغییر نیست؛ فقط عملیات انبار آن را تغییر می‌دهد.
      db.run(`UPDATE products SET name=?,purchase_price=?,sale_price_per_unit=?,unit=?,min_stock=?,category_id=?,updated_at=? WHERE id=?`,
        [name,purchasePrice,salePrice,unit,minStock,categoryId,now,id]);
      db.run("DELETE FROM product_tiers WHERE product_id=?", [id]);
    } else {
      openingStock = assertFiniteNonNegative(p.initial_stock ?? 0, 'موجودی اولیه');
      db.run(`INSERT INTO products(id,name,purchase_price,sale_price_per_unit,unit,stock,min_stock,category_id,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)`,
        [id,name,purchasePrice,salePrice,unit,0,minStock,categoryId,now,now]);
      if (openingStock > 0) {
        const movementId = newId('mov');
        db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
          [movementId,id,null,'OPENING',openingStock,purchasePrice,openingStock*purchasePrice,'MOVING_AVERAGE',now,'موجودی اولیه کالا']);
        syncProductStockFromLedger(id, now);
        queueSync('stock_movement', movementId);
      }
    }
    tiers.forEach((t,i)=>db.run(
      "INSERT INTO product_tiers(id,product_id,min_qty,max_qty,price_per_unit,tier_order) VALUES(?,?,?,?,?,?)",
      [newId('tier'),id,t.min_qty,t.max_qty,t.price_per_unit,i+1]
    ));
    queueSync('product', id);
    return id;
  });
});

ipcMain.handle('products:archive', (_e, productId) => {
  const id = String(productId || '');
  const p = rows('SELECT id,name,active FROM products WHERE id=?',[id])[0];
  if (!p) throw new Error('کالا پیدا نشد');
  const openUse = rows('SELECT COUNT(*) c FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE ii.product_id=? AND i.status=\'OPEN\'',[id])[0];
  if (Number(openUse?.c || 0) > 0) throw new Error('این کالا در یک فاکتور باز استفاده شده و فعلاً قابل آرشیو نیست');
  return withTransaction(()=>{ const now=new Date().toISOString(); db.run('UPDATE products SET active=0,updated_at=? WHERE id=?',[now,id]); queueSync('product', id, 'DELETE'); auditLog('PRODUCT_ARCHIVE','PRODUCT',id,{name:p.name},'PRODUCT',id,now); return true; });
});

function nextPurchaseNo() {
  const current = Number(rows("SELECT value FROM app_meta WHERE key='purchase_sequence'")[0]?.value || 0);
  const next = current + 1;
  setMeta('purchase_sequence', String(next));
  return next;
}

function purchaseDetail(id) {
  const invoice = rows(`SELECT pi.*, s.name supplier_name, s.phone supplier_phone
    FROM purchase_invoices pi JOIN suppliers s ON s.id=pi.supplier_id WHERE pi.id=?`, [id])[0];
  if (!invoice) throw new Error('فاکتور خرید پیدا نشد');
  const items = rows(`SELECT * FROM purchase_items WHERE purchase_invoice_id=? ORDER BY rowid`, [id]);
  const payments = rows(`SELECT * FROM purchase_payments WHERE purchase_invoice_id=? ORDER BY created_at,id`, [id]);
  return {invoice, items, payments};
}

function recalcPurchase(invoiceId) {
  const r = rows("SELECT COALESCE(SUM(amount),0) subtotal FROM purchase_items WHERE purchase_invoice_id=?", [invoiceId])[0];
  const inv = rows("SELECT discount FROM purchase_invoices WHERE id=?", [invoiceId])[0];
  if (!inv) throw new Error('فاکتور خرید پیدا نشد');
  const subtotal = money(r.subtotal);
  const discount = Math.min(subtotal, money(inv.discount));
  const total = money(subtotal - discount);
  db.run("UPDATE purchase_invoices SET subtotal=?,total=?,due_amount=MAX(0,?-paid_amount),updated_at=? WHERE id=?", [subtotal, total, total, new Date().toISOString(), invoiceId]);

  // Allocate invoice discount proportionally so stock cost remains exactly equal to invoice total.
  const items = rows("SELECT id,quantity,amount FROM purchase_items WHERE purchase_invoice_id=?", [invoiceId]);
  let allocated = 0;
  items.forEach((it, idx) => {
    let d = 0;
    if (subtotal > 0 && discount > 0) d = idx === items.length-1 ? money(discount-allocated) : money(discount * Number(it.amount) / subtotal);
    allocated += d;
    const eff = Number(it.quantity) > 0 ? money((Number(it.amount)-d) / Number(it.quantity)) : 0;
    db.run("UPDATE purchase_items SET discount=?,effective_unit_cost=? WHERE id=?", [d, eff, it.id]);
  });
}

function postSupplierLedger(supplierId, direction, amount, entryType, referenceType=null, referenceId=null, note='', createdAt=null) {
  const sid=String(supplierId||''); const a=money(amount);
  if(!sid) throw new Error('تأمین‌کننده الزامی است');
  if(!(a>0)) throw new Error('مبلغ گردش حساب تأمین‌کننده باید بیشتر از صفر باشد');
  if(!['DEBIT','CREDIT'].includes(direction)) throw new Error('نوع گردش حساب تأمین‌کننده نامعتبر است');
  const supplier=rows('SELECT * FROM suppliers WHERE id=?',[sid])[0]; if(!supplier) throw new Error('تأمین‌کننده پیدا نشد');
  const now=createdAt||new Date().toISOString();
  const before=money(supplier.balance);
  const after=money(before + (direction==='CREDIT'?a:-a));
  if(after < 0) throw new Error('مانده تأمین‌کننده نمی‌تواند منفی شود');
  const id=newId('sled');
  db.run(`INSERT INTO supplier_ledger(id,supplier_id,entry_type,direction,amount,balance_after,reference_type,reference_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id,sid,String(entryType||'ADJUSTMENT'),direction,a,after,referenceType,referenceId,String(note||'').trim(),now]);
  db.run('UPDATE suppliers SET balance=?,updated_at=? WHERE id=?',[after,now,sid]);
  queueSync('supplier_ledger',id);
  queueSync('supplier',sid);
  return {id,supplierId:sid,balance:after};
}

ipcMain.handle('suppliers:list', () => rows("SELECT * FROM suppliers WHERE active=1 ORDER BY name"));
ipcMain.handle('suppliers:save', (_e,{id,name,phone,address}) => {
  const n=String(name||'').trim(); if(!n) throw new Error('نام تأمین‌کننده الزامی است');
  const ph=String(phone||'').trim(); const ad=String(address||'').trim(); const now=new Date().toISOString(); const sid=id||newId('sup');
  return withTransaction(()=>{
    if(id) db.run("UPDATE suppliers SET name=?,phone=?,address=?,updated_at=? WHERE id=?",[n,ph,ad,now,sid]);
    else db.run("INSERT INTO suppliers(id,name,phone,address,balance,created_at,updated_at,active) VALUES(?,?,?,?,?,?,?,1)",[sid,n,ph,ad,0,now,now]);
    queueSync('supplier',sid); auditLog(id?'SUPPLIER_UPDATE':'SUPPLIER_CREATE','SUPPLIER',sid,{name:n,phone:ph,address:ad},'SUPPLIER',sid,now);
    return rows('SELECT * FROM suppliers WHERE id=?',[sid])[0];
  });
});
ipcMain.handle('suppliers:ledger', (_e,supplierId) => {
  const s=rows('SELECT * FROM suppliers WHERE id=?',[supplierId])[0]; if(!s) throw new Error('تأمین‌کننده پیدا نشد');
  return rows('SELECT * FROM supplier_ledger WHERE supplier_id=? ORDER BY created_at DESC,id DESC LIMIT 500',[supplierId]);
});
ipcMain.handle('suppliers:summary', (_e,supplierId) => {
  const s=rows('SELECT * FROM suppliers WHERE id=?',[supplierId])[0]; if(!s) throw new Error('تأمین‌کننده پیدا نشد');
  const t=rows("SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0) credit, COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0) debit, COUNT(*) entries FROM supplier_ledger WHERE supplier_id=?",[supplierId])[0];
  return {supplier:s,credit:money(t.credit),debit:money(t.debit),entries:Number(t.entries||0),balance:money(s.balance)};
});

ipcMain.handle('suppliers:payment', (_e,{supplierId,amount,method,note}) => {
  const sid=String(supplierId||''); const a=money(assertPositive(amount,'مبلغ پرداخت')); const m=String(method||'').toUpperCase();
  if(!['CASH','CARD'].includes(m)) throw new Error('روش پرداخت تأمین‌کننده باید نقدی یا کارت باشد');
  const supplier=rows('SELECT * FROM suppliers WHERE id=? AND active=1',[sid])[0]; if(!supplier) throw new Error('تأمین‌کننده پیدا نشد');
  if(a>Number(supplier.balance)) throw new Error(`مبلغ پرداخت بیشتر از بدهی تأمین‌کننده است. مانده: ${money(supplier.balance)} تومان`);
  return withTransaction(()=>{
    const now=new Date().toISOString(); const pid=newId('spay');
    const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0];
    if(m==='CASH' && !reg) throw new Error('برای پرداخت نقدی ابتدا صندوق را باز کنید');
    const ledger=postSupplierLedger(sid,'DEBIT',a,'SUPPLIER_PAYMENT','SUPPLIER_PAYMENT',pid,note||'پرداخت به تأمین‌کننده',now);
    if(m==='CASH') insertCashMovement({registerId:reg.id,type:'SUPPLIER_PAYMENT',amount:a,direction:'OUT',category:'PURCHASE',note:`پرداخت به تأمین‌کننده ${supplier.name}`,referenceType:'SUPPLIER_PAYMENT',referenceId:pid,createdAt:now});
    postJournalOnce('SUPPLIER_PAYMENT','SUPPLIER_PAYMENT',`پرداخت به تأمین‌کننده ${supplier.name}`,[{accountCode:'AP',accountName:'حساب‌های پرداختنی تأمین‌کنندگان',debit:a,credit:0,note:note||''},{accountCode:m==='CASH'?'CASH':'BANK',accountName:m==='CASH'?'صندوق نقدی':'بانک / کارتخوان',debit:0,credit:a,note:note||''}],'SUPPLIER_PAYMENT',pid,now);
    auditLog('SUPPLIER_PAYMENT','SUPPLIER',sid,{paymentId:pid,amount:a,method:m,balance:ledger.balance,note:note||''},'SUPPLIER_PAYMENT',pid,now);
    return {paymentId:pid,method:m,amount:a,balance:ledger.balance,supplier:rows('SELECT * FROM suppliers WHERE id=?',[sid])[0]};
  });
});

ipcMain.handle('purchase:list-open', () => rows("SELECT pi.*,s.name supplier_name FROM purchase_invoices pi JOIN suppliers s ON s.id=pi.supplier_id WHERE pi.status='OPEN' ORDER BY pi.purchase_no"));
ipcMain.handle('purchase:new', (_e,{supplierId}) => withTransaction(()=>{
  const sid=String(supplierId||''); if(!rows('SELECT id FROM suppliers WHERE id=? AND active=1',[sid])[0]) throw new Error('تأمین‌کننده پیدا نشد');
  const now=new Date().toISOString(), id=newId('pinv'), no=nextPurchaseNo();
  db.run("INSERT INTO purchase_invoices(id,purchase_no,supplier_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",[id,no,sid,'OPEN',now,now]);
  queueSync('purchase_invoice',id); return purchaseDetail(id);
}));
ipcMain.handle('purchase:get', (_e,id) => purchaseDetail(id));
ipcMain.handle('purchase:add-item', (_e,{purchaseInvoiceId,productId,quantity,purchaseUnitPrice}) => {
  const inv=rows("SELECT id,status FROM purchase_invoices WHERE id=?",[purchaseInvoiceId])[0]; if(!inv||inv.status!=='OPEN') throw new Error('فاکتور خرید باز پیدا نشد');
  const p=rows("SELECT * FROM products WHERE id=? AND active=1",[productId])[0]; if(!p) throw new Error('کالا پیدا نشد');
  const qty=assertPositive(quantity,'مقدار'); const price=assertFiniteNonNegative(purchaseUnitPrice,'قیمت خرید');
  return withTransaction(()=>{
    const existing=rows("SELECT id FROM purchase_items WHERE purchase_invoice_id=? AND product_id=? LIMIT 1",[purchaseInvoiceId,productId])[0];
    if(existing) db.run("UPDATE purchase_items SET quantity=quantity+?,purchase_unit_price=?,amount=ROUND((quantity+?)*?,0) WHERE id=?",[qty,price,qty,price,existing.id]);
    else db.run("INSERT INTO purchase_items(id,purchase_invoice_id,product_id,product_name,quantity,unit,purchase_unit_price,discount,amount,effective_unit_cost) VALUES(?,?,?,?,?,?,?,?,?,?)",[newId('pitem'),purchaseInvoiceId,p.id,p.name,qty,p.unit,price,0,money(qty*price),price]);
    recalcPurchase(purchaseInvoiceId); queueSync('purchase_invoice',purchaseInvoiceId); return purchaseDetail(purchaseInvoiceId);
  });
});
ipcMain.handle('purchase:remove-item', (_e,{purchaseInvoiceId,itemId}) => {
  const inv=rows("SELECT status FROM purchase_invoices WHERE id=?",[purchaseInvoiceId])[0]; if(!inv||inv.status!=='OPEN') throw new Error('فاکتور خرید باز پیدا نشد');
  return withTransaction(()=>{ db.run("DELETE FROM purchase_items WHERE id=? AND purchase_invoice_id=?",[itemId,purchaseInvoiceId]); recalcPurchase(purchaseInvoiceId); queueSync('purchase_invoice',purchaseInvoiceId); return purchaseDetail(purchaseInvoiceId); });
});
ipcMain.handle('purchase:set-discount', (_e,{purchaseInvoiceId,discount}) => {
  const inv=rows("SELECT status,subtotal FROM purchase_invoices WHERE id=?",[purchaseInvoiceId])[0]; if(!inv||inv.status!=='OPEN') throw new Error('فاکتور خرید باز پیدا نشد');
  const d=assertFiniteNonNegative(discount,'تخفیف'); if(d>Number(inv.subtotal)) throw new Error('تخفیف نمی‌تواند از جمع خرید بیشتر باشد');
  return withTransaction(()=>{db.run("UPDATE purchase_invoices SET discount=? WHERE id=?",[money(d),purchaseInvoiceId]); recalcPurchase(purchaseInvoiceId); queueSync('purchase_invoice',purchaseInvoiceId); return purchaseDetail(purchaseInvoiceId);});
});
ipcMain.handle('purchase:pay', (_e,{purchaseInvoiceId,payments}) => {
  const inv=rows("SELECT * FROM purchase_invoices WHERE id=? AND status='OPEN'",[purchaseInvoiceId])[0]; if(!inv) throw new Error('فاکتور خرید باز پیدا نشد');
  const items=rows("SELECT * FROM purchase_items WHERE purchase_invoice_id=? ORDER BY rowid",[purchaseInvoiceId]); if(!items.length) throw new Error('فاکتور خرید خالی است');
  recalcPurchase(purchaseInvoiceId);
  const fresh=rows("SELECT * FROM purchase_invoices WHERE id=?",[purchaseInvoiceId])[0];
  const list=Array.isArray(payments)?payments:[];
  const normalized=list.map(x=>({method:String(x.method||'').toUpperCase(),amount:money(assertFiniteNonNegative(x.amount,'مبلغ پرداخت'))})).filter(x=>x.amount>0);
  const allowed=new Set(['CASH','CARD','ACCOUNT']);
  if(normalized.some(x=>!allowed.has(x.method))) throw new Error('روش پرداخت خرید نامعتبر است');
  const paidTotal=money(normalized.filter(x=>x.method!=='ACCOUNT').reduce((a,x)=>a+x.amount,0));
  const declaredAccount=money(normalized.filter(x=>x.method==='ACCOUNT').reduce((a,x)=>a+x.amount,0));
  if(money(paidTotal+declaredAccount)>Number(fresh.total)) throw new Error('مجموع پرداخت و اعتبار بیشتر از مبلغ فاکتور است');
  const accountAmount=money(Number(fresh.total)-paidTotal);
  if(declaredAccount>0 && declaredAccount!==accountAmount) throw new Error('مبلغ حساب تأمین‌کننده باید دقیقاً برابر مانده فاکتور باشد');
  return withTransaction(()=>{
    const now=new Date().toISOString();
    const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0];
    if(!reg && normalized.some(x=>x.method==='CASH')) throw new Error('برای پرداخت نقدی ابتدا صندوق را باز کنید');
    for(const item of items){
      const cost=Number(item.effective_unit_cost||0);
      if(!(cost>=0)) throw new Error('بهای تمام‌شده خرید نامعتبر است');
      const mid=newId('mov');
      db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note,source_type,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",[mid,item.product_id,null,'PURCHASE',Number(item.quantity),cost,money(Number(item.quantity)*cost),'PURCHASE_INVOICE',now,`خرید فاکتور ${fresh.purchase_no}`,'PURCHASE',purchaseInvoiceId]);
      syncProductStockFromLedger(item.product_id,now); queueSync('stock_movement',mid); queueSync('product',item.product_id);
      // Keep the current product price as the last purchase reference, not the stock valuation source.
      db.run("UPDATE products SET purchase_price=?,updated_at=? WHERE id=?",[cost,now,item.product_id]); queueSync('product',item.product_id);
    }
    for(const x of normalized){
      const pid=newId('ppay'); db.run("INSERT INTO purchase_payments(id,purchase_invoice_id,method,amount,created_at) VALUES(?,?,?,?,?)",[pid,purchaseInvoiceId,x.method,x.amount,now]); queueSync('purchase_payment',pid);
      if(x.method==='CASH') insertCashMovement({registerId:reg.id,type:'PURCHASE_PAYMENT',amount:x.amount,direction:'OUT',category:'PURCHASE',note:`پرداخت خرید فاکتور ${fresh.purchase_no}`,referenceType:'PURCHASE_INVOICE',referenceId:purchaseInvoiceId,createdAt:now});
    }
    if(accountAmount>0) postSupplierLedger(fresh.supplier_id,'CREDIT',accountAmount,'PURCHASE_CREDIT','PURCHASE_INVOICE',purchaseInvoiceId,`خرید نسیه فاکتور ${fresh.purchase_no}`,now);
    // If any amount was paid now, it reduces what is owed; a fully paid invoice creates no supplier debt.
    if(paidTotal>0 && accountAmount===0) { /* no supplier ledger entry needed for a fully cash/card purchase */ }
    const method=normalized.map(x=>x.method).concat(accountAmount>0?['ACCOUNT']:[]).join('+');
    db.run("UPDATE purchase_invoices SET status='RECEIVED',paid_amount=?,due_amount=?,payment_method=?,closed_at=?,updated_at=? WHERE id=?",[paidTotal,fresh.total-paidTotal,method,now,now,purchaseInvoiceId]);
    queueSync('purchase_invoice',purchaseInvoiceId);
    const lines=[{accountCode:'INVENTORY',accountName:'موجودی کالا',debit:Number(fresh.total),credit:0,note:`فاکتور خرید ${fresh.purchase_no}`}];
    for(const x of normalized){ if(x.method==='CASH') lines.push({accountCode:'CASH',accountName:'صندوق نقدی',debit:0,credit:x.amount,note:`پرداخت خرید ${fresh.purchase_no}`}); if(x.method==='CARD') lines.push({accountCode:'BANK',accountName:'بانک / کارتخوان',debit:0,credit:x.amount,note:`پرداخت خرید ${fresh.purchase_no}`}); }
    if(accountAmount>0) lines.push({accountCode:'AP',accountName:'حساب‌های پرداختنی تأمین‌کنندگان',debit:0,credit:accountAmount,note:`بدهی فاکتور خرید ${fresh.purchase_no}`});
    postJournalOnce('PURCHASE','PURCHASE',`خرید فاکتور ${fresh.purchase_no}`,lines,'PURCHASE_INVOICE',purchaseInvoiceId,now);
    auditLog('PURCHASE_COMPLETED','PURCHASE_INVOICE',purchaseInvoiceId,{purchaseNo:fresh.purchase_no,supplierId:fresh.supplier_id,total:fresh.total,paid:paidTotal,due:accountAmount},'PURCHASE_INVOICE',purchaseInvoiceId,now);
    return purchaseDetail(purchaseInvoiceId);
  });
});

ipcMain.handle('purchase:payments', (_e,id) => rows('SELECT * FROM purchase_payments WHERE purchase_invoice_id=? ORDER BY created_at,id',[id]));

ipcMain.handle('stock:adjust', (_e, {productId, movementType, quantity, note}) => {
  const id = String(productId || '');
  const p = rows('SELECT * FROM products WHERE id=? AND active=1',[id])[0];
  if (!p) throw new Error('کالا پیدا نشد');
  const qty = assertPositive(quantity, 'مقدار');
  const allowed = new Set(['PURCHASE','ADJUST_IN','ADJUST_OUT','WASTE','RETURN_IN']);
  if (!allowed.has(movementType)) throw new Error('نوع گردش موجودی نامعتبر است');
  const signed = movementType === 'ADJUST_OUT' || movementType === 'WASTE' ? -qty : qty;
  const currentStock = ledgerStock(id);
  const nextStock = currentStock + signed;
  if (nextStock < 0) throw new Error('موجودی نمی‌تواند منفی شود');
  const cleanNote = String(note || '').trim();
  if (movementType !== 'PURCHASE' && !cleanNote) throw new Error('توضیح برای اصلاح موجودی الزامی است');
  return withTransaction(() => {
    const now = new Date().toISOString();
    const cost = movementCost(id, movementType, signed);
    const movementId = newId('mov');
    db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [movementId,id,null,movementType,signed,cost.unitCost,cost.totalCost,'MOVING_AVERAGE',now,cleanNote || 'ورود کالا']);
    const materializedStock = syncProductStockFromLedger(id, now);
    queueSync('stock_movement', movementId);
    queueSync('product', id);
    auditLog('STOCK_ADJUSTMENT','STOCK_MOVEMENT',movementId,{productId:id,productName:p.name,movementType,quantity:signed,stockBefore:currentStock,stockAfter:materializedStock,note:cleanNote},'STOCK_MOVEMENT',movementId,now);
    return rows('SELECT * FROM products WHERE id=?',[id])[0];
  });
});

ipcMain.handle('stock:valuation', (_e, productId) => {
  const p=rows('SELECT * FROM products WHERE id=?',[productId])[0]; if(!p) throw new Error('کالا پیدا نشد');
  const v=inventoryValue(productId); return {product:p,quantity:v.quantity,value:v.value,averageCost:v.quantity>0?v.value/v.quantity:0,method:'MOVING_AVERAGE'};
});

ipcMain.handle('stock:movements', (_e, productId) => rows(`
  SELECT sm.*, p.name product_name, p.unit
  FROM stock_movements sm JOIN products p ON p.id=sm.product_id
  WHERE sm.product_id=? ORDER BY sm.created_at DESC LIMIT 200
`, [productId]));

ipcMain.handle('categories:list', () => rows("SELECT c.*, COUNT(p.id) product_count FROM categories c LEFT JOIN products p ON p.category_id=c.id GROUP BY c.id ORDER BY c.name"));
ipcMain.handle('categories:save', (_e,{id,name}) => {
  const n=String(name||'').trim(); if(!n) throw new Error('نام دسته‌بندی الزامی است');
  const cid=id||newId('cat'); const now=new Date().toISOString();
  return withTransaction(()=>{
    const dup=rows('SELECT id FROM categories WHERE lower(name)=lower(?) AND id<>?',[n,cid])[0]; if(dup) throw new Error('این دسته‌بندی قبلاً ثبت شده است');
    if(id){ if(!rows('SELECT id FROM categories WHERE id=?',[id])[0]) throw new Error('دسته‌بندی پیدا نشد'); db.run('UPDATE categories SET name=? WHERE id=?',[n,cid]); }
    else db.run('INSERT INTO categories(id,name,created_at) VALUES(?,?,?)',[cid,n,now]);
    queueSync('category',cid); return rows('SELECT * FROM categories WHERE id=?',[cid])[0];
  });
});
ipcMain.handle('categories:archive', (_e,id) => withTransaction(()=>{
  const c=rows('SELECT id,name FROM categories WHERE id=?',[id])[0]; if(!c) throw new Error('دسته‌بندی پیدا نشد');
  const count=Number(rows('SELECT COUNT(*) c FROM products WHERE category_id=? AND active=1',[id])[0]?.c||0); if(count) throw new Error('ابتدا کالاهای فعال این دسته را به دسته دیگری منتقل کنید');
  db.run('UPDATE products SET category_id=NULL,updated_at=? WHERE category_id=?',[new Date().toISOString(),id]); db.run('DELETE FROM categories WHERE id=?',[id]); queueSync('category',id,'DELETE'); return true;
}));

ipcMain.handle('products:tiers', (_e, productId) => rows(
  "SELECT * FROM product_tiers WHERE product_id=? ORDER BY tier_order",[productId]
));

ipcMain.handle('invoices:list-open', () => rows("SELECT * FROM invoices WHERE status='OPEN' ORDER BY invoice_no"));

ipcMain.handle('invoice:new', () => withTransaction(() => {
  const now = new Date().toISOString();
  const id = newId('inv');
  const no = nextInvoiceNo();
  db.run("INSERT INTO invoices(id,invoice_no,status,created_at,updated_at) VALUES(?,?,?,?,?)",[id,no,'OPEN',now,now]);
  queueSync('invoice', id);
  return invoiceDetail(id);
}));

ipcMain.handle('invoice:get', (_e,id) => invoiceDetail(id));

ipcMain.handle('invoice:add-item', (_e,{invoiceId,productId,quantity,unitPrice,manualPrice}) => {
  const inv = rows("SELECT id,status FROM invoices WHERE id=?",[invoiceId])[0];
  if (!inv || inv.status !== 'OPEN') throw new Error('فاکتور باز پیدا نشد');
  const p = rows("SELECT * FROM products WHERE id=? AND active=1",[productId])[0];
  if (!p) throw new Error('کالا پیدا نشد');
  const qty = Number(quantity);
  if (!(qty>0)) throw new Error('مقدار نامعتبر است');
  const manual = !!manualPrice;
  const requestedPrice = Number(unitPrice);
  if (manual && (!Number.isFinite(requestedPrice) || requestedPrice < 0)) throw new Error('قیمت فروش نامعتبر است');
  return withTransaction(() => {
    const existingQty = rows("SELECT COALESCE(SUM(quantity),0) qty FROM invoice_items WHERE invoice_id=? AND product_id=?", [invoiceId,productId])[0];
    const requestedTotal = Number(existingQty?.qty || 0) + qty;
    if (requestedTotal > ledgerStock(productId)) throw new Error('موجودی کافی نیست');
    const existingItem = rows("SELECT * FROM invoice_items WHERE invoice_id=? AND product_id=? LIMIT 1", [invoiceId,productId])[0];
    if (existingItem) {
      db.run("UPDATE invoice_items SET quantity=quantity+? WHERE id=?", [qty, existingItem.id]);
      if (manual) {
        const price = money(requestedPrice);
        db.run("UPDATE invoice_items SET unit_price=?, amount=ROUND(quantity * ?,0), tier_order=-1 WHERE id=?", [price,price,existingItem.id]);
      } else repriceInvoiceProduct(invoiceId, productId);
    } else {
      const price = manual ? money(requestedPrice) : money(p.sale_price_per_unit);
      db.run(`INSERT INTO invoice_items(id,invoice_id,product_id,product_name,quantity,unit,unit_price,purchase_unit_price,amount,tier_order) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [newId('item'),invoiceId,productId,p.name,qty,p.unit,price,p.purchase_price,money(qty*price),manual?-1:null]);
      if (!manual) repriceInvoiceProduct(invoiceId, productId);
    }
    recalcInvoice(invoiceId);
    queueSync('invoice', invoiceId);
    return invoiceDetail(invoiceId);
  });
});

ipcMain.handle('invoice:remove-item', (_e,{invoiceId,itemId}) => {
  const inv=rows("SELECT status FROM invoices WHERE id=?",[invoiceId])[0];
  if(!inv || inv.status!=='OPEN') throw new Error('فاکتور باز پیدا نشد');
  return withTransaction(()=>{
    const oldItem = rows("SELECT * FROM invoice_items WHERE id=? AND invoice_id=?", [itemId,invoiceId])[0];
    if (!oldItem) throw new Error('قلم فاکتور پیدا نشد');
    const result=db.run("DELETE FROM invoice_items WHERE id=? AND invoice_id=?",[itemId,invoiceId]);
    if(!result.changes) throw new Error('قلم فاکتور پیدا نشد');
    if (oldItem.product_id) repriceInvoiceProduct(invoiceId, oldItem.product_id);
    recalcInvoice(invoiceId);
    queueSync('invoice_item', itemId, 'DELETE', oldItem);
    queueSync('invoice', invoiceId);
    auditLog('INVOICE_ITEM_REMOVE','INVOICE_ITEM',itemId,{invoiceId,productId:oldItem.product_id,quantity:oldItem.quantity},'INVOICE',invoiceId,new Date().toISOString());
    return invoiceDetail(invoiceId);
  });
});

ipcMain.handle('invoice:set-discount', (_e,{invoiceId,discount,discountPercent}) => {
  const inv = rows("SELECT status,subtotal FROM invoices WHERE id=?",[invoiceId])[0];
  if (!inv || inv.status !== 'OPEN') throw new Error('فاکتور باز پیدا نشد');
  let value;
  if (discountPercent !== undefined) {
    const pct=Number(discountPercent);
    if(!Number.isFinite(pct)||pct<0||pct>100) throw new Error('درصد تخفیف باید بین صفر تا ۱۰۰ باشد');
    value=money(Number(inv.subtotal||0)*pct/100);
  } else value=assertFiniteNonNegative(discount, 'تخفیف');
  if (value > Number(inv.subtotal)) throw new Error('تخفیف نمی‌تواند از جمع فاکتور بیشتر باشد');
  return withTransaction(()=>{ db.run("UPDATE invoices SET discount=? WHERE id=?",[money(value),invoiceId]); recalcInvoice(invoiceId); queueSync('invoice', invoiceId); return invoiceDetail(invoiceId); });
});

function recalcInvoice(invoiceId) {
  const r = rows("SELECT COALESCE(SUM(amount),0) subtotal FROM invoice_items WHERE invoice_id=?",[invoiceId])[0];
  const inv = rows("SELECT discount FROM invoices WHERE id=?",[invoiceId])[0];
  const subtotal = money(r.subtotal);
  const discount = Math.min(subtotal, money(inv?.discount));
  db.run("UPDATE invoices SET subtotal=?,total=?,updated_at=? WHERE id=?",
    [subtotal,subtotal-discount,new Date().toISOString(),invoiceId]);
}

ipcMain.handle('invoice:pay', (_e,{invoiceId,payments,method}) => {
  const inv = rows("SELECT * FROM invoices WHERE id=? AND status='OPEN'",[invoiceId])[0];
  if (!inv) throw new Error('فاکتور باز پیدا نشد');
  const items = rows("SELECT * FROM invoice_items WHERE invoice_id=?",[invoiceId]);
  if (!items.length) throw new Error('فاکتور خالی است');
  const list = Array.isArray(payments) ? payments : [{method,amount:inv.total}];
  const normalized = list.map(x => ({method:String(x.method||'').toUpperCase(), amount:money(assertFiniteNonNegative(x.amount,'مبلغ پرداخت'))})).filter(x=>x.amount>0);
  const allowed = new Set(['CASH','CARD','ACCOUNT']);
  if (!normalized.length || normalized.some(x=>!allowed.has(x.method))) throw new Error('روش پرداخت نامعتبر است');
  const paidTotal = normalized.reduce((a,x)=>a+x.amount,0);
  if (paidTotal !== money(inv.total)) throw new Error('مجموع پرداخت‌ها باید دقیقاً برابر مبلغ فاکتور باشد');
  const accountPay = normalized.filter(x=>x.method==='ACCOUNT').reduce((a,x)=>a+x.amount,0);
  if (accountPay > 0 && !inv.customer_id) throw new Error('برای فروش اعتباری باید مشتری انتخاب شود');

  return withTransaction(() => {
    for (const item of items) {
      const p = rows("SELECT stock FROM products WHERE id=? AND active=1",[item.product_id])[0];
      if (!p || ledgerStock(item.product_id) < Number(item.quantity)) throw new Error(`موجودی ${item.product_name} کافی نیست`);
    }
    const now = new Date().toISOString();
    const reg = rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0];
    if (!reg && normalized.some(x=>x.method==='CASH')) throw new Error('برای دریافت نقدی ابتدا صندوق را باز کنید');
    for (const item of items) {
      const saleCost = movementCost(item.product_id, 'SALE', item.quantity, movingAverageCost(item.product_id));
      const movementId = newId('mov');
      db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [movementId,item.product_id,invoiceId,'SALE',-Number(item.quantity),saleCost.unitCost,-saleCost.totalCost,'MOVING_AVERAGE',now,'فروش فاکتور']);
      syncProductStockFromLedger(item.product_id, now);
      queueSync('stock_movement', movementId);
      queueSync('product', item.product_id);
    }
    db.run("UPDATE invoices SET status='PAID',payment_method=?,closed_at=?,updated_at=? WHERE id=? AND status='OPEN'",
      [normalized.map(x=>x.method).join('+'),now,now,invoiceId]);
    queueSync('invoice', invoiceId);
    const journalLines=[];
    for (const x of normalized) {
      const paymentId = newId('pay');
      db.run("INSERT INTO payments(id,invoice_id,method,amount,created_at) VALUES(?,?,?,?,?)",
        [paymentId,invoiceId,x.method,x.amount,now]);
      queueSync('payment', paymentId);
      if (x.method==='ACCOUNT') { postCustomerLedger(inv.customer_id,'DEBIT',x.amount,'SALE_CREDIT','PAYMENT',paymentId,`فروش اعتباری فاکتور ${inv.invoice_no}`,now); journalLines.push({accountCode:'AR',accountName:'حساب‌های دریافتنی مشتریان',debit:x.amount,credit:0,note:`فاکتور ${inv.invoice_no}`}); }
      if (x.method==='CASH') { insertCashMovement({registerId:reg.id,type:'SALE',amount:x.amount,direction:'IN',category:'SALE',note:`فروش فاکتور ${inv.invoice_no}`,referenceType:'INVOICE',referenceId:invoiceId,createdAt:now}); journalLines.push({accountCode:'CASH',accountName:'صندوق نقدی',debit:x.amount,credit:0,note:`فاکتور ${inv.invoice_no}`}); }
      if (x.method==='CARD') journalLines.push({accountCode:'BANK',accountName:'بانک / کارتخوان',debit:x.amount,credit:0,note:`فاکتور ${inv.invoice_no}`});
    }
    journalLines.push({accountCode:'SALES',accountName:'فروش',debit:0,credit:money(inv.total),note:`فاکتور ${inv.invoice_no}`});
    postJournalOnce('SALE','SALE',`فروش فاکتور ${inv.invoice_no}`,journalLines,'INVOICE',invoiceId,now);
    // COGS must be calculated from ALL SALE movements created for this invoice.
    // A product can be added/merged multiple times in one invoice; selecting only
    // the latest movement would understate COGS in that case.
    const saleCogs=money(Number(rows("SELECT COALESCE(-SUM(total_cost),0) v FROM stock_movements WHERE invoice_id=? AND movement_type='SALE'",[invoiceId])[0]?.v||0));
    if(saleCogs>0) postJournalOnce('COGS_SALE','COGS_SALE',`بهای تمام‌شده فاکتور ${inv.invoice_no}`,[{accountCode:'COGS',accountName:'بهای تمام‌شده کالای فروش‌رفته',debit:saleCogs,credit:0,note:`فاکتور ${inv.invoice_no}`},{accountCode:'INVENTORY',accountName:'موجودی کالا',debit:0,credit:saleCogs,note:`فاکتور ${inv.invoice_no}`}],'INVOICE',invoiceId,now);
    auditLog('SALE_COMPLETED','INVOICE',invoiceId,{invoiceNo:inv.invoice_no,total:inv.total,paymentMethods:normalized},'INVOICE',invoiceId,now);
    return invoiceDetail(invoiceId);
  });
});

ipcMain.handle('invoice:returns', (_e, invoiceId) => rows(`
  SELECT sr.*, ri.id item_return_id, ri.invoice_item_id, ri.product_id, ri.product_name, ri.quantity, ri.unit, ri.unit_price, ri.refund_amount
  FROM sales_returns sr JOIN sales_return_items ri ON ri.return_id=sr.id
  WHERE sr.invoice_id=? ORDER BY sr.created_at DESC`, [invoiceId]));

ipcMain.handle('invoice:return', (_e, {invoiceId, items, method, note}) => {
  const inv = rows("SELECT * FROM invoices WHERE id=? AND status IN ('PAID','PARTIALLY_RETURNED')", [invoiceId])[0];
  if (!inv) throw new Error('فاکتور قابل برگشت پیدا نشد');
  const clean = (Array.isArray(items) ? items : []).map(x=>({itemId:String(x.itemId||''), quantity:Number(x.quantity)})).filter(x=>x.itemId && x.quantity>0);
  if (!clean.length) throw new Error('حداقل یک قلم برای برگشت انتخاب کنید');
  const refundMethod=String(method||'').toUpperCase();
  if (!['CASH','CARD','ACCOUNT'].includes(refundMethod)) throw new Error('روش برگشت وجه نامعتبر است');
  if (refundMethod==='ACCOUNT' && !inv.customer_id) throw new Error('برای برگشت به حساب، مشتری باید روی فاکتور ثبت شده باشد');
  return withTransaction(()=>{
    const now=new Date().toISOString(); const normalized=[]; let total=0;
    for(const req of clean){
      const item=rows("SELECT * FROM invoice_items WHERE id=? AND invoice_id=?",[req.itemId,invoiceId])[0]; if(!item) throw new Error('قلم فاکتور پیدا نشد');
      const sold=Number(item.quantity); const returned=Number(rows("SELECT COALESCE(SUM(quantity),0) q FROM sales_return_items WHERE invoice_item_id=?",[item.id])[0]?.q||0);
      const remaining=sold-returned; if(req.quantity>remaining+1e-9) throw new Error(`مقدار قابل برگشت ${item.product_name}: ${remaining} ${item.unit}`);
      const subtotal=Number(inv.subtotal)||0; const discount=Number(inv.discount)||0; const allocation=subtotal>0?Math.min(1,Math.max(0,(subtotal-discount)/subtotal)):1; const grossUnit=sold>0?(Number(item.amount)/sold)*allocation:0; const refund=money(req.quantity*grossUnit); if(refund<=0) throw new Error('مبلغ برگشت نامعتبر است');
      normalized.push({item,quantity:req.quantity,refund}); total=money(total+refund);
    }
    if(refundMethod==='CASH' && !rows("SELECT id FROM cash_registers WHERE status='OPEN' LIMIT 1").length) throw new Error('برای برگشت نقدی ابتدا صندوق را باز کنید');
    const returnId=newId('ret'), returnNo=nextReturnNo();
    db.run("INSERT INTO sales_returns(id,invoice_id,return_no,status,subtotal,refund_total,refund_method,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)",[returnId,invoiceId,returnNo,'COMPLETED',total,total,refundMethod,String(note||'').trim(),now]);
    for(const x of normalized){
      db.run("INSERT INTO sales_return_items(id,return_id,invoice_item_id,product_id,product_name,quantity,unit,unit_price,refund_amount,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[newId('rit'),returnId,x.item.id,x.item.product_id,x.item.product_name,x.quantity,x.item.unit,money(x.item.unit_price),x.refund,now]);
      const saleMove = rows("SELECT quantity,total_cost FROM stock_movements WHERE invoice_id=? AND product_id=? AND movement_type='SALE' ORDER BY created_at DESC,id DESC LIMIT 1",[invoiceId,x.item.product_id])[0];
      const originalCost = saleMove && Number(saleMove.quantity)!==0 ? Math.abs(Number(saleMove.total_cost||0)/Number(saleMove.quantity)) : Number(x.item.purchase_unit_price||0);
      const returnCost = movementCost(x.item.product_id, 'RETURN_IN', x.quantity, originalCost);
      const movId=newId('mov'); db.run("INSERT INTO stock_movements(id,product_id,invoice_id,movement_type,quantity,unit_cost,total_cost,cost_method,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",[movId,x.item.product_id,invoiceId,'RETURN_IN',x.quantity,returnCost.unitCost,returnCost.totalCost,'RETURN_ORIGINAL_COST',now,`مرجوعی فاکتور ${inv.invoice_no} / برگشت ${returnNo}`]); syncProductStockFromLedger(x.item.product_id, now); queueSync('stock_movement',movId); queueSync('product',x.item.product_id);
    }
    const refundId=newId('refund'); db.run("INSERT INTO refunds(id,invoice_id,return_id,method,amount,created_at) VALUES(?,?,?,?,?,?)",[refundId,invoiceId,returnId,refundMethod,total,now]);
    if(refundMethod==='ACCOUNT'){postCustomerLedger(inv.customer_id,'CREDIT',total,'SALES_RETURN','REFUND',refundId,`برگشت وجه اعتباری ${returnNo}`,now);}
    if(refundMethod==='CASH'){const reg=rows("SELECT id FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0]; if(!reg) throw new Error('برای برگشت نقدی ابتدا صندوق را باز کنید'); if(total>cashExpected(reg.id)) throw new Error('موجودی نقدی صندوق برای برگشت وجه کافی نیست'); insertCashMovement({registerId:reg.id,type:'REFUND',amount:total,direction:'OUT',category:'REFUND',note:`برگشت وجه ${returnNo} / فاکتور ${inv.invoice_no}`,referenceType:'REFUND',referenceId:refundId,createdAt:now});}
    const totalReturned=Number(rows("SELECT COALESCE(SUM(refund_amount),0) t FROM sales_return_items WHERE return_id IN (SELECT id FROM sales_returns WHERE invoice_id=?)",[invoiceId])[0]?.t||0);
    const returnLines=[{accountCode:'SALES_RETURNS',accountName:'برگشت از فروش',debit:total,credit:0,note:`مرجوعی ${returnNo}`}];
    if(refundMethod==='CASH') returnLines.push({accountCode:'CASH',accountName:'صندوق نقدی',debit:0,credit:total,note:`مرجوعی ${returnNo}`});
    else if(refundMethod==='CARD') returnLines.push({accountCode:'BANK',accountName:'بانک / کارتخوان',debit:0,credit:total,note:`مرجوعی ${returnNo}`});
    else returnLines.push({accountCode:'AR',accountName:'حساب‌های دریافتنی مشتریان',debit:0,credit:total,note:`مرجوعی ${returnNo}`});
    postJournalOnce('SALES_RETURN','SALES_RETURN',`مرجوعی فاکتور ${inv.invoice_no} - شماره ${returnNo}`,returnLines,'SALES_RETURN',returnId,now);
    // For returns, derive the original unit cost from the complete set of SALE
    // movements for the invoice/product, not just the last one. This remains
    // correct when the same product appears more than once on the invoice.
    const returnCogs=money(normalized.reduce((sum,x)=>{
      const sm=rows("SELECT COALESCE(-SUM(quantity),0) qty,COALESCE(-SUM(total_cost),0) cost FROM stock_movements WHERE invoice_id=? AND product_id=? AND movement_type='SALE'",[invoiceId,x.item.product_id])[0];
      const soldQty=Number(sm?.qty||0);
      const unit=soldQty>0?Number(sm?.cost||0)/soldQty:Number(x.item.purchase_unit_price||0);
      return sum+Number(x.quantity)*unit;
    },0));
    if(returnCogs>0) postJournalOnce('COGS_RETURN','COGS_RETURN',`برگشت بهای تمام‌شده ${returnNo}`,[{accountCode:'INVENTORY',accountName:'موجودی کالا',debit:returnCogs,credit:0,note:`مرجوعی ${returnNo}`},{accountCode:'COGS',accountName:'بهای تمام‌شده کالای فروش‌رفته',debit:0,credit:returnCogs,note:`مرجوعی ${returnNo}`}],'SALES_RETURN',returnId,now);
    const status=totalReturned>=Number(inv.total)-1e-9?'RETURNED':'PARTIALLY_RETURNED'; db.run("UPDATE invoices SET status=?,updated_at=? WHERE id=?",[status,now,invoiceId]); queueSync('invoice',invoiceId);
    auditLog('SALES_RETURN','SALES_RETURN',returnId,{returnNo,invoiceId,amount:total,method:refundMethod,status},'INVOICE',invoiceId,now);
    return {returnId,returnNo,invoiceId,refundTotal:total,method:refundMethod,status,items:normalized.map(x=>({itemId:x.item.id,quantity:x.quantity,refundAmount:x.refund}))};
  });
});

ipcMain.handle('invoice:payments', (_e, invoiceId) => rows("SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at",[invoiceId]));

ipcMain.handle('invoice:cancel', (_e, invoiceId) => {
  const inv = rows("SELECT * FROM invoices WHERE id=? AND status='OPEN'",[invoiceId])[0];
  if (!inv) throw new Error('فاکتور باز پیدا نشد');
  return withTransaction(() => {
    const now=new Date().toISOString(); db.run("UPDATE invoices SET status='CANCELLED',updated_at=? WHERE id=? AND status='OPEN'",[now,invoiceId]);
    queueSync('invoice', invoiceId); auditLog('INVOICE_CANCEL','INVOICE',invoiceId,null,'INVOICE',invoiceId,now);
    return invoiceDetail(invoiceId);
  });
});

function currentActor(){ return sessionUser ? {id:sessionUser.id,name:sessionUser.displayName} : {id:'system-migration',name:'سیستم مهاجرت'}; }
function nextAccountingEntryNo(){
  return Number(rows("SELECT COALESCE(MAX(entry_no),0)+1 n FROM accounting_entries")[0]?.n||1);
}
function auditLog(action, entityType, entityId=null, details=null, referenceType=null, referenceId=null, createdAt=null){
  const a=currentActor(), now=createdAt||new Date().toISOString();
  const id=newId('audit');
  const detailsJson=details==null?null:JSON.stringify(details);
  db.run(`INSERT INTO audit_log(id,actor_id,actor_name,action,entity_type,entity_id,reference_type,reference_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id,a.id,a.name,String(action||'UNKNOWN'),String(entityType||'SYSTEM'),entityId,referenceType,referenceId,detailsJson,now]);
  queueSync('audit_log',id);
  return id;
}
function postJournal(entryType, description, lines, referenceType=null, referenceId=null, createdAt=null){
  if(!Array.isArray(lines)||!lines.length) throw new Error('سند حسابداری بدون سطر است');
  const clean=lines.map(x=>({accountCode:String(x.accountCode),accountName:String(x.accountName),debit:money(x.debit||0),credit:money(x.credit||0),note:String(x.note||'')})).filter(x=>x.debit>0||x.credit>0);
  const debit=money(clean.reduce((a,x)=>a+x.debit,0)), credit=money(clean.reduce((a,x)=>a+x.credit,0));
  if(debit!==credit) throw new Error(`سند حسابداری نامتوازن است: بدهکار ${debit} / بستانکار ${credit}`);
  const now=createdAt||new Date().toISOString(), actor=currentActor(), id=newId('jent'), no=nextAccountingEntryNo();
  db.run(`INSERT INTO accounting_entries(id,entry_no,entry_type,reference_type,reference_id,description,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)`,[id,no,entryType,referenceType,referenceId,description,now,actor.id]);
  for(const x of clean) { const lineId=newId('jline'); db.run(`INSERT INTO accounting_lines(id,entry_id,account_code,account_name,debit,credit,note) VALUES(?,?,?,?,?,?,?)`,[lineId,id,x.accountCode,x.accountName,x.debit,x.credit,x.note]); }
  queueSync('accounting_entry', id);
  return {id,entryNo:no,debit,credit};
}
function postJournalOnce(key, entryType, description, lines, referenceType=null, referenceId=null, createdAt=null){
  if(referenceType&&referenceId){const ex=rows("SELECT id,entry_no FROM accounting_entries WHERE entry_type=? AND reference_type=? AND reference_id=? LIMIT 1",[entryType,referenceType,referenceId])[0]; if(ex) return ex;}
  return postJournal(entryType,description,lines,referenceType,referenceId,createdAt);
}

function postCustomerLedger(customerId, direction, amount, entryType, referenceType=null, referenceId=null, note='', createdAt=null) {
  const cid=String(customerId||''); const a=money(amount);
  if(!cid) throw new Error('مشتری الزامی است');
  if(!(a>0)) throw new Error('مبلغ گردش حساب باید بیشتر از صفر باشد');
  if(!['DEBIT','CREDIT'].includes(direction)) throw new Error('نوع گردش حساب نامعتبر است');
  const customer=rows('SELECT * FROM customers WHERE id=?',[cid])[0]; if(!customer) throw new Error('مشتری پیدا نشد');
  const now=createdAt||new Date().toISOString();
  const before=money(customer.balance); const after=money(before + (direction==='DEBIT'?a:-a));
  const id=newId('cled');
  db.run(`INSERT INTO customer_ledger(id,customer_id,entry_type,direction,amount,balance_after,reference_type,reference_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id,cid,String(entryType||'ADJUSTMENT'),direction,a,after,referenceType,referenceId,String(note||'').trim(),now]);
  db.run('UPDATE customers SET balance=?,updated_at=? WHERE id=?',[after,now,cid]);
  queueSync('customer_ledger',id);
  queueSync('customer',cid);
  const cashSide = referenceType==='CUSTOMER_PAYMENT'||referenceType==='CUSTOMER_SETTLEMENT' ? (entryType==='CUSTOMER_PAYMENT'||entryType==='SETTLEMENT' ? 'CASH' : null) : null;
  auditLog(direction==='DEBIT'?'CUSTOMER_DEBIT':'CUSTOMER_CREDIT','CUSTOMER',cid,{entryType,direction,amount:a,balanceBefore:before,balanceAfter:after,note},referenceType,referenceId,now);
  return {id,customerId:cid,balance:after};
}

ipcMain.handle('customers:list', () => rows("SELECT * FROM customers ORDER BY name"));
ipcMain.handle('customers:save', (_e,{id,name,phone}) => {
  const n=String(name||'').trim(); if(!n) throw new Error('نام مشتری الزامی است');
  const ph=String(phone||'').trim(); const now=new Date().toISOString(); const cid=id||newId('cus');
  return withTransaction(()=>{ if(id) db.run("UPDATE customers SET name=?,phone=?,updated_at=? WHERE id=?",[n,ph,now,cid]); else db.run("INSERT INTO customers(id,name,phone,balance,created_at,updated_at) VALUES(?,?,?,?,?,?)",[cid,n,ph,0,now,now]); queueSync('customer',cid); auditLog(id?'CUSTOMER_UPDATE':'CUSTOMER_CREATE','CUSTOMER',cid,{name:n,phone:ph},'CUSTOMER',cid,now); return rows("SELECT * FROM customers WHERE id=?",[cid])[0]; });
});
ipcMain.handle('customers:ledger', (_e, customerId) => {
  const c=rows('SELECT * FROM customers WHERE id=?',[customerId])[0]; if(!c) throw new Error('مشتری پیدا نشد');
  return rows(`SELECT * FROM customer_ledger WHERE customer_id=? ORDER BY created_at DESC, id DESC LIMIT 500`,[customerId]);
});
ipcMain.handle('customers:summary', (_e, customerId) => {
  const c=rows('SELECT * FROM customers WHERE id=?',[customerId])[0]; if(!c) throw new Error('مشتری پیدا نشد');
  const totals=rows(`SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0) debit, COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0) credit, COUNT(*) entries FROM customer_ledger WHERE customer_id=?`,[customerId])[0];
  return {customer:c,debit:money(totals.debit),credit:money(totals.credit),entries:Number(totals.entries||0),balance:money(c.balance)};
});
ipcMain.handle('customers:payment', (_e,{customerId,amount,method,note}) => {
  const cid=String(customerId||''); const a=assertPositive(amount,'مبلغ پرداخت'); const m=String(method||'').toUpperCase();
  if(!['CASH','CARD'].includes(m)) throw new Error('روش پرداخت باید نقدی یا کارت باشد');
  const c=rows('SELECT * FROM customers WHERE id=?',[cid])[0]; if(!c) throw new Error('مشتری پیدا نشد');
  if(a>Math.max(0,Number(c.balance)+0.000001)) throw new Error(`مبلغ پرداخت بیشتر از بدهی مشتری است. مانده: ${money(c.balance)} تومان`);
  return withTransaction(()=>{
    const now=new Date().toISOString(); const paymentId=newId('cpay');
    const ledger=postCustomerLedger(cid,'CREDIT',a,'CUSTOMER_PAYMENT','CUSTOMER_PAYMENT',paymentId,`دریافت از مشتری${note?' — '+String(note).trim():''}`,now);
    if(m==='CASH'){
      const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0]; if(!reg) throw new Error('برای دریافت نقدی ابتدا صندوق را باز کنید');
      insertCashMovement({registerId:reg.id,type:'CUSTOMER_PAYMENT',amount:a,direction:'IN',category:'CUSTOMER_PAYMENT',note:`دریافت حساب مشتری ${c.name}`,referenceType:'CUSTOMER_PAYMENT',referenceId:paymentId,createdAt:now});
    }
    postJournalOnce('CUSTOMER_PAYMENT','CUSTOMER_PAYMENT',`دریافت از مشتری ${c.name}`,[{accountCode:m==='CASH'?'CASH':'BANK',accountName:m==='CASH'?'صندوق نقدی':'بانک / کارتخوان',debit:a,credit:0},{accountCode:'AR',accountName:'حساب‌های دریافتنی مشتریان',debit:0,credit:a}],'CUSTOMER_PAYMENT',paymentId,now);
    return {paymentId,method:m,amount:a,balance:ledger.balance,customer:rows('SELECT * FROM customers WHERE id=?',[cid])[0]};
  });
});
ipcMain.handle('customers:settle', (_e,{customerId,method,note}) => {
  const c=rows('SELECT * FROM customers WHERE id=?',[customerId])[0]; if(!c) throw new Error('مشتری پیدا نشد');
  const amount=money(c.balance); if(amount<=0) throw new Error('مانده بدهکار برای تسویه وجود ندارد');
  const m=String(method||'').toUpperCase(); if(!['CASH','CARD'].includes(m)) throw new Error('روش تسویه باید نقدی یا کارت باشد');
  return withTransaction(()=>{
    const now=new Date().toISOString(); const paymentId=newId('csettle');
    const ledger=postCustomerLedger(c.id,'CREDIT',amount,'SETTLEMENT','SETTLEMENT',paymentId,`تسویه کامل حساب${note?' — '+String(note).trim():''}`,now);
    if(m==='CASH'){
      const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0]; if(!reg) throw new Error('برای تسویه نقدی ابتدا صندوق را باز کنید');
      insertCashMovement({registerId:reg.id,type:'CUSTOMER_SETTLEMENT',amount:amount,direction:'IN',category:'CUSTOMER_PAYMENT',note:`تسویه حساب مشتری ${c.name}`,referenceType:'CUSTOMER_SETTLEMENT',referenceId:paymentId,createdAt:now});
    }
    postJournalOnce('CUSTOMER_SETTLEMENT','CUSTOMER_SETTLEMENT',`تسویه حساب مشتری ${c.name}`,[{accountCode:m==='CASH'?'CASH':'BANK',accountName:m==='CASH'?'صندوق نقدی':'بانک / کارتخوان',debit:amount,credit:0},{accountCode:'AR',accountName:'حساب‌های دریافتنی مشتریان',debit:0,credit:amount}],'CUSTOMER_SETTLEMENT',paymentId,now);
    auditLog('CUSTOMER_SETTLEMENT','CUSTOMER',c.id,{paymentId,amount,method:m,balance:ledger.balance},'CUSTOMER_SETTLEMENT',paymentId,now);
    return {paymentId,method:m,amount,balance:ledger.balance,customer:rows('SELECT * FROM customers WHERE id=?',[c.id])[0]};
  });
});

ipcMain.handle('invoice:set-customer', (_e,{invoiceId,customerId}) => {
  const inv=rows("SELECT status FROM invoices WHERE id=?",[invoiceId])[0]; if(!inv||inv.status!=='OPEN') throw new Error('فاکتور باز پیدا نشد');
  if(customerId && !rows("SELECT id FROM customers WHERE id=?",[customerId])[0]) throw new Error('مشتری پیدا نشد');
  return withTransaction(()=>{ const now=new Date().toISOString(); db.run("UPDATE invoices SET customer_id=?,updated_at=? WHERE id=?",[customerId||null,now,invoiceId]); queueSync('invoice',invoiceId); auditLog('SET_CUSTOMER','INVOICE',invoiceId,{customerId:customerId||null},'INVOICE',invoiceId,now); return invoiceDetail(invoiceId); });
});

function cashExpected(registerId) {
  const reg=rows("SELECT * FROM cash_registers WHERE id=?",[registerId])[0];
  if(!reg) throw new Error('صندوق پیدا نشد');
  const r=rows("SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) amount FROM cash_movements WHERE register_id=?",[registerId])[0];
  return money(Number(reg.opening_cash)+Number(r?.amount||0));
}

function insertCashMovement({registerId,type,amount,direction,category='GENERAL',note='',referenceType=null,referenceId=null,createdAt=null}) {
  const a=money(amount); if(!(a>0)) throw new Error('مبلغ گردش صندوق باید بیشتر از صفر باشد');
  const d=String(direction||'').toUpperCase(); if(!['IN','OUT'].includes(d)) throw new Error('جهت گردش صندوق نامعتبر است');
  const id=newId('cash'); const now=createdAt||new Date().toISOString();
  db.run("INSERT INTO cash_movements(id,register_id,movement_type,amount,note,created_at,direction,category,reference_type,reference_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [id,registerId,String(type||'GENERAL').toUpperCase(),a,String(note||'').trim(),now,d,String(category||'GENERAL').toUpperCase(),referenceType,referenceId]);
  queueSync('cash_movement',id);
  auditLog(d==='IN'?'CASH_IN':'CASH_OUT','CASH_MOVEMENT',id,{registerId,type,amount:a,direction:d,category,note},referenceType,referenceId,now);
  return id;
}

ipcMain.handle('cash:status', () => {
  const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0]||null;
  if(!reg) return {open:false,register:null,expected:0};
  return {open:true,register:reg,expected:cashExpected(reg.id)};
});
ipcMain.handle('cash:open', (_e,{openingCash,note}) => {
  const existing=rows("SELECT id FROM cash_registers WHERE status='OPEN' LIMIT 1")[0]; if(existing) throw new Error('صندوق از قبل باز است');
  const amount=assertFiniteNonNegative(openingCash,'موجودی اولیه صندوق'); const now=new Date().toISOString();
  return withTransaction(()=>{const id=newId('reg');db.run("INSERT INTO cash_registers(id,opened_at,opening_cash,status,note,discrepancy) VALUES(?,?,?,?,?,0)",[id,now,amount,'OPEN',String(note||'').trim()]);queueSync('cash_register',id); if(amount>0) postJournalOnce('CASH_OPEN','CASH_OPEN',`موجودی اولیه صندوق`,[{accountCode:'CASH',accountName:'صندوق نقدی',debit:amount,credit:0},{accountCode:'OPENING_BALANCE',accountName:'مانده افتتاحیه',debit:0,credit:amount}],'CASH_REGISTER',id,now); auditLog('CASH_OPEN','CASH_REGISTER',id,{openingCash:amount,note},'CASH_REGISTER',id,now);return rows("SELECT * FROM cash_registers WHERE id=?",[id])[0];});
});
ipcMain.handle('cash:move', (_e,{movementType,amount,note,category,referenceType,referenceId}) => {
  const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0]; if(!reg) throw new Error('صندوق باز نیست');
  const a=assertPositive(amount,'مبلغ'); const type=String(movementType||'').toUpperCase();
  if(!['IN','OUT'].includes(type)) throw new Error('نوع گردش صندوق نامعتبر است');
  const clean=String(note||'').trim(); if(!clean) throw new Error('توضیح الزامی است');
  return withTransaction(()=>{ const expected=cashExpected(reg.id); if(type==='OUT' && a>expected) throw new Error('موجودی نقدی صندوق برای این برداشت کافی نیست');
    const id=insertCashMovement({registerId:reg.id,type:type==='IN'?'IN':'OUT',amount:a,direction:type,category,referenceType,referenceId,note:clean});
    const cat=String(category||'GENERAL').toUpperCase();
    let contra=cat==='EXPENSE'?'EXPENSE':cat==='OWNER_WITHDRAWAL'?'OWNER_DRAWING':(type==='IN'?'OTHER_INCOME':'OTHER_EXPENSE');
    const lines=type==='IN'?[{accountCode:'CASH',accountName:'صندوق نقدی',debit:a,credit:0},{accountCode:contra,accountName:contra==='OTHER_INCOME'?'سایر درآمدها':contra, debit:0,credit:a}]:[{accountCode:contra,accountName:contra==='EXPENSE'?'هزینه‌ها':contra==='OWNER_DRAWING'?'برداشت مالک':'سایر هزینه‌ها',debit:a,credit:0},{accountCode:'CASH',accountName:'صندوق نقدی',debit:0,credit:a}];
    postJournalOnce(type==='IN'?'CASH_IN_MANUAL':'CASH_OUT_MANUAL','CASH_MANUAL',clean,lines,'CASH_MOVEMENT',id,new Date().toISOString());
    return id; });
});
ipcMain.handle('cash:close', (_e,{closingCash,note}) => {
  const reg=rows("SELECT * FROM cash_registers WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1")[0]; if(!reg) throw new Error('صندوق باز نیست');
  const actual=assertFiniteNonNegative(closingCash,'موجودی شمارش‌شده صندوق');
  return withTransaction(()=>{
    const expected=cashExpected(reg.id); const discrepancy=money(actual-expected); const now=new Date().toISOString();
    if(discrepancy!==0){ insertCashMovement({registerId:reg.id,type:'ADJUSTMENT',amount:Math.abs(discrepancy),direction:discrepancy>0?'IN':'OUT',category:'DISCREPANCY',note:`مغایرت پایان شیفت: ${discrepancy>0?'+':''}${discrepancy} تومان`,referenceType:'CASH_REGISTER',referenceId:reg.id,createdAt:now}); }
    db.run("UPDATE cash_registers SET status='CLOSED',closed_at=?,closing_cash=?,expected_cash=?,discrepancy=?,note=COALESCE(note,'')||? WHERE id=?",
      [now,actual,expected,discrepancy,String(note||''),reg.id]); queueSync('cash_register',reg.id);
    return {register:rows("SELECT * FROM cash_registers WHERE id=?",[reg.id])[0],expected,actual,discrepancy,finalExpected:cashExpected(reg.id)};
  });
});
ipcMain.handle('cash:movements', (_e,registerId) => rows("SELECT * FROM cash_movements WHERE register_id=? ORDER BY created_at DESC, id DESC",[registerId]));
ipcMain.handle('cash:registers', () => rows("SELECT * FROM cash_registers ORDER BY opened_at DESC LIMIT 100"));
ipcMain.handle('cash:summary', (_e,registerId) => {
  const reg=rows("SELECT * FROM cash_registers WHERE id=?",[registerId])[0]; if(!reg) throw new Error('صندوق پیدا نشد');
  const totals=rows(`SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE 0 END),0) cash_in, COALESCE(SUM(CASE WHEN direction='OUT' THEN amount ELSE 0 END),0) cash_out, COUNT(*) entries FROM cash_movements WHERE register_id=?`,[registerId])[0];
  const byCategory=rows(`SELECT category,direction,COALESCE(SUM(amount),0) amount,COUNT(*) count FROM cash_movements WHERE register_id=? GROUP BY category,direction ORDER BY amount DESC`,[registerId]);
  return {register:reg,cashIn:money(totals.cash_in),cashOut:money(totals.cash_out),entries:Number(totals.entries||0),expected:cashExpected(registerId),byCategory};
});

ipcMain.handle('accounting:entries', (_e, limit=500) => rows(`SELECT e.*, COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit FROM accounting_entries e LEFT JOIN accounting_lines l ON l.entry_id=e.id GROUP BY e.id ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,[Math.min(1000,Math.max(1,Number(limit)||500))]));
ipcMain.handle('accounting:entry', (_e,id) => { const e=rows('SELECT * FROM accounting_entries WHERE id=?',[id])[0]; if(!e) throw new Error('سند حسابداری پیدا نشد'); return {...e,lines:rows('SELECT * FROM accounting_lines WHERE entry_id=? ORDER BY rowid',[id])}; });
ipcMain.handle('accounting:trial-balance', () => rows(`SELECT account_code,account_name,COALESCE(SUM(debit),0) debit,COALESCE(SUM(credit),0) credit,COALESCE(SUM(debit-credit),0) balance FROM accounting_lines GROUP BY account_code,account_name ORDER BY account_code`));
ipcMain.handle('audit:list', (_e, {limit=500,entityType,entityId}={}) => { let q=`SELECT * FROM audit_log WHERE 1=1`, p=[]; if(entityType){q+=' AND entity_type=?';p.push(entityType)} if(entityId){q+=' AND entity_id=?';p.push(entityId)} q+=' ORDER BY created_at DESC,id DESC LIMIT ?';p.push(Math.min(1000,Math.max(1,Number(limit)||500))); return rows(q,p).map(x=>({...x,details:x.details_json?JSON.parse(x.details_json):null})); });
ipcMain.handle('audit:summary', () => rows(`SELECT action,entity_type,COUNT(*) count,MAX(created_at) last_at FROM audit_log GROUP BY action,entity_type ORDER BY last_at DESC`));

ipcMain.handle('reports:summary', () => {
  const day = localDateKey();
  const month = localMonthKey();
  const today = rows("SELECT COALESCE(SUM(total),0) sales, COUNT(*) invoices FROM invoices WHERE status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND date(closed_at,'localtime')=?",[day])[0];
  const m = rows("SELECT COALESCE(SUM(total),0) sales, COUNT(*) invoices FROM invoices WHERE status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND strftime('%Y-%m',closed_at,'localtime')=?",[month])[0];
  const salesToday=Number(rows("SELECT COALESCE(SUM(total),0) v FROM invoices WHERE status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND date(closed_at,'localtime')=?",[day])[0]?.v||0);
  const returnsToday=Number(rows("SELECT COALESCE(SUM(refund_total),0) v FROM sales_returns WHERE date(created_at,'localtime')=?",[day])[0]?.v||0);
  const cogsToday=Number(rows("SELECT COALESCE(-SUM(total_cost),0) v FROM stock_movements WHERE movement_type='SALE' AND date(created_at,'localtime')=?",[day])[0]?.v||0);
  const returnCogsToday=Number(rows("SELECT COALESCE(SUM(total_cost),0) v FROM stock_movements WHERE movement_type='RETURN_IN' AND invoice_id IS NOT NULL AND date(created_at,'localtime')=?",[day])[0]?.v||0);
  const netSales=money(salesToday-returnsToday);
  const netCogs=money(cogsToday-returnCogsToday);
  const profit={salesGross:money(salesToday),returns:money(returnsToday),salesNet:netSales,cogs:netCogs,profit:money(netSales-netCogs)};
  const best = rows(`SELECT product_name, unit, SUM(quantity) quantity, SUM(amount) amount FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND strftime('%Y-%m',i.closed_at,'localtime')=? GROUP BY product_id,product_name,unit ORDER BY quantity DESC LIMIT 10`,[month]);
  const payments = rows("SELECT method, COALESCE(SUM(amount),0) amount, COUNT(*) count FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status IN ('PAID','PARTIALLY_RETURNED','RETURNED') AND date(i.closed_at,'localtime')=? GROUP BY method ORDER BY amount DESC",[day]);
  const stockValue=rows("SELECT COALESCE(SUM(v.value),0) value FROM (SELECT product_id,COALESCE(SUM(total_cost),0) value FROM stock_movements GROUP BY product_id HAVING COALESCE(SUM(quantity),0)>0) v")[0];
  return {today,month:m,profit,best,payments,stockValue,valuationMethod:'MOVING_AVERAGE'};
});

ipcMain.handle('reports:recent', () => rows("SELECT id,invoice_no,total,payment_method,closed_at FROM invoices WHERE status='PAID' ORDER BY closed_at DESC LIMIT 50"));

ipcMain.handle('backup:settings', () => backupSettings());
ipcMain.handle('backup:set-settings', (_e, {enabled, intervalHours}) => {
  const hours = Number(intervalHours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('بازه پشتیبان خودکار باید بین ۱ تا ۱۶۸ ساعت باشد');
  return withTransaction(() => {
    setMeta('auto_backup_enabled', enabled ? '1' : '0');
    setMeta('auto_backup_interval_hours', String(Math.round(hours)));
    startAutoBackupTimer();
    return backupSettings();
  });
});
ipcMain.handle('backup:create', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'ذخیره نسخه پشتیبان',
    defaultPath: path.join(app.getPath('documents'), backupFileName()),
    filters: [{name:'SQLite Backup', extensions:['sqlite']}, {name:'همه فایل‌ها', extensions:['*']}]
  });
  if (result.canceled || !result.filePath) return null;
  return await createBackupAt(result.filePath);
});
ipcMain.handle('backup:create-auto', async () => createAutomaticBackup());
ipcMain.handle('backup:verify', async (_e, source) => validateBackupFile(source));
ipcMain.handle('backup:restore', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'انتخاب فایل پشتیبان برای بازیابی', properties: ['openFile'],
    filters: [{name:'SQLite Backup', extensions:['sqlite','db','sqlite3']}, {name:'همه فایل‌ها', extensions:['*']}]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const source = result.filePaths[0];
  let validation;
  try { validation=validateBackupFile(source); } catch(err) { throw new Error(`این فایل قابل بازیابی نیست: ${err.message}`); }
  const confirm = await dialog.showMessageBox(mainWindow, {
    type:'warning', buttons:['بازیابی و جایگزینی','انصراف'], defaultId:1, cancelId:1,
    title:'تأیید بازیابی امن', message:'فایل پشتیبان معتبر است و اطلاعات فعلی جایگزین خواهد شد.',
    detail:`فایل: ${source}\nحجم: ${Math.round(validation.size/1024)} KB\nSHA-256: ${validation.sha256}`
  });
  if(confirm.response!==0) return null;
  const preRestore=path.join(backupDir(),backupFileName('before-restore'));
  await createBackupAt(preRestore);
  const temp=path.join(dataDir(),`.restore-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`);
  const oldPath=`${dbPath}.old-${Date.now()}`;
  try {
    fs.copyFileSync(source,temp);
    validateBackupFile(temp);
    if(db){try{db.close()}catch(_){} db=null;}
    if(fs.existsSync(dbPath)) fs.renameSync(dbPath,oldPath);
    fs.renameSync(temp,dbPath);
    try { if(fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
    db=new NativeDatabaseAdapter(dbPath); db.run('PRAGMA foreign_keys = ON'); createSchema(); startAutoBackupTimer();
    return {restored:true,source,health:healthCheck(),sha256:validation.sha256,preRestore};
  } catch(err) {
    try{if(db){db.close();db=null;}}catch(_){}
    try{if(fs.existsSync(temp))fs.unlinkSync(temp);}catch(_){}
    try{if(!fs.existsSync(dbPath)&&fs.existsSync(oldPath))fs.renameSync(oldPath,dbPath);}catch(_){}
    if(!db) { try{db=new NativeDatabaseAdapter(dbPath);db.run('PRAGMA foreign_keys = ON');createSchema();}catch(_){} }
    throw new Error(`بازیابی امن انجام نشد و در صورت امکان دیتابیس قبلی حفظ شد: ${err.message}`);
  }
});
function fullIntegrityCheck() {
  if (!db) throw new Error('پایگاه داده آماده نیست');
  const checks=[];
  const add=(code,label,ok,details='')=>checks.push({code,label,ok:Boolean(ok),details:String(details||'')});
  const integrity=db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0] || 'unknown';
  add('SQLITE_INTEGRITY','SQLite Integrity',integrity==='ok',integrity);
  const fk=db.exec('PRAGMA foreign_key_check');
  const fkCount=fk.length?fk[0].values.length:0;
  add('FOREIGN_KEYS','Foreign Keys',fkCount===0,`${fkCount} خطا`);
  const stock=rows(`SELECT p.id,p.name,p.stock,COALESCE(SUM(sm.quantity),0) ledger_stock FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id GROUP BY p.id,p.name,p.stock HAVING ABS(p.stock-COALESCE(SUM(sm.quantity),0))>0.000001 LIMIT 100`);
  add('STOCK_CACHE','موجودی کالا با Ledger',stock.length===0,`${stock.length} مغایرت`);
  const unbalanced=rows(`SELECT e.id,e.entry_no,e.entry_type,COALESCE(SUM(l.debit),0) debit,COALESCE(SUM(l.credit),0) credit FROM accounting_entries e LEFT JOIN accounting_lines l ON l.entry_id=e.id GROUP BY e.id HAVING ABS(COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0))>0.000001 LIMIT 100`);
  add('ACCOUNTING_BALANCE','توازن اسناد حسابداری',unbalanced.length===0,`${unbalanced.length} سند نامتوازن`);
  const orphanLines=rows(`SELECT l.id FROM accounting_lines l LEFT JOIN accounting_entries e ON e.id=l.entry_id WHERE e.id IS NULL LIMIT 100`);
  add('ACCOUNTING_ORPHANS','سطرهای حسابداری یتیم',orphanLines.length===0,`${orphanLines.length} مورد`);
  const customerMismatch=rows(`SELECT c.id,c.name,c.balance,COALESCE(SUM(CASE WHEN cl.direction='DEBIT' THEN cl.amount ELSE -cl.amount END),0) ledger_balance FROM customers c LEFT JOIN customer_ledger cl ON cl.customer_id=c.id GROUP BY c.id,c.name,c.balance HAVING ABS(c.balance-COALESCE(SUM(CASE WHEN cl.direction='DEBIT' THEN cl.amount ELSE -cl.amount END),0))>0.000001 LIMIT 100`);
  add('CUSTOMER_BALANCE','مانده مشتری با Ledger',customerMismatch.length===0,`${customerMismatch.length} مغایرت`);
  const paymentMismatch=rows(`SELECT i.id,i.invoice_no,i.total,COALESCE(SUM(p.amount),0) paid FROM invoices i LEFT JOIN payments p ON p.invoice_id=i.id WHERE i.status IN ('PAID','PARTIALLY_RETURNED','RETURNED') GROUP BY i.id,i.invoice_no,i.total HAVING ABS(i.total-COALESCE(SUM(p.amount),0))>0.000001 LIMIT 100`);
  add('PAYMENTS','پرداخت فاکتورهای بسته',paymentMismatch.length===0,`${paymentMismatch.length} مغایرت`);
  const cogsMovement=Number(rows(`SELECT COALESCE(-SUM(total_cost),0) v FROM stock_movements WHERE movement_type='SALE'`)[0]?.v||0);
  const cogsJournal=Number(rows(`SELECT COALESCE(SUM(l.debit),0) v FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.entry_type='COGS_SALE' AND l.account_code='COGS'`)[0]?.v||0);
  const returnMovement=Number(rows(`SELECT COALESCE(SUM(total_cost),0) v FROM stock_movements WHERE movement_type='RETURN_IN' AND invoice_id IS NOT NULL`)[0]?.v||0);
  const returnJournal=Number(rows(`SELECT COALESCE(SUM(l.credit),0) v FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.entry_type='COGS_RETURN' AND l.account_code='COGS'`)[0]?.v||0);
  add('COGS_SALE','COGS فروش با Ledger',Math.abs(cogsMovement-cogsJournal)<=0.01,`Ledger=${money(cogsMovement)} / Journal=${money(cogsJournal)}`);
  add('COGS_RETURN','COGS مرجوعی با Ledger',Math.abs(returnMovement-returnJournal)<=0.01,`Ledger=${money(returnMovement)} / Journal=${money(returnJournal)}`);
  const duplicateJournals=rows(`SELECT entry_type,reference_type,reference_id,COUNT(*) count FROM accounting_entries WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL GROUP BY entry_type,reference_type,reference_id HAVING COUNT(*)>1 LIMIT 100`);
  add('JOURNAL_DUPLICATES','جلوگیری از سند حسابداری تکراری',duplicateJournals.length===0,`${duplicateJournals.length} گروه تکراری`);
  const userRoleOrphans=rows("SELECT u.id FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE r.id IS NULL LIMIT 100");
  add('USER_ROLE_INTEGRITY','یکپارچگی کاربران و نقش‌ها',userRoleOrphans.length===0,`${userRoleOrphans.length} کاربر بدون نقش`);
  const failed=checks.filter(x=>!x.ok);
  return {ok:failed.length===0,checks,failedCount:failed.length,checkedAt:new Date().toISOString(),details:{stock,unbalanced,orphanLines,customerMismatch,paymentMismatch,duplicateJournals}};
}

ipcMain.handle('backup:health', () => healthCheck());
ipcMain.handle('integrity:full', () => fullIntegrityCheck());
ipcMain.handle('backup:list', () => fs.readdirSync(backupDir()).filter(n=>/\.sqlite$/i.test(n)).map(name=>{const full=path.join(backupDir(),name);const st=fs.statSync(full);let verified=false,sha256=null;try{const v=validateBackupFile(full);verified=true;sha256=v.sha256;}catch(_){}return {name,path:full,size:st.size,modifiedAt:st.mtime.toISOString(),verified,sha256};}).sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt)).slice(0,50));

function healthCheck() {
  if (!db) throw new Error('پایگاه داده آماده نیست');
  const integrity = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0] || 'unknown';
  const foreignKeys = db.exec('PRAGMA foreign_key_check');
  const fkErrors = foreignKeys.length ? foreignKeys[0].values.length : 0;
  const counts = {};
  for (const table of ['products','invoices','invoice_items','stock_movements','payments','customers','customer_ledger','cash_registers','cash_movements']) {
    counts[table] = Number(rows(`SELECT COUNT(*) c FROM ${table}`)[0]?.c || 0);
  }
  const stockMismatches = rows(`
    SELECT p.id,p.name,p.stock,COALESCE(SUM(sm.quantity),0) ledger_stock
    FROM products p LEFT JOIN stock_movements sm ON sm.product_id=p.id
    GROUP BY p.id,p.name,p.stock
    HAVING ABS(p.stock-COALESCE(SUM(sm.quantity),0)) > 0.000001
    LIMIT 100
  `);
  saveDb();
  const fileSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  return {ok: integrity === 'ok' && fkErrors === 0 && stockMismatches.length === 0, integrity, foreignKeyErrors: fkErrors, stockMismatches, fileSize, counts, checkedAt:new Date().toISOString()};
}

ipcMain.handle('receipt:print', async (_e, invoiceId) => {
  if(!mainWindow) throw new Error('پنجره صندوق آماده نیست');
  const detail=invoiceDetail(invoiceId); if(!detail) throw new Error('فاکتور پیدا نشد');
  const payments=rows("SELECT * FROM payments WHERE invoice_id=? ORDER BY created_at",[invoiceId]);
  const html=`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><style>body{font-family:Tahoma,sans-serif;width:280px;margin:0 auto;font-size:12px}h2{text-align:center;margin:8px 0}.line{display:flex;justify-content:space-between;margin:6px 0}.total{border-top:1px solid #000;padding-top:8px;font-weight:bold;font-size:14px}.items{border-top:1px dashed #888;border-bottom:1px dashed #888;padding:6px 0}.muted{color:#666;font-size:10px;text-align:center}</style><h2>صندوق عطاری</h2><div class="muted">فاکتور ${detail.invoice_no}</div><div class="items">${detail.items.map(x=>`<div class="line"><span>${String(x.product_name).replace(/[<>&]/g,'')}</span><span>${x.quantity} × ${x.unit_price}</span></div>`).join('')}</div><div class="line"><span>جمع</span><b>${detail.subtotal.toLocaleString()}</b></div><div class="line"><span>تخفیف</span><b>${detail.discount.toLocaleString()}</b></div><div class="line total"><span>مبلغ نهایی</span><b>${detail.total.toLocaleString()}</b></div>${payments.map(x=>`<div class="line"><span>${x.method==='CASH'?'نقدی':x.method==='CARD'?'کارت':'حساب'}</span><b>${Number(x.amount).toLocaleString()}</b></div>`).join('')}<div class="muted">از خرید شما سپاسگزاریم</div></html>`;
  const printWin=new BrowserWindow({show:false,parent:mainWindow,webPreferences:{sandbox:true}});
  await printWin.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  return new Promise((resolve,reject)=>printWin.webContents.print({silent:false,printBackground:true},(success,failureReason)=>{printWin.close();if(!success) reject(new Error(failureReason||'چاپ انجام نشد'));else resolve(true);}));
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname,'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  win.loadFile(path.join(__dirname,'src','index.html'));
}

app.whenReady().then(async()=>{ await initDatabase(); dashboardCore = createDashboardCore(createBusinessCoreContext()); await createAutomaticBackup(); startAutoBackupTimer(); createWindow(); }).catch(err=>{
  try {
    const logDir = app.getPath('userData');
    fs.mkdirSync(logDir,{recursive:true});
    fs.appendFileSync(path.join(logDir,'startup-error.log'), `\n[${new Date().toISOString()}]\n${err?.stack||err}\n`, 'utf8');
  } catch (_) {}
  try { dialog.showErrorBox('خطای اجرای صندوق', String(err?.message||err)); } catch (_) {}
  app.quit();
});
app.on('before-quit',()=>{ if(autoBackupTimer) clearInterval(autoBackupTimer); try { saveDb(); } catch (_) {} });
app.on('window-all-closed',()=>{ if(process.platform!=='darwin') app.quit(); });
