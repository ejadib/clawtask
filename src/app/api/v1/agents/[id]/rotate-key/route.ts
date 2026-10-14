import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getDb } from '@/db/db';
import { hashApiKey } from '@/lib/auth';
import { ok, err } from '@/lib/response';

// Returns the plaintext replacement only in this response. The database keeps
// a hash for authentication and the existing encrypted/local key field for the
// adapter's task prompt contract.
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const db = getDb();
  const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
  if (!agent) return err('NOT_FOUND', 'Agent not found', 404);

  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await hashApiKey(apiKey);
  db.prepare('UPDATE agents SET apiKey = ?, apiKeyHash = ? WHERE id = ?').run(apiKey, apiKeyHash, id);

  return ok({ id, apiKey });
}
