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

// INSERT して挿入ID(id)を返す。プレーンなINSERT文に対して使用（ON CONFLICT系は run() を使う）
async function runInsert(sql, params = []) {
  if (mode === 'pg') {
    const pgSql = convertPlaceholders(sql) + ' RETURNING id';
    const result = await pool.query(pgSql, params);
    return result.rows[0] ? result.rows[0].id : null;
  } else {
    sqliteDb.run(sql, params);
    const r = sqliteDb.exec('SELECT last_insert_rowid() as id');
    saveSqlite();
    if (r.length > 0 && r[0].values.length > 0) return r[0].values[0][0];
    return null;
  }
}

// ? → $1, $2, ... に変換（PostgreSQL用）
function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// pg ドライバは COUNT(*) を bigint = 文字列で返す。Number() で正規化する
function asInt(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
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
  // 経理モジュールへのアクセス権（井上さん=201、管理者=admin）
  await addColumnIfMissing('users', 'keiri_access', 'INTEGER DEFAULT 0');
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

  // 経理モジュール用テーブル群（keiri_ プレフィックスで既存テーブルと分離）
  await createKeiriTables();
  await addColumnIfMissing('keiri_bank_accounts', 'account_number', "TEXT DEFAULT ''");
  await addColumnIfMissing('keiri_invoice_files', 'facility', "TEXT DEFAULT ''");
  await addColumnIfMissing('keiri_invoices', 'carry_4', 'REAL DEFAULT 0');
  await addColumnIfMissing('keiri_invoices', 'carry_4_cleared', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('keiri_invoices', 'carry_5', 'REAL DEFAULT 0');
  await addColumnIfMissing('keiri_invoices', 'carry_5_cleared', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('keiri_invoices', 'carry_6', 'REAL DEFAULT 0');
  await addColumnIfMissing('keiri_invoices', 'carry_6_cleared', 'INTEGER DEFAULT 0');

  // 資金管理（社長Excel v8 のアプリ化）用テーブル群
  await createFundsTables();

  // 組織体制図ハブの編集差分テーブル
  await createOrgChartTables();
}

// ===== 資金管理モジュール用テーブル =====
async function createFundsTables() {
  const autoIncPK = (mode === 'pg') ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const nowDefault = (mode === 'pg') ? 'TIMESTAMP DEFAULT NOW()' : "TEXT DEFAULT (datetime('now','localtime'))";

  // 会社マスタ
  await run(`
    CREATE TABLE IF NOT EXISTS funds_companies (
      id ${autoIncPK},
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_funds_target INTEGER DEFAULT 1,
      color TEXT DEFAULT '#1F4E79',
      sort_order INTEGER DEFAULT 0,
      created_at ${nowDefault}
    )
  `);

  // 物件マスタ
  await run(`
    CREATE TABLE IF NOT EXISTS funds_properties (
      id ${autoIncPK},
      name TEXT NOT NULL,
      company_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at ${nowDefault}
    )
  `);

  // 資金繰り項目マスタ（収入/支出/財務）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_fund_items (
      id ${autoIncPK},
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // 勘定科目マスタ（→ 資金繰り項目にマッピング）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_account_categories (
      id ${autoIncPK},
      name TEXT NOT NULL UNIQUE,
      fund_item_id INTEGER,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // 入金記録
  await run(`
    CREATE TABLE IF NOT EXISTS funds_income_entries (
      id ${autoIncPK},
      company_id INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      item TEXT,
      fund_item_id INTEGER,
      amount INTEGER DEFAULT 0,
      status TEXT DEFAULT '予測',
      memo TEXT DEFAULT '',
      created_at ${nowDefault},
      updated_at ${nowDefault}
    )
  `);

  // 未払／支出記録
  await run(`
    CREATE TABLE IF NOT EXISTS funds_payable_entries (
      id ${autoIncPK},
      company_id INTEGER NOT NULL,
      property_id INTEGER,
      kind TEXT DEFAULT '月次予定',
      summary TEXT,
      account_category_id INTEGER,
      due_date TEXT,
      billto TEXT DEFAULT '',
      current_amount INTEGER DEFAULT 0,
      carry_1m INTEGER DEFAULT 0,
      carry_2m INTEGER DEFAULT 0,
      carry_3m_plus INTEGER DEFAULT 0,
      priority TEXT DEFAULT '月次',
      plan_date TEXT,
      plan_amount INTEGER DEFAULT 0,
      pay_status TEXT DEFAULT '',
      invoice_path TEXT DEFAULT '',
      created_at ${nowDefault},
      updated_at ${nowDefault}
    )
  `);

  // カード枠回復記録
  await run(`
    CREATE TABLE IF NOT EXISTS funds_card_recoveries (
      id ${autoIncPK},
      company_id INTEGER NOT NULL,
      pay_date TEXT NOT NULL,
      card_name TEXT DEFAULT '',
      amount INTEGER DEFAULT 0,
      kind TEXT DEFAULT '通常',
      memo TEXT DEFAULT '',
      created_at ${nowDefault}
    )
  `);

  // ===== v10 で追加：施設／OTA／売上／入金予測 =====

  // 施設マスタ（売上計上単位・17施設）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_facilities (
      id ${autoIncPK},
      name TEXT NOT NULL,
      dept TEXT DEFAULT '',
      company_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at ${nowDefault}
    )
  `);

  // OTA／決済サイクルマスタ（売上計上月に対する入金タイミング）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_ota_channels (
      id ${autoIncPK},
      name TEXT NOT NULL UNIQUE,
      cur_ratio INTEGER DEFAULT 0,
      nxt_ratio INTEGER DEFAULT 0,
      nxt2_ratio INTEGER DEFAULT 0,
      pay_day_cur INTEGER,
      pay_day_nxt INTEGER,
      pay_day_nxt2 INTEGER,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // ===== 白井システム統合：別名マスタ・振込口座マスタ =====

  // 別名（エイリアス）マスタ：各システムの表記 → 正本ID へ解決
  await run(`
    CREATE TABLE IF NOT EXISTS funds_name_aliases (
      id ${autoIncPK},
      kind TEXT NOT NULL,
      alias TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      source TEXT DEFAULT '',
      created_at ${nowDefault},
      UNIQUE(kind, alias)
    )
  `);

  // 振込口座マスタ（入金管理.xlsx「マスタ情報」由来）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_bank_accounts (
      id ${autoIncPK},
      label TEXT NOT NULL,
      bank TEXT DEFAULT '',
      branch TEXT DEFAULT '',
      account_no TEXT DEFAULT '',
      holder TEXT DEFAULT '',
      company_id INTEGER,
      memo TEXT DEFAULT '',
      created_at ${nowDefault}
    )
  `);

  // 売上入力（OTA別／施設別／月別）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_sales_entries (
      id ${autoIncPK},
      company_id INTEGER NOT NULL,
      facility_id INTEGER NOT NULL,
      ota_channel_id INTEGER NOT NULL,
      year_month TEXT NOT NULL,
      amount INTEGER DEFAULT 0,
      memo TEXT DEFAULT '',
      created_at ${nowDefault},
      updated_at ${nowDefault}
    )
  `);

  // 入金予測（売上1行→最大3行展開／日次CFの入金へ加算）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_predicted_incomes (
      id ${autoIncPK},
      sales_entry_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      facility_id INTEGER NOT NULL,
      ota_channel_id INTEGER NOT NULL,
      expected_date TEXT,
      amount INTEGER DEFAULT 0,
      period TEXT,
      created_at ${nowDefault}
    )
  `);

  // 全体売上収支（白井システム）— 施設×月の 売上/経費（Web編集可能・追加のみ）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_uriage_entries (
      id ${autoIncPK},
      facility TEXT NOT NULL,
      dept TEXT DEFAULT '',
      year_month TEXT NOT NULL,
      sales INTEGER DEFAULT 0,
      expense INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      updated_at ${nowDefault},
      UNIQUE(facility, year_month)
    )
  `);

  // 全体売上収支（白井システム）詳細指標 — 施設×月×指標（Excel卒業・全指標編集可能）
  await run(`
    CREATE TABLE IF NOT EXISTS funds_uriage_metrics (
      id ${autoIncPK},
      facility TEXT NOT NULL,
      year_month TEXT NOT NULL,
      metric TEXT NOT NULL,
      value TEXT DEFAULT '0',
      fac_order INTEGER DEFAULT 0,
      updated_at ${nowDefault},
      UNIQUE(facility, year_month, metric)
    )
  `);

  // 初期シード（マスタのみ。デモデータは投入しない）
  await seedFundsMasters();
  // await seedFundsDemoData();  // 正式データ移行のため無効化
  await seedFundsV10();
}

async function seedFundsMasters() {
  // 会社（引継ぎ書2.3）
  const companies = [
    { code: 'residence', name: 'レジデンス', is_funds_target: 1, color: '#1F4E79', sort_order: 1 },
    { code: 'resort',    name: 'リゾート',   is_funds_target: 1, color: '#0984e3', sort_order: 2 },
    { code: 'motel',     name: 'モーテル',   is_funds_target: 1, color: '#00b894', sort_order: 3 },
    { code: 'zack',      name: 'ザック',     is_funds_target: 1, color: '#e17055', sort_order: 4 },
    { code: 'world_ray', name: 'ワールド・レイ',   is_funds_target: 0, color: '#6c5ce7', sort_order: 5 },
    { code: 'coco_uni',  name: 'ココ・ユニバース', is_funds_target: 0, color: '#d63031', sort_order: 6 },
  ];
  const cCount = await query("SELECT COUNT(*) as c FROM funds_companies");
  if (Number(cCount[0].c) === 0) {
    for (const c of companies) {
      await run("INSERT INTO funds_companies (code, name, is_funds_target, color, sort_order) VALUES (?, ?, ?, ?, ?)",
        [c.code, c.name, c.is_funds_target, c.color, c.sort_order]);
    }
  }

  // 物件（引継ぎ書2.4）— 既存マッピング
  const pCount = await query("SELECT COUNT(*) as c FROM funds_properties");
  if (Number(pCount[0].c) === 0) {
    const compRows = await query("SELECT id, code FROM funds_companies");
    const byCode = {};
    compRows.forEach(r => { byCode[r.code] = r.id; });
    const props = [
      { name: 'リゾート',        code: 'resort',    sort_order: 1 },
      { name: 'ほうらい',        code: 'resort',    sort_order: 2 },
      { name: 'フォレスト',      code: 'resort',    sort_order: 3 },
      { name: 'グリーンシャワー',code: 'resort',    sort_order: 4 },
      { name: '周防大島',        code: 'resort',    sort_order: 5 },
      { name: 'モーテル',        code: 'motel',     sort_order: 6 },
      { name: 'レジデンス',      code: 'residence', sort_order: 7 },
      { name: 'ココユニバース',  code: 'zack',      sort_order: 8 },
    ];
    for (const p of props) {
      const cid = byCode[p.code];
      if (cid) await run("INSERT INTO funds_properties (name, company_id, sort_order) VALUES (?, ?, ?)",
        [p.name, cid, p.sort_order]);
    }
  }

  // 資金繰り項目（引継ぎ書3.6・6.4：12ヶ月レイアウトの行構成）
  const fiCount = await query("SELECT COUNT(*) as c FROM funds_fund_items");
  if (Number(fiCount[0].c) === 0) {
    const items = [
      // 収入
      { name: '現金売上',   kind: '収入', sort_order: 1 },
      { name: '売掛金回収', kind: '収入', sort_order: 2 },
      { name: '手形入金',   kind: '収入', sort_order: 3 },
      { name: 'その他収入', kind: '収入', sort_order: 4 },
      // 支出
      { name: '買掛金支払', kind: '支出', sort_order: 11 },
      { name: '人件費',     kind: '支出', sort_order: 12 },
      { name: '地代家賃',   kind: '支出', sort_order: 13 },
      { name: '水道光熱費', kind: '支出', sort_order: 14 },
      { name: '租税公課',   kind: '支出', sort_order: 15 },
      { name: '支払利息',   kind: '支出', sort_order: 16 },
      { name: 'その他経費', kind: '支出', sort_order: 17 },
      // 財務
      { name: '借入金',     kind: '財務', sort_order: 21 },
      { name: '設備売却',   kind: '財務', sort_order: 22 },
    ];
    for (const it of items) {
      await run("INSERT INTO funds_fund_items (name, kind, sort_order) VALUES (?, ?, ?)",
        [it.name, it.kind, it.sort_order]);
    }
  }

  // 勘定科目マスタ（→ 資金繰り項目にマッピング）
  const acCount = await query("SELECT COUNT(*) as c FROM funds_account_categories");
  if (Number(acCount[0].c) === 0) {
    const fiRows = await query("SELECT id, name FROM funds_fund_items");
    const fiByName = {};
    fiRows.forEach(r => { fiByName[r.name] = r.id; });
    const accs = [
      { name: '仕入',           fi: '買掛金支払', sort_order: 1 },
      { name: '給料手当',       fi: '人件費',     sort_order: 2 },
      { name: '法定福利費',     fi: '人件費',     sort_order: 3 },
      { name: '地代家賃',       fi: '地代家賃',   sort_order: 4 },
      { name: '水道光熱費',     fi: '水道光熱費', sort_order: 5 },
      { name: '通信費',         fi: 'その他経費', sort_order: 6 },
      { name: '消耗品費',       fi: 'その他経費', sort_order: 7 },
      { name: '修繕費',         fi: 'その他経費', sort_order: 8 },
      { name: '広告宣伝費',     fi: 'その他経費', sort_order: 9 },
      { name: '交際費',         fi: 'その他経費', sort_order: 10 },
      { name: '旅費交通費',     fi: 'その他経費', sort_order: 11 },
      { name: '車両費',         fi: 'その他経費', sort_order: 12 },
      { name: '租税公課',       fi: '租税公課',   sort_order: 13 },
      { name: '支払手数料',     fi: 'その他経費', sort_order: 14 },
      { name: '支払利息',       fi: '支払利息',   sort_order: 15 },
      { name: '減価償却費',     fi: 'その他経費', sort_order: 16 },
      { name: '保険料',         fi: 'その他経費', sort_order: 17 },
      { name: '雑費',           fi: 'その他経費', sort_order: 18 },
    ];
    for (const a of accs) {
      await run("INSERT INTO funds_account_categories (name, fund_item_id, sort_order) VALUES (?, ?, ?)",
        [a.name, fiByName[a.fi] || null, a.sort_order]);
    }
  }
}

// 5月のデモデータを投入（既にデータがあるときはスキップ）
async function seedFundsDemoData() {
  const incCount = await query("SELECT COUNT(*) as c FROM funds_income_entries");
  const payCount = await query("SELECT COUNT(*) as c FROM funds_payable_entries");
  const recCount = await query("SELECT COUNT(*) as c FROM funds_card_recoveries");
  if (Number(incCount[0].c) > 0 || Number(payCount[0].c) > 0 || Number(recCount[0].c) > 0) return;

  const comp = {};
  (await query("SELECT id, code FROM funds_companies")).forEach(r => comp[r.code] = r.id);
  const props = {};
  (await query("SELECT p.id, p.name, c.code AS company_code FROM funds_properties p JOIN funds_companies c ON c.id = p.company_id"))
    .forEach(r => props[r.name] = r.id);
  const fi = {};
  (await query("SELECT id, name FROM funds_fund_items")).forEach(r => fi[r.name] = r.id);
  const ac = {};
  (await query("SELECT id, name FROM funds_account_categories")).forEach(r => ac[r.name] = r.id);

  // ─── 入金 ───
  const incomeSeed = [
    // レジデンス
    { company: 'residence', entry_date: '2026-05-01', item: '5月分家賃（テナントA）', fi: '売掛金回収', amount: 1800000, status: '確認済' },
    { company: 'residence', entry_date: '2026-05-10', item: '5月分家賃（テナントB）', fi: '売掛金回収', amount: 1200000, status: '確認済' },
    { company: 'residence', entry_date: '2026-05-25', item: '駐車場収入',           fi: '現金売上',   amount:  350000, status: '確認済' },
    // リゾート
    { company: 'resort',    entry_date: '2026-05-03', item: '宿泊売上（GW）',       fi: '現金売上',   amount: 4200000, status: '確認済' },
    { company: 'resort',    entry_date: '2026-05-18', item: '宿泊売上（中旬）',     fi: '現金売上',   amount: 1850000, status: '確認済' },
    { company: 'resort',    entry_date: '2026-05-28', item: '法人団体予約入金',     fi: '売掛金回収', amount:  780000, status: '未確認' },
    // モーテル
    { company: 'motel',     entry_date: '2026-05-05', item: '宿泊売上（前半）',     fi: '現金売上',   amount: 1600000, status: '確認済' },
    { company: 'motel',     entry_date: '2026-05-22', item: '宿泊売上（後半）',     fi: '現金売上',   amount: 1400000, status: '確認済' },
    // ザック
    { company: 'zack',      entry_date: '2026-05-12', item: '管理委託料',           fi: '売掛金回収', amount:  500000, status: '確認済' },
    { company: 'zack',      entry_date: '2026-05-30', item: '清掃業務収入',         fi: 'その他収入', amount:  280000, status: '予測' },
  ];
  for (const s of incomeSeed) {
    await run(`INSERT INTO funds_income_entries (company_id, entry_date, item, fund_item_id, amount, status, memo)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [comp[s.company], s.entry_date, s.item, fi[s.fi] || null, s.amount, s.status, '']);
  }

  // ─── 未払／支出 ───
  const payableSeed = [
    // レジデンス
    { company: 'residence', property: 'レジデンス', kind: '月次予定', summary: '○○ガス（5月分）',        ac: '水道光熱費', due: '2026-05-31', plan: '2026-05-28', amount: 180000, priority: '月次' },
    { company: 'residence', property: 'レジデンス', kind: '月次予定', summary: '清掃委託料（5月分）',    ac: '雑費',       due: '2026-05-31', plan: '2026-05-31', amount: 320000, priority: '月次' },
    { company: 'residence', property: 'レジデンス', kind: '未払繰越', summary: '修繕費（漏水対応）',     ac: '修繕費',     due: '2026-04-30', plan: '2026-05-15', amount: 450000, priority: '低', carry_1m: 450000 },
    { company: 'residence', property: 'レジデンス', kind: '月次予定', summary: '建物管理委託費',         ac: '雑費',       due: '2026-05-25', plan: '2026-05-25', amount: 280000, priority: '月次' },
    // リゾート
    { company: 'resort',    property: 'リゾート',         kind: '月次予定', summary: '食材仕入（A社）',         ac: '仕入',       due: '2026-05-20', plan: '2026-05-20', amount: 1200000, priority: '月次' },
    { company: 'resort',    property: 'リゾート',         kind: '月次予定', summary: 'リネン業者',             ac: '雑費',       due: '2026-05-25', plan: '2026-05-25', amount:  450000, priority: '月次' },
    { company: 'resort',    property: 'ほうらい',         kind: '未払繰越', summary: '燃料費（前々月分）',     ac: '水道光熱費', due: '2026-03-31', plan: '2026-05-10', amount:  220000, priority: '中', carry_2m: 220000 },
    { company: 'resort',    property: 'フォレスト',       kind: '月次予定', summary: 'パート給与（5月分）',     ac: '給料手当',   due: '2026-05-25', plan: '2026-05-25', amount: 1800000, priority: '月次' },
    { company: 'resort',    property: 'グリーンシャワー', kind: '月次予定', summary: '電気代（中国電力）',     ac: '水道光熱費', due: '2026-05-31', plan: '2026-05-31', amount:  680000, priority: '月次' },
    // モーテル
    { company: 'motel',     property: 'モーテル', kind: '月次予定', summary: '備品仕入',                 ac: '消耗品費',   due: '2026-05-15', plan: '2026-05-15', amount: 180000, priority: '月次' },
    { company: 'motel',     property: 'モーテル', kind: '月次予定', summary: '清掃用洗剤',               ac: '消耗品費',   due: '2026-05-20', plan: '2026-05-20', amount:  85000, priority: '月次' },
    { company: 'motel',     property: 'モーテル', kind: '未払繰越', summary: '看板修理代（滞留）',       ac: '修繕費',     due: '2026-02-28', plan: '2026-05-30', amount: 350000, priority: '高', carry_3m_plus: 350000 },
    // ザック
    { company: 'zack',      property: 'ココユニバース', kind: '月次予定', summary: '清掃用品仕入',         ac: '消耗品費',   due: '2026-05-15', plan: '2026-05-15', amount: 120000, priority: '月次' },
    { company: 'zack',      property: 'ココユニバース', kind: '月次予定', summary: 'スタッフ給与',         ac: '給料手当',   due: '2026-05-25', plan: '2026-05-25', amount: 850000, priority: '月次' },
    { company: 'zack',      property: 'ココユニバース', kind: '月次予定', summary: '社用車リース',         ac: '車両費',     due: '2026-05-27', plan: '2026-05-27', amount:  95000, priority: '月次' },
  ];
  for (const s of payableSeed) {
    const total = (s.current_amount || 0) + (s.carry_1m || 0) + (s.carry_2m || 0) + (s.carry_3m_plus || 0);
    const current = total === 0 ? s.amount : (s.current_amount || 0);
    await run(`INSERT INTO funds_payable_entries
      (company_id, property_id, kind, summary, account_category_id, due_date, billto,
       current_amount, carry_1m, carry_2m, carry_3m_plus, priority, plan_date, plan_amount, pay_status, invoice_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        comp[s.company], props[s.property] || null, s.kind, s.summary, ac[s.ac] || null,
        s.due, '', current, s.carry_1m || 0, s.carry_2m || 0, s.carry_3m_plus || 0,
        s.priority, s.plan, s.amount, '', ''
      ]);
  }

  // ─── カード枠回復 ───
  const cardSeed = [
    { company: 'residence', pay_date: '2026-05-01', card_name: 'JCB',       amount: 280000, kind: '通常', memo: '5月分カード支払' },
    { company: 'residence', pay_date: '2026-05-10', card_name: '楽天カード', amount: 150000, kind: '通常', memo: '' },
    { company: 'resort',    pay_date: '2026-05-03', card_name: 'JCB',       amount: 850000, kind: '通常', memo: 'GW期間支払分' },
    { company: 'resort',    pay_date: '2026-05-18', card_name: 'AMEX',      amount: 320000, kind: '通常', memo: '' },
    { company: 'motel',     pay_date: '2026-05-05', card_name: '楽天カード', amount: 180000, kind: '通常', memo: '' },
    { company: 'zack',      pay_date: '2026-05-12', card_name: 'JCB',       amount: 120000, kind: '通常', memo: '' },
  ];
  for (const s of cardSeed) {
    await run("INSERT INTO funds_card_recoveries (company_id, pay_date, card_name, amount, kind, memo) VALUES (?, ?, ?, ?, ?, ?)",
      [comp[s.company], s.pay_date, s.card_name, s.amount, s.kind, s.memo]);
  }
}

// ===== v10 追加分のシード（17施設・16OTA・売上&入金予測サンプル） =====
async function seedFundsV10() {
  const comp = {};
  (await query("SELECT id, code FROM funds_companies")).forEach(r => comp[r.code] = r.id);

  // 施設（売上計上単位・引継ぎ書2.4）
  const facCount = await query("SELECT COUNT(*) as c FROM funds_facilities");
  if (Number(facCount[0].c) === 0) {
    const facilities = [
      // リゾート（ホテル）
      { name: 'de Lune',           dept: 'ホテル',   code: 'resort',    sort_order: 1 },
      { name: 'VIEW',              dept: 'ホテル',   code: 'resort',    sort_order: 2 },
      { name: '本川',              dept: 'ホテル',   code: 'resort',    sort_order: 3 },
      { name: '天神',              dept: 'ホテル',   code: 'resort',    sort_order: 4 },
      { name: '玖波',              dept: 'ホテル',   code: 'resort',    sort_order: 5 },
      { name: '温井',              dept: 'ホテル',   code: 'resort',    sort_order: 6 },
      { name: 'いこいの村',        dept: 'ホテル',   code: 'resort',    sort_order: 7 },
      // モーテル（ホテル）
      { name: '弥山',              dept: 'ホテル',   code: 'motel',     sort_order: 8 },
      // リゾート（マンスリー）
      { name: 'TAKAYA',            dept: 'マンスリー', code: 'resort', sort_order: 9 },
      { name: '壱番館',            dept: 'マンスリー', code: 'resort', sort_order: 10 },
      { name: '弐番館',            dept: 'マンスリー', code: 'resort', sort_order: 11 },
      { name: 'Otake',             dept: 'マンスリー', code: 'resort', sort_order: 12 },
      // リゾート（指定管理）
      { name: '竹原（レストラン含む）', dept: '指定管理', code: 'resort', sort_order: 13 },
      { name: 'フォレストヒルズガーデン', dept: '指定管理', code: 'resort', sort_order: 14 },
      { name: 'グリーンシャワー',  dept: '指定管理', code: 'resort', sort_order: 15 },
      // サウナ
      { name: 'MAKI de SAUNA',     dept: 'サウナ',   code: 'zack',      sort_order: 16 },
      { name: '周防大島',          dept: 'サウナ',   code: 'resort',    sort_order: 17 },
    ];
    for (const f of facilities) {
      const cid = comp[f.code];
      if (cid) await run("INSERT INTO funds_facilities (name, dept, company_id, sort_order) VALUES (?, ?, ?, ?)",
        [f.name, f.dept, cid, f.sort_order]);
    }
  }

  // OTA／決済（引継ぎ書5.2）
  const otaCount = await query("SELECT COUNT(*) as c FROM funds_ota_channels");
  if (Number(otaCount[0].c) === 0) {
    const otas = [
      { name: 'Booking',     cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 15, d_nxt2: null, sort: 1 },
      { name: '楽天',        cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 25, d_nxt2: null, sort: 2 },
      { name: 'じゃらん',    cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 25, d_nxt2: null, sort: 3 },
      { name: '一休',        cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 28, d_nxt2: null, sort: 4 },
      { name: 'Expedia',     cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 25, d_nxt2: null, sort: 5 },
      { name: 'Agoda',       cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 25, d_nxt2: null, sort: 6 },
      { name: 'スマレジ',    cur: 100, nxt: 0,   nxt2: 0,   d_cur: 31,   d_nxt: null, d_nxt2: null, sort: 7 },
      { name: 'JCB',         cur: 0,   nxt: 50,  nxt2: 50,  d_cur: null, d_nxt: 25, d_nxt2: 25,   sort: 8 },
      { name: 'GMO',         cur: 50,  nxt: 50,  nxt2: 0,   d_cur: 31,   d_nxt: 15, d_nxt2: null, sort: 9 },
      { name: 'JMS',         cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 15, d_nxt2: null, sort: 10 },
      { name: 'PayPay',      cur: 100, nxt: 0,   nxt2: 0,   d_cur: 28,   d_nxt: null, d_nxt2: null, sort: 11 },
      { name: 'カード',      cur: 0,   nxt: 100, nxt2: 0,   d_cur: null, d_nxt: 25, d_nxt2: null, sort: 12 },
      { name: '現金売上',    cur: 100, nxt: 0,   nxt2: 0,   d_cur: 28,   d_nxt: null, d_nxt2: null, sort: 13 },
      { name: 'ホテル売上',  cur: 100, nxt: 0,   nxt2: 0,   d_cur: 28,   d_nxt: null, d_nxt2: null, sort: 14 },
      { name: '竹原市',      cur: 0,   nxt: 0,   nxt2: 100, d_cur: null, d_nxt: null, d_nxt2: 28,   sort: 15 },
      { name: '売上',        cur: 100, nxt: 0,   nxt2: 0,   d_cur: 28,   d_nxt: null, d_nxt2: null, sort: 16 },
    ];
    for (const o of otas) {
      await run(`INSERT INTO funds_ota_channels (name, cur_ratio, nxt_ratio, nxt2_ratio, pay_day_cur, pay_day_nxt, pay_day_nxt2, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.name, o.cur, o.nxt, o.nxt2, o.d_cur, o.d_nxt, o.d_nxt2, o.sort]);
    }
  }

  // 売上＋入金予測 サンプル（4-5月分） — 正式データ移行のため無効化
  const salesCount = await query("SELECT COUNT(*) as c FROM funds_sales_entries");
  if (false && Number(salesCount[0].c) === 0) {
    const fac = {};
    (await query("SELECT id, name FROM funds_facilities")).forEach(r => fac[r.name] = r.id);
    const ota = {};
    (await query("SELECT * FROM funds_ota_channels")).forEach(r => ota[r.name] = r);

    // Excel v10「売上入力」より4-5月の代表データ（ホテル売上中心）
    const salesSeed = [
      // 4月計上
      { ym: '2026-04', company: 'zack',     fac: 'MAKI de SAUNA', ota: '売上',       amount:  121831 },
      { ym: '2026-04', company: 'resort',   fac: 'VIEW',          ota: 'ホテル売上', amount: 2904045 },
      { ym: '2026-04', company: 'resort',   fac: 'de Lune',       ota: 'ホテル売上', amount: 8310821 },
      { ym: '2026-04', company: 'resort',   fac: 'いこいの村',    ota: 'ホテル売上', amount: 6092392 },
      { ym: '2026-04', company: 'resort',   fac: '本川',          ota: 'ホテル売上', amount: 1955058 },
      { ym: '2026-04', company: 'resort',   fac: '温井',          ota: 'ホテル売上', amount: 2330934 },
      { ym: '2026-04', company: 'resort',   fac: '玖波',          ota: 'ホテル売上', amount:  331500 },
      { ym: '2026-04', company: 'motel',    fac: '弥山',          ota: 'ホテル売上', amount: 4004248 },
      { ym: '2026-04', company: 'resort',   fac: 'TAKAYA',        ota: '売上',       amount:  455000 },
      { ym: '2026-04', company: 'resort',   fac: '壱番館',        ota: '売上',       amount:  101400 },
      { ym: '2026-04', company: 'resort',   fac: '弐番館',        ota: '売上',       amount:   90000 },
      { ym: '2026-04', company: 'resort',   fac: 'Otake',         ota: '売上',       amount:  105000 },
      { ym: '2026-04', company: 'resort',   fac: 'グリーンシャワー',           ota: '売上',  amount:  626997 },
      { ym: '2026-04', company: 'resort',   fac: 'フォレストヒルズガーデン',   ota: '売上',  amount: 5535949 },
      { ym: '2026-04', company: 'resort',   fac: '竹原（レストラン含む）',     ota: '竹原市', amount: 840500 },
      // 5月計上
      { ym: '2026-05', company: 'zack',     fac: 'MAKI de SAUNA', ota: '売上',       amount:   36276 },
      { ym: '2026-05', company: 'resort',   fac: 'VIEW',          ota: 'ホテル売上', amount: 2287142 },
      { ym: '2026-05', company: 'resort',   fac: 'de Lune',       ota: 'ホテル売上', amount: 6833097 },
      { ym: '2026-05', company: 'resort',   fac: 'いこいの村',    ota: 'ホテル売上', amount: 4468786 },
      { ym: '2026-05', company: 'motel',    fac: '弥山',          ota: 'ホテル売上', amount: 1161868 },
      { ym: '2026-05', company: 'resort',   fac: 'VIEW',          ota: 'Booking',    amount: 1200000 },
      { ym: '2026-05', company: 'resort',   fac: 'de Lune',       ota: '楽天',       amount:  850000 },
      { ym: '2026-05', company: 'resort',   fac: 'いこいの村',    ota: 'じゃらん',   amount:  650000 },
      { ym: '2026-05', company: 'resort',   fac: 'TAKAYA',        ota: '売上',       amount:  455000 },
    ];
    for (const s of salesSeed) {
      const cid = comp[s.company];
      const fid = fac[s.fac];
      const o = ota[s.ota];
      if (!cid || !fid || !o) continue;
      const sid = await runInsert(`
        INSERT INTO funds_sales_entries (company_id, facility_id, ota_channel_id, year_month, amount, memo)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [cid, fid, o.id, s.ym, s.amount, '']);
      // 予測入金を3行展開
      const predictions = buildPredictedIncomes(s.ym, s.amount, o);
      for (const p of predictions) {
        await run(`
          INSERT INTO funds_predicted_incomes
            (sales_entry_id, company_id, facility_id, ota_channel_id, expected_date, amount, period)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [sid, cid, fid, o.id, p.date, p.amount, p.period]);
      }
    }
  }
}

