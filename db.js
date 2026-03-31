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
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        employee_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'user',
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
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } else {
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'user',
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
        created_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (car_id) REFERENCES cars(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    saveSqlite();
  }
}

// ===== 初期データ =====

async function seedData() {
  // 管理者
  const admins = await query("SELECT id FROM users WHERE employee_id = ?", ['admin']);
  if (admins.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await run("INSERT INTO users (employee_id, password, name, role) VALUES (?, ?, ?, ?)",
      ['admin', hash, '管理者', 'admin']);
  }

  // サンプルユーザー
  const users = await query("SELECT id FROM users WHERE employee_id = ?", ['1001']);
  if (users.length === 0) {
    const hash = bcrypt.hashSync('pass1001', 10);
    await run("INSERT INTO users (employee_id, password, name, role) VALUES (?, ?, ?, ?)",
      ['1001', hash, '山田 太郎', 'user']);
  }

  // サンプル車両
  const cars = await query("SELECT id FROM cars LIMIT 1");
  if (cars.length === 0) {
    await run("INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      ['GR-001', 'トヨタ アルファード', 7, '本社駐車場']);
    await run("INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      ['GR-002', 'トヨタ ハイエース', 10, '本社駐車場']);
    await run("INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      ['GR-003', 'トヨタ プリウス', 5, '本社駐車場']);
  }
}

module.exports = { initDatabase, query, run };
