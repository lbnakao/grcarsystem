const express = require('express');
const { query, run } = require('../db');
const router = express.Router();

// JST現在時刻を取得（Renderサーバーがutcのため）
function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function nowJSTPlus10() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString().slice(0, 16);
}

// 対象グループを解決（管理者 or 横断許可ユーザーは?group=で切替可）
function resolveGroupCode(req) {
  const canCross = req.session.user.role === 'admin' || req.session.user.cross_group;
  if (canCross && req.query.group) {
    return req.query.group;
  }
  return req.session.user.group_code;
}

async function getGroupIdByCode(code) {
  const rows = await query("SELECT id FROM groups WHERE code = ?", [code]);
  return rows.length > 0 ? rows[0].id : null;
}

// 終了時間を過ぎた予約を自動完了にし、車両の現在地を返却場所に更新
// ただし安芸太田町組は完了ボタン必須のため自動完了しない
async function autoCompleteExpired() {
  const now = nowJST();
  const expired = await query(
    `SELECT r.id, r.car_id, r.return_location
     FROM reservations r
     JOIN cars c ON r.car_id = c.id
     JOIN groups g ON c.group_id = g.id
     WHERE r.status = 'active' AND r.end_datetime <= ? AND g.code = 'gr'`,
    [now]
  );
  for (const r of expired) {
    await run("UPDATE reservations SET status = 'completed' WHERE id = ?", [r.id]);
    await run("UPDATE cars SET current_location = ? WHERE id = ?", [r.return_location, r.car_id]);
  }
}

