// scripts/reseed_funds_v10.js
// Excel v10「全社統合_資金管理_v10.xlsx」の実数値で funds_* テーブルを再シード
// 実行: node scripts/reseed_funds_v10.js [excel-path]
//
// 既存の funds_income_entries / funds_payable_entries / funds_card_recoveries /
// funds_sales_entries / funds_predicted_incomes を全削除して入れ直します。
// マスタ（会社／物件／施設／勘定科目／OTA）は名称ベースでマッピング、
// 不足する勘定科目は自動追加します。

const path = require('path');
const XLSX = require('xlsx');
const { initDatabase, query, run, runInsert, buildPredictedIncomes } = require('../db');

const EXCEL_PATH = process.argv[2]
  || 'c:/Users/event/OneDrive/デスクトップ/AIクライアント用/GR経理/全社統合_資金管理_v10.xlsx';

// 会社名 → DBの code マッピング
const COMPANY_NAME_TO_CODE = {
  'レジデンス': 'residence',
  'リゾート':   'resort',
  'モーテル':   'motel',
  'ザック':     'zack',
  'ワールド・レイ':       'world_ray',
  'ココ・ユニバース':     'coco_uni',
};

// 集計／非会社な行を弾く
const SKIP_COMPANIES = new Set(['合計', '支払済合計', '未払残高（予定）', '取消', '']);

// 勘定科目 → 資金繰り項目 マッピング（引継ぎ書v2 5.2 + 既存）
const ACCOUNT_TO_FUND_ITEM = {
  '水道光熱費': '買掛金支払',
  '設備費':     '買掛金支払',
  '通信費':     '買掛金支払',
  '衛生管理費': '買掛金支払',
  '食材費':     '買掛金支払',
  'システム利用料': '買掛金支払',
  '業務委託料': '買掛金支払',
  '業務委託費': '買掛金支払',
  '備品消耗品費': '買掛金支払',
  '消耗品費':   '買掛金支払',
  'ゴミ収集費': '買掛金支払',
  '燃料費':     '買掛金支払',
  '租税公課':   '租税公課',
  '保険':       'その他経費',
  '保険料':     'その他経費',
  '手数料':     'その他経費',
  '支払手数料': 'その他経費',
  'リース料':   'その他経費',
  '諸会費':     'その他経費',
  'その他':     'その他経費',
  'カード':     'その他経費',
  '役員報酬':   '人件費',
  '従業員給与': '人件費',
  '社員給与':   '人件費',
  '給料手当':   '人件費',
  '法定福利費': '人件費',
  '地代家賃':   '地代家賃',
  '賃料':       '地代家賃',
  '支払利息':   '支払利息',
  '仕入':       '買掛金支払',
  '修繕費':     'その他経費',
  '広告宣伝費': 'その他経費',
  '交際費':     'その他経費',
  '旅費交通費': 'その他経費',
  '車両費':     'その他経費',
  '減価償却費': 'その他経費',
  '雑費':       'その他経費',
};

