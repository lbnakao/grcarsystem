// ============================================================================
// 経理モジュール API ルート
// マウントポイント: /api/keiri/*
// テーブル: keiri_* プレフィックス
// DB: 共有 query/run (sql.js or PostgreSQL)
// ============================================================================
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { query, run, runInsert } = require('../db');
const categorizer = require('../lib/keiri-categorizer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
router.use(express.json({ limit: '50mb' }));

// ─── ユーティリティ ───
function excelSerialToDate(serial) {
  if (!serial && serial !== 0) return null;
  const n = Number(serial);
  if (isNaN(n) || n < 1) return null;
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const date = new Date(epoch.getTime() + n * 86400000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function dateToMonthLabel(s) {
  if (!s) return null;
  const m = parseInt(s.split('-')[1], 10);
  return isNaN(m) ? null : `${m}月`;
}
function dateToYear(s) {
  if (!s) return null;
  const y = parseInt(s.split('-')[0], 10);
  return isNaN(y) ? null : y;
}
function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
function parseDate(s) {
  if (!s && s !== 0) return null;
  if (typeof s === 'number') return excelSerialToDate(s);
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^[RrＲ令和]\s*(\d+)[\.\-\/年](\d{1,2})[\.\-\/月](\d{1,2})/);
  if (m) { const y = 2018 + parseInt(m[1]); return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`; }
  m = s.match(/^[HhＨ平成]\s*(\d+)[\.\-\/年](\d{1,2})[\.\-\/月](\d{1,2})/);
  if (m) { const y = 1988 + parseInt(m[1]); return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`; }
  if (/^\d+$/.test(s) && parseInt(s) > 30000 && parseInt(s) < 80000) return excelSerialToDate(parseInt(s));
  return null;
}

function detectColumns(header) {
  const map = { date: -1, valueDate: -1, withdrawal: -1, deposit: -1, balance: -1, description: -1, txType: -1, bankName: -1, branchName: -1, rowNumber: -1, accountInfo: -1, category: -1, facility: -1, isCleared: -1, note: -1 };
  if (!Array.isArray(header)) return map;
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '').trim().toLowerCase().replace(/\s/g, '');
    if (!h) continue;
    if (map.date < 0 && /勘定日|取引日|日付|年月日|お取扱日|ご利用日|date/.test(h)) map.date = i;
    else if (map.valueDate < 0 && /起算日|valuedate/.test(h)) map.valueDate = i;
    else if (map.withdrawal < 0 && /出金|お引出|引出|引落|お支払|支払|withdrawal|debit/.test(h)) map.withdrawal = i;
    else if (map.deposit < 0 && /入金|お預入|預入|お預け入|預け入|deposit|credit/.test(h)) map.deposit = i;
    else if (map.balance < 0 && /残高|差引残高|balance/.test(h)) map.balance = i;
    else if (map.description < 0 && /摘要|内容|お取扱内容|取扱内容|description|memo/.test(h)) map.description = i;
    else if (map.txType < 0 && /取引区分|区分/.test(h)) map.txType = i;
    else if (map.bankName < 0 && /金融機関|銀行名/.test(h)) map.bankName = i;
    else if (map.branchName < 0 && /支店/.test(h)) map.branchName = i;
    else if (map.rowNumber < 0 && /^番号|^no\.?$|順序/.test(h)) map.rowNumber = i;
    else if (map.accountInfo < 0 && /照会口座|口座/.test(h)) map.accountInfo = i;
    else if (map.category < 0 && /勘定科目|科目/.test(h)) map.category = i;
    else if (map.facility < 0 && /施設名|施設|請求先/.test(h)) map.facility = i;
    else if (map.isCleared < 0 && /^済$|チェック|入力済/.test(h)) map.isCleared = i;
    else if (map.note < 0 && /備考|メモ|note/.test(h)) map.note = i;
  }
  return map;
}
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  return lines.map(line => {
    if (!line) return [];
    const result = []; let current = ''; let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (c === '"') { inQuote = false; }
        else { current += c; }
      } else {
        if (c === '"') { inQuote = true; }
        else if (c === ',') { result.push(current); current = ''; }
        else { current += c; }
      }
    }
    result.push(current);
    return result.map(s => s.trim());
  });
}
function decodeBuffer(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf-8');
  const utf8 = buf.toString('utf-8');
  const replaceCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replaceCount > 5 || (replaceCount > 0 && replaceCount / utf8.length > 0.01)) {
    try { const iconv = require('iconv-lite'); return iconv.decode(buf, 'Shift_JIS'); }
    catch (e) { try { return new TextDecoder('shift-jis').decode(buf); } catch (e2) { return utf8; } }
  }
  return utf8;
}

// ─── カテゴリ同義グループ ───
const CATEGORY_GROUPS = [
  ['水道光熱費', '電気', '水道', 'ガス', '光熱費'],
  ['ゴミ収集費', 'ゴミ収集', 'ごみ収集', 'ごみ収集費'],
  ['業務委託費', '業務委託料'],
  ['警備費', '警備料'],
  ['リース料', 'リース費'],
  ['通信費', 'Wi-Fi', 'WiFi', '電話料'],
  ['租税公課', '税金'],
  ['賃料', '家賃'],
];
function categoryGroupKey(cat) {
  if (!cat) return '';
  for (const g of CATEGORY_GROUPS) if (g.includes(cat)) return g[0];
  return cat;
}
function categoriesMatch(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  return categoryGroupKey(a) === categoryGroupKey(b);
}
function normalizeForMatch(s) {
  if (!s) return '';
  return String(s)
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/ｶﾌﾞｼｷｶﾞｲｼﾔ|株式会社|\(株\)|㈱|ｶ\)|\(ｶ/g, '')
    .replace(/ﾕｳｹﾞﾝｶﾞｲｼﾔ|有限会社|\(有\)|㈲|ﾕ\)|\(ﾕ/g, '')
    .replace(/ｺﾞｳﾄﾞｳｶﾞｲｼﾔ|合同会社|\(同\)/g, '')
    .replace(/[\s\-ー−‐‑‒–—−]/g, '')
    .toLowerCase();
}
function kanaNormalize(s) {
  const h2f = {
    'ｧ':'ア','ｨ':'イ','ｩ':'ウ','ｪ':'エ','ｫ':'オ','ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ',
    'ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ','ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ',
    'ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト','ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ',
    'ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ','ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ',
    'ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ','ｬ':'ヤ','ｭ':'ユ','ｮ':'ヨ','ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ',
    'ﾜ':'ワ','ｦ':'ヲ','ﾝ':'ン','ｯ':'ツ','ﾞ':'','ﾟ':'','ｰ':'ー',
  };
  return s.split('').map(c => h2f[c] || c).join('');
}
function vendorSimilarity(a, b) {
  if (!a || !b) return 0;
  const na = normalizeForMatch(kanaNormalize(a));
  const nb = normalizeForMatch(kanaNormalize(b));
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 2 && nb.includes(na)) return 0.8;
  if (nb.length >= 2 && na.includes(nb)) return 0.8;
  const minLen = Math.min(na.length, nb.length);
  if (minLen >= 3) {
    let common = 0;
    for (let i = 0; i < minLen && na[i] === nb[i]; i++) common++;
    if (common >= 3) return 0.5 + (common / minLen) * 0.3;
  }
  return 0;
}

// ─── 請求書ステータスを再計算 ───
async function recalcInvoiceStatus(id) {
  const rows = await query('SELECT amount, carry_1, carry_2, carry_3, amount_cleared, carry_1_cleared, carry_2_cleared, carry_3_cleared FROM keiri_invoices WHERE id = ?', [id]);
  if (rows.length === 0) return;
  const r = rows[0];
  const pairs = [
    [r.amount || 0, r.amount_cleared],
    [r.carry_1 || 0, r.carry_1_cleared],
    [r.carry_2 || 0, r.carry_2_cleared],
    [r.carry_3 || 0, r.carry_3_cleared],
  ];
  const nonZero = pairs.filter(([v]) => v > 0);
  let newStatus;
  if (nonZero.length === 0) {
    const anyFlag = pairs.some(([, c]) => c);
    newStatus = anyFlag ? '済' : '未';
  } else {
    const allCleared = nonZero.every(([, c]) => c);
    const anyCleared = nonZero.some(([, c]) => c);
    newStatus = allCleared ? '済' : (anyCleared ? '一部済' : '未');
  }
  await run('UPDATE keiri_invoices SET status = ? WHERE id = ?', [newStatus, id]);
}

