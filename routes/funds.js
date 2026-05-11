// ============================================================================
// 資金管理モジュール API ルート（社長Excel v8 のアプリ化）
// マウントポイント: /api/funds/*
// テーブル: funds_* プレフィックス
// 引継ぎ書「全社統合 資金管理システム 技術引継ぎ書」準拠
// ============================================================================
const express = require('express');
const { query, run, runInsert } = require('../db');

const router = express.Router();
router.use(express.json({ limit: '10mb' }));

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? 0 : n;
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
  res.json({ companies, properties, fundItems, accountCategories });
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
  const pay = await query(`
    SELECT COALESCE(SUM(plan_amount), 0) AS total
    FROM funds_payable_entries WHERE substr(plan_date,1,7) = ?${companyFilter}
  `, params);
  const rec = await query(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM funds_card_recoveries WHERE substr(pay_date,1,7) = ?${companyFilter}
  `, params);

  const income = toInt(inc[0]?.total);
  const payout = toInt(pay[0]?.total);
  const cardRecovery = toInt(rec[0]?.total);
  const dailyNet = income - payout - cardRecovery;
  const usable = dailyNet + cardRecovery;

  res.json({ income, payout, cardRecovery, dailyNet, usable, ym });
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

module.exports = router;
