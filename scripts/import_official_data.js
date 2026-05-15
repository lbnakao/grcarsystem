// =============================================================================
// 公式Excelデータ移行スクリプト
//   - GR経理/2026年５月 配下の通帳5本 + 請求額5本 をインポート
//   - 既存のデモデータ(funds_*, keiri_invoices, keiri_bank_transactions) は全削除
//   - 実行: node scripts/import_official_data.js
// =============================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { initDatabase, query, run, runInsert } = require('../db');

const SRC_DIR = 'C:\\Users\\event\\OneDrive\\デスクトップ\\AIクライアント用\\GR経理\\2026年５月';

// ─── 共通ユーティリティ ───
function excelSerialToDate(serial) {
  const n = Number(serial);
  if (isNaN(n) || n < 1) return null;
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const date = new Date(epoch.getTime() + n * 86400000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function dateToMonthLabel(s) { if (!s) return null; const m = parseInt(s.split('-')[1], 10); return isNaN(m) ? null : `${m}月`; }
function dateToYear(s) { if (!s) return null; const y = parseInt(s.split('-')[0], 10); return isNaN(y) ? null : y; }
function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[,\s¥￥]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function toStr(v) { if (v === null || v === undefined) return ''; return String(v).trim(); }
function parseDate(s, defaultYear) {
  if (!s && s !== 0) return null;
  if (typeof s === 'number') return excelSerialToDate(s);
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let yy = parseInt(m[3], 10);
    if (yy < 100) yy = yy < 70 ? 2000 + yy : 1900 + yy;
    return `${yy}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m && defaultYear) return `${defaultYear}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  m = s.match(/^[RrＲ](\d+)[\.\-\/年](\d{1,2})[\.\-\/月](\d{1,2})/);
  if (m) { const y = 2018 + parseInt(m[1]); return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`; }
  if (/^\d+$/.test(s) && parseInt(s) > 30000 && parseInt(s) < 80000) return excelSerialToDate(parseInt(s));
  return null;
}

// ─── データ削除 ───
async function wipeDemoData() {
  const tables = [
    'keiri_invoices',
    'keiri_bank_transactions',
    'keiri_clear_history',
    'funds_income_entries',
    'funds_payable_entries',
    'funds_card_recoveries',
    'funds_predicted_incomes',
    'funds_sales_entries',
  ];
  for (const t of tables) {
    try {
      await run(`DELETE FROM ${t}`);
      console.log(`  ✓ ${t} を全削除`);
    } catch (e) {
      console.log(`  ! ${t}: ${e.message}`);
    }
  }
}

// ─── 通帳ファイルのインポート ───
const PARENT_LEDGER_MAP = {
  accountInfo: 0, rowNumber: 1, date: 2, valueDate: 3,
  withdrawal: 4, deposit: 5, checkType: 6, balance: 7,
  txType: 8, detailType: 9, bankName: 10, branchName: 11,
  description: 12, category: 13, facility: 14, isCleared: 15, note1: 16, note2: 17,
};

async function importPassbook(filePath) {
  const filename = path.basename(filePath);
  console.log(`\n[通帳] ${filename}`);
  const wb = XLSX.readFile(filePath, { cellDates: false });
  let totalInserted = 0;
  for (const sheetName of wb.SheetNames) {
    if (!sheetName.includes('CSV') && !sheetName.includes('csv')) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const account = sheetName.replace(/【CSV】|【csv】|\[CSV\]/gi, '').trim();
    const batchId = `import_${Date.now()}_${account}`;
    let inserted = 0;
    const M = PARENT_LEDGER_MAP;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const get = (idx) => idx >= 0 && idx < row.length ? row[idx] : '';
      const txDate = parseDate(get(M.date));
      const withdrawal = toInt(get(M.withdrawal));
      const deposit = toInt(get(M.deposit));
      if (!txDate || (!withdrawal && !deposit)) continue;
      const valueDate = parseDate(get(M.valueDate));
      const description = toStr(get(M.description));
      const month = dateToMonthLabel(txDate);
      const year = dateToYear(txDate);
      await run(`INSERT INTO keiri_bank_transactions (
        account, batch_id, row_number, tx_date, value_date, withdrawal, deposit, check_type, balance,
        tx_type, detail_type, bank_name, branch_name, description, vendor_name,
        category, facility, is_cleared, note1, note2, month, year, auto_categorized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
        account, batchId, toInt(get(M.rowNumber)), txDate, valueDate, withdrawal, deposit,
        toStr(get(M.checkType)), toInt(get(M.balance)),
        toStr(get(M.txType)), toStr(get(M.detailType)),
        toStr(get(M.bankName)), toStr(get(M.branchName)),
        description, '',
        toStr(get(M.category)), toStr(get(M.facility)),
        toStr(get(M.isCleared)), toStr(get(M.note1)), toStr(get(M.note2)),
        month, year,
      ]);
      inserted++;
    }
    // 口座マスタに登録
    const exists = await query('SELECT 1 FROM keiri_bank_accounts WHERE name = ?', [account]);
    if (exists.length === 0) {
      await run('INSERT INTO keiri_bank_accounts (name, display_name, sort_order) VALUES (?, ?, ?)',
        [account, account, 99]);
    }
    console.log(`  ✓ シート「${sheetName}」→ 口座「${account}」: ${inserted}件`);
    totalInserted += inserted;
  }
  return totalInserted;
}

