const express = require('express');
const bcrypt = require('bcryptjs');
const { query, run } = require('../db');
const router = express.Router();

// ログイン
router.post('/login', async (req, res) => {
  try {
    const { employee_id, password } = req.body;

    if (!employee_id || !password) {
      return res.status(400).json({ error: '社員番号とパスワードを入力してください' });
    }

    const rows = await query(
      "SELECT id, employee_id, password, name, role FROM users WHERE employee_id = ?",
      [employee_id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: '社員番号またはパスワードが正しくありません' });
    }

    const user = rows[0];

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: '社員番号またはパスワードが正しくありません' });
    }

    req.session.user = {
      id: user.id,
      employee_id: user.employee_id,
      name: user.name,
      role: user.role
    };

    res.json({ message: 'ログイン成功', user: req.session.user });
  } catch (e) {
    console.error('ログインエラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ログアウト
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'ログアウトしました' });
});

// 現在のユーザー情報
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  res.status(401).json({ error: '未ログイン' });
});

// ユーザー登録（管理者のみ）
router.post('/register', async (req, res) => {
  try {
    if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '管理者権限が必要です' });
    }

    const { employee_id, password, name, role } = req.body;

    if (!employee_id || !password || !name) {
      return res.status(400).json({ error: '必須項目を入力してください' });
    }

    const existing = await query("SELECT id FROM users WHERE employee_id = ?", [employee_id]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'この社員番号は既に登録されています' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    await run(
      "INSERT INTO users (employee_id, password, name, role) VALUES (?, ?, ?, ?)",
      [employee_id, hashedPassword, name, role || 'user']
    );

    res.json({ message: 'ユーザーを登録しました' });
  } catch (e) {
    console.error('ユーザー登録エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ユーザー一覧（管理者のみ）
router.get('/users', async (req, res) => {
  try {
    if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: '管理者権限が必要です' });
    }

    const rows = await query("SELECT id, employee_id, name, role, created_at FROM users ORDER BY id");
    res.json(rows);
  } catch (e) {
    console.error('ユーザー一覧エラー:', e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

module.exports = router;
