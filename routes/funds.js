// ============================================================================
// 資金管理モジュール API ルート（社長Excel v8 のアプリ化）
// マウントポイント: /api/funds/*
// テーブル: funds_* プレフィックス
// 引継ぎ書「全社統合 資金管理システム 技術引継ぎ書」準拠
// ============================================================================
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { query, run, runInsert, buildPredictedIncomes } = require('../db');

const router = express.Router();
router.use(express.json({ limit: '10mb' }));

// 社長Excel アップロード用
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[,\s¥]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function ymdFromSerial(serial) {
  if (typeof serial !== 'number') return null;
  return XLSX.SSF.format('yyyy-mm-dd', serial);
}
function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}
function nullIfEmpty(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ─── マスター系 ───

router.get('/companies', async (req, res) => {
  const rows = await query("SELECT * FROM funds_companies ORDER BY sort_order, id");
  res.json(rows);
});

router.get('/properties', async (req, res) => {
  const rows = await query(`
    SELECT p.*, c.name AS company_name
    FROM funds_properties p
    LEFT JOIN funds_companies c ON c.id = p.company_id
    ORDER BY p.sort_order, p.id
  `);
  res.json(rows);
});

router.get('/fund-items', async (req, res) => {
  const rows = await query("SELECT * FROM funds_fund_items ORDER BY sort_order, id");
  res.json(rows);
});

router.get('/account-categories', async (req, res) => {
  const rows = await query(`
    SELECT a.*, f.name AS fund_item_name, f.kind AS fund_item_kind
    FROM funds_account_categories a
    LEFT JOIN funds_fund_items f ON f.id = a.fund_item_id
    ORDER BY a.sort_order, a.id
  `);
  res.json(rows);
});

// マスター一括取得（UIの初回ロード用）
router.get('/masters', async (req, res) => {
  const companies = await query("SELECT * FROM funds_companies ORDER BY sort_order, id");
  const properties = await query("SELECT * FROM funds_properties ORDER BY sort_order, id");
  const fundItems = await query("SELECT * FROM funds_fund_items ORDER BY sort_order, id");
  const accountCategories = await query("SELECT * FROM funds_account_categories ORDER BY sort_order, id");
  const facilities = await query("SELECT * FROM funds_facilities ORDER BY sort_order, id");
  const otaChannels = await query("SELECT * FROM funds_ota_channels ORDER BY sort_order, id");
  res.json({ companies, properties, fundItems, accountCategories, facilities, otaChannels });
});

// 施設マスタ
router.get('/facilities', async (req, res) => {
  const rows = await query(`
    SELECT f.*, c.name AS company_name
    FROM funds_facilities f
    LEFT JOIN funds_companies c ON c.id = f.company_id
    ORDER BY f.sort_order, f.id
  `);
  res.json(rows);
});

// OTAマスタ
router.get('/ota-channels', async (req, res) => {
  const rows = await query("SELECT * FROM funds_ota_channels ORDER BY sort_order, id");
  res.json(rows);
});

router.put('/ota-channels/:id', async (req, res) => {
  const b = req.body || {};
  await run(`
    UPDATE funds_ota_channels SET
      cur_ratio = ?, nxt_ratio = ?, nxt2_ratio = ?,
      pay_day_cur = ?, pay_day_nxt = ?, pay_day_nxt2 = ?
    WHERE id = ?
  `, [
    toInt(b.cur_ratio), toInt(b.nxt_ratio), toInt(b.nxt2_ratio),
    b.pay_day_cur ? toInt(b.pay_day_cur) : null,
    b.pay_day_nxt ? toInt(b.pay_day_nxt) : null,
    b.pay_day_nxt2 ? toInt(b.pay_day_nxt2) : null,
    toInt(req.params.id)
  ]);
  res.json({ ok: true });
});

// ─── 売上入力 + 入金予測（自動展開） ───

router.get('/sales', async (req, res) => {
  const { companyId, year, month } = req.query;
  let sql = `
    SELECT s.*, c.name AS company_name, f.name AS facility_name, f.dept AS facility_dept,
           o.name AS ota_name, o.cur_ratio, o.nxt_ratio, o.nxt2_ratio
    FROM funds_sales_entries s
    LEFT JOIN funds_companies c ON c.id = s.company_id
    LEFT JOIN funds_facilities f ON f.id = s.facility_id
    LEFT JOIN funds_ota_channels o ON o.id = s.ota_channel_id
    WHERE 1=1
  `;
  const params = [];
  if (companyId) { sql += " AND s.company_id = ?"; params.push(toInt(companyId)); }
  if (year && month) {
    sql += " AND s.year_month = ?";
    params.push(`${year}-${String(month).padStart(2, '0')}`);
  } else if (year) {
    sql += " AND s.year_month LIKE ?";
    params.push(`${year}-%`);
  }
  sql += " ORDER BY s.year_month, s.id";
  const rows = await query(sql, params);
  res.json(rows);
});

async function regeneratePredictedIncomes(salesId) {
  await run("DELETE FROM funds_predicted_incomes WHERE sales_entry_id = ?", [salesId]);
  const rows = await query("SELECT * FROM funds_sales_entries WHERE id = ?", [salesId]);
  if (!rows[0]) return;
  const s = rows[0];
  const otaRows = await query("SELECT * FROM funds_ota_channels WHERE id = ?", [s.ota_channel_id]);
  if (!otaRows[0]) return;
  const predictions = buildPredictedIncomes(s.year_month, s.amount, otaRows[0]);
  for (const p of predictions) {
    await run(`
      INSERT INTO funds_predicted_incomes
        (sales_entry_id, company_id, facility_id, ota_channel_id, expected_date, amount, period)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [salesId, s.company_id, s.facility_id, s.ota_channel_id, p.date, p.amount, p.period]);
  }
}

router.post('/sales', async (req, res) => {
  const b = req.body || {};
  const id = await runInsert(`
    INSERT INTO funds_sales_entries (company_id, facility_id, ota_channel_id, year_month, amount, memo)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    toInt(b.company_id), toInt(b.facility_id), toInt(b.ota_channel_id),
    toStr(b.year_month), toInt(b.amount), toStr(b.memo)
  ]);
  await regeneratePredictedIncomes(id);
  res.json({ id });
});

