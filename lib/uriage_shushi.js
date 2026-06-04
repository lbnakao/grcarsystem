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

module.exports = { renderSheets, DEFAULT_FILE };
