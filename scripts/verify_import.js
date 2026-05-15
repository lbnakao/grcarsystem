const { initDatabase, query } = require('../db');
(async () => {
  await initDatabase();
  const tables = [
    'keiri_invoices', 'keiri_bank_transactions', 'keiri_bank_accounts',
    'funds_income_entries', 'funds_payable_entries', 'funds_card_recoveries',
    'funds_sales_entries', 'funds_predicted_incomes',
  ];
  for (const t of tables) {
    const r = await query(`SELECT COUNT(*) as c FROM ${t}`);
    console.log(`${t}: ${r[0].c}`);
  }
  console.log('\n[請求書: 事業体ごとの集計]');
  const byEntity = await query(`SELECT entity, COUNT(*) as c, SUM(amount) as total FROM keiri_invoices GROUP BY entity ORDER BY total DESC`);
  byEntity.forEach(r => console.log(`  ${r.entity}: ${r.c}件 / ¥${(r.total || 0).toLocaleString()}`));

  console.log('\n[請求書: 月ごとの集計]');
  const byMonth = await query(`SELECT year, month, COUNT(*) as c FROM keiri_invoices GROUP BY year, month ORDER BY year, month`);
  byMonth.forEach(r => console.log(`  ${r.year}年 ${r.month}: ${r.c}件`));

  console.log('\n[通帳: 口座ごとの集計]');
  const byAccount = await query(`SELECT account, COUNT(*) as c, SUM(withdrawal) as w, SUM(deposit) as d FROM keiri_bank_transactions GROUP BY account ORDER BY c DESC`);
  byAccount.forEach(r => console.log(`  ${r.account}: ${r.c}件 / 出金¥${(r.w||0).toLocaleString()} / 入金¥${(r.d||0).toLocaleString()}`));

  process.exit(0);
})();
