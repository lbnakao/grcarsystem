// 全体売上収支Excel → funds_uriage_entries（施設×月の売上/経費）へ取り込み
// 既に行があればスキップ（Web編集を上書きしないため）。 実行: node scripts/import_uriage.js [--force]
const { initDatabase, query, run } = require('../db');
const { parseEntries } = require('../lib/uriage_shushi');

const YEAR = 2026;
const parse = () => parseEntries();

(async () => {
  await initDatabase();
  const force = process.argv.includes('--force');
  const existing = await query("SELECT COUNT(*) AS c FROM funds_uriage_entries");
  if (Number(existing[0].c) > 0 && !force) {
    console.log('既にデータあり（' + existing[0].c + '行）。--force でなければスキップします。');
    process.exit(0);
  }
  if (force) await run("DELETE FROM funds_uriage_entries");

  const { facs, order } = parse();
  let n = 0;
  for (let oi = 0; oi < order.length; oi++) {
    const key = order[oi];
    const f = facs[key];
    for (let m = 0; m < 12; m++) {
      const ym = `${YEAR}-${String(m + 1).padStart(2, '0')}`;
      await run(
        "INSERT INTO funds_uriage_entries (facility, dept, year_month, sales, expense, sort_order) VALUES (?,?,?,?,?,?)",
        [key, f.dept, ym, f.sales[m], f.expense[m], oi]
      );
      n++;
    }
  }
  console.log(`取り込み完了：${order.length} 施設 × 12ヶ月 = ${n} 行`);
  console.log('施設:', order.join(' / '));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