// 売上1件→（当月／翌月／翌々月）の予測入金を計算
function buildPredictedIncomes(yearMonth, amount, ota) {
  const [y, m] = yearMonth.split('-').map(Number);
  const out = [];
  function clampDay(year, mo, day) {
    if (!day) return null;
    const last = new Date(year, mo, 0).getDate();
    return Math.min(day, last);
  }
  function addMonths(year, mo, delta) {
    let nm = mo + delta;
    let ny = year;
    while (nm > 12) { nm -= 12; ny += 1; }
    while (nm < 1)  { nm += 12; ny -= 1; }
    return { y: ny, m: nm };
  }
  const periods = [
    { ratio: ota.cur_ratio,  day: ota.pay_day_cur,  shift: 0, label: '当月分'  },
    { ratio: ota.nxt_ratio,  day: ota.pay_day_nxt,  shift: 1, label: '翌月分'  },
    { ratio: ota.nxt2_ratio, day: ota.pay_day_nxt2, shift: 2, label: '翌々月分' },
  ];
  for (const p of periods) {
    const r = p.ratio || 0;
    const amt = Math.round(amount * r / 100);
    let date = null;
    if (r > 0 && p.day) {
      const { y: yy, m: mm } = addMonths(y, m, p.shift);
      const d = clampDay(yy, mm, p.day);
      if (d) date = `${yy}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
    out.push({ date, amount: amt, period: p.label });
  }
  return out;
}

// ===== 組織体制図ハブ用テーブル =====
async function createOrgChartTables() {
  const autoIncPK = (mode === 'pg') ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const nowDefault = (mode === 'pg') ? 'TIMESTAMP DEFAULT NOW()' : "TEXT DEFAULT (datetime('now','localtime'))";

  // ノード差分（既存ハードコードノードへの上書きパッチ）と付箋（新規フリーテキスト）を1テーブルで管理
  // kind='node'  : node_id 必須、data は {x?, y?, title?, sub?, person?} の部分上書き
  // kind='sticky': node_id NULL、data は {x, y, w?, text, color?}
  await run(`
    CREATE TABLE IF NOT EXISTS org_chart_edits (
      id ${autoIncPK},
      panel TEXT NOT NULL,
      kind TEXT NOT NULL,
      node_id TEXT,
      data TEXT NOT NULL,
      created_at ${nowDefault},
      updated_at ${nowDefault}
    )
  `);
}

// ===== 経理モジュール用テーブル =====
async function createKeiriTables() {
  const autoIncPK = (mode === 'pg') ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const nowDefault = (mode === 'pg') ? 'TIMESTAMP DEFAULT NOW()' : "TEXT DEFAULT (datetime('now','localtime'))";

  // 請求書
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_invoices (
      id ${autoIncPK},
      vendor TEXT NOT NULL,
      category TEXT,
      payment_method TEXT,
      due_date TEXT,
      facility TEXT,
      entity TEXT DEFAULT '',
      transaction_date TEXT,
      amount INTEGER DEFAULT 0,
      carry_1 INTEGER DEFAULT 0,
      carry_2 INTEGER DEFAULT 0,
      carry_3 INTEGER DEFAULT 0,
      amount_cleared INTEGER DEFAULT 0,
      carry_1_cleared INTEGER DEFAULT 0,
      carry_2_cleared INTEGER DEFAULT 0,
      carry_3_cleared INTEGER DEFAULT 0,
      month TEXT,
      year INTEGER,
      note TEXT,
      status TEXT DEFAULT '未',
      cleared_at TEXT,
      matched_bank_tx_id INTEGER,
      created_at ${nowDefault}
    )
  `);

  // 通帳取引
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_bank_transactions (
      id ${autoIncPK},
      account TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      row_number INTEGER,
      tx_date TEXT NOT NULL,
      value_date TEXT,
      withdrawal INTEGER DEFAULT 0,
      deposit INTEGER DEFAULT 0,
      check_type TEXT,
      balance INTEGER DEFAULT 0,
      tx_type TEXT,
      detail_type TEXT,
      bank_name TEXT,
      branch_name TEXT,
      description TEXT,
      description_pattern TEXT DEFAULT '',
      vendor_name TEXT DEFAULT '',
      category TEXT DEFAULT '',
      facility TEXT DEFAULT '',
      is_cleared TEXT DEFAULT '',
      note1 TEXT DEFAULT '',
      note2 TEXT DEFAULT '',
      month TEXT,
      year INTEGER,
      auto_categorized INTEGER DEFAULT 0,
      matched_invoice_id INTEGER,
      imported_at ${nowDefault}
    )
  `);

  // 学習ルール
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_category_rules (
      id ${autoIncPK},
      description_pattern TEXT NOT NULL,
      account TEXT DEFAULT '',
      category TEXT DEFAULT '',
      facility TEXT DEFAULT '',
      vendor_name TEXT DEFAULT '',
      priority INTEGER DEFAULT 0,
      match_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at ${nowDefault},
      updated_at ${nowDefault},
      UNIQUE(description_pattern, account)
    )
  `);

  // 銀行口座マスタ
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_bank_accounts (
      id ${autoIncPK},
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at ${nowDefault}
    )
  `);

  // 施設マスタ
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_facilities (
      id ${autoIncPK},
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // 消込履歴
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_clear_history (
      id ${autoIncPK},
      invoice_id INTEGER,
      clear_type TEXT,
      cleared_at TEXT
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_invoice_files (
      id ${autoIncPK},
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      vendor TEXT,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER,
      uploaded_at ${nowDefault}
    )
  `);

  // 初期データ（空の場合のみ）
  const bankAccCount = await query("SELECT COUNT(*) as c FROM keiri_bank_accounts");
  if (Number(bankAccCount[0].c) === 0) {
    await run("INSERT INTO keiri_bank_accounts (name, display_name, sort_order) VALUES (?, ?, ?)",
      ['リゾート親', 'リゾート親口座', 1]);
    await run("INSERT INTO keiri_bank_accounts (name, display_name, sort_order) VALUES (?, ?, ?)",
      ['モーテル', 'モーテル口座', 2]);
    await run("INSERT INTO keiri_bank_accounts (name, display_name, sort_order) VALUES (?, ?, ?)",
      ['レジデンス', 'レジデンス口座', 3]);
  }

  const facCount = await query("SELECT COUNT(*) as c FROM keiri_facilities");
  if (Number(facCount[0].c) === 0) {
    const facList = [
      'リゾート', 'ビュー', 'デルーネ', 'デルーネ西館', '天神ハウス', '本川', '竹原', 'たけはら',
      'フォレストヒルズ', '温井', 'いこいの村', 'グリーンシャワー', 'パルコ',
      'ほうらいの里', 'ほうらい(客室)', 'カフェ', '沖縄', '周防大島', '弥山',
      'サウナ', 'マンスリー', 'ココユニバース', '不明'
    ];
    for (let i = 0; i < facList.length; i++) {
      await run("INSERT INTO keiri_facilities (name, sort_order) VALUES (?, ?)", [facList[i], i]);
    }
  }

  // 必須5社を確実に登録（既存DBへの追加マイグレーション）
  const requiredFacilities = ['リゾート', 'レジデンス', 'ワールド・レイ', 'ココ・ユニバース', 'モーテル'];
  for (const name of requiredFacilities) {
    const exists = await query("SELECT COUNT(*) as c FROM keiri_facilities WHERE name = ?", [name]);
    if (Number(exists[0].c) === 0) {
      const maxRow = await query("SELECT COALESCE(MAX(sort_order), -1) as m FROM keiri_facilities");
      await run("INSERT INTO keiri_facilities (name, sort_order) VALUES (?, ?)", [name, Number(maxRow[0].m) + 1]);
    }
  }

  // 現場要望施設を追加（存在チェックしてから挿入 ─ PG/SQLite 共通）
  const requestedFacilities = ['リゾート', 'ビュー', 'デルーネ', '弥山', 'ほうらい', '本川', '温井', 'いこいの村', 'フォレスト', '竹原', '周防大島'];
  for (const name of requestedFacilities) {
    const exists = await query("SELECT COUNT(*) as c FROM keiri_facilities WHERE name = ?", [name]);
    if (Number(exists[0].c) === 0) {
      const maxRow = await query("SELECT COALESCE(MAX(sort_order), -1) as m FROM keiri_facilities");
      await run("INSERT INTO keiri_facilities (name, sort_order) VALUES (?, ?)", [name, Number(maxRow[0].m) + 1]);
    }
  }

  // 支払方法マスタ
  await run(`
    CREATE TABLE IF NOT EXISTS keiri_payment_methods (
      id ${autoIncPK},
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#636e72',
      sort_order INTEGER DEFAULT 0
    )
  `);

  // 支払方法の初期データ（空の場合のみ）
  const pmCount = await query("SELECT COUNT(*) as c FROM keiri_payment_methods");
  if (Number(pmCount[0].c) === 0) {
    const defaultMethods = [
      { name: '振替',     color: '#6c5ce7', sort_order: 1 },
      { name: '振込',     color: '#d63031', sort_order: 2 },
      { name: 'コンビニ', color: '#e17055', sort_order: 3 },
      { name: 'クレジット', color: '#00b894', sort_order: 4 },
      { name: '銀行',     color: '#0984e3', sort_order: 5 },
    ];
    for (const m of defaultMethods) {
      await run("INSERT INTO keiri_payment_methods (name, color, sort_order) VALUES (?, ?, ?)", [m.name, m.color, m.sort_order]);
    }
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

  // 経理担当 井上さん（201）を登録
  const inoue = await query("SELECT id FROM users WHERE employee_id = ?", ['201']);
  if (inoue.length === 0) {
    const hash = bcrypt.hashSync('igr2026', 10);
    await run("INSERT INTO users (employee_id, password, name, role, group_id, keiri_access) VALUES (?, ?, ?, ?, ?, ?)",
      ['201', hash, '井上', 'user', grId, 1]);
  } else {
    // 既に存在する場合は keiri_access を立てる
    await run("UPDATE users SET keiri_access = 1 WHERE employee_id = ?", ['201']);
  }

  // 管理者にも keiri_access を付与
  await run("UPDATE users SET keiri_access = 1 WHERE role = 'admin'");

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

module.exports = { initDatabase, query, run, runInsert, buildPredictedIncomes, seedFundsMasters, seedFundsV10 };