function ymd(serial) {
  if (typeof serial !== 'number') return null;
  return XLSX.SSF.format('yyyy-mm-dd', serial);
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).replace(/[,\s¥]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

async function main() {
  console.log('Excel:', EXCEL_PATH);
  const wb = XLSX.readFile(EXCEL_PATH);
  await initDatabase();

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
  // Excelは半角ｶﾀｶﾅ '竹原（ﾚｽﾄﾗﾝ含む）'、DBは全角 '竹原（レストラン含む）'。両方ヒットさせる
  if (facilities['竹原（レストラン含む）']) {
    facilities['竹原（ﾚｽﾄﾗﾝ含む）'] = facilities['竹原（レストラン含む）'];
  }

  const otaChannels = {};
  (await query("SELECT * FROM funds_ota_channels")).forEach(r => otaChannels[r.name] = r);

  const fundItems = {};
  (await query("SELECT id, name FROM funds_fund_items")).forEach(r => fundItems[r.name] = r.id);

  // 不足している資金繰り項目を補充
  const requiredFI = ['買掛金支払', '人件費', '地代家賃', '水道光熱費', '租税公課', '支払利息', 'その他経費', '現金売上', '売掛金回収', 'その他収入'];
  for (const name of requiredFI) {
    if (!fundItems[name]) {
      const kind = ['現金売上', '売掛金回収', '手形入金', 'その他収入'].includes(name) ? '収入'
                  : ['借入金', '設備売却'].includes(name) ? '財務' : '支出';
      const id = await runInsert("INSERT INTO funds_fund_items (name, kind, sort_order) VALUES (?, ?, ?)", [name, kind, 100]);
      fundItems[name] = id;
      console.log('  [+] fund_item追加:', name);
    }
  }

  const accountCategories = {};
  (await query("SELECT id, name FROM funds_account_categories")).forEach(r => accountCategories[r.name] = r.id);

  // ── データ全削除 ──
  console.log('既存の funds_* データを削除...');
  await run("DELETE FROM funds_predicted_incomes");
  await run("DELETE FROM funds_sales_entries");
  await run("DELETE FROM funds_income_entries");
  await run("DELETE FROM funds_payable_entries");
  await run("DELETE FROM funds_card_recoveries");

  // ── 入金入力 ──
  const inc = XLSX.utils.sheet_to_json(wb.Sheets['入金入力'], { header: 1, defval: '' });
  let incomeAdded = 0;
  for (let i = 3; i < inc.length; i++) {
    const r = inc[i];
    if (!r[0] || SKIP_COMPANIES.has(r[0])) continue;
    const date = ymd(r[1]);
    if (!date) continue;
    const cid = companies[r[0]];
    if (!cid) { console.warn('  ! 入金: 不明な会社:', r[0]); continue; }
    const fi = fundItems[r[3]] || null;
    await run(`
      INSERT INTO funds_income_entries (company_id, entry_date, item, fund_item_id, amount, status, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [cid, date, r[2] || '', fi, toInt(r[4]), r[6] || '予測', r[5] || '']);
    incomeAdded++;
  }
  console.log(`✓ 入金入力: ${incomeAdded}件`);

  // ── 売上入力 → 入金予測自動展開 ──
  const sales = XLSX.utils.sheet_to_json(wb.Sheets['売上入力'], { header: 1, defval: '' });
  let salesAdded = 0, predAdded = 0;
  for (let i = 3; i < sales.length; i++) {
    const r = sales[i];
    if (!r[0] || typeof r[0] !== 'number') continue;
    if (SKIP_COMPANIES.has(r[1])) continue;
    const ym = ymd(r[0])?.substr(0, 7);
    if (!ym) continue;
    const cid = companies[r[1]];
    const fid = facilities[r[2]];
    const ota = otaChannels[r[3]];
    if (!cid) { console.warn('  ! 売上: 不明な会社:', r[1]); continue; }
    if (!fid) { console.warn('  ! 売上: 不明な施設:', r[2]); continue; }
    if (!ota) { console.warn('  ! 売上: 不明なOTA:', r[3]); continue; }
    const sid = await runInsert(`
      INSERT INTO funds_sales_entries (company_id, facility_id, ota_channel_id, year_month, amount, memo)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [cid, fid, ota.id, ym, toInt(r[4]), r[5] || '']);
    salesAdded++;
    const preds = buildPredictedIncomes(ym, toInt(r[4]), ota);
    for (const p of preds) {
      await run(`
        INSERT INTO funds_predicted_incomes
          (sales_entry_id, company_id, facility_id, ota_channel_id, expected_date, amount, period)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [sid, cid, fid, ota.id, p.date, p.amount, p.period]);
      predAdded++;
    }
  }
  console.log(`✓ 売上入力: ${salesAdded}件 / 入金予測自動展開: ${predAdded}件`);

  // ── 未払予定一覧（カード枠回復もここに含まれる） ──
  const pay = XLSX.utils.sheet_to_json(wb.Sheets['未払予定一覧'], { header: 1, defval: '' });
  let payableAdded = 0, cardAdded = 0;
  for (let i = 3; i < pay.length; i++) {
    const r = pay[i];
    if (!r[0] || SKIP_COMPANIES.has(r[0])) continue;
    const cid = companies[r[0]];
    if (!cid) { console.warn('  ! 未払: 不明な会社:', r[0]); continue; }
    const kind = r[1] || '月次予定';
    const property = r[2] || '';
    const summary = r[3] || '';
    const account = r[4] || '';
    const due = ymd(r[5]);
    const billto = r[6] || '';
    const current = toInt(r[7]);
    const c1 = toInt(r[8]);
    const c2 = toInt(r[9]);
    const c3 = toInt(r[10]);
    const priority = r[12] || '月次';
    const planDate = ymd(r[13]);
    const planAmount = toInt(r[14]);
    const payStatus = r[15] || '';
    const invoicePath = r[16] || '';

    // カード枠回復は別テーブルへ
    if (kind === 'カード枠回復' || priority === 'カード枠回復') {
      if (planDate) {
        await run(
          "INSERT INTO funds_card_recoveries (company_id, pay_date, card_name, amount, kind, memo) VALUES (?, ?, ?, ?, ?, ?)",
          [cid, planDate, account || 'カード', planAmount || current, '通常', summary]
        );
        cardAdded++;
      }
      continue;
    }

    // 不足する勘定科目をその場で追加（マッピングは ACCOUNT_TO_FUND_ITEM 経由）
    let accId = accountCategories[account];
    if (account && !accId) {
      const fiName = ACCOUNT_TO_FUND_ITEM[account] || 'その他経費';
      accId = await runInsert(
        "INSERT INTO funds_account_categories (name, fund_item_id, sort_order) VALUES (?, ?, ?)",
        [account, fundItems[fiName] || null, 100]
      );
      accountCategories[account] = accId;
      console.log('  [+] 勘定科目追加:', account, '→', fiName);
    }

    const propId = properties[property] || null;
    await run(`
      INSERT INTO funds_payable_entries
        (company_id, property_id, kind, summary, account_category_id, due_date, billto,
         current_amount, carry_1m, carry_2m, carry_3m_plus, priority, plan_date, plan_amount, pay_status, invoice_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      cid, propId, kind, summary, accId || null, due, billto,
      current, c1, c2, c3, priority, planDate, planAmount, payStatus, invoicePath
    ]);
    payableAdded++;
  }
  console.log(`✓ 未払予定: ${payableAdded}件 / カード枠回復: ${cardAdded}件`);

  // ── 集計サマリー ──
  console.log('\n=== 集計 ===');
  for (const [name, id] of Object.entries(companies).filter(([k]) => COMPANY_NAME_TO_CODE[k])) {
    const inc = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_income_entries WHERE company_id = ?", [id]);
    const pay = await query("SELECT COALESCE(SUM(plan_amount),0) AS t FROM funds_payable_entries WHERE company_id = ?", [id]);
    const sal = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_sales_entries WHERE company_id = ?", [id]);
    const pre = await query("SELECT COALESCE(SUM(amount),0) AS t FROM funds_predicted_incomes WHERE company_id = ?", [id]);
    console.log(`  ${name.padEnd(12, '　')} 入金:${(inc[0].t||0).toLocaleString().padStart(12)}  支出:${(pay[0].t||0).toLocaleString().padStart(12)}  売上:${(sal[0].t||0).toLocaleString().padStart(12)}  予測:${(pre[0].t||0).toLocaleString().padStart(12)}`);
  }

  console.log('\n✓ 再シード完了');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
