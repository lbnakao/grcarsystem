const express = require('express');
const { query, run } = require('../db');
const router = express.Router();

// リクエストから対象グループコードを解決
// - 管理者 or 横断許可ユーザー(cross_group): ?group=gr|akiota で切替可
// - 一般: 常にセッションのグループ
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

// 車両一覧取得（グループフィルタ付き）
router.get('/', async (req, res) => {
  try {
    const code = resolveGroupCode(req);
    const gid = await getGroupIdByCode(code);
    if (!gid) return res.json([]);

    const rows = await query(
      `SELECT id, name, model, capacity, current_location, is_active, group_id, created_at
       FROM cars
       WHERE group_id = ?
       ORDER BY id`,
      [gid]
    );
    res.json(rows);
  } catch (e) {
    console.error('車両一覧エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 車両詳細取得
router.get('/:id', async (req, res) => {
  try {
    const rows = await query(
      "SELECT id, name, model, capacity, current_location, is_active, group_id FROM cars WHERE id = ?",
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '車両が見つかりません' });
    }
    const car = rows[0];
    // 一般ユーザーは自分のグループ以外の車両にアクセス不可（横断許可ユーザーは除く）
    const canCross = req.session.user.role === 'admin' || req.session.user.cross_group;
    if (!canCross && car.group_id !== req.session.user.group_id) {
      return res.status(403).json({ error: 'アクセス権限がありません' });
    }
    res.json(car);
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

    const { name, model, capacity, current_location, group_id } = req.body;

    if (!name || !model || !capacity) {
      return res.status(400).json({ error: '車両名、車種、積載人数は必須です' });
    }

    await run(
      "INSERT INTO cars (name, model, capacity, current_location, group_id) VALUES (?, ?, ?, ?, ?)",
      [name, model, parseInt(capacity), current_location || '本社駐車場', parseInt(group_id) || 1]
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

    const { name, model, capacity, current_location, is_active, group_id } = req.body;
    const gid = parseInt(group_id) || 1;

    await run(
      "UPDATE cars SET name = ?, model = ?, capacity = ?, current_location = ?, is_active = ?, group_id = ? WHERE id = ?",
      [name, model, parseInt(capacity), current_location, is_active ? 1 : 0, gid, req.params.id]
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
