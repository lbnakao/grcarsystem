const express = require('express');
const { getDb, saveDatabase } = require('../db');
const router = express.Router();

// 車両一覧取得
router.get('/', (req, res) => {
  const db = getDb();
  const result = db.exec("SELECT id, name, model, capacity, current_location, is_active, created_at FROM cars ORDER BY id");

  if (result.length === 0) return res.json([]);

  const cars = result[0].values.map(row => ({
    id: row[0],
    name: row[1],
    model: row[2],
    capacity: row[3],
    current_location: row[4],
    is_active: row[5],
    created_at: row[6]
  }));

  res.json(cars);
});

// 車両詳細取得
router.get('/:id', (req, res) => {
  const db = getDb();
  const result = db.exec("SELECT id, name, model, capacity, current_location, is_active FROM cars WHERE id = ?", [req.params.id]);

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(404).json({ error: '車両が見つかりません' });
  }

  const row = result[0].values[0];
  res.json({
    id: row[0],
    name: row[1],
    model: row[2],
    capacity: row[3],
    current_location: row[4],
    is_active: row[5]
  });
});

// 車両新規作成（管理者のみ）
router.post('/', (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }

  const { name, model, capacity, current_location } = req.body;

  if (!name || !model || !capacity) {
    return res.status(400).json({ error: '車両名、車種、積載人数は必須です' });
  }

  const db = getDb();
  db.run(
    "INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
    [name, model, parseInt(capacity), current_location || '本社駐車場']
  );
  saveDatabase();

  res.json({ message: '車両を登録しました' });
});

// 車両更新（管理者のみ）
router.put('/:id', (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }

  const { name, model, capacity, current_location, is_active } = req.body;
  const db = getDb();

  db.run(
    "UPDATE cars SET name = ?, model = ?, capacity = ?, current_location = ?, is_active = ? WHERE id = ?",
    [name, model, parseInt(capacity), current_location, is_active ? 1 : 0, req.params.id]
  );
  saveDatabase();

  res.json({ message: '車両情報を更新しました' });
});

// 車両削除（管理者のみ）
router.delete('/:id', (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }

  const db = getDb();
  db.run("UPDATE cars SET is_active = 0 WHERE id = ?", [req.params.id]);
  saveDatabase();

  res.json({ message: '車両を無効化しました' });
});

module.exports = router;
