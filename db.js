const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

let mode = null; // 'pg' or 'sqlite'
let pool = null;
let sqliteDb = null;

const SQLITE_DB_PATH = path.join(__dirname, 'data', 'database.sqlite');

// ===== 統一インターフェース =====

// SELECT用: [{col: val, ...}, ...] を返す
async function query(sql, params = []) {
  if (mode === 'pg') {
    const pgSql = convertPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    return result.rows;
  } else {
    const result = sqliteDb.exec(sql, params);
    if (result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }
}

// INSERT/UPDATE/DELETE用
async function run(sql, params = []) {
  if (mode === 'pg') {
    const pgSql = convertPlaceholders(sql);
    await pool.query(pgSql, params);
  } else {
    sqliteDb.run(sql, params);
    saveSqlite();
  }
}

// ? → $1, $2, ... に変換（PostgreSQL用）
function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// ===== 初期化 =====

async function initDatabase() {
  if (process.env.DATABASE_URL) {
    mode = 'pg';
    await initPostgres();
  } else {
    mode = 'sqlite';
    await initSqlite();
  }

  await createTables();
  await migrateSchema();
  await seedData();
  console.log(`データベース初期化完了 (${mode})`);
}

async function initPostgres() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  // 接続テスト
  const client = await pool.connect();
  client.release();
  console.log('PostgreSQL接続成功');
}

async function initSqlite() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (fs.existsSync(SQLITE_DB_PATH)) {
    const fileBuffer = fs.readFileSync(SQLITE_DB_PATH);
    sqliteDb = new SQL.Database(fileBuffer);
  } else {
    sqliteDb = new SQL.Database();
  }
}

function saveSqlite() {
  if (sqliteDb) {
    const data = sqliteDb.export();
    fs.writeFileSync(SQLITE_DB_PATH, Buffer.from(data));
  }
}

// ===== テーブル作成 =====

