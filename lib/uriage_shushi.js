// 全体売上収支Excel → 各シートを忠実HTMLに（施設欄を1施設ごとに分解／セル結合保持）
// Phase1：既存に干渉しない読み取り専用モジュール
const path = require('path');
const XLSX = require('xlsx');

const FACJP = { 'de Lune': 'デルーネ', 'VIEW': 'ビュー' };
const skipFac = /合計|リゾート|レジデンス|不明/;

// 既定の対象ファイル（assets配下に配置）
const DEFAULT_FILE = path.join(__dirname, '..', 'assets', 'uriage_shushi.xlsx');

function renderSheets(filePath = DEFAULT_FILE) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const enc = XLSX.utils.encode_cell;
  const out = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const merges = ws['!merges'] || [];
    // 施設列(B)の複数行マージのうち、明細(D)を持つ多施設グループを分解
    const keep = [];
    for (const m of merges) {
      if (m.s.c === 1 && m.e.r > m.s.r) {
        let hasMeibo = false;
        for (let r = m.s.r; r <= m.e.r; r++) {
          const d = ws[enc({ r, c: 3 })];
          if (d && String(d.v).trim() && !skipFac.test(String(d.v))) { hasMeibo = true; break; }
        }
        if (hasMeibo) {
          for (let r = m.s.r; r <= m.e.r; r++) {
            const d = ws[enc({ r, c: 3 })];
            let val = '';
            if (d && String(d.v).trim() && !skipFac.test(String(d.v))) { const s = String(d.v).trim(); val = FACJP[s] || s; }
            ws[enc({ r, c: 1 })] = { t: 's', v: val, w: val };
          }
          continue;
        }
      }
      keep.push(m);
    }
    ws['!merges'] = keep;
    // 文字セルの連続スペース→改行
    Object.keys(ws).forEach(ref => {
      if (ref[0] === '!') return;
      const c = ws[ref];
      if (c && c.t === 's' && typeof c.v === 'string') {
        const cleaned = c.v.replace(/[ 　]{2,}/g, '\n').replace(/^[\s　]+|[\s　]+$/g, '');
        c.v = cleaned; c.w = cleaned;
      }
    });
    const full = XLSX.utils.sheet_to_html(ws, { editable: false });
    const mt = full.match(/<table[\s\S]*?<\/table>/i);
    out.push({ name, html: mt ? mt[0] : '<p>(空)</p>' });
  }
  return out;
}

// 全体収支シート → 施設×月の 売上/経費（編集用テーブル投入の元データ）
function parseEntries(filePath = DEFAULT_FILE) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['グローバルリゾート全体収支'], { header: 1, blankrows: false });
  const norm = s => String(s || '').replace(/[\s　]/g, '');
  const skip = /売上合計|経費合計|^合計$|リゾート|レジデンス|不明金/;
  let dept = '', facility = '', section = '', groupHasMeibo = false;
  const facs = {}, order = [];
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
      if (skip.test(meibo)) continue;
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

