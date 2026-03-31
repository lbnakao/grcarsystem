const express = require('express');
const { query, run } = require('../db');
const router = express.Router();

// 車両一覧取得
router.get('/', async (req, res) => {
  try {
    const rows = await query("SELECT id, name, model, capacity, current_location, is_active, created_at FROM cars ORDER BY id");
    res.json(rows);
  } catch (e) {
    console.error('車両一覧エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 車両詳細取得
router.get('/:id', async (req, res) => {
  try {
    const rows = await query("SELECT id, name, model, capacity, current_location, is_active FROM cars WHERE id = ?", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: '車両が見つかりません' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('車両詳細エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 車両新規作成（管理者のみ）
router.post('/', async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '管理者権限が必要です' });
    }

    const { name, model, capacity, current_location } = req.body;

    if (!name || !model || !capacity) {
      return res.status(400).json({ error: '車両名、車種、積載人数は必須です' });
    }

    await run(
      "INSERT INTO cars (name, model, capacity, current_location) VALUES (?, ?, ?, ?)",
      [name, model, parseInt(capacity), current_location || '本社駐車場']
    );

    res.json({ message: '車両を登録しました' });
  } catch (e) {
    console.error('車両登録エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 車両更新（管理者のみ）
router.put('/:id', async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '管理者権限が必要です' });
    }

    const { name, model, capacity, current_location, is_active } = req.body;

    await run(
      "UPDATE cars SET name = ?, model = ?, capacity = ?, current_location = ?, is_active = ? WHERE id = ?",
      [name, model, parseInt(capacity), current_location, is_active ? 1 : 0, req.params.id]
    );

    res.json({ message: '車両情報を更新しました' });
  } catch (e) {
    console.error('車両更新エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 車両削除（管理者のみ）
router.delete('/:id', async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '管理者権限が必要です' });
    }

    await run("UPDATE cars SET is_active = 0 WHERE id = ?", [req.params.id]);
    res.json({ message: '車両を無効化しました' });
  } catch (e) {
    console.error('車両削除エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
