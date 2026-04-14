// ─── 経理モジュール：自動カテゴリ化エンジン ───
// 銀行CSVの摘要から、過去の入力履歴を学習して勘定科目・施設名を自動推定する
// 共有DB接続（sql.js or PostgreSQL）を使用する async版

const { query, run } = require('../db');

function normalize(s) {
  if (!s) return '';
  return String(s).trim().replace(/\s+/g, ' ');
}

/**
 * 摘要から安定するパターン部分を抽出
 *  "ガス料 2512317178341623020" → "ガス料"
 *  "ﾍﾟｲｵﾆｱ ｼﾞﾔﾊﾟﾝ(ｶ 4366185352339057" → "ﾍﾟｲｵﾆｱ ｼﾞﾔﾊﾟﾝ(ｶ"
 *  "中国電力(401)" → "中国電力(401)" (変化なし)
 */
function extractPattern(desc) {
  if (!desc) return '';
  let s = normalize(desc);
  const stripped = s.replace(/\s+\d{4,}.*$/, '').trim();
  if (stripped.length < 3) return s;
  return stripped;
}

/**
 * 単一の摘要に対して自動カテゴリ化を実行
 */
async function autoCategorize(description, account = '') {
  const desc = normalize(description);
  if (!desc) return { category: '', facility: '', vendor_name: '', confidence: 'none', ruleId: null };

  const pattern = extractPattern(desc);

  // Step 1: 完全一致（生の摘要 or 抽出パターン、口座固有を優先）
  let rows = await query(`
    SELECT * FROM keiri_category_rules
    WHERE (description_pattern = ? OR description_pattern = ?)
      AND (account = ? OR account = '')
    ORDER BY (CASE WHEN account = ? THEN 0 ELSE 1 END), priority DESC, match_count DESC
    LIMIT 1
  `, [desc, pattern, account, account]);

  if (rows.length > 0) {
    const r = rows[0];
    return {
      category: r.category || '',
      facility: r.facility || '',
      vendor_name: r.vendor_name || '',
      confidence: 'exact',
      ruleId: r.id,
    };
  }

  // Step 2: 前方一致（パターンが摘要の先頭に含まれる）
  rows = await query(`
    SELECT *, LENGTH(description_pattern) as plen FROM keiri_category_rules
    WHERE LENGTH(description_pattern) >= 3
      AND ? LIKE description_pattern || '%'
      AND (account = ? OR account = '')
    ORDER BY (CASE WHEN account = ? THEN 0 ELSE 1 END), plen DESC, priority DESC, match_count DESC
    LIMIT 1
  `, [desc, account, account]);

  if (rows.length > 0) {
    const r = rows[0];
    return {
      category: r.category || '',
      facility: r.facility || '',
      vendor_name: r.vendor_name || '',
      confidence: 'prefix',
      ruleId: r.id,
    };
  }

  // Step 3: 逆方向プレフィックス（ルールパターンが摘要より長い）
  rows = await query(`
    SELECT *, LENGTH(description_pattern) as plen FROM keiri_category_rules
    WHERE LENGTH(?) >= 3
      AND description_pattern LIKE ? || '%'
      AND (account = ? OR account = '')
    ORDER BY (CASE WHEN account = ? THEN 0 ELSE 1 END), plen DESC, priority DESC, match_count DESC
    LIMIT 1
  `, [desc, desc, account, account]);

  if (rows.length > 0) {
    const r = rows[0];
    return {
      category: r.category || '',
      facility: r.facility || '',
      vendor_name: r.vendor_name || '',
      confidence: 'partial',
      ruleId: r.id,
    };
  }

  return { category: '', facility: '', vendor_name: '', confidence: 'none', ruleId: null };
}

/**
 * 学習：摘要パターンに対するルールを作成または更新
 */
async function learnRule(description, account, category, facility, vendor_name) {
  const desc = normalize(description);
  if (!desc) return null;
  if (!category && !vendor_name) return null;

  const pattern = extractPattern(desc);

  const existing = await query(
    `SELECT * FROM keiri_category_rules WHERE description_pattern = ? AND account = ?`,
    [pattern, account || '']
  );

  if (existing.length > 0) {
    const e = existing[0];
    const newCategory = category || e.category;
    const newFacility = facility !== undefined ? (facility || e.facility || '') : e.facility;
    const newVendor = vendor_name !== undefined ? (vendor_name || e.vendor_name || '') : e.vendor_name;
    await run(`
      UPDATE keiri_category_rules
      SET category = ?, facility = ?, vendor_name = ?, match_count = match_count + 1,
          last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newCategory, newFacility, newVendor, e.id]);
    return e.id;
  } else {
    await run(`
      INSERT INTO keiri_category_rules (description_pattern, account, category, facility, vendor_name, match_count, last_used_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `, [pattern, account || '', category || '', facility || '', vendor_name || '']);
    const last = await query(
      `SELECT id FROM keiri_category_rules WHERE description_pattern = ? AND account = ?`,
      [pattern, account || '']
    );
    return last.length > 0 ? last[0].id : null;
  }
}

/**
 * 既存の keiri_bank_transactions から一括ルール学習
 */
async function bootstrapRules() {
  const rows = await query(`
    SELECT description, account, category, facility, vendor_name, COUNT(*) as cnt
    FROM keiri_bank_transactions
    WHERE description IS NOT NULL AND description != ''
      AND ((category != '' AND category IS NOT NULL) OR (vendor_name != '' AND vendor_name IS NOT NULL))
    GROUP BY description, account, category, facility, vendor_name
    ORDER BY cnt DESC
  `);

  let created = 0;
  let updated = 0;

  for (const r of rows) {
    const desc = normalize(r.description);
    if (!desc) continue;
    const pattern = extractPattern(desc);

    const existing = await query(
      `SELECT * FROM keiri_category_rules WHERE description_pattern = ? AND account = ?`,
      [pattern, r.account || '']
    );

    if (existing.length > 0) {
      const e = existing[0];
      const newCategory = r.category || e.category;
      const newFacility = r.facility || e.facility || '';
      const newVendor = r.vendor_name || e.vendor_name || '';
      await run(`
        UPDATE keiri_category_rules
        SET category = ?, facility = ?, vendor_name = ?, match_count = match_count + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [newCategory, newFacility, newVendor, r.cnt, e.id]);
      updated++;
    } else {
      await run(`
        INSERT INTO keiri_category_rules (description_pattern, account, category, facility, vendor_name, match_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [pattern, r.account || '', r.category || '', r.facility || '', r.vendor_name || '', r.cnt]);
      created++;
    }
  }

  return { created, updated };
}

module.exports = {
  autoCategorize,
  learnRule,
  bootstrapRules,
  normalize,
  extractPattern,
};
