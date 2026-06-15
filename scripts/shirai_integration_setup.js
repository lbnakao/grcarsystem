// 白井システム統合 Step0：マスタ正本化（白井表記）＋別名・振込口座・新規マスタ投入
// 再実行可能（idempotent）。白井さん確認待ちの項目（入金サイクル等）は含めない。
// 実行: node scripts/shirai_integration_setup.js
const { initDatabase, query, run, runInsert } = require('../db');

async function one(sql, params) { const r = await query(sql, params); return r[0] || null; }
async function ensureAlias(kind, alias, targetId, source) {
  const ex = await query("SELECT id FROM funds_name_aliases WHERE kind=? AND alias=?", [kind, alias]);
  if (ex.length) return;
  await run("INSERT INTO funds_name_aliases (kind, alias, target_id, source) VALUES (?,?,?,?)",
    [kind, alias, targetId, source]);
}

(async () => {
  await initDatabase();

  // 1) OTA名を白井表記へリネーム
  const otaRenames = [['楽天', '楽天トラベル'], ['Booking', 'booking'], ['一休', '一休.com'], ['PayPay', 'PAYPAY'], ['現金売上', '売上金（現金）']];
  for (const [oldN, newN] of otaRenames) {
    const hasNew = await one("SELECT id FROM funds_ota_channels WHERE name=?", [newN]);
    if (!hasNew) await run("UPDATE funds_ota_channels SET name=? WHERE name=?", [newN, oldN]);
  }

  // 2) 施設名を白井表記へ（明確な相違のみ）
  await run("UPDATE funds_facilities SET name=? WHERE name=?", ['デルーネ', 'de Lune']);

  // 3) 新会社：有限会社パルコ
  let parco = await one("SELECT id FROM funds_companies WHERE code=?", ['parco']);
  if (!parco) {
    const id = await runInsert("INSERT INTO funds_companies (code,name,is_funds_target,color,sort_order) VALUES (?,?,?,?,?)",
      ['parco', '有限会社パルコ', 0, '#8e44ad', 7]);
    parco = { id };
  }

  // 4) 新施設：ジーアール柳井（パルコ）
  let yanai = await one("SELECT id FROM funds_facilities WHERE name=?", ['ジーアール柳井']);
  if (!yanai) await run("INSERT INTO funds_facilities (name,dept,company_id,sort_order) VALUES (?,?,?,?)",
    ['ジーアール柳井', '', parco.id, 100]);

  // 5) 新OTA（入金サイクルは白井確認後に設定するため 0 プレースホルダ）
  for (const ch of ['Airbnb', 'JTB', 'リクルートペイメント']) {
    const ex = await one("SELECT id FROM funds_ota_channels WHERE name=?", [ch]);
    if (!ex) await run("INSERT INTO funds_ota_channels (name,cur_ratio,nxt_ratio,nxt2_ratio,sort_order) VALUES (?,0,0,0,99)", [ch]);
  }

  // 6) 施設の別名（funds旧表記・経理表記・白井表記 → 施設ID）
  const facById = {};
  (await query("SELECT id,name FROM funds_facilities")).forEach(r => { facById[r.name] = r.id; });
  const facAliases = {
    'VIEW': ['ビュー', 'モーテル(VIEW)'],
    'デルーネ': ['de Lune', 'デルーネ(LUNE)'],
    'いこいの村': ['いこいの村ひろしま'],
    '弥山': ['モーテル（弥山）'],
    '天神': ['天神ハウス'],
    'フォレストヒルズガーデン': ['フォレスト', 'フォレストヒルズ'],
    '竹原（レストラン含む）': ['竹原', 'たけはら'],
    'MAKI de SAUNA': ['サウナ'], // ※Q3未確定：白井「サウナ＝ココ・ユニバース」回答待ち。暫定で同一扱い
  };
  for (const [canon, aliases] of Object.entries(facAliases)) {
    const fid = facById[canon];
    if (!fid) continue;
    await ensureAlias('facility', canon, fid, 'canonical');
    for (const a of aliases) await ensureAlias('facility', a, fid, 'alias');
  }

  // 7) OTAの別名（funds旧表記 → OTA ID）
  const otaById = {};
  (await query("SELECT id,name FROM funds_ota_channels")).forEach(r => { otaById[r.name] = r.id; });
  const otaAliases = {
    '楽天トラベル': ['楽天'], 'booking': ['Booking'], '一休.com': ['一休'], 'PAYPAY': ['PayPay'], '売上金（現金）': ['現金売上'],
  };
  for (const [canon, aliases] of Object.entries(otaAliases)) {
    const cid = otaById[canon];
    if (!cid) continue;
    await ensureAlias('channel', canon, cid, 'canonical');
    for (const a of aliases) await ensureAlias('channel', a, cid, 'alias');
  }

  // 8) 振込口座マスタ
  const coById = {};
  (await query("SELECT id,name FROM funds_companies")).forEach(r => { coById[r.name] = r.id; });
  const banks = [
    { label: 'カ)グローバルリゾート 広島銀行 本店営業部', bank: '広島銀行', branch: '本店営業部', account_no: '4138342', holder: 'カ)グローバルリゾート', company: 'リゾート' },
    { label: 'カ)グローバルリゾート 楽天銀行 第三営業支店', bank: '楽天銀行', branch: '第三営業支店', account_no: '7493359', holder: 'カ)グローバルリゾート', company: 'リゾート' },
    { label: 'カ)グローバルリゾート 広島商銀 本店営業部', bank: '広島商銀', branch: '本店営業部', account_no: '0205771', holder: 'カ)グローバルリゾート', company: 'リゾート' },
    { label: 'ユ)モーテルトウキョウ 広島銀行 宮島口支店', bank: '広島銀行', branch: '宮島口支店', account_no: '607070', holder: 'ユ)モーテルトウキョウ', company: 'モーテル' },
  ];
  for (const b of banks) {
    const ex = await one("SELECT id FROM funds_bank_accounts WHERE account_no=?", [b.account_no]);
    if (ex) continue;
    await run("INSERT INTO funds_bank_accounts (label,bank,branch,account_no,holder,company_id) VALUES (?,?,?,?,?,?)",
      [b.label, b.bank, b.branch, b.account_no, b.holder, coById[b.company] || null]);
  }

  // 検証出力
  console.log('--- 完了 ---');
  console.log('別名 件数:', (await one("SELECT COUNT(*) c FROM funds_name_aliases")).c);
  console.log('振込口座 件数:', (await one("SELECT COUNT(*) c FROM funds_bank_accounts")).c);
  console.log('OTAチャネル:', (await query("SELECT name FROM funds_ota_channels ORDER BY sort_order,name")).map(r => r.name).join(' / '));
  console.log('パルコ施設:', (await query("SELECT f.name FROM funds_facilities f JOIN funds_companies c ON f.company_id=c.id WHERE c.code='parco'")).map(r => r.name).join(' / '));
  console.log('デルーネ確認:', (await query("SELECT name FROM funds_facilities WHERE name IN ('デルーネ','de Lune')")).map(r => r.name).join(','));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