// 予約一覧（カレンダー用）
router.get('/', async (req, res) => {
  await autoCompleteExpired();
  try {
    const { start, end, car_id } = req.query;
    const code = resolveGroupCode(req);
    const gid = await getGroupIdByCode(code);
    if (!gid) return res.json([]);

    let sql = `
      SELECT r.id, r.car_id, r.user_id, r.start_datetime, r.end_datetime,
             r.departure_location, r.return_location, r.status, r.notes, r.created_at,
             r.start_odometer, r.end_odometer, r.distance_used, r.purpose, r.completed_at,
             c.name as car_name, c.model as car_model, c.group_id,
             u.name as user_name, u.employee_id
      FROM reservations r
      JOIN cars c ON r.car_id = c.id
      JOIN users u ON r.user_id = u.id
      WHERE r.status != 'cancelled'
      AND c.group_id = ?
    `;
    const params = [gid];

    if (start) {
      sql += " AND r.end_datetime >= ?";
      params.push(start);
    }
    if (end) {
      sql += " AND r.start_datetime <= ?";
      params.push(end);
    }
    if (car_id) {
      sql += " AND r.car_id = ?";
      params.push(parseInt(car_id));
    }

    sql += " ORDER BY r.start_datetime";

    const rows = await query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('予約一覧エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 予約作成
router.post('/', async (req, res) => {
  try {
    const { car_id, start_datetime, end_datetime, departure_location, return_location, notes } = req.body;

    if (!car_id || !start_datetime || !end_datetime || !departure_location || !return_location) {
      return res.status(400).json({ error: '必須項目を入力してください' });
    }

    if (new Date(start_datetime) >= new Date(end_datetime)) {
      return res.status(400).json({ error: '終了時間は開始時間より後にしてください' });
    }

    // 車両のグループを確認し、一般ユーザーは自グループのみ予約可（横断許可ユーザーは除く）
    const carRows = await query("SELECT group_id FROM cars WHERE id = ?", [parseInt(car_id)]);
    if (carRows.length === 0) {
      return res.status(404).json({ error: '車両が見つかりません' });
    }
    const canCross = req.session.user.role === 'admin' || req.session.user.cross_group;
    if (!canCross && carRows[0].group_id !== req.session.user.group_id) {
      return res.status(403).json({ error: 'この車両は予約できません' });
    }

    // 重複チェック
    const conflict = await query(`
      SELECT id FROM reservations
      WHERE car_id = ? AND status = 'active'
      AND start_datetime < ? AND end_datetime > ?
    `, [parseInt(car_id), end_datetime, start_datetime]);

    if (conflict.length > 0) {
      return res.status(400).json({ error: 'この時間帯は既に予約が入っています' });
    }

    // 前回の帰着距離を取得して出庫距離として引用
    const lastCompleted = await query(`
      SELECT end_odometer FROM reservations
      WHERE car_id = ? AND status = 'completed' AND end_odometer IS NOT NULL
      ORDER BY completed_at DESC, end_datetime DESC
      LIMIT 1
    `, [parseInt(car_id)]);
    const startOdo = lastCompleted.length > 0 && lastCompleted[0].end_odometer != null
      ? lastCompleted[0].end_odometer
      : 0;

    await run(
      `INSERT INTO reservations (car_id, user_id, start_datetime, end_datetime,
        departure_location, return_location, notes, start_odometer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [parseInt(car_id), req.session.user.id, start_datetime, end_datetime,
       departure_location, return_location, notes || '', startOdo]
    );

    // 車両の現在地を更新
    await run("UPDATE cars SET current_location = ? WHERE id = ?", [departure_location, parseInt(car_id)]);

    res.json({ message: '予約を作成しました' });
  } catch (e) {
    console.error('予約作成エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 予約更新
router.put('/:id', async (req, res) => {
  try {
    const { car_id, start_datetime, end_datetime, departure_location, return_location, notes, status } = req.body;

    // 自分の予約か管理者か確認
    const existing = await query("SELECT user_id FROM reservations WHERE id = ?", [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: '予約が見つかりません' });
    }

    const ownerId = existing[0].user_id;
    if (ownerId !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '自分の予約のみ編集できます' });
    }

    if (status === 'completed') {
      await run("UPDATE reservations SET status = 'completed' WHERE id = ?", [req.params.id]);
      if (return_location) {
        await run("UPDATE cars SET current_location = ? WHERE id = ?", [return_location, parseInt(car_id)]);
      }
    } else if (status === 'cancelled') {
      await run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    } else {
      // 重複チェック（自分自身の予約は除外）
      const conflict = await query(`
        SELECT id FROM reservations
        WHERE car_id = ? AND status = 'active' AND id != ?
        AND start_datetime < ? AND end_datetime > ?
      `, [parseInt(car_id), parseInt(req.params.id), end_datetime, start_datetime]);

      if (conflict.length > 0) {
        return res.status(400).json({ error: 'この時間帯は既に予約が入っています' });
      }

      await run(
        `UPDATE reservations SET car_id = ?, start_datetime = ?, end_datetime = ?,
         departure_location = ?, return_location = ?, notes = ? WHERE id = ?`,
        [parseInt(car_id), start_datetime, end_datetime, departure_location, return_location, notes || '', req.params.id]
      );
    }

    res.json({ message: '予約を更新しました' });
  } catch (e) {
    console.error('予約更新エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 予約完了（安芸太田町組用：完了ボタン押下）
// 帰着時間は押下時刻、帰着距離・行先/使用目的を記録
router.post('/:id/complete', async (req, res) => {
  try {
    const { start_odometer, end_odometer, purpose } = req.body;

    const existing = await query(
      `SELECT r.id, r.user_id, r.car_id, r.return_location, r.start_odometer, r.status
       FROM reservations r WHERE r.id = ?`,
      [req.params.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: '予約が見つかりません' });
    }
    const resv = existing[0];

    if (resv.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '自分の予約のみ完了できます' });
    }

    if (resv.status !== 'active') {
      return res.status(400).json({ error: 'この予約は既に完了またはキャンセル済みです' });
    }

    if (end_odometer == null || end_odometer === '') {
      return res.status(400).json({ error: '帰着時の積算距離を入力してください' });
    }

    const endOdo = parseFloat(end_odometer);
    const startOdo = start_odometer != null && start_odometer !== ''
      ? parseFloat(start_odometer)
      : (resv.start_odometer != null ? parseFloat(resv.start_odometer) : 0);

    if (isNaN(endOdo) || endOdo < 0) {
      return res.status(400).json({ error: '帰着距離は有効な数値を入力してください' });
    }
    if (endOdo < startOdo) {
      return res.status(400).json({ error: '帰着距離は出庫距離以上にしてください' });
    }

    const distance = endOdo - startOdo;
    const completedAt = nowJST();

    // end_datetime は予約時の計画値のまま保持し、実際の帰着時刻は completed_at に記録
    await run(
      `UPDATE reservations SET status = 'completed',
         start_odometer = ?, end_odometer = ?, distance_used = ?,
         purpose = ?, completed_at = ?
       WHERE id = ?`,
      [startOdo, endOdo, distance, purpose || '', completedAt, req.params.id]
    );

    // 車両の現在地を返却場所に更新
    await run("UPDATE cars SET current_location = ? WHERE id = ?",
      [resv.return_location, resv.car_id]);

    res.json({ message: '使用を完了しました', distance_used: distance, completed_at: completedAt });
  } catch (e) {
    console.error('予約完了エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 予約キャンセル（ソフト：status='cancelled'）
router.delete('/:id', async (req, res) => {
  try {
    const existing = await query("SELECT user_id FROM reservations WHERE id = ?", [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: '予約が見つかりません' });
    }

    const ownerId = existing[0].user_id;
    if (ownerId !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '自分の予約のみキャンセルできます' });
    }

    await run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [req.params.id]);
    res.json({ message: '予約をキャンセルしました' });
  } catch (e) {
    console.error('予約キャンセルエラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 予約完全削除（DB行ごと削除。テストデータ整理用）
// - 自分の予約は誰でも削除可
// - 他人の予約は「管理者」または「安芸太田町組のリーダー(髙宮/社員番号101)」のみ削除可
router.delete('/:id/purge', async (req, res) => {
  try {
    const existing = await query("SELECT user_id FROM reservations WHERE id = ?", [req.params.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: '予約が見つかりません' });
    }

    const ownerId = existing[0].user_id;
    const u = req.session.user;
    const canDeleteOthers = u.role === 'admin' || u.employee_id === '101';

    if (ownerId !== u.id && !canDeleteOthers) {
      return res.status(403).json({ error: '自分が作成した予約のみ削除できます' });
    }

    await run("DELETE FROM reservations WHERE id = ?", [req.params.id]);
    res.json({ message: '予約を完全に削除しました' });
  } catch (e) {
    console.error('予約完全削除エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 車両ステータス一括取得（現在の使用者＋次回予約）
router.get('/status/all', async (req, res) => {
  try {
    await autoCompleteExpired();
    const now = nowJST();
    const nowPlus10 = nowJSTPlus10();

    const code = resolveGroupCode(req);
    const gid = await getGroupIdByCode(code);
    if (!gid) return res.json({ current: {}, next: {} });

    // 現在使用中（10分前から使用中扱い）
    const currentRows = await query(`
      SELECT r.car_id, r.start_datetime, r.end_datetime,
             r.departure_location, r.return_location,
             u.name as user_name, u.employee_id
      FROM reservations r
      JOIN users u ON r.user_id = u.id
      JOIN cars c ON r.car_id = c.id
      WHERE r.status = 'active'
      AND r.start_datetime <= ? AND r.end_datetime > ?
      AND c.group_id = ?
      ORDER BY r.start_datetime
    `, [nowPlus10, now, gid]);

    const currentMap = {};
    currentRows.forEach(row => {
      if (!currentMap[row.car_id]) {
        currentMap[row.car_id] = row;
      }
    });

    // 次回予約
    const nextRows = await query(`
      SELECT r.car_id, r.start_datetime, r.end_datetime,
             r.departure_location, r.return_location,
             u.name as user_name, u.employee_id
      FROM reservations r
      JOIN users u ON r.user_id = u.id
      JOIN cars c ON r.car_id = c.id
      WHERE r.status = 'active'
      AND r.start_datetime > ?
      AND c.group_id = ?
      ORDER BY r.start_datetime
    `, [nowPlus10, gid]);

    const nextMap = {};
    nextRows.forEach(row => {
      if (!nextMap[row.car_id]) {
        nextMap[row.car_id] = row;
      }
    });

    res.json({ current: currentMap, next: nextMap });
  } catch (e) {
    console.error('ステータスエラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 重複チェックAPI（フロント用）
router.get('/check-conflict', async (req, res) => {
  try {
    const { car_id, start, end, exclude_id } = req.query;
    if (!car_id || !start || !end) {
      return res.json({ conflict: false });
    }

    let sql = `
      SELECT r.id, r.start_datetime, r.end_datetime, u.name as user_name
      FROM reservations r
      JOIN users u ON r.user_id = u.id
      WHERE r.car_id = ? AND r.status = 'active'
      AND r.start_datetime < ? AND r.end_datetime > ?
    `;
    const params = [parseInt(car_id), end, start];

    if (exclude_id) {
      sql += " AND r.id != ?";
      params.push(parseInt(exclude_id));
    }

    const rows = await query(sql, params);
    if (rows.length > 0) {
      const r = rows[0];
      return res.json({
        conflict: true,
        message: `その時間帯は ${r.user_name} さんの予約が入っています（${r.start_datetime.slice(0,16)} ～ ${r.end_datetime.slice(0,16)}）`
      });
    }

    res.json({ conflict: false });
  } catch (e) {
    console.error('重複チェックエラー:', e);
    res.json({ conflict: false });
  }
});

// 直前の予約の返却場所を取得（場所不一致チェック用）
router.get('/last-return', async (req, res) => {
  try {
    const { car_id, before } = req.query;
    if (!car_id || !before) {
      return res.json({ return_location: null });
    }

    const rows = await query(`
      SELECT r.return_location, u.name as user_name, r.end_datetime
      FROM reservations r
      JOIN users u ON r.user_id = u.id
      WHERE r.car_id = ? AND r.status = 'active'
      AND r.end_datetime <= ?
      ORDER BY r.end_datetime DESC
      LIMIT 1
    `, [parseInt(car_id), before]);

    if (rows.length > 0) {
      return res.json(rows[0]);
    }

    res.json({ return_location: null });
  } catch (e) {
    console.error('返却場所取得エラー:', e);
    res.json({ return_location: null });
  }
});

// ログイン時の完了リマインダー用:
// ログインユーザーが持つ安芸太田町組のactive予約で、
// 現在「使用中（start以降）」または「終了時刻超過」のものを返す
router.get('/pending-complete', async (req, res) => {
  try {
    const now = nowJST();
    const rows = await query(`
      SELECT r.id, r.car_id, r.start_datetime, r.end_datetime,
             r.departure_location, r.return_location, r.start_odometer,
             c.name as car_name, c.model as car_model
      FROM reservations r
      JOIN cars c ON r.car_id = c.id
      JOIN groups g ON c.group_id = g.id
      WHERE r.status = 'active'
      AND r.user_id = ?
      AND g.code = 'akiota'
      AND r.start_datetime <= ?
      ORDER BY r.start_datetime
    `, [req.session.user.id, now]);

    const result = rows.map(r => ({
      ...r,
      overdue: r.end_datetime <= now,
      in_progress: r.start_datetime <= now && r.end_datetime > now
    }));

    res.json(result);
  } catch (e) {
    console.error('pending-completeエラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 運行記録簿: 車両別・月別の完了済予約一覧（安芸太田町組用）
router.get('/operation-log', async (req, res) => {
  try {
    const { car_id, year, month } = req.query;
    if (!car_id || !year || !month) {
      return res.status(400).json({ error: 'car_id, year, month は必須です' });
    }

    const yyyy = parseInt(year);
    const mm = parseInt(month);
    const monthStart = `${yyyy}-${String(mm).padStart(2, '0')}-01`;
    // 翌月1日
    const nextMonthDate = mm === 12
      ? `${yyyy + 1}-01-01`
      : `${yyyy}-${String(mm + 1).padStart(2, '0')}-01`;

    // 車両情報
    const carRows = await query(
      `SELECT c.id, c.name, c.model, c.capacity, c.current_location, c.group_id,
              g.code as group_code, g.name as group_name
       FROM cars c LEFT JOIN groups g ON c.group_id = g.id
       WHERE c.id = ?`,
      [parseInt(car_id)]
    );
    if (carRows.length === 0) {
      return res.status(404).json({ error: '車両が見つかりません' });
    }
    const car = carRows[0];

    // 一般ユーザーは自グループのみ
    if (req.session.user.role !== 'admin' && car.group_id !== req.session.user.group_id) {
      return res.status(403).json({ error: 'アクセス権限がありません' });
    }

    // 完了済予約（start_datetimeが対象月）
    const rows = await query(
      `SELECT r.id, r.start_datetime, r.end_datetime, r.completed_at,
              r.departure_location, r.return_location,
              r.start_odometer, r.end_odometer, r.distance_used, r.purpose,
              u.name as user_name, u.employee_id
       FROM reservations r
       JOIN users u ON r.user_id = u.id
       WHERE r.car_id = ?
       AND r.status = 'completed'
       AND r.start_datetime >= ?
       AND r.start_datetime < ?
       ORDER BY r.start_datetime`,
      [parseInt(car_id), monthStart, nextMonthDate]
    );

    res.json({ car, year: yyyy, month: mm, records: rows });
  } catch (e) {
    console.error('運行記録簿エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
