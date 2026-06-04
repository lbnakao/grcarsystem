// 全体売上収支Excel → funds_uriage_entries（施設×月の売上/経費）へ取り込み
// 既に行があればスキップ（Web編集を上書きしないため）。 実行: node scripts/import_uriage.js [--force]
const path = require('path');
const XLSX = require('xlsx');
const { initDatabase, query, run } = require('../db');

const FILE = path.join(__dirname, '..', 'assets', 'uriage_shushi.xlsx');
const YEAR = 2026;
const norm = s => String(s || '').replace(/[\s　]/g, '');
const skipMeibo = /売上合計|経費合計|^合計$|リゾート|レジデンス|不明金/;

function parse() {
  const wb = XLSX.readFile(FILE, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['グローバルリゾート全体収支'], { header: 1, blankrows: false });
  let dept = '', facility = '', section = '', groupHasMeibo = false;
  const facs = {}; const order = [];
  const rec = (k, d) => { if (!facs[k]) { facs[k] = { dept: d, sales: Array(12).fill(0), expense: Array(12).fill(0) }; order.push(k); } return facs[k]; };
  for (let i = 2; i <= 58 && i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    if (r[0]) dept = String(r[0]).trim();
    if (r[1]) { facility = String(r[1]).replace(/[　\s]+/g, ' ').trim(); groupHasMeibo = false; }
    const inn = norm(r[2]);
    if (inn.includes('売上')) section = 'sales';
    else if (inn.includes('経費')) section = 'expense';
    else if (inn.includes('差引')) section = 'net';
    const meibo = String(r[3] || '').replace(/[　\s]+/g, ' ').trim();
    const months = Array.from({ length: 12 }, (_, k) => { const v = r[4 + k]; return (typeof v === 'number' && isFinite(v)) ? Math.round(v) : 0; });
    if (meibo) {
      if (skipMeibo.test(meibo)) continue;
      groupHasMeibo = true;
      if (section === 'sales' || section === 'expense') rec(meibo, dept)[section] = months;
    } else {
      if (groupHasMeibo) continue;
      if (section !== 'sales' && section !== 'expense') continue;
      if (/合計|不明/.test(facility)) continue;
      rec(facility, dept)[section] = months;
    }
  }
  return { facs, order };
}

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
