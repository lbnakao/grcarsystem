const express = require('express');
const { getDb, saveDatabase } = require('../db');
const router = express.Router();

// 予約一覧（カレンダー用）
router.get('/', (req, res) => {
  const db = getDb();
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

  const result = db.exec(sql, params);
  if (result.length === 0) return res.json([]);

  const reservations = result[0].values.map(row => ({
    id: row[0],
    car_id: row[1],
    user_id: row[2],
    start_datetime: row[3],
    end_datetime: row[4],
    departure_location: row[5],
    return_location: row[6],
    status: row[7],
    notes: row[8],
    created_at: row[9],
    car_name: row[10],
    car_model: row[11],
    user_name: row[12],
    employee_id: row[13]
  }));

  res.json(reservations);
});

// 予約作成
router.post('/', (req, res) => {
  const { car_id, start_datetime, end_datetime, departure_location, return_location, notes } = req.body;

  if (!car_id || !start_datetime || !end_datetime || !departure_location || !return_location) {
    return res.status(400).json({ error: '必須項目を入力してください' });
  }

  if (new Date(start_datetime) >= new Date(end_datetime)) {
    return res.status(400).json({ error: '終了時間は開始時間より後にしてください' });
  }

  const db = getDb();

  // 重複チェック
  const conflict = db.exec(`
    SELECT id FROM reservations
    WHERE car_id = ? AND status = 'active'
    AND start_datetime < ? AND end_datetime > ?
  `, [parseInt(car_id), end_datetime, start_datetime]);

  if (conflict.length > 0 && conflict[0].values.length > 0) {
    return res.status(400).json({ error: 'この時間帯は既に予約が入っています' });
  }

  db.run(
    `INSERT INTO reservations (car_id, user_id, start_datetime, end_datetime, departure_location, return_location, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [parseInt(car_id), req.session.user.id, start_datetime, end_datetime, departure_location, return_location, notes || '']
  );

  // 車両の現在地を更新
  db.run("UPDATE cars SET current_location = ? WHERE id = ?", [departure_location, parseInt(car_id)]);
  saveDatabase();

  res.json({ message: '予約を作成しました' });
});

// 予約更新
router.put('/:id', (req, res) => {
  const { car_id, start_datetime, end_datetime, departure_location, return_location, notes, status } = req.body;
  const db = getDb();

  // 自分の予約か管理者か確認
  const existing = db.exec("SELECT user_id FROM reservations WHERE id = ?", [req.params.id]);
  if (existing.length === 0 || existing[0].values.length === 0) {
    return res.status(404).json({ error: '予約が見つかりません' });
  }

  const ownerId = existing[0].values[0][0];
  if (ownerId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '自分の予約のみ編集できます' });
  }

  if (status === 'completed') {
    // 返却完了時、車両の現在地を返却先に更新
    db.run("UPDATE reservations SET status = 'completed' WHERE id = ?", [req.params.id]);
    if (return_location) {
      db.run("UPDATE cars SET current_location = ? WHERE id = ?", [return_location, parseInt(car_id)]);
    }
  } else if (status === 'cancelled') {
    db.run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [req.params.id]);
  } else {
    // 重複チェック（自分自身の予約は除外）
    const conflict = db.exec(`
      SELECT id FROM reservations
      WHERE car_id = ? AND status = 'active' AND id != ?
      AND start_datetime < ? AND end_datetime > ?
    `, [parseInt(car_id), parseInt(req.params.id), end_datetime, start_datetime]);

    if (conflict.length > 0 && conflict[0].values.length > 0) {
      return res.status(400).json({ error: 'この時間帯は既に予約が入っています' });
    }

    db.run(
      `UPDATE reservations SET car_id = ?, start_datetime = ?, end_datetime = ?,
       departure_location = ?, return_location = ?, notes = ? WHERE id = ?`,
      [parseInt(car_id), start_datetime, end_datetime, departure_location, return_location, notes || '', req.params.id]
    );
  }

  saveDatabase();
  res.json({ message: '予約を更新しました' });
});

// 予約キャンセル
router.delete('/:id', (req, res) => {
  const db = getDb();

  const existing = db.exec("SELECT user_id FROM reservations WHERE id = ?", [req.params.id]);
  if (existing.length === 0 || existing[0].values.length === 0) {
    return res.status(404).json({ error: '予約が見つかりません' });
  }

  const ownerId = existing[0].values[0][0];
  if (ownerId !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '自分の予約のみキャンセルできます' });
  }

  db.run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [req.params.id]);
  saveDatabase();

  res.json({ message: '予約をキャンセルしました' });
});

// 車両ステータス一括取得（現在の使用者＋次回予約）
router.get('/status/all', (req, res) => {
  const db = getDb();
  const now = new Date().toISOString().slice(0, 16);
  // 10分後を「使用中」判定に使う
  const nowPlus10 = new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 16);

  // 現在使用中（10分前から使用中扱い）
  const currentResult = db.exec(`
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
  if (currentResult.length > 0) {
    currentResult[0].values.forEach(row => {
      if (!currentMap[row[0]]) {
        currentMap[row[0]] = {
          start_datetime: row[1],
          end_datetime: row[2],
          departure_location: row[3],
          return_location: row[4],
          user_name: row[5],
          employee_id: row[6]
        };
      }
    });
  }

  // 次回予約（現在時刻以降で最も近いもの）
  const nextResult = db.exec(`
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
  if (nextResult.length > 0) {
    nextResult[0].values.forEach(row => {
      if (!nextMap[row[0]]) {
        nextMap[row[0]] = {
          start_datetime: row[1],
          end_datetime: row[2],
          departure_location: row[3],
          return_location: row[4],
          user_name: row[5],
          employee_id: row[6]
        };
      }
    });
  }

  res.json({ current: currentMap, next: nextMap });
});

// 重複チェックAPI（フロント用）
router.get('/check-conflict', (req, res) => {
  const { car_id, start, end, exclude_id } = req.query;
  if (!car_id || !start || !end) {
    return res.json({ conflict: false });
  }

  const db = getDb();
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

  const result = db.exec(sql, params);
  if (result.length > 0 && result[0].values.length > 0) {
    const row = result[0].values[0];
    return res.json({
      conflict: true,
      message: `その時間帯は ${row[3]} さんの予約が入っています（${row[1].slice(0,16)} ～ ${row[2].slice(0,16)}）`
    });
  }

  res.json({ conflict: false });
});

// 直前の予約の返却場所を取得（場所不一致チェック用）
router.get('/last-return', (req, res) => {
  const { car_id, before } = req.query;
  if (!car_id || !before) {
    return res.json({ return_location: null });
  }

  const db = getDb();
  const result = db.exec(`
    SELECT r.return_location, u.name as user_name, r.end_datetime
    FROM reservations r
    JOIN users u ON r.user_id = u.id
    WHERE r.car_id = ? AND r.status = 'active'
    AND r.end_datetime <= ?
    ORDER BY r.end_datetime DESC
    LIMIT 1
  `, [parseInt(car_id), before]);

  if (result.length > 0 && result[0].values.length > 0) {
    const row = result[0].values[0];
    return res.json({
      return_location: row[0],
      user_name: row[1],
      end_datetime: row[2]
    });
  }

  res.json({ return_location: null });
});

module.exports = router;