async function createTables() {
  if (mode === 'pg') {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        employee_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        group_id INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cars (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        current_location TEXT DEFAULT '本社駐車場',
        is_active INTEGER DEFAULT 1,
        group_id INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        car_id INTEGER NOT NULL REFERENCES cars(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        start_datetime TEXT NOT NULL,
        end_datetime TEXT NOT NULL,
        departure_location TEXT NOT NULL,
        return_location TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        notes TEXT DEFAULT '',
        start_odometer REAL,
        end_odometer REAL,
        distance_used REAL,
        purpose TEXT DEFAULT '',
        completed_at TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } else {
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        group_id INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS cars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        current_location TEXT DEFAULT '本社駐車場',
        is_active INTEGER DEFAULT 1,
        group_id INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        car_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        start_datetime TEXT NOT NULL,
        end_datetime TEXT NOT NULL,
        departure_location TEXT NOT NULL,
        return_location TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        notes TEXT DEFAULT '',
        start_odometer REAL,
        end_odometer REAL,
        distance_used REAL,
        purpose TEXT DEFAULT '',
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (car_id) REFERENCES cars(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    saveSqlite();
  }
}

// ===== 既存DBのマイグレーション（カラム追加） =====

async function columnExists(table, col) {
  if (mode === 'pg') {
    const rows = await query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
      [table, col]
    );
    return rows.length > 0;
  } else {
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some(r => r.name === col);
  }
}

async function addColumnIfMissing(table, col, def) {
  if (!(await columnExists(table, col))) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

async function migrateSchema() {
  // 既存のusers/cars/reservationsにgroup_id等が無ければ追加
  await addColumnIfMissing('users', 'group_id', 'INTEGER DEFAULT 1');
  await addColumnIfMissing('users', 'cross_group', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('cars', 'group_id', 'INTEGER DEFAULT 1');
  await addColumnIfMissing('reservations', 'start_odometer', 'REAL');
  await addColumnIfMissing('reservations', 'end_odometer', 'REAL');
  await addColumnIfMissing('reservations', 'distance_used', 'REAL');
  await addColumnIfMissing('reservations', 'purpose', "TEXT DEFAULT ''");
  await addColumnIfMissing('reservations', 'completed_at', 'TEXT');

  // 既存レコードに group_id=1 をセット（NULL対策）
  await run("UPDATE users SET group_id = 1 WHERE group_id IS NULL");
  await run("UPDATE cars SET group_id = 1 WHERE group_id IS NULL");

  // gr グループの表示名を「清掃組」に更新
  await run("UPDATE groups SET name = ? WHERE code = ?", ['清掃組', 'gr']);

  // 横断可能ユーザー（青山001・ビエン009・屋比久010・髙宮101）を設定
  const crossEmpIds = ['001', '009', '010', '101'];
  for (const eid of crossEmpIds) {
    await run("UPDATE users SET cross_group = 1 WHERE employee_id = ?", [eid]);
  }
}

// ===== 初期データ =====

async function seedData() {
  // グループ
  const groups = await query("SELECT id, code FROM groups ORDER BY id");
  if (groups.length === 0) {
    await run("INSERT INTO groups (code, name, color) VALUES (?, ?, ?)",
      ['gr', '清掃組', '#1a73e8']);
    await run("INSERT INTO groups (code, name, color) VALUES (?, ?, ?)",
      ['akiota', '安芸太田町組', '#059669']);
  }

  const grGroup = await query("SELECT id FROM groups WHERE code = ?", ['gr']);
  const akGroup = await query("SELECT id FROM groups WHERE code = ?", ['akiota']);
  const grId = grGroup[0].id;
  const akId = akGroup[0].id;

  // 管理者
  const admins = await query("SELECT id FROM users WHERE employee_id = ?", ['admin']);
  if (admins.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run("INSERT INTO users (employee_id, password, name, role, group_id) VALUES (?, ?, ?, ?, ?)",
      ['admin', hash, '管理者', 'admin', grId]);
  }

  // GR社員登録
  const grEmployees = [
    { employee_id: '001', name: '青山',       password: 'agr2026' },
    { employee_id: '002', name: '加川',       password: 'kgr2026' },
    { employee_id: '003', name: '川岡',       password: 'kgr2026' },
    { employee_id: '004', name: '北林',       password: 'kgr2026' },
    { employee_id: '005', name: 'ギルバート', password: 'ggr2026' },
    { employee_id: '006', name: '国島',       password: 'kgr2026' },
    { employee_id: '007', name: '中道',       password: 'ngr2026' },
    { employee_id: '008', name: '西',         password: 'ngr2026' },
    { employee_id: '009', name: 'ビエン',     password: 'bgr2026' },
    { employee_id: '010', name: '屋比久',     password: 'ygr2026' },
  ];

  for (const emp of grEmployees) {
    const existing = await query("SELECT id FROM users WHERE employee_id = ?", [emp.employee_id]);
    if (existing.length === 0) {
      const hash = bcrypt.hashSync(emp.password, 10);
      await run("INSERT INTO users (employee_id, password, name, role, group_id) VALUES (?, ?, ?, ?, ?)",
        [emp.employee_id, hash, emp.name, 'user', grId]);
    }
  }

  // 安芸太田町組 社員登録（101:髙宮、102:佐伯、103:仁井田は確定。以降あいうえお順）
  const akEmployees = [
    { employee_id: '101', name: '髙宮',       password: 'tgr2026' },
    { employee_id: '102', name: '佐伯',       password: 'sgr2026' },
    { employee_id: '103', name: '仁井田',     password: 'ngr2026' },
    { employee_id: '104', name: '安部',       password: 'agr2026' }, // あ
    { employee_id: '105', name: '陳',         password: 'cgr2026' }, // ち
    { employee_id: '106', name: '原田',       password: 'hgr2026' }, // は
    { employee_id: '107', name: '和田',       password: 'wgr2026' }, // わ
    { employee_id: '108', name: 'ジェイシー', password: 'jgr2026' },
  ];

  for (const emp of akEmployees) {
    const existing = await query("SELECT id FROM users WHERE employee_id = ?", [emp.employee_id]);
    if (existing.length === 0) {
      const hash = bcrypt.hashSync(emp.password, 10);
      await run("INSERT INTO users (employee_id, password, name, role, group_id) VALUES (?, ?, ?, ?, ?)",
        [emp.employee_id, hash, emp.name, 'user', akId]);
    }
  }

  // GRサンプル車両
  const grCars = await query("SELECT id FROM cars WHERE group_id = ?", [grId]);
  if (grCars.length === 0) {
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['GR-001', 'トヨタ アルファード', 7, '本社駐車場', grId]);
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['GR-002', 'トヨタ ハイエース', 10, '本社駐車場', grId]);
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['GR-003', 'トヨタ プリウス', 5, '本社駐車場', grId]);
  }

  // 安芸太田町組 車両
  const akCars = await query("SELECT id FROM cars WHERE group_id = ?", [akId]);
  if (akCars.length === 0) {
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['AK-001', 'キャラバン', 10, '温井', akId]);
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['AK-002', 'ローザ（マイクロバス）', 28, 'いこい', akId]);
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['AK-003', 'セルボ', 4, 'いこい', akId]);
    await run("INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      ['AK-004', 'アトレー（清掃用）', 5, 'FHG', akId]);
  }
}

module.exports = { initDatabase, query, run };
