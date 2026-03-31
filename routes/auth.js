const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, saveDatabase } = require('../db');
const router = express.Router();

// ログイン
router.post('/login', (req, res) => {
  const { employee_id, password } = req.body;

  if (!employee_id || !password) {
    return res.status(400).json({ error: '社員番号とパスワードを入力してください' });
  }

  const db = getDb();
  const result = db.exec(
    "SELECT id, employee_id, password, name, role FROM users WHERE employee_id = ?",
    [employee_id]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    return res.status(401).json({ error: '社員番号またはパスワードが正しくありません' });
  }

  const row = result[0].values[0];
  const user = {
    id: row[0],
    employee_id: row[1],
    password: row[2],
    name: row[3],
    role: row[4]
  };

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '社員番号またはパスワードが正しくありません' });
  }

  req.session.user = {
    id: user.id,
    employee_id: user.employee_id,
    name: user.name,
    role: user.role
  };

  res.json({
    message: 'ログイン成功',
    user: req.session.user
  });
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
router.post('/register', (req, res) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }

  const { employee_id, password, name, role } = req.body;

  if (!employee_id || !password || !name) {
    return res.status(400).json({ error: '必須項目を入力してください' });
  }

  const db = getDb();
  const existing = db.exec("SELECT id FROM users WHERE employee_id = ?", [employee_id]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    return res.status(400).json({ error: 'この社員番号は既に登録されています' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  db.run(
    "INSERT INTO users (employee_id, password, name, role) VALUES (?, ?, ?, ?)",
    [employee_id, hashedPassword, name, role || 'user']
  );
  saveDatabase();

  res.json({ message: 'ユーザーを登録しました' });
});

// ユーザー一覧（管理者のみ）
router.get('/users', (req, res) => {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }

  const db = getDb();
  const result = db.exec("SELECT id, employee_id, name, role, created_at FROM users ORDER BY id");

  if (result.length === 0) return res.json([]);

  const users = result[0].values.map(row => ({
    id: row[0],
    employee_id: row[1],
    name: row[2],
    role: row[3],
    created_at: row[4]
  }));

  res.json(users);
});

module.exports = router;