// 詳細シート群 → 施設×月×指標 の値配列（Excel卒業向け・全指標）
const FAC_MAP = {
  'デルーネ': 'de Lune', 'ビュー': 'VIEW', '本川': '本川', '天神': '天神', '天神ハウス': '天神', '玖波': '玖波',
  '弥山': '弥山', '温井': '温井', 'いこいの村': 'いこいの村', 'フォレストヒルズガーデン': 'フォレストヒルズガーデン',
  '竹原': '竹原（ﾚｽﾄﾗﾝ含む）', 'サウナ': 'MAKI de SAUNA', 'MAKIdeSAUNA': 'MAKI de SAUNA', '深入山GS': '深入山GS',
  'TAKAYA': 'TAKAYA', '高屋': 'TAKAYA', '壱番館': '壱番館', '弐番館': '弐番館', 'Otake': 'Otake',
};
const METRIC_MAP = {
  '目標売上': '目標売上', '売上進捗': '売上実績', '売上実績': '売上実績', '客室売上': '客室売上', 'レジ売上': 'レジ売上',
  '飲食売上': '飲食売上', '朝食売上': '朝食売上', '朝食数': '朝食数', '夕食売上': '夕食売上', '夕食数': '夕食数',
  '昨年売上': '昨年売上', '昨年経費': '昨年経費', '2024年売上': '2024年売上',
  '経費予測': '経費予測', '経費実績': '経費実績',
  '販売客室数': '販売客室数', '利用人数': '利用人数', '稼働率': '稼働率', '客室単価': '客室単価', '客単価': '客単価',
};
// 編集グリッドで使う指標の表示順
const METRIC_ORDER = Object.values(METRIC_MAP).filter((v, i, a) => a.indexOf(v) === i);
// 完全再現用：グループ＋型＋計算式（input:入力／f:計算式）。エクセル弥山シートの全行を再現
const METRIC_DEFS = [
  { g: '売上', k: '目標売上', t: 'money', input: true },
  { g: '売上', k: '売上実績', t: 'money', input: true },
  { g: '売上', k: '客室売上', t: 'money', input: true },
  { g: '売上', k: 'レジ売上', t: 'money', input: true },
  { g: '売上', k: '達成率', t: 'pct', f: ['/', '売上実績', '目標売上'] },
  { g: '売上', k: '売上目標差異', t: 'money', f: ['-', '売上実績', '目標売上'] },
  { g: '稼働', k: '稼働率', t: 'rate', input: true },
  { g: '稼働', k: '販売客室数', t: 'count', input: true },
  { g: '稼働', k: '利用人数', t: 'count', input: true },
  { g: '稼働', k: '客室単価', t: 'money', input: true },
  { g: '稼働', k: '客単価', t: 'money', input: true },
  { g: '飲食', k: '飲食売上', t: 'money', input: true },
  { g: '飲食', k: '朝食売上', t: 'money', input: true },
  { g: '飲食', k: '朝食数', t: 'count', input: true },
  { g: '飲食', k: '朝食利用率', t: 'pct', f: ['/', '朝食数', '利用人数'] },
  { g: '飲食', k: '夕食売上', t: 'money', input: true },
  { g: '飲食', k: '夕食数', t: 'count', input: true },
  { g: '飲食', k: '夕食利用率', t: 'pct', f: ['/', '夕食数', '利用人数'] },
  { g: '経費・収支', k: '経費予測', t: 'money', input: true },
  { g: '経費・収支', k: '昨年経費', t: 'money', input: true },
  { g: '経費・収支', k: '経費実績', t: 'money', input: true },
  { g: '経費・収支', k: '経費差異', t: 'money', f: ['-', '経費予測', '経費実績'] },
  { g: '経費・収支', k: '差引収支', t: 'money', f: ['-', '売上実績', '経費実績'] },
  { g: '前年比較', k: '昨年売上', t: 'money', input: true },
  { g: '前年比較', k: '昨年対比', t: 'pct', f: ['/', '売上実績', '昨年売上'] },
  { g: '前年比較', k: '2024年売上', t: 'money', input: true },
];

function parseMetrics(filePath = DEFAULT_FILE) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const norm = s => String(s || '').replace(/[\s　]/g, '');
  const YEAR = 2026;
  const out = [];
  const detailSheets = ['ホテル部門→', 'マンスリー部門', '弥山', '温井', 'いこいの村', '深入山GS', 'フォレストヒルズガーデン', '竹原', 'サウナ'];
  for (const sn of detailSheets) {
    const ws = wb.Sheets[sn]; if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    let cur = null;
    for (const r of rows) {
      if (!r) continue;
      const a = norm(r[0]); if (!a) continue;
      const bIsMonth = r[1] != null && /月/.test(String(r[1]));
      if (bIsMonth) {
        if (a === '全体') { cur = null; continue; }
        cur = FAC_MAP[a.replace(/全体$/, '')] || null;
        continue;
      }
      if (!cur) continue;
      const metric = METRIC_MAP[a.replace(/全体$/, '')];
      if (!metric) continue;
      for (let m = 0; m < 12; m++) {
        const v = r[1 + m];
        if (typeof v === 'number' && isFinite(v)) {
          out.push({ facility: cur, year_month: `${YEAR}-${String(m + 1).padStart(2, '0')}`, metric, value: v });
        }
      }
    }
  }
  // 全体収支から 売上実績/経費実績（詳細シートに無い施設の補完）
  const { facs, order } = parseEntries(filePath);
  const seen = new Set(out.map(o => o.facility + '|' + o.metric));
  for (const k of order) {
    const f = facs[k];
    for (const [metric, arr] of [['売上実績', f.sales], ['経費実績', f.expense]]) {
      if (seen.has(k + '|' + metric)) continue;
      for (let m = 0; m < 12; m++) {
        if (arr[m]) out.push({ facility: k, year_month: `${YEAR}-${String(m + 1).padStart(2, '0')}`, metric, value: arr[m] });
      }
    }
  }
  return out;
}

module.exports = { renderSheets, parseEntries, parseMetrics, METRIC_ORDER, METRIC_DEFS, DEFAULT_FILE };
