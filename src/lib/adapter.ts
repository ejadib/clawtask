/**
 * OpenClaw Adapter Service
 *
 * Manages persistent WebSocket connections to the OpenClaw gateway per agent.
 * Uses the real OpenClaw gateway protocol (req/res/event framing).
 *
 * Auth flow mirrors @paperclipai/adapter-openclaw-gateway:
 * - Ed25519 device keypair; deviceId = sha256(rawPublicKey).hex
 * - v3 pipe-delimited signing payload
 * - connect params include role + scopes at top level
 * - auto-pairing: on PAIRING_REQUIRED, connects with token only to approve, then retries
 * - agent.wait receives { runId, timeoutMs }
 * - agent event stream filters by runId + stream === 'assistant'
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '@/db/db';
import { broadcastSse } from './sse';
import { v4 as uuidv4 } from 'uuid';
import { logActivity } from './activity';
import { enrichTask } from './tasks';
import { parseAgentRunControl, stripAgentRunControl } from './agent-run-control';

// ─── Device identity ──────────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DEVICE_KEY_PATH = path.join(process.env.HOME || '~', '.clawtask', 'gateway-device-key.pem');

// Self-URL used in agent wake prompts. Set CLAWTASK_PUBLIC_URL in production.
// Defaults to localhost:3333 for local dev.
const CLAWTASK_SELF_URL = (process.env.CLAWTASK_PUBLIC_URL || '${CLAWTASK_SELF_URL}').replace(/\/$/, '');

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKey: crypto.KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

interface DeviceIdentity {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
}

function loadOrCreateDeviceIdentity(): DeviceIdentity {
  try {
    if (fs.existsSync(DEVICE_KEY_PATH)) {
      const privateKeyPem = fs.readFileSync(DEVICE_KEY_PATH, 'utf8');
      const privateKey = crypto.createPrivateKey(privateKeyPem);
      const publicKey = crypto.createPublicKey(privateKey);
      const raw = derivePublicKeyRaw(publicKey);
      return {
        deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
        publicKeyRawBase64Url: base64UrlEncode(raw),
        privateKeyPem,
      };
    }
  } catch {}

  // Generate new keypair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = derivePublicKeyRaw(publicKey);
  const identity: DeviceIdentity = {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem,
  };

  try {
    fs.mkdirSync(path.dirname(DEVICE_KEY_PATH), { recursive: true });
    fs.writeFileSync(DEVICE_KEY_PATH, privateKeyPem, { mode: 0o600 });
  } catch {}

  return identity;
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
}): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    process.platform,
    '', // deviceFamily
  ].join('|');
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

// ─── Gateway protocol types ───────────────────────────────────────────────────

interface GatewayReqFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

interface GatewayResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

interface GatewayEventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame;

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Agent connection state ───────────────────────────────────────────────────

interface AgentConnection {
  agentId: string;
  openclawAgentId: string;
  displayName: string;
  ws: WebSocket | null;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  currentTaskId: string | null;
  currentRunId: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  currentCommentId: string | null;
  currentCommentIds: string[];
  runOutput: string;
  pending: Map<string, PendingRequest>;
  handshakeDone: boolean;
  challengeNonce: string | null;
  challengeTs: number | null;
  autoPairAttempted: boolean;
}

const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const CLIENT_VERSION = 'clawtask';
const ROLE = 'operator';
const SCOPES = ['operator.admin'];
const GATEWAY_PROTOCOL_VERSION = 4;

// ─── Adapter service ──────────────────────────────────────────────────────────

class AdapterService {
  private connections = new Map<string, AgentConnection>();
  private gatewayUrl: string = 'ws://localhost:2222';
  private gatewayAuthToken: string = '';
  private deviceIdentity: DeviceIdentity | null = null;
  private initialized = false;

  constructor() {
    // Load config eagerly so probeAgent works before init() fires
    try {
      const db = getDb();
      const cfg = db.prepare("SELECT value FROM config WHERE key = 'gatewayUrl'").get() as { value: string } | undefined;
      if (cfg?.value) this.gatewayUrl = cfg.value;
      const authCfg = db.prepare("SELECT value FROM config WHERE key = 'gatewayAuthToken'").get() as { value: string } | undefined;
      if (authCfg?.value) this.gatewayAuthToken = authCfg.value;
      this.deviceIdentity = loadOrCreateDeviceIdentity();
    } catch {}
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const db = getDb();
      const cfg = db.prepare("SELECT value FROM config WHERE key = 'gatewayUrl'").get() as { value: string } | undefined;
      if (cfg?.value) this.gatewayUrl = cfg.value;

      const authCfg = db.prepare("SELECT value FROM config WHERE key = 'gatewayAuthToken'").get() as { value: string } | undefined;
      if (authCfg?.value) this.gatewayAuthToken = authCfg.value;

      this.deviceIdentity = loadOrCreateDeviceIdentity();

      // Connect all existing agents with probeStatus ok
      const agents = db.prepare("SELECT * FROM agents WHERE probeStatus = 'ok'").all() as any[];
      for (const agent of agents) {
        this.connectAgent(agent);
      }
    } catch {}
  }

  updateGatewayUrl(url: string) {
    this.gatewayUrl = url;
    try {
      const db = getDb();
      const authCfg = db.prepare("SELECT value FROM config WHERE key = 'gatewayAuthToken'").get() as { value: string } | undefined;
      if (authCfg?.value) this.gatewayAuthToken = authCfg.value;
    } catch {}
    for (const [agentId] of this.connections) {
      this.disconnectAgent(agentId);
      this.connectAgentById(agentId);
    }
  }

  // ─── Probe ────────────────────────────────────────────────────────────────

  async probeAgent(agent: { id: string; openclawAgentId: string; displayName: string }): Promise<{ ok: boolean; error?: string }> {
    // First probe on a cold Next.js route can miss the connect.challenge event
    // (gateway sends it before the compiled handler attaches the WS listener).
    // Retry once with a short delay if the connection closed before handshake.
    const result = await this._probeAgentOnce(agent);
    if (!result.ok && result.error?.includes('before handshake')) {
      await new Promise(r => setTimeout(r, 300));
      return this._probeAgentOnce(agent);
    }
    return result;
  }

  private async _probeAgentOnce(agent: { id: string; openclawAgentId: string; displayName: string }): Promise<{ ok: boolean; error?: string }> {
    const identity = this.deviceIdentity ?? loadOrCreateDeviceIdentity();

    return new Promise((resolve) => {
      const overallTimeout = setTimeout(() => resolve({ ok: false, error: 'Connection timeout' }), 10000);
      let done = false;
      const pending = new Map<string, PendingRequest>();

      const finish = (ok: boolean, error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(overallTimeout);
        for (const pr of pending.values()) { clearTimeout(pr.timer); pr.reject(new Error('probe aborted')); }
        try { ws.close(); } catch {}
        resolve({ ok, error });
      };

      const sendReq = (method: string, params?: unknown): Promise<unknown> => {
        return new Promise((res, rej) => {
          const id = uuidv4();
          const timer = setTimeout(() => { pending.delete(id); rej(new Error(`req ${method} timed out`)); }, 15000);
          pending.set(id, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
      };

      const ws = new WebSocket(this.gatewayUrl);

      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString()) as GatewayFrame;

          if (frame.type === 'res') {
            const pr = pending.get((frame as GatewayResFrame).id);
            if (pr) {
              clearTimeout(pr.timer);
              pending.delete((frame as GatewayResFrame).id);
              (frame as GatewayResFrame).ok
                ? pr.resolve((frame as GatewayResFrame).payload)
                : pr.reject(new Error(String((frame as GatewayResFrame).error?.message ?? 'req failed')));
            }
          }

          if (frame.type === 'event' && (frame as GatewayEventFrame).event === 'connect.challenge') {
            const challenge = (frame as any).payload;
            const nonce = challenge?.nonce as string;
            const signedAtMs = challenge?.ts as number;
            if (!nonce || !Number.isFinite(signedAtMs)) {
              finish(false, 'Invalid gateway challenge');
              return;
            }
            const v3Payload = buildDeviceAuthPayloadV3({
              deviceId: identity.deviceId,
              clientId: CLIENT_ID,
              clientMode: CLIENT_MODE,
              role: ROLE,
              scopes: SCOPES,
              signedAtMs,
              token: this.gatewayAuthToken,
              nonce,
            });

            sendReq('connect', {
              minProtocol: GATEWAY_PROTOCOL_VERSION,
              maxProtocol: GATEWAY_PROTOCOL_VERSION,
              client: { id: CLIENT_ID, version: CLIENT_VERSION, platform: process.platform, mode: CLIENT_MODE },
              role: ROLE,
              scopes: SCOPES,
              auth: this.gatewayAuthToken ? { token: this.gatewayAuthToken } : undefined,
              device: {
                id: identity.deviceId,
                publicKey: identity.publicKeyRawBase64Url,
                signature: signDevicePayload(identity.privateKeyPem, v3Payload),
                signedAt: signedAtMs,
                nonce,
              },
            }).then(() => finish(true))
              .catch((e: Error) => {
                // On pairing required, still call it success — we'll pair on first use
                if (e.message.toLowerCase().includes('pairing')) {
                  finish(true);
                } else {
                  finish(false, e.message);
                }
              });
          }
        } catch {}
      });

      ws.on('error', (e: any) => finish(false, e.message || e.code || 'WebSocket error'));
      ws.on('close', (code) => { if (!done) finish(false, `Connection closed before handshake (code ${code})`); });
    });
  }

  // ─── Connect / disconnect ─────────────────────────────────────────────────

  connectAgent(agent: { id: string; openclawAgentId: string; displayName: string }) {
    if (this.connections.has(agent.id)) return;

    const conn: AgentConnection = {
      agentId: agent.id,
      openclawAgentId: agent.openclawAgentId,
      displayName: agent.displayName,
      ws: null,
      status: 'disconnected',
      currentTaskId: null,
      currentRunId: null,
      reconnectTimer: null,
      currentCommentId: null,
      currentCommentIds: [],
      runOutput: '',
      pending: new Map(),
      handshakeDone: false,
      challengeNonce: null,
      challengeTs: null,
      autoPairAttempted: false,
    };
    this.connections.set(agent.id, conn);
    this.doConnect(conn);
  }

  private connectAgentById(agentId: string) {
    try {
      const db = getDb();
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
      if (agent) this.connectAgent(agent);
    } catch {}
  }

  private doConnect(conn: AgentConnection) {
    conn.status = 'connecting';
    conn.handshakeDone = false;
    conn.challengeNonce = null;
    conn.challengeTs = null;
    conn.pending.clear();

    try {
      const ws = new WebSocket(this.gatewayUrl);
      conn.ws = ws;

      ws.on('message', (data) => this.handleFrame(conn, data.toString()));

      ws.on('close', () => {
        conn.status = 'disconnected';
        conn.ws = null;
        conn.handshakeDone = false;
        this.rejectAllPending(conn, 'WebSocket closed');
        conn.reconnectTimer = setTimeout(() => this.doConnect(conn), 5000);
      });

      ws.on('error', () => {
        conn.status = 'error';
        conn.ws = null;
        conn.handshakeDone = false;
        this.rejectAllPending(conn, 'WebSocket error');
        conn.reconnectTimer = setTimeout(() => this.doConnect(conn), 10000);
      });
    } catch {
      conn.status = 'error';
      conn.reconnectTimer = setTimeout(() => this.doConnect(conn), 10000);
    }
  }

  // ─── Frame handling ───────────────────────────────────────────────────────

  private handleFrame(conn: AgentConnection, raw: string) {
    try {
      const frame = JSON.parse(raw) as GatewayFrame;

      if (frame.type === 'event') {
        this.handleEventFrame(conn, frame as GatewayEventFrame);
        return;
      }

      if (frame.type === 'res') {
        const resFrame = frame as GatewayResFrame;
        const pr = conn.pending.get(resFrame.id);
        if (pr) {
          clearTimeout(pr.timer);
          conn.pending.delete(resFrame.id);
          resFrame.ok
            ? pr.resolve(resFrame.payload)
            : pr.reject(Object.assign(new Error(String(resFrame.error?.message ?? 'req failed')), {
                gatewayCode: resFrame.error?.code,
                gatewayDetails: resFrame.error?.details,
              }));
        }
      }
    } catch {}
  }

  private handleEventFrame(conn: AgentConnection, frame: GatewayEventFrame) {
    if (frame.event === 'connect.challenge') {
      const challenge = frame.payload as any;
      conn.challengeNonce = challenge?.nonce ?? null;
      conn.challengeTs = Number.isFinite(challenge?.ts) ? challenge.ts : null;
      this.doHandshake(conn);
      return;
    }

    // Agent stream events: filter by runId and stream=assistant
    if (frame.event === 'agent' && conn.currentTaskId) {
      const payload = frame.payload as any;
      if (!payload) return;

      const runId = typeof payload.runId === 'string' ? payload.runId : null;
      // Only accept chunks that match the current task's runId exactly — reject anything else (including unrelated sessions on the same agent)
      if (!runId || !conn.currentRunId || runId !== conn.currentRunId) return;

      const stream = typeof payload.stream === 'string' ? payload.stream : null;

      // Tool/job events may interleave with assistant streaming. They are not a
      // comment boundary: the Gateway owns one visible agent comment per run.
      if (stream !== 'assistant') return;

      const data = payload.data as any;
      const isDelta = typeof data?.delta === 'string';
      const chunk = isDelta ? data.delta
        : typeof data?.text === 'string' ? data.text
        : null;

      if (!chunk) return;
      if (process.env.NODE_ENV === 'development') {
        console.log('[adapter] stream chunk', isDelta ? 'delta' : 'text', JSON.stringify(chunk).slice(0, 80));
      }

      try {
        const db = getDb();
        this.handleAgentOutput(conn, db, chunk);
      } catch {}
    }
  }

  // ─── Handshake ────────────────────────────────────────────────────────────

  private async doHandshake(conn: AgentConnection) {
    const nonce = conn.challengeNonce;
    if (!nonce) { conn.ws?.close(); return; }

    const signedAtMs = conn.challengeTs;
    if (signedAtMs === null || !Number.isFinite(signedAtMs)) { conn.ws?.close(); return; }

    const identity = this.deviceIdentity;
    if (!identity) { conn.ws?.close(); return; }

    const v3Payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: SCOPES,
      signedAtMs,
      token: this.gatewayAuthToken,
      nonce,
    });

    const connectParams = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: { id: CLIENT_ID, version: CLIENT_VERSION, platform: process.platform, mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      auth: this.gatewayAuthToken ? { token: this.gatewayAuthToken } : undefined,
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKeyRawBase64Url,
        signature: signDevicePayload(identity.privateKeyPem, v3Payload),
        signedAt: signedAtMs,
        nonce,
      },
    };

    try {
      await this.sendReq(conn, 'connect', connectParams, 15000);
      conn.status = 'connected';
      conn.handshakeDone = true;
      conn.autoPairAttempted = false;
      this.processNextTask(conn);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      const isPairingRequired = msg.toLowerCase().includes('pairing');

      if (isPairingRequired && !conn.autoPairAttempted && this.gatewayAuthToken) {
        conn.autoPairAttempted = true;
        const pairOk = await this.autoPairDevice(identity, err?.gatewayDetails?.requestId as string | undefined);
        if (pairOk) {
          // Reconnect — will get a new challenge and retry handshake
          conn.ws?.close();
          return;
        }
      }

      conn.status = 'error';
      conn.ws?.close();
    }
  }

  // ─── Auto-pairing ─────────────────────────────────────────────────────────

  private async autoPairDevice(identity: DeviceIdentity, requestId?: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const ws = new WebSocket(this.gatewayUrl);
        const pending = new Map<string, PendingRequest>();
        let done = false;

        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          for (const pr of pending.values()) { clearTimeout(pr.timer); pr.reject(new Error('aborted')); }
          try { ws.close(); } catch {}
          resolve(ok);
        };

        const sendReq = (method: string, params?: unknown): Promise<unknown> => {
          return new Promise((res, rej) => {
            const id = uuidv4();
            const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, 15000);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ type: 'req', id, method, params }));
          });
        };

        ws.on('message', async (data) => {
          try {
            const frame = JSON.parse(data.toString()) as GatewayFrame;

            if (frame.type === 'res') {
              const r = frame as GatewayResFrame;
              const pr = pending.get(r.id);
              if (pr) {
                clearTimeout(pr.timer);
                pending.delete(r.id);
                r.ok ? pr.resolve(r.payload) : pr.reject(new Error(String(r.error?.message ?? 'failed')));
              }
            }

            if (frame.type === 'event' && (frame as GatewayEventFrame).event === 'connect.challenge') {
              try {
                // Connect with token only (no device) + pairing scope
                await sendReq('connect', {
                  minProtocol: GATEWAY_PROTOCOL_VERSION,
                  maxProtocol: GATEWAY_PROTOCOL_VERSION,
                  client: { id: CLIENT_ID, version: CLIENT_VERSION, platform: process.platform, mode: CLIENT_MODE },
                  role: ROLE,
                  scopes: [...SCOPES, 'operator.pairing'],
                  auth: { token: this.gatewayAuthToken },
                });

                // Find the pending pairing request
                let reqId = requestId;
                if (!reqId) {
                  const listPayload = await sendReq('device.pair.list', {}) as any;
                  const pendingRequests = Array.isArray(listPayload?.pending) ? listPayload.pending : [];
                  const match = pendingRequests.find((r: any) => r.deviceId === identity.deviceId)
                    ?? pendingRequests[pendingRequests.length - 1];
                  reqId = match?.requestId;
                }

                if (!reqId) { finish(false); return; }

                await sendReq('device.pair.approve', { requestId: reqId });
                finish(true);
              } catch {
                finish(false);
              }
            }
          } catch {}
        });

        ws.on('error', () => finish(false));
        ws.on('close', () => { if (!done) finish(false); });
        setTimeout(() => finish(false), 20000);
      } catch {
        resolve(false);
      }
    });
  }

  // ─── Task dispatch ────────────────────────────────────────────────────────

  private async processNextTask(conn: AgentConnection) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN || !conn.handshakeDone) return;
    if (conn.currentTaskId) return;

    try {
      const db = getDb();
      const nextTask = db.prepare(`
        SELECT * FROM tasks
        WHERE assigneeId = ? AND assigneeType = 'agent' AND status NOT IN ('backlog', 'done', 'archived')
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          createdAt ASC
        LIMIT 1
      `).get(conn.agentId) as any;

      if (!nextTask) return;

      conn.currentTaskId = nextTask.id;
      conn.currentCommentId = null;
      conn.currentCommentIds = [];
      conn.currentRunId = null;
      conn.runOutput = '';

      await this.dispatchTask(conn, nextTask);
    } catch {
      conn.currentTaskId = null;
      conn.currentRunId = null;
    }
  }

  private async dispatchTask(conn: AgentConnection, task: any) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;

    const slug = (task.issueId as string).toLowerCase();
    const message = `You have been assigned task ${task.issueId} in Clawtask.

Instructions:
1. Fetch the task: GET ${CLAWTASK_SELF_URL}/api/v1/tasks/${slug}
2. Fetch EVERY existing instruction/comment before acting: GET ${CLAWTASK_SELF_URL}/api/v1/tasks/${slug}/comments?order=asc
3. Do the work. Task comments are authoritative instructions in addition to the task description.
4. Write concise progress/final updates in your normal response. The verified Gateway adapter records them as agent comments.
5. Do NOT call Clawtask mutation APIs and do not handle any Clawtask credentials.
6. End your final response with exactly one control line:
   CLAWTASK_FINAL: {"status":"done"}
   To return the task to Todo and remove yourself instead, use:
   CLAWTASK_FINAL: {"status":"todo","unassign":true}
   Allowed statuses are done, todo, and blocked.`;
    const idempotencyKey = uuidv4();
    const sessionKey = `agent:${conn.openclawAgentId}:clawtask:${task.id}`;

    try {
      this.markGatewayRunInProgress(conn, task.id);
      const accepted = await this.sendReq(conn, 'agent', {
        message,
        idempotencyKey,
        sessionKey,
        agentId: conn.openclawAgentId,
      }, 15000) as any;

      const runId: string = accepted?.runId ?? idempotencyKey;
      conn.currentRunId = runId;

      const acceptedStatus = (accepted?.status as string ?? '').toLowerCase();

      // If not immediately resolved, wait for completion
      if (acceptedStatus !== 'ok') {
        await this.sendReq(conn, 'agent.wait', {
          runId,
          timeoutMs: 300000,
        }, 360000);
      }

      this.finishGatewayRun(conn, task.id);
      conn.currentTaskId = null;
      conn.currentRunId = null;
      conn.currentCommentId = null;
      conn.currentCommentIds = [];
      conn.runOutput = '';
      this.processNextTask(conn);
    } catch (err) {
      console.error('[adapter] dispatchTask failed', err);
      conn.currentTaskId = null;
      conn.currentRunId = null;
      conn.currentCommentId = null;
      conn.currentCommentIds = [];
      conn.runOutput = '';
    }
  }

  /** Gateway-authenticated lifecycle changes. No model-held API credential. */
  private markGatewayRunInProgress(conn: AgentConnection, taskId: string) {
    const db = getDb();
    const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    if (!current || current.assigneeId !== conn.agentId || current.assigneeType !== 'agent' || current.status === 'in_progress') return;
    db.prepare("UPDATE tasks SET status = 'in_progress', updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(taskId);
    logActivity(db, { taskId, actorId: conn.agentId, actorType: 'agent', verb: 'status_changed', meta: { from: current.status, to: 'in_progress', source: 'gateway_run' } });
    broadcastSse({ type: 'task.updated', data: enrichTask(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any) });
  }

  private finishGatewayRun(conn: AgentConnection, taskId: string) {
    const db = getDb();
    const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
    // A human cancellation/reassignment wins over a late agent run.
    if (!current || current.assigneeId !== conn.agentId || current.assigneeType !== 'agent') return;

    const control = parseAgentRunControl(conn.runOutput);
    for (const commentId of conn.currentCommentIds) {
      const row = db.prepare("SELECT content FROM comments WHERE id = ? AND taskId = ? AND authorId = ? AND authorType = 'agent'").get(commentId, taskId, conn.agentId) as { content: string } | undefined;
      if (!row) continue;
      const cleaned = stripAgentRunControl(row.content);
      if (cleaned !== row.content) {
        db.prepare("UPDATE comments SET content = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(cleaned, commentId);
        const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId) as any;
        const author = db.prepare('SELECT id, openclawAgentId, displayName FROM agents WHERE id = ?').get(conn.agentId);
        broadcastSse({ type: 'comment.updated', data: { ...comment, humanRequested: false, author } });
      }
    }

    db.prepare("UPDATE tasks SET status = ?, assigneeId = ?, assigneeType = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(control.status, control.unassign ? null : conn.agentId, control.unassign ? null : 'agent', taskId);
    logActivity(db, {
      taskId,
      actorId: conn.agentId,
      actorType: 'agent',
      verb: 'status_changed',
      meta: { from: current.status, to: control.status, unassigned: control.unassign, source: 'gateway_run' },
    });
    broadcastSse({ type: 'task.updated', data: enrichTask(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any) });
  }

  // ─── Output streaming ─────────────────────────────────────────────────────

  private handleAgentOutput(conn: AgentConnection, db: any, content: string) {
    if (!conn.currentTaskId) return;
    conn.runOutput = (conn.runOutput + content).slice(-65536);
    if (!content.trim() && !conn.currentCommentId) return;

    const agentAuthor = db.prepare('SELECT id, openclawAgentId, displayName FROM agents WHERE id = ?').get(conn.agentId);

    if (conn.currentCommentId) {
      const existing = db.prepare('SELECT * FROM comments WHERE id = ?').get(conn.currentCommentId) as any;
      if (existing) {
        const newContent = content.startsWith(existing.content) ? content : existing.content + content;
        db.prepare("UPDATE comments SET content = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
          .run(newContent, conn.currentCommentId);
        const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(conn.currentCommentId);
        broadcastSse({ type: 'comment.updated', data: { ...updated, humanRequested: false, author: agentAuthor } });
        return;
      }
      conn.currentCommentId = null;
    }

    const commentId = uuidv4();
    db.prepare(`INSERT INTO comments (id, taskId, authorId, authorType, type, content, humanRequested, createdAt, updatedAt)
      VALUES (?, ?, ?, 'agent', 'message', ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
      .run(commentId, conn.currentTaskId, conn.agentId, content);
    conn.currentCommentId = commentId;
    conn.currentCommentIds.push(commentId);
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
    broadcastSse({ type: 'comment.added', data: { ...comment, humanRequested: false, author: agentAuthor } });
  }

  // ─── Request primitive ────────────────────────────────────────────────────

  private sendReq(conn: AgentConnection, method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }

      const id = uuidv4();
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`req ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type: 'req', id, method, params } as GatewayReqFrame));
    });
  }

  private rejectAllPending(conn: AgentConnection, reason: string) {
    for (const [, pr] of conn.pending) {
      clearTimeout(pr.timer);
      pr.reject(new Error(reason));
    }
    conn.pending.clear();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async assignTaskToAgent(task: any, agentId: string) {
    let conn = this.connections.get(agentId);
    if (!conn) {
      this.connectAgentById(agentId);
      // Connection is async; task will be picked up once handshake completes via processNextTask
      return;
    }

    if (conn.handshakeDone && !conn.currentTaskId) {
      this.processNextTask(conn);
    }
    // If connecting or busy, task will be picked up when ready
  }

  async notifyHumanComment(task: any, comment: any) {
    if (!task.assigneeId || task.assigneeType !== 'agent') return;

    // Ensure the agent is connected — connect if not yet tracked
    if (!this.connections.has(task.assigneeId)) {
      this.connectAgentById(task.assigneeId);
    }

    const conn = this.connections.get(task.assigneeId);
    if (!conn) return;

    // If not yet connected, wait up to 8s for handshake
    if (!conn.handshakeDone) {
      await new Promise<void>(resolve => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (conn.handshakeDone || Date.now() - start > 8000) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });
    }

    if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN || !conn.handshakeDone) return;

    const db = getDb();
    const slug = (task.issueId as string).toLowerCase();

    // Auto-reopen if done — do this before checking currentTaskId so the agent gets context, not a fresh dispatch
    if (task.status === 'done') {
      db.prepare(`UPDATE tasks SET status = 'in_progress', updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(task.id);
      const humanRow = db.prepare('SELECT id FROM humans LIMIT 1').get() as any;
      if (humanRow) {
        const [{ logActivity }, { broadcastSse }, { enrichTask }] = await Promise.all([
          import('./activity'),
          import('./sse'),
          import('./tasks'),
        ]);
        logActivity(db, { taskId: task.id, actorId: humanRow.id, actorType: 'human', verb: 'status_changed', meta: { from: 'done', to: 'in_progress' } });
        const updated = enrichTask(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as any);
        broadcastSse({ type: 'task.updated', data: updated });
        task = { ...task, status: 'in_progress' };
      }
    }

    const wasTrackingTask = conn.currentTaskId === task.id;
    // Ensure conn tracks this task so streamed output lands in a comment
    if (!conn.currentTaskId) {
      conn.currentTaskId = task.id;
      conn.currentCommentId = null;
      conn.currentCommentIds = [];
      conn.currentRunId = null;
      conn.runOutput = '';
    }

    const message = `A human left a comment on task ${task.issueId} that you are working on.

Human comment: "${comment.content}"

This is a follow-up to existing work — do NOT restart or re-execute the task from scratch. Fetch the current task state from ${CLAWTASK_SELF_URL}/api/v1/tasks/${slug} AND the complete comment history from ${CLAWTASK_SELF_URL}/api/v1/tasks/${slug}/comments?order=asc for full context.

Write your response normally; the verified Gateway adapter records it as an agent comment. Do NOT call Clawtask mutation APIs or handle any credentials. End with exactly one line: CLAWTASK_FINAL: {"status":"done"}. Use {"status":"todo","unassign":true} only if the human explicitly requested it.`;
    const idempotencyKey = uuidv4();
    const sessionKey = `agent:${conn.openclawAgentId}:clawtask:${task.id}`;

    try {
      const accepted = await this.sendReq(conn, 'agent', {
        message,
        idempotencyKey,
        sessionKey,
        agentId: conn.openclawAgentId,
      }, 15000) as any;

      const runId: string = accepted?.runId ?? idempotencyKey;
      // Always update runId so the stream filter accepts chunks for this turn
      conn.currentTaskId = task.id;
      conn.currentRunId = runId;

      const acceptedStatus = (accepted?.status as string ?? '').toLowerCase();
      if (acceptedStatus !== 'ok') {
        await this.sendReq(conn, 'agent.wait', { runId, timeoutMs: 300000 }, 360000);
      }

      if (!wasTrackingTask) {
        this.finishGatewayRun(conn, task.id);
        conn.currentTaskId = null;
        conn.currentRunId = null;
        conn.currentCommentId = null;
        conn.currentCommentIds = [];
        conn.runOutput = '';
        this.processNextTask(conn);
      }
    } catch {}
  }

  disconnectAgent(agentId: string) {
    const conn = this.connections.get(agentId);
    if (!conn) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    this.rejectAllPending(conn, 'Agent disconnected');
    conn.ws?.close();
    this.connections.delete(agentId);
  }

  getConnectionStatus(agentId: string) {
    return this.connections.get(agentId)?.status || 'disconnected';
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __clawtask_adapter: AdapterService | undefined;
}

export function getAdapterService(): AdapterService {
  if (!globalThis.__clawtask_adapter) {
    globalThis.__clawtask_adapter = new AdapterService();
    setTimeout(() => globalThis.__clawtask_adapter!.init(), 100);
  }
  return globalThis.__clawtask_adapter;
}
