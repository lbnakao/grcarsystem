const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'database.sqlite');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  // dataディレクトリがなければ作成
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 既存のDBファイルがあれば読み込み
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // テーブル作成
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
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

  db.run(`
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

  // 管理者アカウントがなければ作成
  const admin = db.exec("SELECT id FROM users WHERE employee_id = 'admin'");
  if (admin.length === 0 || admin[0].values.length === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.run(
      "INSERT INTO users (employee_id, password, name, role) VALUES (?, ?, ?, ?)",
      ['admin', hashedPassword, '管理者', 'admin']
    );
  }

  // サンプルユーザー
  const sampleUser = db.exec("SELECT id FROM users WHERE employee_id = '1001'");
  if (sampleUser.length === 0 || sampleUser[0].values.length === 0) {
    const hashedPassword = bcrypt.hashSync('pass1001', 10);
    db.run(
      "INSERT INTO users (employee_id, password, name, role) VALUES (?, ?, ?, ?)",
      ['1001', hashedPassword, '山田 太郎', 'user']
    );
  }

  // サンプル車両
  const sampleCar = db.exec("SELECT id FROM cars LIMIT 1");
  if (sampleCar.length === 0 || sampleCar[0].values.length === 0) {
    db.run("INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      ['GR-001', 'トヨタ アルファード', 7, '本社駐車場']);
    db.run("INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      ['GR-002', 'トヨタ ハイエース', 10, '本社駐車場']);
    db.run("INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      ['GR-003', 'トヨタ プリウス', 5, '本社駐車場']);
  }

  saveDatabase();
  console.log('データベース初期化完了');
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb, saveDatabase };