// ─── 請求額ファイルのインポート ───
const SKIP_SHEETS = ['検索', '総合計'];
const ENTITY_MAP = {
  'ｸﾞﾘｰﾝｼｬﾜｰ': 'グリーンシャワー',
  'ｸﾞﾘ-ﾝｼﾔﾜ-': 'グリーンシャワー',
};

async function importInvoices(filePath) {
  const filename = path.basename(filePath);
  console.log(`\n[請求額] ${filename}`);
  // ファイル名から月と年を取得 例: R8.5月（4月分）請求額.xlsx → month='5月', year=2026
  let defaultMonth = '';
  let defaultYear = null;
  const mm = filename.match(/R\d+\.(\d{1,2})月/);
  if (mm) defaultMonth = mm[1] + '月';
  const yr = filename.match(/R(\d+)/);
  if (yr) defaultYear = 2018 + parseInt(yr[1]);

  const wb = XLSX.readFile(filePath, { cellDates: false });
  let totalInserted = 0;
  for (const sheetName of wb.SheetNames) {
    if (SKIP_SHEETS.some(s => sheetName.includes(s))) continue;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    if (rows.length < 3) continue;
    const entity = ENTITY_MAP[sheetName] || sheetName;
    let month = defaultMonth;
    let year = defaultYear;
    if (rows[0] && rows[0][0]) {
      const tm = String(rows[0][0]).match(/(\d{1,2})\s*月/);
      if (tm) month = tm[1] + '月';
    }
    // ヘッダー行の検出
    let headerIdx = -1;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const s = (rows[i] || []).map(c => String(c || '')).join('');
      if (/概要|業者名/.test(s) && /勘定科目|科目/.test(s)) { headerIdx = i; break; }
    }
    if (headerIdx < 0) continue;
    const header = rows[headerIdx];
    const cm = { vendor: -1, category: -1, payMethod: -1, dueDate: -1, facility: -1, txDate: -1, amount: -1, carry1: -1, carry2: -1, carry3: -1, note: -1 };
    for (let i = 0; i < header.length; i++) {
      const h = String(header[i] || '').trim();
      if (!h) continue;
      if (cm.vendor < 0 && /概要|業者名/.test(h)) cm.vendor = i;
      else if (cm.category < 0 && /勘定科目|科目/.test(h)) cm.category = i;
      else if (cm.payMethod < 0 && /支払方法|支払/.test(h)) cm.payMethod = i;
      else if (cm.dueDate < 0 && /期日|期限/.test(h)) cm.dueDate = i;
      else if (cm.facility < 0 && /請求先|施設/.test(h)) cm.facility = i;
      else if (cm.txDate < 0 && /取引日/.test(h)) cm.txDate = i;
      else if (cm.amount < 0 && /金額|当月/.test(h)) cm.amount = i;
      else if (cm.carry1 < 0 && /前月繰越/.test(h)) cm.carry1 = i;
      else if (cm.carry2 < 0 && /前々.*繰越|前々月/.test(h)) cm.carry2 = i;
      else if (cm.carry3 < 0 && /前々々/.test(h)) cm.carry3 = i;
    }
    let inserted = 0;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const get = (idx) => idx >= 0 && idx < row.length ? row[idx] : '';
      const vendor = toStr(get(cm.vendor));
      if (!vendor || /合計|小計|総計/.test(vendor)) continue;
      const amount = toInt(get(cm.amount));
      const carry1 = toInt(get(cm.carry1));
      const carry2 = toInt(get(cm.carry2));
      const carry3 = toInt(get(cm.carry3));
      if (amount === 0 && carry1 === 0 && carry2 === 0 && carry3 === 0) continue;
      await run(`INSERT INTO keiri_invoices (vendor, category, payment_method, due_date, facility, entity, transaction_date, amount, carry_1, carry_2, carry_3, month, year, note, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '未')`,
        [vendor, toStr(get(cm.category)), toStr(get(cm.payMethod)),
         parseDate(get(cm.dueDate), year) || '',
         toStr(get(cm.facility)), entity,
         parseDate(get(cm.txDate), year) || '',
         amount, carry1, carry2, carry3, month, year, '']);
      inserted++;
    }
    console.log(`  ✓ シート「${sheetName}」→ 事業体「${entity}」: ${inserted}件`);
    totalInserted += inserted;
  }
  return totalInserted;
}

// ─── メイン ───
(async () => {
  console.log('======================================');
  console.log('公式データ移行スクリプト');
  console.log('======================================');
  await initDatabase();

  console.log('\n[STEP 1] 既存のデモデータを削除');
  await wipeDemoData();

  console.log('\n[STEP 2] 通帳ファイルをインポート');
  const passbookFiles = fs.readdirSync(SRC_DIR)
    .filter(f => f.includes('通帳') && /\.xlsx$/i.test(f))
    .map(f => path.join(SRC_DIR, f));
  let bankTotal = 0;
  for (const f of passbookFiles) {
    bankTotal += await importPassbook(f);
  }
  console.log(`  ─ 通帳取引: 合計 ${bankTotal} 件`);

  console.log('\n[STEP 3] 請求額ファイルをインポート');
  const invoiceFiles = fs.readdirSync(SRC_DIR)
    .filter(f => /R\d+\.\d+月.*請求額\.xlsx$/i.test(f))
    .map(f => path.join(SRC_DIR, f));
  let invTotal = 0;
  for (const f of invoiceFiles) {
    invTotal += await importInvoices(f);
  }
  console.log(`  ─ 請求書: 合計 ${invTotal} 件`);

  console.log('\n======================================');
  console.log('移行完了');
  console.log('======================================');
  process.exit(0);
})().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
