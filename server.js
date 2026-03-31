const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./db');

const authRoutes = require('./routes/auth');
const carsRoutes = require('./routes/cars');
const reservationsRoutes = require('./routes/reservations');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;

// Render等のリバースプロキシ対応
if (isProduction) {
  app.set('trust proxy', 1);
}

// ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'gr-car-management-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// 静的ファイル
app.use(express.static(path.join(__dirname, 'public')));

// 認証ミドルウェア
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.status(401).json({ error: 'ログインが必要です' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ error: '管理者権限が必要です' });
}

// APIルート
app.use('/api/auth', authRoutes);
app.use('/api/cars', requireAuth, carsRoutes);
app.use('/api/reservations', requireAuth, reservationsRoutes);

// 管理者専用ルート
app.use('/api/admin/cars', requireAuth, requireAdmin, carsRoutes);

// ページルーティング
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// サーバー起動
async function start() {
  await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`社用車管理システム起動: http://localhost:${PORT}`);
    console.log(`管理者ログイン: 社員番号 admin / パスワード admin123`);
    console.log(`サンプルユーザー: 社員番号 1001 / パスワード pass1001`);
  });
}

start().catch(err => {
  console.error('起動エラー:', err);
  process.exit(1);
});
