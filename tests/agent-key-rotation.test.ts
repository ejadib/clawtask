import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/v1/agents/[id]/rotate-key/route';
import { resolveActor } from '../src/lib/auth';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtask-rotate-key-'));
const db = new Database(path.join(root, 'test.db'));

before(() => {
  db.exec(fs.readFileSync(path.resolve('src/db/schema.sql'), 'utf8'));
  db.prepare('INSERT INTO agents (id, openclawAgentId, displayName, apiKeyHash, apiKey) VALUES (?, ?, ?, ?, ?)')
    .run('agent-1', 'main', 'Main', 'old-hash', 'old-key');
  globalThis.__clawtask_db = db;
});

after(() => {
  globalThis.__clawtask_db = undefined;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('rotating an agent key replaces the stored key/hash and returns the key once', async () => {
  const res = await POST(new NextRequest('http://localhost/api/v1/agents/agent-1/rotate-key', { method: 'POST' }), { params: Promise.resolve({ id: 'agent-1' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.id, 'agent-1');
  assert.match(body.data.apiKey, /^[a-f0-9]{64}$/);
  const stored = db.prepare('SELECT apiKey, apiKeyHash FROM agents WHERE id = ?').get('agent-1') as any;
  assert.equal(stored.apiKey, body.data.apiKey);
  assert.notEqual(stored.apiKeyHash, 'old-hash');
  const actor = await resolveActor(new NextRequest('http://localhost', { headers: { Authorization: `Bearer ${body.data.apiKey}` } }));
  assert.deepEqual(actor, { actorId: 'agent-1', actorType: 'agent' });
});

test('rotating a missing agent returns not found', async () => {
  const res = await POST(new NextRequest('http://localhost/api/v1/agents/missing/rotate-key', { method: 'POST' }), { params: Promise.resolve({ id: 'missing' }) });
  assert.equal(res.status, 404);
});
