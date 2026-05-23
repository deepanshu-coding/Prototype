/**
 * CORA — Cloudflare Worker
 * Serves the CORA HTML app and exposes a D1-backed REST API
 * for persistent ledger storage across sessions.
 *
 * Routes:
 *   GET  /           → serve index.html
 *   GET  /api/ledger → fetch all ledger entries
 *   POST /api/ledger → append a new entry
 *   DELETE /api/ledger → wipe the ledger
 */

import HTML from './index.html';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ── Static app ────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // ── API ───────────────────────────────────────────────────
    if (pathname === '/api/ledger') {
      // Ensure table exists (idempotent)
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          seq       INTEGER NOT NULL,
          ts        TEXT    NOT NULL,
          action    TEXT    NOT NULL,
          target    TEXT    NOT NULL,
          confidence INTEGER NOT NULL,
          tampered  INTEGER NOT NULL DEFAULT 0,
          prev_hash TEXT    NOT NULL,
          curr_hash TEXT    NOT NULL,
          action_sig TEXT   NOT NULL,
          reasoning TEXT    NOT NULL
        )
      `);

      // GET — return all rows ordered by seq
      if (request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM ledger ORDER BY seq ASC'
        ).all();
        const entries = results.map(row => ({
          seq:           row.seq,
          timestamp:     row.ts,
          tampered:      row.tampered === 1,
          prevHash:      row.prev_hash,
          currentHash:   row.curr_hash,
          actionSignature: row.action_sig,
          scenario: {
            action:     row.action,
            target:     row.target,
            confidence: row.confidence,
            reasoning:  JSON.parse(row.reasoning),
            // reconstruct fields used by the frontend
            name:       row.action,
            desc:       '',
            alert:      '',
          },
        }));
        return json({ ok: true, entries });
      }

      // POST — insert a single entry
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch {
          return json({ ok: false, error: 'Invalid JSON' }, 400);
        }
        const { seq, timestamp, tampered, prevHash, currentHash,
                actionSignature, scenario } = body;

        if (!seq || !timestamp || !scenario) {
          return json({ ok: false, error: 'Missing required fields' }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO ledger
            (seq, ts, action, target, confidence, tampered,
             prev_hash, curr_hash, action_sig, reasoning)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          seq,
          timestamp,
          scenario.action,
          scenario.target,
          scenario.confidence,
          tampered ? 1 : 0,
          prevHash   || 'GENESIS',
          currentHash,
          actionSignature,
          JSON.stringify(scenario.reasoning)
        ).run();

        return json({ ok: true, seq });
      }

      // DELETE — clear all entries
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM ledger').run();
        return json({ ok: true });
      }

      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return new Response('Not found', { status: 404 });
  },
};
