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

// 終了時間を過ぎた予約を自動完了にし、車両の現在地を返却場所に更新
async function autoCompleteExpired() {
  const now = nowJST();
  const expired = await query(
    "SELECT id, car_id, return_location FROM reservations WHERE status = 'active' AND end_datetime <= ?",
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

    let sql = `
      SELECT r.id, r.car_id, r.user_id, r.start_datetime, r.end_datetime,
             r.departure_location, r.return_location, r.status, r.notes, r.created_at,
             c.name as car_name, c.model as car_model,
             u.name as user_name, u.employee_id
      FROM reservations r
      JOIN cars c ON r.car_id = c.id
      JOIN users u ON r.user_id = u.id
      WHERE r.status != 'cancelled'
    `;
    const params = [];

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

    // 重複チェック
    const conflict = await query(`
      SELECT id FROM reservations
      WHERE car_id = ? AND status = 'active'
      AND start_datetime < ? AND end_datetime > ?
    `, [parseInt(car_id), end_datetime, start_datetime]);

    if (conflict.length > 0) {
      return res.status(400).json({ error: 'この時間帯は既に予約が入っています' });
    }

    await run(
      `INSERT INTO reservations (car_id, user_id, start_datetime, end_datetime, departure_location, return_location, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [parseInt(car_id), req.session.user.id, start_datetime, end_datetime, departure_location, return_location, notes || '']
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

// 予約キャンセル
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

// 車両ステータス一括取得（現在の使用者＋次回予約）
router.get('/status/all', async (_req, res) => {
  try {
    await autoCompleteExpired();
    const now = nowJST();
    const nowPlus10 = nowJSTPlus10();

    // 現在使用中（10分前から使用中扱い）
    const currentRows = await query(`
      SELECT r.car_id, r.start_datetime, r.end_datetime,
             r.departure_location, r.return_location,
             u.name as user_name, u.employee_id
      FROM reservations r
      JOIN users u ON r.user_id = u.id
      WHERE r.status = 'active'
      AND r.start_datetime <= ? AND r.end_datetime > ?
      ORDER BY r.start_datetime
    `, [nowPlus10, now]);

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
      WHERE r.status = 'active'
      AND r.start_datetime > ?
      ORDER BY r.start_datetime
    `, [nowPlus10]);

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

module.exports = router;
