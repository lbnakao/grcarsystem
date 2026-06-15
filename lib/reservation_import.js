// 予約システム（コアキャスト／アイパス）書き出しファイル → 施設×月×指標 へ変換
// 対応: コアキャスト日別(.xls) / コアキャストメニュー別内訳(.xls) / アイパス帳票集計(.csv) / アイパス科目別売上(.csv)
const XLSX = require('xlsx');

const FAC = { 'デルーネ': 'de Lune', '弥山': '弥山', 'ビュー': 'VIEW', '本川': '本川', '温井': '温井', 'いこいの村': 'いこいの村', '周防大島': '周防大島' };
function facFromName(name) { for (const k in FAC) if (name.includes(k)) return FAC[k]; return null; }
function ymFromText(s) { const m = String(s || '').match(/(20\d{2})[-_/.](\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : null; }
function n(v) { if (typeof v === 'number') return isFinite(v) ? v : 0; if (v == null) return 0; const x = parseFloat(String(v).replace(/[,¥\s"％%]/g, '')); return isFinite(x) ? x : 0; }
function norm(s) { return String(s == null ? '' : s).replace(/[\s　]/g, ''); }

// 1ファイルを解析 → {type, facility, year_month, metrics} or {error}
function parseFile(name, buf) {
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer' }); } catch (e) { return { error: 'ファイルを開けません: ' + e.message, name }; }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true });
  const facility = facFromName(name);
  const head = rows.slice(0, 4).map(r => (r || []).map(norm).join('|')).join(' ');

  // --- コアキャスト 日別 売上/ADR/稼働率 ---
  if (head.includes('在室') && (head.includes('ADR') || head.includes('稼働率'))) {
    const hi = rows.findIndex(r => r && r.map(norm).includes('在室'));
    const H = rows[hi].map(norm);
    const col = lbl => H.indexOf(lbl);
    const tot = rows.find(r => r && norm(r[0]).includes('総合計'));
    let ym = null;
    for (const r of rows) { const c = (r || []).find(x => /\d{1,2}\/\d{1,2}\/20\d{2}/.test(String(x))); if (c) { const m = String(c).match(/(\d{1,2})\/\d{1,2}\/(20\d{2})/); ym = `${m[2]}-${String(m[1]).padStart(2, '0')}`; break; } }
    ym = ym || ymFromText(name);
    if (!tot) return { error: '総合計行が見つかりません', name };
    const occCol = col('稼働率(％)') >= 0 ? col('稼働率(％)') : col('稼働率(%)');
    return {
      type: 'corecast_daily', facility, year_month: ym, metrics: {
        '販売客室数': n(tot[col('在室')]),
        '利用人数': n(tot[col('顧客数')]),
        '客室売上': n(tot[col('売上')]),
        '稼働率': occCol >= 0 ? n(tot[occCol]) / 100 : 0,
        '客室単価': n(tot[col('ADR')]),
      }
    };
  }

  // --- コアキャスト メニュー別内訳（食事） ---
  if (head.includes('メニュー別内訳') || (head.includes('部門') && head.includes('メニューGP'))) {
    const rest = rows.find(r => r && /レストラン.*合計/.test(norm(r[0])));
    const ym = ymFromText(name);
    const shokuji = rest ? n(rest[4]) : 0; // 税別
    let asaA = 0, asaN = 0, yuA = 0, yuN = 0;
    for (const r of rows) {
      if (!r) continue; const item = String(r[2] || '');
      if (/朝食/.test(item)) { asaA += n(r[4]); asaN += n(r[3]); }
      else if (/夕食/.test(item)) { yuA += n(r[4]); yuN += n(r[3]); }
    }
    const metrics = { '飲食売上': shokuji };
    if (asaA || asaN) { metrics['朝食売上'] = asaA; metrics['朝食数'] = asaN; }
    if (yuA || yuN) { metrics['夕食売上'] = yuA; metrics['夕食数'] = yuN; }
    return { type: 'corecast_menu', facility, year_month: ym, metrics };
  }

  // --- アイパス 帳票集計（月次サマリー） ---
  if (head.includes('期間-開始') && head.includes('OCC')) {
    const hi = rows.findIndex(r => r && r.map(norm).includes('OCC'));
    const H = rows[hi].map(norm);
    const col = lbl => H.indexOf(lbl);
    const d = rows[hi + 1] || [];
    const ym = ymFromText(d[0]) || ymFromText(name);
    return {
      type: 'aipass_summary', facility, year_month: ym, metrics: {
        '利用人数': n(d[col('宿泊人数')]),
        '販売客室数': n(d[col('販売客室数')]),
        '稼働率': n(d[col('OCC')]),
        '客室単価': n(d[col('ADR')]),
      }
    };
  }

  // --- アイパス 科目別売上（室料・食事・その他） ---
  if (head.includes('科目別売上')) {
    let room = 0, shokuji = 0, reji = 0, asaA = 0, asaN = 0, yuA = 0, yuN = 0, inSec = false;
    for (const r of rows) {
      const k = norm(r[0]);
      if (k === '客室売上' && norm(r[1]) === '数量') { inSec = true; continue; } // セクション開始
      if (!inSec) continue;
      if (/^客室売上合計/.test(k)) break;
      if (!k) continue;
      const qty = n(r[1]), amt = n(r[2]);
      if (k === '室料') room += amt;
      else if (/朝食/.test(k)) { shokuji += amt; asaA += amt; asaN += qty; }
      else if (/夕食/.test(k)) { shokuji += amt; yuA += amt; yuN += qty; }
      else if (/ドリンク|飲食/.test(k)) shokuji += amt;
      else if (/入湯税|宿泊税|税$/.test(k)) continue; // 税は除外
      else reji += amt; // 宴会料・その他
    }
    const ym = ymFromText((rows[0] || [])[0]) || ymFromText(name);
    const metrics = { '客室売上': room, '飲食売上': shokuji, 'レジ売上': reji };
    if (asaA || asaN) { metrics['朝食売上'] = asaA; metrics['朝食数'] = asaN; }
    if (yuA || yuN) { metrics['夕食売上'] = yuA; metrics['夕食数'] = yuN; }
    return { type: 'aipass_kamoku', facility, year_month: ym, metrics };
  }

  return { error: '未対応のファイル形式です', name, type: null };
}

// 複数ファイル → (施設,月) ごとに指標をマージ。売上実績＝客室売上＋飲食売上 を計算
function mergeFiles(files) {
  const acc = {}; // key "fac|ym" -> {facility, year_month, metrics}
  const results = [];
  for (const f of files) {
    const r = parseFile(f.name, f.buffer);
    if (r.error) { results.push({ name: f.name, ok: false, message: r.error }); continue; }
    if (!r.facility) { results.push({ name: f.name, ok: false, message: '施設をファイル名から判別できません（デルーネ/弥山/ビュー/本川/温井/いこいの村/周防大島 を含めてください）' }); continue; }
    if (!r.year_month) { results.push({ name: f.name, ok: false, message: '対象月を判別できません' }); continue; }
    const key = r.facility + '|' + r.year_month;
    if (!acc[key]) acc[key] = { facility: r.facility, year_month: r.year_month, metrics: {} };
    Object.assign(acc[key].metrics, r.metrics);
    results.push({ name: f.name, ok: true, type: r.type, facility: r.facility, year_month: r.year_month, metrics: Object.keys(r.metrics) });
  }
  const entries = Object.values(acc);
  // 売上実績・客単価の計算
  for (const e of entries) {
    const m = e.metrics;
    const room = m['客室売上'] || 0, shoku = m['飲食売上'] || 0, reji = m['レジ売上'] || 0;
    if (room || shoku || reji) m['売上実績'] = room + shoku + reji;
    if (m['利用人数']) m['客単価'] = Math.round((m['売上実績'] || room) / m['利用人数']);
  }
  return { entries, results };
}

module.exports = { parseFile, mergeFiles };