// ============================================================================
// 銀行口座マスタ
// ============================================================================
router.get('/accounts', async (req, res) => {
  const rows = await query('SELECT * FROM keiri_bank_accounts ORDER BY sort_order, id');
  res.json(rows);
});
router.post('/accounts', async (req, res) => {
  const { name, display_name, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const id = await runInsert('INSERT INTO keiri_bank_accounts (name, display_name, sort_order) VALUES (?, ?, ?)',
      [name, display_name || name, sort_order || 99]);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/accounts/:id', async (req, res) => {
  const { name, display_name, sort_order } = req.body;
  const upd = [], val = [];
  if (name !== undefined) { upd.push('name = ?'); val.push(name); }
  if (display_name !== undefined) { upd.push('display_name = ?'); val.push(display_name); }
  if (sort_order !== undefined) { upd.push('sort_order = ?'); val.push(sort_order); }
  if (upd.length === 0) return res.status(400).json({ error: 'no fields' });
  val.push(req.params.id);
  await run(`UPDATE keiri_bank_accounts SET ${upd.join(', ')} WHERE id = ?`, val);
  res.json({ ok: true });
});
router.delete('/accounts/:id', async (req, res) => {
  await run('DELETE FROM keiri_bank_accounts WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ============================================================================
// 施設マスタ
// ============================================================================
router.get('/facilities', async (req, res) => {
  const rows = await query('SELECT * FROM keiri_facilities ORDER BY sort_order, id');
  res.json(rows);
});
router.post('/facilities', async (req, res) => {
  const { name, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const id = await runInsert('INSERT INTO keiri_facilities (name, sort_order) VALUES (?, ?)',
      [name, sort_order || 99]);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/facilities/:id', async (req, res) => {
  const { name, sort_order } = req.body;
  const upd = [], val = [];
  if (name !== undefined) { upd.push('name = ?'); val.push(name); }
  if (sort_order !== undefined) { upd.push('sort_order = ?'); val.push(sort_order); }
  if (upd.length === 0) return res.status(400).json({ error: 'no fields' });
  val.push(req.params.id);
  await run(`UPDATE keiri_facilities SET ${upd.join(', ')} WHERE id = ?`, val);
  res.json({ ok: true });
});
router.delete('/facilities/:id', async (req, res) => {
  await run('DELETE FROM keiri_facilities WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ============================================================================
// 勘定科目マスタ（固定）
// ============================================================================
const CATEGORIES = [
  '通信費', 'システム利用料', '設備費', '備品消耗品費', '修繕費', 'リネン費', 'リース料',
  '広告宣伝費', '旅費交通費', '水道光熱費', '燃料費', '衛生管理費', '食材費', 'ゴミ収集費',
  '手数料', '警備料', '警備費', '新聞図書費', '諸会費', '家賃', '賃料', '利息', '税金',
  '租税公課', '保証料', '組合費', '協賛金', '法定福利費', '人件費', '業務委託料', '業務委託費',
  '資金移動', '小口金', '保管料', '保険', 'Wi-Fi', '電気', 'ガス', '水道', '社長へ', '不明', 'その他'
];
router.get('/categories', (req, res) => res.json(CATEGORIES));

// ============================================================================
// 通帳アップロード
// ============================================================================
router.post('/bank/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  const filename = req.file.originalname || 'upload';
  const isExcel = /\.(xlsx|xls)$/i.test(filename);
  const accountFromForm = req.body.account || '';

  const PARENT_LEDGER_MAP = { accountInfo: 0, rowNumber: 1, date: 2, valueDate: 3, withdrawal: 4, deposit: 5, checkType: 6, balance: 7, txType: 8, detailType: 9, bankName: 10, branchName: 11, description: 12, category: 13, facility: 14, isCleared: 15, note1: 16, note2: 17 };

  let parsed = [];
  try {
    if (isExcel) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const csvSheets = wb.SheetNames.filter(n => n.includes('CSV') || n.includes('csv'));
      const sheetsToProcess = csvSheets.length > 0 ? csvSheets : wb.SheetNames;
      const isParentLedger = csvSheets.length > 0;
      for (const sheetName of sheetsToProcess) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const account = accountFromForm || sheetName.replace(/【CSV】|【csv】|\[CSV\]/gi, '').trim();
        const colMap = isParentLedger ? PARENT_LEDGER_MAP : detectColumns(rows[0] || []);
        parsed.push({ account, rows, colMap });
      }
    } else {
      const text = decodeBuffer(req.file.buffer);
      const rows = parseCSV(text);
      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const r = rows[i];
        if (r && r.some(c => /勘定日|取引日|出金|お引出|残高|摘要/.test(String(c || '')))) { headerIdx = i; break; }
      }
      const colMap = detectColumns(rows[headerIdx] || []);
      const score = (colMap.date >= 0 ? 1 : 0) + (colMap.withdrawal >= 0 ? 1 : 0) + (colMap.deposit >= 0 ? 1 : 0) + (colMap.description >= 0 ? 1 : 0);
      const finalMap = score >= 2 ? colMap : PARENT_LEDGER_MAP;
      const dataRows = [rows[headerIdx], ...rows.slice(headerIdx + 1)];
      const accountName = accountFromForm || filename.replace(/\.(csv|xlsx?|txt)$/i, '');
      parsed.push({ account: accountName, rows: dataRows, colMap: finalMap });
    }
  } catch (e) { return res.status(400).json({ error: 'ファイル読み込みエラー: ' + e.message }); }

  const batchId = `batch_${Date.now()}`;
  const allTransactions = [];
  const newAccounts = new Set();

  for (const sheet of parsed) {
    if (!sheet.rows || sheet.rows.length < 2) continue;
    const M = sheet.colMap;
    for (let i = 1; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      if (!row || row.length === 0) continue;
      const get = (idx) => idx >= 0 && idx < row.length ? row[idx] : '';
      const rowNumber = toInt(get(M.rowNumber));
      const txDateRaw = get(M.date);
      const withdrawal = toInt(get(M.withdrawal));
      const deposit = toInt(get(M.deposit));
      const txDate = parseDate(txDateRaw);
      if (!txDate || (!withdrawal && !deposit)) continue;
      const valueDate = parseDate(get(M.valueDate));
      const month = dateToMonthLabel(txDate);
      const year = dateToYear(txDate);
      const description = toStr(get(M.description));
      const existingCategory = toStr(get(M.category));
      const existingFacility = toStr(get(M.facility));
      const isCleared = toStr(get(M.isCleared));

      let category = existingCategory, facility = existingFacility, vendorName = '';
      let autoCategorized = 0, confidence = 'manual';
      const auto = await categorizer.autoCategorize(description, sheet.account);
      if (auto.vendor_name) vendorName = auto.vendor_name;
      if (!category && auto.category) { category = auto.category; autoCategorized = 1; confidence = auto.confidence; }
      if (!facility && auto.facility) facility = auto.facility;

      allTransactions.push({
        account: sheet.account, batch_id: batchId, row_number: rowNumber, tx_date: txDate, value_date: valueDate,
        withdrawal, deposit,
        check_type: toStr(get(M.checkType !== undefined ? M.checkType : -1)),
        balance: toInt(get(M.balance)),
        tx_type: toStr(get(M.txType)),
        detail_type: toStr(get(M.detailType !== undefined ? M.detailType : -1)),
        bank_name: toStr(get(M.bankName)),
        branch_name: toStr(get(M.branchName)),
        description, vendor_name: vendorName, category, facility, is_cleared: isCleared,
        note1: toStr(get(M.note1 !== undefined ? M.note1 : M.note)),
        note2: toStr(get(M.note2 !== undefined ? M.note2 : -1)),
        month, year, auto_categorized: autoCategorized, confidence,
      });
      const accExists = await query('SELECT 1 FROM keiri_bank_accounts WHERE name = ?', [sheet.account]);
      if (accExists.length === 0) newAccounts.add(sheet.account);
    }
  }

  const stats = {
    total: allTransactions.length,
    auto_categorized: allTransactions.filter(t => t.auto_categorized === 1).length,
    has_existing_category: allTransactions.filter(t => t.category && t.auto_categorized === 0).length,
    uncategorized: allTransactions.filter(t => !t.category).length,
    new_accounts: [...newAccounts],
  };
  res.json({ batch_id: batchId, transactions: allTransactions, stats });
});

// 確定保存
router.post('/bank/upload/confirm', async (req, res) => {
  const { transactions, learn = true } = req.body;
  if (!Array.isArray(transactions)) return res.status(400).json({ error: 'transactions required' });

  let inserted = 0, skipped = 0, learned = 0;
  const newAccounts = new Set();

  try {
    for (const t of transactions) {
      if (t.account) {
        const exists = await query('SELECT 1 FROM keiri_bank_accounts WHERE name = ?', [t.account]);
        if (exists.length === 0) {
          await run('INSERT INTO keiri_bank_accounts (name, display_name, sort_order) VALUES (?, ?, ?)', [t.account, t.account, 99]);
          newAccounts.add(t.account);
        }
      }
      const dup = await query(`SELECT id FROM keiri_bank_transactions WHERE account = ? AND tx_date = ? AND row_number = ? AND withdrawal = ? AND deposit = ? AND description = ?`,
        [t.account, t.tx_date, t.row_number || 0, t.withdrawal || 0, t.deposit || 0, t.description || '']);
      if (dup.length > 0) { skipped++; continue; }

      await run(`INSERT INTO keiri_bank_transactions (
        account, batch_id, row_number, tx_date, value_date, withdrawal, deposit, check_type, balance,
        tx_type, detail_type, bank_name, branch_name, description, description_pattern, vendor_name,
        category, facility, is_cleared, note1, note2, month, year, auto_categorized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.account, t.batch_id, t.row_number || 0, t.tx_date, t.value_date || null, t.withdrawal || 0, t.deposit || 0,
         t.check_type || '', t.balance || 0, t.tx_type || '', t.detail_type || '', t.bank_name || '', t.branch_name || '',
         t.description || '', categorizer.extractPattern(t.description || ''), t.vendor_name || '', t.category || '',
         t.facility || '', t.is_cleared || '', t.note1 || '', t.note2 || '', t.month || null, t.year || null, t.auto_categorized || 0]);
      inserted++;
      if (learn && t.description && ((t.category && t.auto_categorized === 0) || t.vendor_name)) {
        await categorizer.learnRule(t.description, t.account, t.category || '', t.facility || '', t.vendor_name || '');
        learned++;
      }
    }
    res.json({ ok: true, inserted, skipped, learned, new_accounts: [...newAccounts] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 取引一覧
router.get('/bank/transactions', async (req, res) => {
  const { account, month, year, category, facility, is_cleared, search } = req.query;
  let sql = 'SELECT * FROM keiri_bank_transactions WHERE 1=1';
  const params = [];
  if (account) { sql += ' AND account = ?'; params.push(account); }
  if (month) { sql += ' AND month = ?'; params.push(month); }
  if (year) { sql += ' AND year = ?'; params.push(parseInt(year)); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (facility) { sql += ' AND facility = ?'; params.push(facility); }
  if (is_cleared) { sql += ' AND is_cleared = ?'; params.push(is_cleared); }
  if (search) { sql += ' AND description LIKE ?'; params.push('%' + search + '%'); }
  sql += ' ORDER BY tx_date, id';
  res.json(await query(sql, params));
});

// 取引編集
router.patch('/bank/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { category, facility, vendor_name, is_cleared, note1, note2, learn } = req.body;
  const curRows = await query('SELECT * FROM keiri_bank_transactions WHERE id = ?', [id]);
  if (curRows.length === 0) return res.status(404).json({ error: 'not found' });
  const current = curRows[0];
  const upd = [], val = [];
  if (category !== undefined) { upd.push('category = ?'); val.push(category); if (category !== current.category) upd.push('auto_categorized = 0'); }
  if (facility !== undefined) { upd.push('facility = ?'); val.push(facility); }
  if (vendor_name !== undefined) { upd.push('vendor_name = ?'); val.push(vendor_name); }
  if (is_cleared !== undefined) { upd.push('is_cleared = ?'); val.push(is_cleared); }
  if (note1 !== undefined) { upd.push('note1 = ?'); val.push(note1); }
  if (note2 !== undefined) { upd.push('note2 = ?'); val.push(note2); }
  if (upd.length === 0) return res.status(400).json({ error: 'no fields' });
  val.push(id);
  await run(`UPDATE keiri_bank_transactions SET ${upd.join(', ')} WHERE id = ?`, val);

  let learnedRuleId = null, propagatedCount = 0;
  if (learn && (category !== undefined || facility !== undefined || vendor_name !== undefined)) {
    const newCategory = category !== undefined ? category : current.category;
    const newFacility = facility !== undefined ? facility : current.facility;
    const newVendor = vendor_name !== undefined ? vendor_name : current.vendor_name;
    if ((newCategory || newVendor) && current.description) {
      learnedRuleId = await categorizer.learnRule(current.description, current.account, newCategory || '', newFacility || '', newVendor || '');
      const currentPattern = categorizer.extractPattern(current.description);
      if (currentPattern && currentPattern.length >= 3) {
        const samerows = await query(`SELECT id, description, category, facility, vendor_name FROM keiri_bank_transactions WHERE account = ? AND id != ? AND (description = ? OR description LIKE ?)`,
          [current.account, id, current.description, currentPattern + '%']);
        const matched = samerows.filter(r => categorizer.extractPattern(r.description) === currentPattern);
        for (const sr of matched) {
          const u = [], v = [];
          if (newVendor && sr.vendor_name !== newVendor) { u.push('vendor_name = ?'); v.push(newVendor); }
          if (newCategory && !sr.category) { u.push('category = ?'); v.push(newCategory); u.push('auto_categorized = 1'); }
          if (newFacility && !sr.facility) { u.push('facility = ?'); v.push(newFacility); }
          if (u.length > 0) {
            v.push(sr.id);
            await run(`UPDATE keiri_bank_transactions SET ${u.join(', ')} WHERE id = ?`, v);
            propagatedCount++;
          }
        }
      }
    }
  }
  const updated = await query('SELECT * FROM keiri_bank_transactions WHERE id = ?', [id]);
  res.json({ ...updated[0], learned_rule_id: learnedRuleId, propagated: propagatedCount });
});

// パターン集約
router.get('/bank/patterns', async (req, res) => {
  const { account, only_unset } = req.query;
  let sql = `SELECT description, description_pattern, account, category, facility, vendor_name, COUNT(*) as cnt, SUM(withdrawal) as total_withdrawal
    FROM keiri_bank_transactions WHERE description IS NOT NULL AND description != ''`;
  const params = [];
  if (account) { sql += ' AND account = ?'; params.push(account); }
  sql += ' GROUP BY description, description_pattern, account, category, facility, vendor_name';
  const rows = await query(sql, params);

  const grouped = {};
  for (const r of rows) {
    const pattern = r.description_pattern || categorizer.extractPattern(r.description);
    const key = pattern + '|' + (r.account || '');
    if (!grouped[key]) grouped[key] = { pattern, account: r.account || '', sample_description: r.description, count: 0, total_withdrawal: 0, vendor_names: new Set(), categories: new Set(), facilities: new Set() };
    grouped[key].count += r.cnt;
    grouped[key].total_withdrawal += (r.total_withdrawal || 0);
    if (r.vendor_name) grouped[key].vendor_names.add(r.vendor_name);
    if (r.category) grouped[key].categories.add(r.category);
    if (r.facility) grouped[key].facilities.add(r.facility);
    if (r.description.length < grouped[key].sample_description.length) grouped[key].sample_description = r.description;
  }
  let result = Object.values(grouped).map(g => ({
    pattern: g.pattern, account: g.account, sample_description: g.sample_description, count: g.count, total_withdrawal: g.total_withdrawal,
    vendor_name: g.vendor_names.size === 1 ? [...g.vendor_names][0] : (g.vendor_names.size > 1 ? '（混在）' : ''),
    category: g.categories.size === 1 ? [...g.categories][0] : (g.categories.size > 1 ? '（混在）' : ''),
    facility: g.facilities.size === 1 ? [...g.facilities][0] : (g.facilities.size > 1 ? '（混在）' : ''),
    is_mixed: g.vendor_names.size > 1 || g.categories.size > 1 || g.facilities.size > 1,
  }));
  if (only_unset === '1') result = result.filter(r => !r.vendor_name);
  result.sort((a, b) => b.count - a.count);
  res.json(result);
});

// パターン一括更新
router.post('/bank/patterns/bulk-update', async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates required' });
  let totalUpdated = 0, rulesLearned = 0;
  try {
    for (const u of updates) {
      const { pattern, account, vendor_name, category, facility } = u;
      if (!pattern) continue;
      const candidates = await query(`SELECT * FROM keiri_bank_transactions WHERE account = ? AND description IS NOT NULL AND description != '' AND (description = ? OR description LIKE ?)`,
        [account || '', pattern, pattern + '%']);
      const targets = candidates.filter(c => categorizer.extractPattern(c.description) === pattern);
      for (const t of targets) {
        const upd = [], val = [];
        if (vendor_name !== undefined) { upd.push('vendor_name = ?'); val.push(vendor_name); }
        if (category !== undefined && category !== '') { upd.push('category = ?'); val.push(category); upd.push('auto_categorized = 0'); }
        if (facility !== undefined && facility !== '') { upd.push('facility = ?'); val.push(facility); }
        if (upd.length > 0) {
          val.push(t.id);
          await run(`UPDATE keiri_bank_transactions SET ${upd.join(', ')} WHERE id = ?`, val);
          totalUpdated++;
        }
      }
      if (vendor_name || category || facility) {
        await categorizer.learnRule(pattern, account || '', category || '', facility || '', vendor_name || '');
        rulesLearned++;
      }
    }
    res.json({ ok: true, transactions_updated: totalUpdated, rules_learned: rulesLearned });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 経費内訳ピボット
router.get('/bank/pivot', async (req, res) => {
  const { account, month, year } = req.query;
  let sql = `SELECT facility, category, SUM(withdrawal) as total FROM keiri_bank_transactions WHERE withdrawal > 0`;
  const params = [];
  if (account) { sql += ' AND account = ?'; params.push(account); }
  if (month) { sql += ' AND month = ?'; params.push(month); }
  if (year) { sql += ' AND year = ?'; params.push(parseInt(year)); }
  sql += ' GROUP BY facility, category ORDER BY facility, category';
  res.json(await query(sql, params));
});

// バッチ削除
router.delete('/bank/batch/:batchId', async (req, res) => {
  await run('DELETE FROM keiri_bank_transactions WHERE batch_id = ?', [req.params.batchId]);
  res.json({ ok: true });
});

// ============================================================================
// 学習ルール
// ============================================================================
router.get('/rules', async (req, res) => {
  const { search } = req.query;
  let sql = 'SELECT * FROM keiri_category_rules';
  const params = [];
  if (search) {
    sql += ' WHERE description_pattern LIKE ? OR category LIKE ? OR facility LIKE ? OR vendor_name LIKE ?';
    const q = '%' + search + '%';
    params.push(q, q, q, q);
  }
  sql += ' ORDER BY match_count DESC, updated_at DESC';
  res.json(await query(sql, params));
});
router.post('/rules', async (req, res) => {
  const { description_pattern, account, category, facility, vendor_name, priority } = req.body;
  if (!description_pattern || !category) return res.status(400).json({ error: 'pattern and category required' });
  try {
    const id = await runInsert(`INSERT INTO keiri_category_rules (description_pattern, account, category, facility, vendor_name, priority) VALUES (?, ?, ?, ?, ?, ?)`,
      [description_pattern, account || '', category, facility || '', vendor_name || '', priority || 0]);
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/rules/:id', async (req, res) => {
  const allowed = ['description_pattern', 'account', 'category', 'facility', 'vendor_name', 'priority'];
  const upd = [], val = [];
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) { upd.push(`${k} = ?`); val.push(v); }
  }
  if (upd.length === 0) return res.status(400).json({ error: 'no fields' });
  upd.push("updated_at = CURRENT_TIMESTAMP");
  val.push(req.params.id);
  await run(`UPDATE keiri_category_rules SET ${upd.join(', ')} WHERE id = ?`, val);
  res.json({ ok: true });
});
router.delete('/rules/:id', async (req, res) => {
  await run('DELETE FROM keiri_category_rules WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});
router.post('/rules/learn', async (req, res) => {
  const result = await categorizer.bootstrapRules();
  res.json(result);
});

// 会社名シード（140件の既知マッピング）
router.post('/rules/seed-vendors', async (req, res) => {
  const VM = [
    ['EBﾌﾘｺﾐ BOOKING.COM JAPAN K.', 'Booking.com Japan'],['EBﾌﾘｺﾐ HTBｴﾅｼﾞ-(ｶ', 'HTBエナジー'],
    ['EBﾌﾘｺﾐ ｲﾜﾀﾆｻﾝﾖｳ(ｶ', '岩谷産業'],['EBﾌﾘｺﾐ ｶ) ﾓﾉﾀﾛｳ', 'モノタロウ'],['EBﾌﾘｺﾐ ｶ)MEﾓﾊﾞｲﾙ', 'MEモバイル'],
    ['EBﾌﾘｺﾐ ｶ)ｱﾂﾌﾟｻｲﾀﾞ-', 'アップサイダー'],['EBﾌﾘｺﾐ ｶ)ｲﾏｲﾁ', 'イマイチ'],['EBﾌﾘｺﾐ ｶ)ｴﾑｹｲｺｳｻﾝ', 'MK興産'],
    ['EBﾌﾘｺﾐ ｶ)ｸﾗﾌﾄｺ-ﾎﾟﾚ-ｼﾖﾝ', 'クラフトコーポレーション'],['EBﾌﾘｺﾐ ｶ)ｸﾞﾛ-ﾊﾞﾙﾘｿﾞ-ﾄ', 'グローバルリゾート'],
    ['EBﾌﾘｺﾐ ｶ)ｸﾞﾛ-ﾊﾞﾙﾘｿﾞ-ﾄﾚｼﾞﾃﾞﾝ', 'グローバルリゾートレジデンス'],['EBﾌﾘｺﾐ ｶ)ｼ-ｴｽ.ﾌﾟﾛ', 'CS.プロ'],
    ['EBﾌﾘｺﾐ ｶ)ｼﾞｴｲﾃｲ-ﾋﾞ-ｼﾖｳｼﾞ', 'JTB商事'],['EBﾌﾘｺﾐ ｶ)ｾﾝﾎﾞｳ', 'センボウ'],
    ['EBﾌﾘｺﾐ ｶ)ﾊ-ｽﾄ-ﾘｲﾌﾟﾗｽ', 'ハーストーリィプラス'],['EBﾌﾘｺﾐ ｶ)ﾌｵﾜ-ﾄﾞ', 'フォワード'],
    ['EBﾌﾘｺﾐ ｶ)ﾌｸﾔｶﾆﾔﾃﾝ', 'ふくやかにや店'],['EBﾌﾘｺﾐ ｶ)ﾌﾛﾝﾃｲｱﾘﾈﾝｻﾌﾟﾗ', 'フロンティアリネンサプライ'],
    ['EBﾌﾘｺﾐ ｶ)ﾎ-ﾑﾗﾝﾄﾞ', 'ホームランド'],['EBﾌﾘｺﾐ ｶ)ﾔﾏﾋ', 'ヤマヒ'],['EBﾌﾘｺﾐ ｶ)ﾘｸﾙ-ﾄ', 'リクルート'],
    ['EBﾌﾘｺﾐ ｷﾖｳﾜﾓｸｻﾞｲ(ｶ', '協和木材'],['EBﾌﾘｺﾐ ｺｸｻｲｻﾎﾟ-ﾄｺﾞｳﾄﾞｳｶﾞｲｼﾔ', '国際サポート合同会社'],
    ['EBﾌﾘｺﾐ ﾄﾐﾀﾋﾘﾖｳ(ｶ', '富田肥料'],['EBﾌﾘｺﾐ ﾄﾗｽﾄﾕｱｻ-ﾋﾞｽ(ｶ', 'トラストユアサービス'],
    ['EBﾌﾘｺﾐ ﾆﾎﾝｼﾖﾂｹﾝ(ｶ', '日本食研'],['EBﾌﾘｺﾐ ﾋﾛｼﾏｶﾞｽﾀﾞｲｲﾁﾌﾟﾛﾊﾟﾝ(ｶ', '広島ガス第一プロパン'],
    ['EBﾌﾘｺﾐ ﾋﾛｼﾏｶﾞｽﾆｼﾁﾕｳｺﾞｸ(ｶ', '広島ガス西中国'],['EBﾌﾘｺﾐ ﾋﾛｼﾏｶﾞｽﾌﾟﾛﾊﾟﾝ(ｶ', '広島ガスプロパン'],
    ['EBﾌﾘｺﾐ ﾌｼﾞﾌｲﾙﾑﾋﾞｼﾞﾈｽｲﾉﾍﾞ-ｼﾖ', '富士フイルムビジネスイノベーション'],
    ['EBﾌﾘｺﾐ ﾐﾂｲｽﾐﾄﾓﾌｱｲﾅﾝｽｱﾝﾄﾞﾘ-ｽ', '三井住友ファイナンス&リース'],
    ['EBﾌﾘｺﾐ ﾕ)ｺｳﾀﾞｳﾝｿｳﾃﾝ', '黄檀荘店'],['EBﾌﾘｺﾐ ﾕ)ｾﾙｷｶｸｺﾝｻﾙﾀﾝﾄ', 'セルキャクコンサルタント'],
    ['EBﾌﾘｺﾐ ﾕ)ﾊﾟﾙｺ', 'パルコ'],['EBﾌﾘｺﾐ ﾕ)ﾓ-ﾃﾙﾄｳｷﾖｳ', 'モーテル東京'],
    ['EBﾌﾘｺﾐ ﾕ-ｼ-ｼ-ｺ-ﾋ-ﾌﾟﾛﾌｴﾂｼﾖﾅﾙ', 'UCCコーヒープロフェッショナル'],['EBﾌﾘｺﾐ ﾕ-ﾃﾞﾝｷ(ｶ', 'U電気'],
    ['EBﾌﾘｺﾐ ｱﾏﾉﾏﾈｼﾞﾒﾝﾄｻ-ﾋﾞｽ(ｶ)ﾋﾛ', 'アマノマネジメントサービス'],
    ['EBﾌﾘｺﾐ ｱｼﾀﾊﾞｼﾔｶｲﾎｹﾝﾛｳﾑｼﾎｳｼﾞ', '足立橋社会保険労務士事務所'],['EBﾌﾘｺﾐ (ｶ)ｾｷﾈ ｾｷﾈ ﾖｳｲﾁ', 'セキネ'],
    ['EBﾌﾘｶｴ ｶ)ｸﾞﾛ-ﾊﾞﾙﾘｿﾞ-ﾄ', 'グローバルリゾート'],
    ['ｱﾏﾉﾏﾈｼﾞﾒﾝﾄｻ-ﾋﾞｽ(ｶ', 'アマノマネジメントサービス'],['ｴﾇｴﾇﾃｲ(ｶ', 'NTT'],
    ['ｵｵｻｷ ｷｾﾝ(ｶ', '大崎汽船'],['ｵｵｻｷﾌｴﾘ-ﾄﾞｳﾒｲ', '大崎フェリー同盟'],['ｶ)ｱｲﾓﾊﾞｲﾙ', 'アイモバイル'],
    ['ｶ)ｲﾂｷﾕｳ', '一休'],['ｶ)ｴﾇｴｽﾃｲ-', 'エヌエスティー'],['ｶ)ｸﾞﾛ-ﾊﾞﾙ', 'グローバル'],
    ['ｶ)ｸﾞﾛ-ﾊﾞﾙﾘｿﾞ-ﾄ', 'グローバルリゾート'],['ｶ)ｻﾆｸﾘ-ﾝﾁﾕｳｺﾞｸ', 'サニクリーン中国'],
    ['ｶ)ｼﾖｳﾜｺ-ﾎﾟﾚ-ｼﾖﾝ', '昭和コーポレーション'],['ｶ)ｼﾞｴ-ｼ-ﾋﾞ- ﾎﾝｼ', 'JCB'],
    ['ｶ)ｼﾞｴｲｴﾑｴｽ', 'JMS'],['ｶ)ｼﾞｴｲﾃｲ-ﾋﾞ-', 'JTB'],['ｶ)ｽﾏﾚｼﾞ', 'スマレジ'],
    ['ｶ)ﾄｸﾜ', 'トクワ'],['ｶ)ﾊｸﾋﾞｼ ﾋｶﾞｼﾋﾛｼﾏｼﾃﾝ', '白美紙 東広島支店'],
    ['ｶ)ﾌﾟﾗﾝﾆﾝｸﾞｻﾌﾟﾗ', 'プランニングサプラ'],['ｶ)ﾓﾘﾀｶ', 'モリタカ'],
    ['ｶ)ﾘｸﾙ-ﾄ ﾍﾟｲﾒﾝﾄ', 'リクルートペイメント'],['ｶ)ﾚｽﾎﾟﾝｽ', 'レスポンス'],
    ['ｶﾌﾞｼｷｶﾞｲｼﾔﾏｴｶﾜｼﾖｳｶｲ', '前川商会'],['ｺｶｺ-ﾗﾎﾞﾄﾗ-ｽﾞｼﾞ', 'コカ・コーラボトラーズジャパン'],
    ['ｺｸﾐﾝｺｳｺ ｶ)ﾆﾂﾎﾟﾝｾｲｻｸｷﾝﾕ', '日本政策金融公庫'],['ｻﾝﾃﾞﾝﾘﾖｺｳ(ｶ', '三電旅行'],
    ['ｽﾄﾗｲﾌﾟｼﾞﾔﾊﾟﾝ(ｶ', 'Stripe Japan'],['ﾀｹﾊﾗｶｲｳﾝ(ｶ', '竹原海運'],['ﾀｹﾊﾗｼ', '竹原市'],
    ['ﾁｷﾞﾘｼﾏｳﾝﾕ(ｶ', 'ちぎりしま運輸'],['ﾁﾕｳｺﾞｸｻﾝｷﾞﾖｳ(ｶ', '中国産業'],['ﾄﾞｺﾓﾋﾞｼﾞﾈｽｺﾞﾘﾖ', 'ドコモビジネス'],
    ['ﾆｼﾆﾎﾝｴｷｶｶﾞｽ', '西日本液化ガス'],['ﾆﾂｺｳｷｾﾂ(ｶ', '日工機設'],['ﾆﾎﾝｾ-ﾌﾃｲ(ｶ)ｼﾝﾀｸｸﾞﾁ', '日本セーフティー'],
    ['ﾊﾂｶｲﾁｼｾｲｶﾂﾌｸｼｶ', '廿日市市生活福祉課'],['ﾊﾏﾀﾞｶｲｹｲｶ', '浜田会計課'],['ﾋﾛｼﾏｼﾁﾖｳｿﾝｷﾖｳｻ', '広島市町村共済'],
    ['ﾋﾛｼﾏｿｳｺﾞｳｹｲﾋﾞﾎ', '広島総合警備保障'],['ﾋﾛｼﾏﾄﾖﾍﾟﾂﾄ(ｶ', '広島トヨペット'],['ﾌﾏｷﾗ-(ｶ', 'フマキラー'],
    ['ﾍｲﾜﾌﾄﾞｳｻﾝﾊﾝﾊﾞｲ', '平和不動産販売'],['ﾍﾟｲｵﾆｱ ｼﾞﾔﾊﾟﾝ(ｶ', 'ペイオニアジャパン'],
    ['ﾐﾂｲｽﾐﾄﾓFL(SMFL', '三井住友ファイナンス&リース'],['ﾐﾂﾋﾞｼﾕ-ｴﾌｼﾞｴｲﾆｺｽ', '三菱UFJニコス'],
    ['ﾐﾊﾗｼｾﾞｲｾｲｼﾕｳﾉｳｶ', '三原市税政収納課'],['ﾒﾙﾍﾟｲ', 'メルペイ'],
    ['ﾗｸﾃﾝｸﾞﾙ-ﾌﾟ(ｶ', '楽天グループ'],['ﾗｸﾃﾝﾏﾙﾁｹﾂｻｲｻ-ﾋﾞ', '楽天マルチ決済サービス'],
    ['ﾘｸﾙ-ﾄ(ｼﾞﾔﾗﾝ', 'リクルート（じゃらん）'],['ﾘｸﾙ-ﾄﾎﾟｲﾝﾄﾌﾟﾛｸﾞ', 'リクルートポイントプログラム'],
    ['(ｶ)ﾗｲﾝﾌﾟﾛﾌｴｸﾄ', 'ラインプロフェクト'],['ｿﾝｶﾞｲﾎｹﾝ ﾄｳｷﾖｳｶｲｼﾞﾖｳﾆﾁﾄ', '東京海上日動'],
    ['ｼﾞ-ｴﾑｵ-ﾌｲﾅﾝｼﾔﾙｹ', 'GMOフィナンシャルゲート'],['ｼﾞ-ｴﾑｵ-ﾌｲﾅﾝｼﾔﾙｹﾞ-ﾄ(ｶ', 'GMOフィナンシャルゲート'],
    ['ｲｴﾗﾌﾞ(ﾔﾁﾝｼﾝﾀｸ', 'イエラブ（家賃信託）'],['ｶｲﾋ ｾﾄｳﾁﾃﾞｲ-ｴﾑｵ-ﾒﾝ', '瀬戸内DMO（会費）'],
    ['ｶｲﾋ ｾﾞｲﾘｼｶｲ', '税理士会（会費）'],['ｵｵﾉｽｲｻﾝ(ﾕ', '大野水産'],
    ['ﾕ)ｺｳﾅﾝﾌﾟﾗｽﾁﾂｸｺｳｷﾞﾖｳｼﾖ', '光南プラスチック工業所'],['ﾕ)ﾏｴｶﾜｻｹﾃﾝ', '前川酒店'],
    ['ﾕ)ﾓ-ﾃﾙﾄｳｷﾖｳ', 'モーテル東京'],['PAYPAY', 'PayPay'],['JTBﾄｳｷﾖｳﾀﾏｼﾃﾝ', 'JTB東京多摩支店'],
    ['WCP(ｿﾌﾄﾊﾞﾝｸﾌﾘｺﾐ', 'SoftBank（WCP振込）'],['ﾌﾘｺﾐﾀﾞｲｺｳSBPS(ｶ)ﾘｸﾙ-ﾄ', 'リクルート（SBPS振込代行）'],
    ['ガス料', 'ガス料金'],['水道料', '水道料金'],['電気料', '電気料金'],['電話料', '電話料金'],
    ['ｸﾚｼﾞﾂﾄ ｵﾘｺ', 'オリコ'],['ｸﾚｼﾞﾂﾄ ｾｿﾞﾝ)ﾘ-ｽ', 'セゾンリース'],
    ['ｸﾚｼﾞﾂﾄ ｿﾌﾄﾊﾞﾝｸ(SMCC', 'SoftBank（SMCCクレジット）'],
    ['ｸﾚｼﾞﾂﾄ ｿﾌﾄﾊﾞﾝｸMB(SMCC', 'SoftBankモバイル（SMCCクレジット）'],
    ['ｸﾚｼﾞﾂﾄ ﾆﾎﾝﾃｸﾉ(SMCC', '日本テクノ（SMCCクレジット）'],['ｸﾚｼﾞﾂﾄ ﾎｳｼﾞﾝETC(SMCC', '法人ETC（SMCCクレジット）'],
    ['ｸﾚｼﾞﾂﾄ ﾕﾆﾏﾂﾄﾗｲﾌ(SMCC', 'ユニマットライフ（SMCCクレジット）'],['ｸﾚｼﾞﾂﾄ JCB)ﾘｸﾙ-ﾄ', 'リクルート（JCBクレジット）'],
    ['ｸﾚｼﾞﾂﾄ JCB)ﾛﾎﾞﾂﾄﾍﾟｲ', 'ロボットペイ（JCBクレジット）'],['ｸﾚｼﾞﾂﾄ NS ｶ)ﾄｳﾒｲ', '東明（NSクレジット）'],
    ['ｸﾚｼﾞﾂﾄ NS ﾘｸﾙ-ﾄ', 'リクルート（NSクレジット）'],['ｸﾚｼﾞﾂﾄ MHF)RETTY', 'Retty（MHFクレジット）'],
    ['ｸﾚｼﾞﾂﾄ MHF)ﾆﾎﾝｼﾖﾂｹﾝ', '日本食研（MHFクレジット）'],['ｸﾚｼﾞﾂﾄ MBS.ｼﾖｳｺｳｶｲ', '商工会（MBSクレジット）'],
    ['ｸﾚｼﾞﾂﾄ DF.PAID', 'PAID（DFクレジット）'],['ｸﾚｼﾞﾂﾄ DF.ｲﾜﾀﾆｻﾝﾖｳ', '岩谷産業（DFクレジット）'],
    ['ｸﾚｼﾞﾂﾄ DF.ﾏｲﾎﾞﾂｸｽ24', 'マイボックス24（DFクレジット）'],['ｸﾚｼﾞﾂﾄ DF.ﾗｸﾃﾝﾄﾗﾍﾞﾙ', '楽天トラベル（DFクレジット）'],
    ['ｸﾚｼﾞﾂﾄ DKｶﾗｵｹ(SMCC', 'DKカラオケ（SMCCクレジット）'],['ｸﾚｼﾞﾂﾄ AP(ﾅｺﾞﾔｾｲﾗｸ', '名古屋精螺（APクレジット）'],
    ['SMBC(PAID', 'PAID（SMBC）'],['SMBC(SFIﾘ-ｼﾝｸﾞ', 'SFIリーシング（SMBC）'],
    ['SMBC(ｶ)ﾈﾂﾄﾌﾟﾛﾃ', 'ネツトプロテ（SMBC）'],['SMBC(ｷﾔﾉﾝ', 'キヤノン（SMBC）'],
    ['SMBC(ﾆﾂﾎﾟﾝｵ-ﾁｽ', '日本オーチス（SMBC）'],['SMBC(ﾒﾝﾃ.ﾏ-ｷﾕﾘ', 'メンテマーキュリー（SMBC）'],
    ['SMTﾊﾟﾅ', 'パナソニック（SMT）'],
    ['ｼﾞﾄﾞｳｿｳｷ ｵｵﾉｸﾘ-ﾝｻ-ﾋﾞｽ', '大野クリーンサービス（自動送金）'],
    ['ｼﾞﾄﾞｳｿｳｷ ﾕ)ｵｵﾉｸﾘ-ﾝｻ-ﾋﾞｽ', '大野クリーンサービス（自動送金）'],
    ['ｼﾔ)NUKUI OUTDOOR FIELD', 'NUKUI OUTDOOR FIELD'],['ｼﾔ)ﾇｸｲｱｳﾄﾄﾞｱﾌｲ-ﾙﾄﾞ', 'NUKUI OUTDOOR FIELD'],
  ];
  let created = 0, updated = 0;
  try {
    for (const [pattern, vendorName] of VM) {
      const existing = await query('SELECT id, vendor_name FROM keiri_category_rules WHERE description_pattern = ?', [pattern]);
      if (existing.length > 0 && existing[0].vendor_name) continue;
      if (existing.length > 0) {
        await run("UPDATE keiri_category_rules SET vendor_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [vendorName, existing[0].id]);
        updated++;
      } else {
        await run("INSERT INTO keiri_category_rules (description_pattern, account, category, facility, vendor_name, priority, match_count) VALUES (?, '', '', '', ?, 0, 0)", [pattern, vendorName]);
        created++;
      }
      await run("UPDATE keiri_bank_transactions SET vendor_name = ? WHERE (vendor_name = '' OR vendor_name IS NULL) AND description_pattern = ?", [vendorName, pattern]);
    }
    res.json({ ok: true, created, updated, total: VM.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// 請求書Excelアップロード
// ============================================================================
router.post('/invoices/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  const filename = req.file.originalname || 'upload';
  if (!/\.(xlsx|xls)$/i.test(filename)) return res.status(400).json({ error: 'Excelファイル（.xlsx/.xls）をアップロードしてください' });

  let defaultMonth = '';
  let defaultYear = null;
  const mm = filename.match(/(\d{1,2})月/);
  if (mm) defaultMonth = mm[1] + '月';
  const yr = filename.match(/[RrＲ](\d+)/);
  if (yr) defaultYear = 2018 + parseInt(yr[1]);
  const ywest = filename.match(/(20\d{2})/);
  if (!defaultYear && ywest) defaultYear = parseInt(ywest[1]);

  const SKIP_SHEETS = ['検索', '総合計'];
  const ENTITY_MAP = {
    'ｸﾞﾘｰﾝｼｬﾜｰ': 'グリーンシャワー', 'ｸﾞﾘ-ﾝｼﾔﾜ-': 'グリーンシャワー', 'グリーンシャワー': 'グリーンシャワー',
  };

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const allInvoices = [];
    let year = defaultYear;
    for (const sheetName of wb.SheetNames) {
      if (SKIP_SHEETS.some(s => sheetName.includes(s))) continue;
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (rows.length < 3) continue;
      const entity = ENTITY_MAP[sheetName] || sheetName;
      let month = defaultMonth;
      if (rows[0] && rows[0][0]) {
        const tm = String(rows[0][0]).match(/(\d{1,2})月|(\d{1,2})\s*月/);
        if (tm) month = (tm[1] || tm[2]) + '月';
        const ty = String(rows[0][0]).match(/(\d{4})年|R(\d+)/);
        if (ty) year = ty[1] ? parseInt(ty[1]) : (2018 + parseInt(ty[2]));
      }
      let headerIdx = -1;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const s = (rows[i] || []).map(c => String(c || '')).join('');
        if (/概要|業者名|支払先名/.test(s) && /勘定科目|科目/.test(s)) { headerIdx = i; break; }
      }
      if (headerIdx < 0) continue;
      const header = rows[headerIdx];
      const cm = { vendor: -1, category: -1, payMethod: -1, dueDate: -1, facility: -1, txDate: -1, amount: -1, carry1: -1, carry2: -1, carry3: -1, note: -1 };
      for (let i = 0; i < header.length; i++) {
        const h = String(header[i] || '').trim();
        if (!h) continue;
        if (cm.vendor < 0 && /概要|業者名|支払先名/.test(h)) cm.vendor = i;
        else if (cm.category < 0 && /勘定科目|科目/.test(h)) cm.category = i;
        else if (cm.payMethod < 0 && /支払方法|支払/.test(h)) cm.payMethod = i;
        else if (cm.dueDate < 0 && /期日|期限|支払期日/.test(h)) cm.dueDate = i;
        else if (cm.facility < 0 && /請求先|施設/.test(h)) cm.facility = i;
        else if (cm.txDate < 0 && /取引日/.test(h)) cm.txDate = i;
        else if (cm.amount < 0 && /金額|当月/.test(h)) cm.amount = i;
        else if (cm.carry1 < 0 && /前月繰越/.test(h)) cm.carry1 = i;
        else if (cm.carry2 < 0 && /前々.*繰越|前々月/.test(h)) cm.carry2 = i;
        else if (cm.carry3 < 0 && /前々々|3.*繰越/.test(h)) cm.carry3 = i;
        else if (cm.note < 0 && /備考/.test(h)) cm.note = i;
      }
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
        allInvoices.push({
          vendor, category: toStr(get(cm.category)), payment_method: toStr(get(cm.payMethod)),
          due_date: parseDate(get(cm.dueDate)) || '', facility: toStr(get(cm.facility)),
          entity, transaction_date: parseDate(get(cm.txDate)) || '',
          amount, carry_1: carry1, carry_2: carry2, carry_3: carry3, month, year, note: toStr(get(cm.note)),
        });
      }
    }
    res.json({
      invoices: allInvoices,
      stats: { total: allInvoices.length, total_amount: allInvoices.reduce((s, i) => s + i.amount, 0), entities: [...new Set(allInvoices.map(i => i.entity))], month: defaultMonth, year }
    });
  } catch (e) { res.status(400).json({ error: '読み込みエラー: ' + e.message }); }
});

router.post('/invoices/upload/confirm', async (req, res) => {
  const { invoices: items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'invoices array required' });
  let inserted = 0;
  try {
    for (const inv of items) {
      await run(`INSERT INTO keiri_invoices (vendor, category, payment_method, due_date, facility, entity, transaction_date, amount, carry_1, carry_2, carry_3, month, year, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '未')`,
        [inv.vendor || '', inv.category || '', inv.payment_method || '', inv.due_date || '', inv.facility || '', inv.entity || '',
         inv.transaction_date || '', inv.amount || 0, inv.carry_1 || 0, inv.carry_2 || 0, inv.carry_3 || 0, inv.month || '', inv.year || null, inv.note || '']);
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// 請求書 CRUD
// ============================================================================
router.get('/invoices', async (req, res) => {
  const { status, facility, month, entity, year, search } = req.query;
  let sql = 'SELECT * FROM keiri_invoices WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (facility) { sql += ' AND facility = ?'; params.push(facility); }
  if (month) { sql += ' AND month = ?'; params.push(month); }
  if (entity) { sql += ' AND entity = ?'; params.push(entity); }
  if (year) { sql += ' AND year = ?'; params.push(parseInt(year)); }
  if (search) { sql += ' AND vendor LIKE ?'; params.push('%' + search + '%'); }
  sql += ' ORDER BY due_date, vendor';
  res.json(await query(sql, params));
});

router.post('/invoices', async (req, res) => {
  const { vendor, category, payment_method, due_date, facility, entity, transaction_date, amount, carry_1, carry_2, carry_3, month, year, note } = req.body;
  const id = await runInsert(`INSERT INTO keiri_invoices (vendor, category, payment_method, due_date, facility, entity, transaction_date, amount, carry_1, carry_2, carry_3, month, year, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '未')`,
    [vendor || '（新規）', category || '', payment_method || '', due_date || '', facility || '', entity || '',
     transaction_date || '', amount || 0, carry_1 || 0, carry_2 || 0, carry_3 || 0, month || '', year || null, note || '']);
  res.json({ id });
});

router.patch('/invoices/:id', async (req, res) => {
  const allowed = ['vendor', 'category', 'payment_method', 'due_date', 'facility', 'entity', 'transaction_date', 'amount', 'carry_1', 'carry_2', 'carry_3', 'month', 'year', 'note', 'status', 'amount_cleared', 'carry_1_cleared', 'carry_2_cleared', 'carry_3_cleared'];
  const upd = [], val = [];
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) { upd.push(`${k} = ?`); val.push(v); }
  }
  if (upd.length === 0) return res.status(400).json({ error: 'no fields' });
  val.push(req.params.id);
  await run(`UPDATE keiri_invoices SET ${upd.join(', ')} WHERE id = ?`, val);
  await recalcInvoiceStatus(req.params.id);
  const rows = await query('SELECT * FROM keiri_invoices WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
});

router.delete('/invoices/:id', async (req, res) => {
  await run('DELETE FROM keiri_invoices WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.post('/invoices/bulk-delete', async (req, res) => {
  const { ids, filter } = req.body || {};
  let deleted = 0;
  if (Array.isArray(ids) && ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    await run(`DELETE FROM keiri_invoices WHERE id IN (${ph})`, ids);
    deleted = ids.length;
  } else if (filter && typeof filter === 'object') {
    let sql = 'DELETE FROM keiri_invoices WHERE 1=1';
    const params = [];
    if (filter.month) { sql += ' AND month = ?'; params.push(filter.month); }
    if (filter.entity) { sql += ' AND entity = ?'; params.push(filter.entity); }
    if (filter.year) { sql += ' AND year = ?'; params.push(parseInt(filter.year)); }
    if (filter.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (params.length === 0) return res.status(400).json({ error: 'フィルタが指定されていません（全件削除を防止）' });
    await run(sql, params);
    deleted = -1; // sql.js doesn't return changes
  } else {
    return res.status(400).json({ error: 'ids または filter を指定してください' });
  }
  res.json({ ok: true, deleted });
});

// 消込
router.post('/invoices/clear', async (req, res) => {
  const { ids, clear_type } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids required' });
  const flagMap = { amount: 'amount_cleared', carry_1: 'carry_1_cleared', carry_2: 'carry_2_cleared', carry_3: 'carry_3_cleared' };
  try {
    for (const id of ids) {
      const rows = await query('SELECT * FROM keiri_invoices WHERE id = ?', [id]);
      if (rows.length === 0) continue;
      if (clear_type === 'all') {
        await run(`UPDATE keiri_invoices SET
          amount_cleared = CASE WHEN amount > 0 THEN 1 ELSE amount_cleared END,
          carry_1_cleared = CASE WHEN carry_1 > 0 THEN 1 ELSE carry_1_cleared END,
          carry_2_cleared = CASE WHEN carry_2 > 0 THEN 1 ELSE carry_2_cleared END,
          carry_3_cleared = CASE WHEN carry_3 > 0 THEN 1 ELSE carry_3_cleared END,
          cleared_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
      } else {
        const flag = flagMap[clear_type];
        if (!flag) continue;
        await run(`UPDATE keiri_invoices SET ${flag} = 1, cleared_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
      }
      await recalcInvoiceStatus(id);
      await run(`INSERT INTO keiri_clear_history (invoice_id, clear_type, cleared_at) VALUES (?, ?, CURRENT_TIMESTAMP)`, [id, clear_type]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/invoices/undo', async (req, res) => {
  const { id } = req.body;
  await run(`UPDATE keiri_invoices SET amount_cleared=0, carry_1_cleared=0, carry_2_cleared=0, carry_3_cleared=0, status='未', cleared_at=NULL WHERE id = ?`, [id]);
  res.json({ ok: true });
});

router.get('/invoices/months', async (req, res) => {
  const rows = await query(`SELECT DISTINCT month FROM keiri_invoices WHERE month IS NOT NULL AND month != '' ORDER BY month`);
  res.json(rows);
});

router.get('/invoices/entities', async (req, res) => {
  const rows = await query(`SELECT DISTINCT entity FROM keiri_invoices WHERE entity IS NOT NULL AND entity != '' ORDER BY entity`);
  res.json(rows);
});

// ============================================================================
// 集計
// ============================================================================
router.get('/summary/monthly', async (req, res) => {
  const { month, year, account } = req.query;
  let sql = `SELECT category,
    CASE WHEN vendor_name != '' AND vendor_name IS NOT NULL THEN vendor_name
         WHEN description_pattern != '' AND description_pattern IS NOT NULL THEN description_pattern
         ELSE description END as vendor,
    facility, SUM(withdrawal) as total
    FROM keiri_bank_transactions WHERE withdrawal > 0`;
  const params = [];
  if (month) { sql += ' AND month = ?'; params.push(month); }
  if (year) { sql += ' AND year = ?'; params.push(parseInt(year)); }
  if (account) { sql += ' AND account = ?'; params.push(account); }
  sql += ' GROUP BY category, vendor, facility ORDER BY category, vendor, facility';
  const rows = await query(sql, params);
  const facRows = await query('SELECT name FROM keiri_facilities ORDER BY sort_order');
  const facilities = facRows.map(f => f.name);
  const groups = {};
  for (const r of rows) {
    const cat = r.category || '不明', vendor = r.vendor || '(空)', fac = r.facility || '不明';
    if (!groups[cat]) groups[cat] = {};
    if (!groups[cat][vendor]) groups[cat][vendor] = {};
    groups[cat][vendor][fac] = (groups[cat][vendor][fac] || 0) + (r.total || 0);
  }
  res.json({ facilities, groups });
});

router.get('/summary/annual', async (req, res) => {
  const { year, account } = req.query;
  let sql = `SELECT month, category, SUM(withdrawal) as total FROM keiri_bank_transactions WHERE withdrawal > 0`;
  const params = [];
  if (year) { sql += ' AND year = ?'; params.push(parseInt(year)); }
  if (account) { sql += ' AND account = ?'; params.push(account); }
  sql += ' GROUP BY month, category ORDER BY year, month, category';
  res.json(await query(sql, params));
});

// ============================================================================
// 自動マッチング
// ============================================================================
router.post('/match/auto', async (req, res) => {
  const bankTxs = await query(`SELECT * FROM keiri_bank_transactions WHERE withdrawal > 0 AND matched_invoice_id IS NULL AND is_cleared != '済'`);
  const pendingInvoices = await query(`SELECT * FROM keiri_invoices WHERE status != '済'`);
  const matches = [];
  const diag = { bank_total: bankTxs.length, invoice_total: pendingInvoices.length, no_vendor_name: 0, no_amount_match: 0, matched_high: 0, matched_medium: 0, matched_low: 0 };

  for (const tx of bankTxs) {
    if (!tx.vendor_name || !String(tx.vendor_name).trim()) { diag.no_vendor_name++; continue; }
    const byAmount = pendingInvoices.filter(inv => {
      const pairs = [[inv.amount, inv.amount_cleared], [inv.carry_1, inv.carry_1_cleared], [inv.carry_2, inv.carry_2_cleared], [inv.carry_3, inv.carry_3_cleared]];
      const amts = pairs.filter(([v, c]) => v > 0 && !c).map(([v]) => v);
      return amts.includes(tx.withdrawal);
    });
    if (byAmount.length === 0) { diag.no_amount_match++; continue; }
    const bankVendor = tx.vendor_name;
    const scored = byAmount.map(inv => {
      const sim = vendorSimilarity(bankVendor, inv.vendor);
      const catOk = categoriesMatch(tx.category, inv.category);
      const facOk = (!tx.facility || !inv.facility || tx.facility === '不明' || inv.facility === '不明' || tx.facility === inv.facility);
      let score = sim * 100 + (catOk ? 10 : 0) + (inv.category === tx.category ? 5 : 0) + (facOk ? 8 : 0) + (inv.facility === tx.facility ? 5 : 0) + (inv.amount === tx.withdrawal ? 3 : 2);
      let confidence = 'low';
      if (sim >= 0.8) confidence = 'high';
      else if (sim >= 0.5 && catOk) confidence = 'high';
      else if (sim >= 0.5) confidence = 'medium';
      else if (catOk && facOk) confidence = 'medium';
      return { inv, sim, catOk, facOk, score, confidence };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best.confidence === 'low' && byAmount.length > 3) continue;
    let clearType = 'amount';
    if (best.inv.amount === tx.withdrawal && !best.inv.amount_cleared) clearType = 'amount';
    else if (best.inv.carry_1 === tx.withdrawal && !best.inv.carry_1_cleared) clearType = 'carry_1';
    else if (best.inv.carry_2 === tx.withdrawal && !best.inv.carry_2_cleared) clearType = 'carry_2';
    else if (best.inv.carry_3 === tx.withdrawal && !best.inv.carry_3_cleared) clearType = 'carry_3';
    matches.push({ bank_tx: tx, invoice: best.inv, clear_type: clearType, confidence: best.confidence, alternatives: byAmount.length - 1, similarity: Math.round(best.sim * 100) });
    diag['matched_' + best.confidence]++;
  }
  const order = { high: 0, medium: 1, low: 2 };
  matches.sort((a, b) => order[a.confidence] - order[b.confidence]);
  res.json({ matches, unmatched_count: bankTxs.length - matches.length, total_unmatched_invoices: pendingInvoices.length, diagnostic: diag });
});

router.post('/match/confirm', async (req, res) => {
  const { confirmations } = req.body;
  const flagMap = { amount: 'amount_cleared', carry_1: 'carry_1_cleared', carry_2: 'carry_2_cleared', carry_3: 'carry_3_cleared' };
  try {
    for (const c of confirmations) {
      const invRows = await query('SELECT * FROM keiri_invoices WHERE id = ?', [c.invoice_id]);
      if (invRows.length === 0) continue;
      if (c.clear_type === 'all') {
        await run(`UPDATE keiri_invoices SET
          amount_cleared = CASE WHEN amount > 0 THEN 1 ELSE amount_cleared END,
          carry_1_cleared = CASE WHEN carry_1 > 0 THEN 1 ELSE carry_1_cleared END,
          carry_2_cleared = CASE WHEN carry_2 > 0 THEN 1 ELSE carry_2_cleared END,
          carry_3_cleared = CASE WHEN carry_3 > 0 THEN 1 ELSE carry_3_cleared END,
          cleared_at = CURRENT_TIMESTAMP, matched_bank_tx_id = ? WHERE id = ?`, [c.bank_tx_id || null, c.invoice_id]);
      } else {
        const flag = flagMap[c.clear_type];
        if (!flag) continue;
        await run(`UPDATE keiri_invoices SET ${flag} = 1, cleared_at = CURRENT_TIMESTAMP, matched_bank_tx_id = ? WHERE id = ?`, [c.bank_tx_id || null, c.invoice_id]);
      }
      await recalcInvoiceStatus(c.invoice_id);
      if (c.bank_tx_id) {
        await run(`UPDATE keiri_bank_transactions SET is_cleared = '済', matched_invoice_id = ? WHERE id = ?`, [c.invoice_id, c.bank_tx_id]);
      }
      await run(`INSERT INTO keiri_clear_history (invoice_id, clear_type, cleared_at) VALUES (?, ?, CURRENT_TIMESTAMP)`, [c.invoice_id, c.clear_type]);
    }
    res.json({ ok: true, cleared: confirmations.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// ヘルプ（説明書）
// ============================================================================
router.get('/help', (req, res) => {
  const fs = require('fs');
  const p = path.join(__dirname, '..', 'public', 'keiri', '使い方.md');
  try {
    const md = fs.readFileSync(p, 'utf-8');
    res.type('text/markdown; charset=utf-8').send(md);
  } catch (e) {
    res.status(404).json({ error: '説明書が見つかりません' });
  }
});

module.exports = router;
