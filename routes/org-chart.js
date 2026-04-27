// ============================================================================
// 組織体制図ハブ 編集差分 API
// マウントポイント: /api/org-chart/*
// テーブル: org_chart_edits
// 認証: なし（既存 /keiri/ と同じ静的扱い）
// ============================================================================
const express = require('express');
const { query, run, runInsert } = require('../db');

const router = express.Router();

const VALID_PANELS = new Set(['overview', 'facility', 'crossfunc', 'actions']);

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

// GET /api/org-chart?panel=overview
//   → { nodes: { ceo: {x,y,title,...}, ... }, stickies: [{id, x, y, text, ...}, ...] }
router.get('/', async (req, res) => {
  const panel = String(req.query.panel || '');
  if (!VALID_PANELS.has(panel)) return badRequest(res, 'invalid panel');
  try {
    const rows = await query(
      "SELECT id, kind, node_id, data FROM org_chart_edits WHERE panel = ?",
      [panel]
    );
    const nodes = {};
    const stickies = [];
    for (const r of rows) {
      let data; try { data = JSON.parse(r.data); } catch { data = {}; }
      if (r.kind === 'node' && r.node_id) {
        nodes[r.node_id] = data;
      } else if (r.kind === 'sticky') {
        stickies.push({ id: r.id, ...data });
      }
    }
    res.json({ nodes, stickies });
  } catch (e) {
    console.error('org-chart GET error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /api/org-chart/node
//   body: { panel, node_id, data }
//   既存の (panel, node_id) があれば上書き、無ければ insert
router.put('/node', async (req, res) => {
  const { panel, node_id } = req.body || {};
  const data = req.body && req.body.data;
  if (!VALID_PANELS.has(panel)) return badRequest(res, 'invalid panel');
  if (!node_id || typeof node_id !== 'string') return badRequest(res, 'invalid node_id');
  if (!data || typeof data !== 'object') return badRequest(res, 'invalid data');
  try {
    const existing = await query(
      "SELECT id FROM org_chart_edits WHERE panel = ? AND kind = 'node' AND node_id = ?",
      [panel, node_id]
    );
    const json = JSON.stringify(data);
    if (existing.length > 0) {
      await run(
        "UPDATE org_chart_edits SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [json, existing[0].id]
      );
    } else {
      await run(
        "INSERT INTO org_chart_edits (panel, kind, node_id, data) VALUES (?, 'node', ?, ?)",
        [panel, node_id, json]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('org-chart PUT node error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /api/org-chart/node?panel=X&node_id=Y
//   ノード差分をリセット（元位置に戻す）
router.delete('/node', async (req, res) => {
  const panel = String(req.query.panel || '');
  const node_id = String(req.query.node_id || '');
  if (!VALID_PANELS.has(panel)) return badRequest(res, 'invalid panel');
  if (!node_id) return badRequest(res, 'invalid node_id');
  try {
    await run(
      "DELETE FROM org_chart_edits WHERE panel = ? AND kind = 'node' AND node_id = ?",
      [panel, node_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('org-chart DELETE node error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/org-chart/sticky
//   body: { panel, data: {x, y, w?, text, color?} }
//   → { id }
router.post('/sticky', async (req, res) => {
  const { panel } = req.body || {};
  const data = req.body && req.body.data;
  if (!VALID_PANELS.has(panel)) return badRequest(res, 'invalid panel');
  if (!data || typeof data !== 'object') return badRequest(res, 'invalid data');
  try {
    const id = await runInsert(
      "INSERT INTO org_chart_edits (panel, kind, node_id, data) VALUES (?, 'sticky', NULL, ?)",
      [panel, JSON.stringify(data)]
    );
    res.json({ id });
  } catch (e) {
    console.error('org-chart POST sticky error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /api/org-chart/sticky/:id
router.put('/sticky/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const data = req.body && req.body.data;
  if (!Number.isFinite(id)) return badRequest(res, 'invalid id');
  if (!data || typeof data !== 'object') return badRequest(res, 'invalid data');
  try {
    await run(
      "UPDATE org_chart_edits SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kind = 'sticky'",
      [JSON.stringify(data), id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('org-chart PUT sticky error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /api/org-chart/sticky/:id
router.delete('/sticky/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return badRequest(res, 'invalid id');
  try {
    await run(
      "DELETE FROM org_chart_edits WHERE id = ? AND kind = 'sticky'",
      [id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('org-chart DELETE sticky error', e);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