router.put('/sales/:id', async (req, res) => {
  const b = req.body || {};
  const id = toInt(req.params.id);
  await run(`
    UPDATE funds_sales_entries SET
      company_id = ?, facility_id = ?, ota_channel_id = ?,
      year_month = ?, amount = ?, memo = ?
    WHERE id = ?
  `, [
    toInt(b.company_id), toInt(b.facility_id), toInt(b.ota_channel_id),
    toStr(b.year_month), toInt(b.amount), toStr(b.memo), id
  ]);
  await regeneratePredictedIncomes(id);
  res.json({ ok: true });
});

router.delete('/sales/:id', async (req, res) => {
  const id = toInt(req.params.id);
  await run("DELETE FROM funds_predicted_incomes WHERE sales_entry_id = ?", [id]);
  await run("DELETE FROM funds_sales_entries WHERE id = ?", [id]);
  res.json({ ok: true });
});

// 入金予測（読み取り専用）
router.get('/predicted-incomes', async (req, res) => {
  const { companyId, year, month } = req.query;
  let sql = `
    SELECT p.*, c.name AS company_name, f.name AS facility_name, o.name AS ota_name
    FROM funds_predicted_incomes p
    LEFT JOIN funds_companies c ON c.id = p.company_id
    LEFT JOIN funds_facilities f ON f.id = p.facility_id
    LEFT JOIN funds_ota_channels o ON o.id = p.ota_channel_id
    WHERE p.amount > 0
  `;
  const params = [];
  if (companyId) { sql += " AND p.company_id = ?"; params.push(toInt(companyId)); }
  if (year && month) {
    sql += " AND substr(p.expected_date,1,7) = ?";
    params.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  sql += " ORDER BY p.expected_date, p.id";
  const rows = await query(sql, params);
  res.json(rows);
});

// ─── 入金 ───

router.get('/income', async (req, res) => {
  const { companyId, month, year } = req.query;
  let sql = `
    SELECT i.*, f.name AS fund_item_name, f.kind AS fund_item_kind, c.name AS company_name
    FROM funds_income_entries i
    LEFT JOIN funds_fund_items f ON f.id = i.fund_item_id
    LEFT JOIN funds_companies c ON c.id = i.company_id
    WHERE 1=1
  `;
  const params = [];
  if (companyId) { sql += " AND i.company_id = ?"; params.push(toInt(companyId)); }
  if (month && year) {
    sql += " AND substr(i.entry_date,1,7) = ?";
    params.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  sql += " ORDER BY i.entry_date, i.id";
  const rows = await query(sql, params);
  res.json(rows);
});

router.post('/income', async (req, res) => {
  const b = req.body || {};
  const id = await runInsert(`
    INSERT INTO funds_income_entries
      (company_id, entry_date, item, fund_item_id, amount, status, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    toInt(b.company_id),
    toStr(b.entry_date),
    toStr(b.item),
    b.fund_item_id ? toInt(b.fund_item_id) : null,
    toInt(b.amount),
    toStr(b.status) || '予測',
    toStr(b.memo)
  ]);
  res.json({ id });
});

router.put('/income/:id', async (req, res) => {
  const b = req.body || {};
  await run(`
    UPDATE funds_income_entries SET
      company_id = ?, entry_date = ?, item = ?, fund_item_id = ?,
      amount = ?, status = ?, memo = ?
    WHERE id = ?
  `, [
    toInt(b.company_id),
    toStr(b.entry_date),
    toStr(b.item),
    b.fund_item_id ? toInt(b.fund_item_id) : null,
    toInt(b.amount),
    toStr(b.status) || '予測',
    toStr(b.memo),
    toInt(req.params.id)
  ]);
  res.json({ ok: true });
});

router.delete('/income/:id', async (req, res) => {
  await run("DELETE FROM funds_income_entries WHERE id = ?", [toInt(req.params.id)]);
  res.json({ ok: true });
});

// ─── 未払／支出 ───

router.get('/payables', async (req, res) => {
  const { companyId, month, year } = req.query;
  let sql = `
    SELECT p.*, a.name AS account_category_name, prop.name AS property_name, c.name AS company_name
    FROM funds_payable_entries p
    LEFT JOIN funds_account_categories a ON a.id = p.account_category_id
    LEFT JOIN funds_properties prop ON prop.id = p.property_id
    LEFT JOIN funds_companies c ON c.id = p.company_id
    WHERE 1=1
  `;
  const params = [];
  if (companyId) { sql += " AND p.company_id = ?"; params.push(toInt(companyId)); }
  if (month && year) {
    sql += " AND (substr(p.plan_date,1,7) = ? OR substr(p.due_date,1,7) = ?)";
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    params.push(ym, ym);
  }
  sql += " ORDER BY p.plan_date, p.id";
  const rows = await query(sql, params);
  res.json(rows);
});

router.post('/payables', async (req, res) => {
  const b = req.body || {};
  const id = await runInsert(`
    INSERT INTO funds_payable_entries
      (company_id, property_id, kind, summary, account_category_id, due_date, billto,
       current_amount, carry_1m, carry_2m, carry_3m_plus, priority, plan_date, plan_amount, pay_status, invoice_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    toInt(b.company_id),
    b.property_id ? toInt(b.property_id) : null,
    toStr(b.kind) || '月次予定',
    toStr(b.summary),
    b.account_category_id ? toInt(b.account_category_id) : null,
    nullIfEmpty(b.due_date),
    toStr(b.billto),
    toInt(b.current_amount),
    toInt(b.carry_1m),
    toInt(b.carry_2m),
    toInt(b.carry_3m_plus),
    toStr(b.priority) || '月次',
    nullIfEmpty(b.plan_date),
    toInt(b.plan_amount),
    toStr(b.pay_status),
    toStr(b.invoice_path)
  ]);
  res.json({ id });
});

router.put('/payables/:id', async (req, res) => {
  const b = req.body || {};
  await run(`
    UPDATE funds_payable_entries SET
      company_id = ?, property_id = ?, kind = ?, summary = ?,
      account_category_id = ?, due_date = ?, billto = ?,
      current_amount = ?, carry_1m = ?, carry_2m = ?, carry_3m_plus = ?,
      priority = ?, plan_date = ?, plan_amount = ?, pay_status = ?, invoice_path = ?
    WHERE id = ?
  `, [
    toInt(b.company_id),
    b.property_id ? toInt(b.property_id) : null,
    toStr(b.kind) || '月次予定',
    toStr(b.summary),
    b.account_category_id ? toInt(b.account_category_id) : null,
    nullIfEmpty(b.due_date),
    toStr(b.billto),
    toInt(b.current_amount),
    toInt(b.carry_1m),
    toInt(b.carry_2m),
    toInt(b.carry_3m_plus),
    toStr(b.priority) || '月次',
    nullIfEmpty(b.plan_date),
    toInt(b.plan_amount),
    toStr(b.pay_status),
    toStr(b.invoice_path),
    toInt(req.params.id)
  ]);
  res.json({ ok: true });
});

router.delete('/payables/:id', async (req, res) => {
  await run("DELETE FROM funds_payable_entries WHERE id = ?", [toInt(req.params.id)]);
  res.json({ ok: true });
});

// ─── カード枠回復 ───

router.get('/card-recoveries', async (req, res) => {
  const { companyId, month, year } = req.query;
  let sql = `
    SELECT r.*, c.name AS company_name
    FROM funds_card_recoveries r
    LEFT JOIN funds_companies c ON c.id = r.company_id
    WHERE 1=1
  `;
  const params = [];
  if (companyId) { sql += " AND r.company_id = ?"; params.push(toInt(companyId)); }
  if (month && year) {
    sql += " AND substr(r.pay_date,1,7) = ?";
    params.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  sql += " ORDER BY r.pay_date, r.id";
  const rows = await query(sql, params);
  res.json(rows);
});

router.post('/card-recoveries', async (req, res) => {
  const b = req.body || {};
  const id = await runInsert(`
    INSERT INTO funds_card_recoveries (company_id, pay_date, card_name, amount, kind, memo)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    toInt(b.company_id),
    toStr(b.pay_date),
    toStr(b.card_name),
    toInt(b.amount),
    toStr(b.kind) || '通常',
    toStr(b.memo)
  ]);
  res.json({ id });
});

router.put('/card-recoveries/:id', async (req, res) => {
  const b = req.body || {};
  await run(`
    UPDATE funds_card_recoveries SET
      company_id = ?, pay_date = ?, card_name = ?, amount = ?, kind = ?, memo = ?
    WHERE id = ?
  `, [
    toInt(b.company_id),
    toStr(b.pay_date),
    toStr(b.card_name),
    toInt(b.amount),
    toStr(b.kind) || '通常',
    toStr(b.memo),
    toInt(req.params.id)
  ]);
  res.json({ ok: true });
});

router.delete('/card-recoveries/:id', async (req, res) => {
  await run("DELETE FROM funds_card_recoveries WHERE id = ?", [toInt(req.params.id)]);
  res.json({ ok: true });
});

// ─── サマリー（月別） ───
// 引継ぎ書 5.1 のビジネスルール反映：
//   日次差引 = 入金 - 支出 - カード枠回復
//   使用可能額 = 累計差引 + 累計カード枠回復
router.get('/summary', async (req, res) => {
  const { companyId, month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: 'month と year は必須です' });

  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const params = [ym];
  let companyFilter = '';
  if (companyId) {
    companyFilter = " AND company_id = ?";
    params.push(toInt(companyId));
  }

  const inc = await query(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM funds_income_entries WHERE substr(entry_date,1,7) = ?${companyFilter}
  `, params);
  const predIncFilter = companyFilter; // 同じ列名 company_id
  const predInc = await query(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM funds_predicted_incomes
    WHERE substr(expected_date,1,7) = ?${predIncFilter}
  `, params);
  const pay = await query(`
    SELECT COALESCE(SUM(plan_amount), 0) AS total
    FROM funds_payable_entries WHERE substr(plan_date,1,7) = ?${companyFilter}
  `, params);
  const rec = await query(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM funds_card_recoveries WHERE substr(pay_date,1,7) = ?${companyFilter}
  `, params);

  const incomeManual = toInt(inc[0]?.total);
  const incomePredicted = toInt(predInc[0]?.total);
  const income = incomeManual + incomePredicted;
  const payout = toInt(pay[0]?.total);
  const cardRecovery = toInt(rec[0]?.total);
  const dailyNet = income - payout - cardRecovery;
  const usable = dailyNet + cardRecovery;

  res.json({ income, incomeManual, incomePredicted, payout, cardRecovery, dailyNet, usable, ym });
});

// 日次キャッシュフロー（引継ぎ書3.4・6.3）
//   列: 日付 / 入金 / 支出 / 日次差引 / 累計差引 / カード枠回復 / 使用可能額 / 備考(曜日)
//   月またぎ連動: 同会社の対象月初より前の入金・支出・カード回復で累計を初期化
router.get('/daily-cashflow', async (req, res) => {
  const { companyId, year, month } = req.query;
  if (!companyId || !year || !month) return res.status(400).json({ error: 'companyId, year, month は必須です' });
  const cid = toInt(companyId);
  const y = toInt(year);
  const m = toInt(month);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;

  // 前月末までの累計（純現金残高 = 入金（手動+予測） - 支出 - カード回復、累計カード回復 = カード回復合計）
  const prevInc = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_income_entries WHERE company_id = ? AND entry_date < ?", [cid, monthStart]);
  const prevPredInc = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_predicted_incomes WHERE company_id = ? AND expected_date IS NOT NULL AND expected_date < ?", [cid, monthStart]);
  const prevPay = await query("SELECT COALESCE(SUM(plan_amount),0) AS t FROM funds_payable_entries WHERE company_id = ? AND plan_date < ?", [cid, monthStart]);
  const prevRec = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_card_recoveries WHERE company_id = ? AND pay_date < ?", [cid, monthStart]);
  const prevIncomeTotal = toInt(prevInc[0]?.t) + toInt(prevPredInc[0]?.t);
  let cumNet = prevIncomeTotal - toInt(prevPay[0]?.t) - toInt(prevRec[0]?.t);
  let cumCard = toInt(prevRec[0]?.t);
  const prevCumNet = cumNet;
  const prevCumCard = cumCard;

  // 当月日別集計を1クエリずつ（件数31なので許容）
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const inc = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_income_entries WHERE company_id = ? AND entry_date = ?", [cid, date]);
    const predInc = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_predicted_incomes WHERE company_id = ? AND expected_date = ?", [cid, date]);
    const pay = await query("SELECT COALESCE(SUM(plan_amount),0) AS t FROM funds_payable_entries WHERE company_id = ? AND plan_date = ?", [cid, date]);
    const rec = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_card_recoveries WHERE company_id = ? AND pay_date = ?", [cid, date]);
    const incomeManual = toInt(inc[0]?.t);
    const incomePredicted = toInt(predInc[0]?.t);
    const income = incomeManual + incomePredicted;
    const payout = toInt(pay[0]?.t);
    const cardRecovery = toInt(rec[0]?.t);
    const dailyNet = income - payout - cardRecovery;
    cumNet += dailyNet;
    cumCard += cardRecovery;
    const usable = cumNet + cumCard;
    const dow = new Date(`${date}T00:00:00`).getDay(); // 0=日, 6=土
    days.push({ date, dow, income, incomeManual, incomePredicted, payout, cardRecovery, dailyNet, cumNet, cumCard, usable });
  }

  res.json({ days, prevCumNet, prevCumCard, daysInMonth });
});

// 全社合算サマリー（会社×月のマトリクス）
router.get('/summary-matrix', async (req, res) => {
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'year は必須です' });

  const companies = await query("SELECT id, name FROM funds_companies WHERE is_funds_target = 1 ORDER BY sort_order, id");

  const result = [];
  for (const c of companies) {
    const row = { company_id: c.id, company_name: c.name, months: {} };
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2, '0')}`;
      const inc = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_income_entries WHERE company_id = ? AND substr(entry_date,1,7) = ?", [c.id, ym]);
      const pay = await query("SELECT COALESCE(SUM(plan_amount),0) AS t FROM funds_payable_entries WHERE company_id = ? AND substr(plan_date,1,7) = ?", [c.id, ym]);
      const rec = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_card_recoveries WHERE company_id = ? AND substr(pay_date,1,7) = ?", [c.id, ym]);
      row.months[m] = {
        income: toInt(inc[0]?.t),
        payout: toInt(pay[0]?.t),
        cardRecovery: toInt(rec[0]?.t)
      };
    }
    result.push(row);
  }
  res.json(result);
});

// ============================================================================
// 社長Excel v10（全社統合_資金管理_v10.xlsx）取り込み
//   - シート: 入金入力 / 売上入力 / 未払予定一覧
//   - 既存の funds_income/payable/card/sales/predicted を全削除して入れ直す
//   - 勘定科目は不足分を自動追加
//   - body: dry_run=true でプレビュー件数のみ返す
// ============================================================================
const PRESIDENT_REQUIRED_SHEETS = ['入金入力', '売上入力', '未払予定一覧'];

const COMPANY_NAME_TO_CODE = {
  'レジデンス': 'residence',
  'リゾート':   'resort',
  'モーテル':   'motel',
  'ザック':     'zack',
  'ワールド・レイ':       'world_ray',
  'ココ・ユニバース':     'coco_uni',
};
const SKIP_COMPANIES = new Set(['合計', '支払済合計', '未払残高（予定）', '取消', '']);
const ACCOUNT_TO_FUND_ITEM = {
  '水道光熱費': '買掛金支払', '設備費': '買掛金支払', '通信費': '買掛金支払',
  '衛生管理費': '買掛金支払', '食材費': '買掛金支払', 'システム利用料': '買掛金支払',
  '業務委託料': '買掛金支払', '業務委託費': '買掛金支払', '備品消耗品費': '買掛金支払',
  '消耗品費': '買掛金支払', 'ゴミ収集費': '買掛金支払', '燃料費': '買掛金支払',
  '租税公課': '租税公課', '保険': 'その他経費', '保険料': 'その他経費',
  '手数料': 'その他経費', '支払手数料': 'その他経費', 'リース料': 'その他経費',
  '諸会費': 'その他経費', 'その他': 'その他経費', 'カード': 'その他経費',
  '役員報酬': '人件費', '従業員給与': '人件費', '社員給与': '人件費',
  '給料手当': '人件費', '法定福利費': '人件費',
  '地代家賃': '地代家賃', '賃料': '地代家賃',
  '支払利息': '支払利息', '仕入': '買掛金支払',
  '修繕費': 'その他経費', '広告宣伝費': 'その他経費', '交際費': 'その他経費',
  '旅費交通費': 'その他経費', '車両費': 'その他経費', '減価償却費': 'その他経費',
  '雑費': 'その他経費',
};

router.post('/upload-v10', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  const filename = req.file.originalname || 'upload.xlsx';
  if (!/\.(xlsx|xls)$/i.test(filename)) return res.status(400).json({ error: 'Excelファイル（.xlsx/.xls）をアップロードしてください' });

  // dry_runは multipart の場合 body にしか乗らない。form field で受ける
  const dryRun = String(req.body?.dry_run || '').toLowerCase() === 'true';

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Excel読込エラー: ' + e.message });
  }

  // 形式チェック：必須シートが揃っているか
  const missing = PRESIDENT_REQUIRED_SHEETS.filter(s => !wb.SheetNames.includes(s));
  if (missing.length > 0) {
    return res.status(400).json({
      error: '社長Excel v10 の必須シートが見つかりません',
      missing,
      hint: '「入金入力」「売上入力」「未払予定一覧」の3シートを含む「全社統合_資金管理_v10.xlsx」をアップロードしてください。',
    });
  }

  // ── マスタ取得 ──
  const companies = {};
  (await query("SELECT id, code, name FROM funds_companies")).forEach(r => {
    companies[r.code] = r.id;
    companies[r.name] = r.id;
  });
  const properties = {};
  (await query("SELECT id, name FROM funds_properties")).forEach(r => properties[r.name] = r.id);
  const facilities = {};
  (await query("SELECT id, name FROM funds_facilities")).forEach(r => facilities[r.name] = r.id);
  if (facilities['竹原（レストラン含む）']) {
    facilities['竹原（ﾚｽﾄﾗﾝ含む）'] = facilities['竹原（レストラン含む）'];
  }
  const otaChannels = {};
  (await query("SELECT * FROM funds_ota_channels")).forEach(r => otaChannels[r.name] = r);
  const fundItems = {};
  (await query("SELECT id, name FROM funds_fund_items")).forEach(r => fundItems[r.name] = r.id);
  const accountCategories = {};
  (await query("SELECT id, name FROM funds_account_categories")).forEach(r => accountCategories[r.name] = r.id);

  const stats = { income: 0, sales: 0, predicted: 0, payable: 0, card: 0, skipped: 0 };
  const warnings = [];

  if (!dryRun) {
    // 不足している資金繰り項目を補充
    const requiredFI = ['買掛金支払', '人件費', '地代家賃', '水道光熱費', '租税公課', '支払利息', 'その他経費', '現金売上', '売掛金回収', 'その他収入'];
    for (const name of requiredFI) {
      if (!fundItems[name]) {
        const kind = ['現金売上', '売掛金回収', '手形入金', 'その他収入'].includes(name) ? '収入'
                    : ['借入金', '設備売却'].includes(name) ? '財務' : '支出';
        const id = await runInsert("INSERT INTO funds_fund_items (name, kind, sort_order) VALUES (?, ?, ?)", [name, kind, 100]);
        fundItems[name] = id;
      }
    }
    // 既存データ全削除
    await run("DELETE FROM funds_predicted_incomes");
    await run("DELETE FROM funds_sales_entries");
    await run("DELETE FROM funds_income_entries");
    await run("DELETE FROM funds_payable_entries");
    await run("DELETE FROM funds_card_recoveries");
  }

  // ── 入金入力 ──
  const inc = XLSX.utils.sheet_to_json(wb.Sheets['入金入力'], { header: 1, defval: '' });
  for (let i = 3; i < inc.length; i++) {
    const r = inc[i];
    if (!r[0] || SKIP_COMPANIES.has(r[0])) continue;
    const date = ymdFromSerial(r[1]);
    if (!date) continue;
    const cid = companies[r[0]];
    if (!cid) { warnings.push(`入金: 不明な会社「${r[0]}」`); stats.skipped++; continue; }
    if (!dryRun) {
      const fi = fundItems[r[3]] || null;
      await run(
        `INSERT INTO funds_income_entries (company_id, entry_date, item, fund_item_id, amount, status, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cid, date, r[2] || '', fi, toInt(r[4]), r[6] || '予測', r[5] || '']
      );
    }
    stats.income++;
  }

  // ── 売上入力 → 入金予測自動展開 ──
  const sales = XLSX.utils.sheet_to_json(wb.Sheets['売上入力'], { header: 1, defval: '' });
  for (let i = 3; i < sales.length; i++) {
    const r = sales[i];
    if (!r[0] || typeof r[0] !== 'number') continue;
    if (SKIP_COMPANIES.has(r[1])) continue;
    const ym = (ymdFromSerial(r[0]) || '').substr(0, 7);
    if (!ym) continue;
    const cid = companies[r[1]];
    const fid = facilities[r[2]];
    const ota = otaChannels[r[3]];
    if (!cid) { warnings.push(`売上: 不明な会社「${r[1]}」`); stats.skipped++; continue; }
    if (!fid) { warnings.push(`売上: 不明な施設「${r[2]}」`); stats.skipped++; continue; }
    if (!ota) { warnings.push(`売上: 不明なOTA「${r[3]}」`); stats.skipped++; continue; }
    if (!dryRun) {
      const sid = await runInsert(
        `INSERT INTO funds_sales_entries (company_id, facility_id, ota_channel_id, year_month, amount, memo)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [cid, fid, ota.id, ym, toInt(r[4]), r[5] || '']
      );
      const preds = buildPredictedIncomes(ym, toInt(r[4]), ota);
      for (const p of preds) {
        await run(
          `INSERT INTO funds_predicted_incomes
             (sales_entry_id, company_id, facility_id, ota_channel_id, expected_date, amount, period)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [sid, cid, fid, ota.id, p.date, p.amount, p.period]
        );
        stats.predicted++;
      }
    } else {
      stats.predicted += 3; // 当月/翌月/翌々月の3行
    }
    stats.sales++;
  }

  // ── 未払予定一覧（カード枠回復も含む） ──
  const pay = XLSX.utils.sheet_to_json(wb.Sheets['未払予定一覧'], { header: 1, defval: '' });
  for (let i = 3; i < pay.length; i++) {
    const r = pay[i];
    if (!r[0] || SKIP_COMPANIES.has(r[0])) continue;
    const cid = companies[r[0]];
    if (!cid) { warnings.push(`未払: 不明な会社「${r[0]}」`); stats.skipped++; continue; }
    const kind = r[1] || '月次予定';
    const property = r[2] || '';
    const summary = r[3] || '';
    const account = r[4] || '';
    const due = ymdFromSerial(r[5]);
    const billto = r[6] || '';
    const current = toInt(r[7]);
    const c1 = toInt(r[8]);
    const c2 = toInt(r[9]);
    const c3 = toInt(r[10]);
    const priority = r[12] || '月次';
    const planDate = ymdFromSerial(r[13]);
    const planAmount = toInt(r[14]);
    const payStatus = r[15] || '';
    const invoicePath = r[16] || '';

    if (kind === 'カード枠回復' || priority === 'カード枠回復') {
      if (planDate) {
        if (!dryRun) {
          await run(
            "INSERT INTO funds_card_recoveries (company_id, pay_date, card_name, amount, kind, memo) VALUES (?, ?, ?, ?, ?, ?)",
            [cid, planDate, account || 'カード', planAmount || current, '通常', summary]
          );
        }
        stats.card++;
      }
      continue;
    }

    if (!dryRun) {
      let accId = accountCategories[account];
      if (account && !accId) {
        const fiName = ACCOUNT_TO_FUND_ITEM[account] || 'その他経費';
        accId = await runInsert(
          "INSERT INTO funds_account_categories (name, fund_item_id, sort_order) VALUES (?, ?, ?)",
          [account, fundItems[fiName] || null, 100]
        );
        accountCategories[account] = accId;
      }
      const propId = properties[property] || null;
      await run(
        `INSERT INTO funds_payable_entries
           (company_id, property_id, kind, summary, account_category_id, due_date, billto,
            current_amount, carry_1m, carry_2m, carry_3m_plus, priority, plan_date, plan_amount, pay_status, invoice_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cid, propId, kind, summary, accId || null, due, billto,
         current, c1, c2, c3, priority, planDate, planAmount, payStatus, invoicePath]
      );
    }
    stats.payable++;
  }

  res.json({ ok: true, dry_run: dryRun, stats, warnings: warnings.slice(0, 20), total_warnings: warnings.length });
});

module.exports = router;
