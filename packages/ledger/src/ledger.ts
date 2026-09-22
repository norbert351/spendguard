import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { AuditEvent, Decision, SignedProof } from '@spendguard/contracts';

// node:sqlite is experimental (Node >=22.13) and NOT in vite-node's builtin
// list, so a static value-`import ... from 'node:sqlite'` makes vite try to
// resolve bare `sqlite`. `process.getBuiltinModule` returns it without entering
// the vite module graph (works at runtime AND under vitest/vite-node). The
// type-only import is erased at build time, so vite never sees it.
const { DatabaseSync: DatabaseSyncCtor } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
// Re-export the type for consumers.
export type { DatabaseSyncType as DatabaseSync };

/**
 * Append-only audit ledger on node:sqlite (built into Node >= 22.13, no native
 * deps). Every decision lands as an event whose `hash` chains off the previous
 * event's hash => tamper-evident, reproducible trail of
 * "considered / did / declined & why".
 */
export class AuditLedger {
  private db: DatabaseSyncType;
  private readonly file: string;

  /** Create (and open) a ledger. Pass ':memory:' for tests. */
  constructor(file: string = ':memory:') {
    this.file = file;
    this.db = new DatabaseSyncCtor(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        detail TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        receipt_id TEXT
      );
      CREATE TABLE IF NOT EXISTS policies (
        agent_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS windows (
        agent_id TEXT PRIMARY KEY,
        spent TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** The sha256 of a normalized event payload. */
  static hashEvent(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private lastHash(): string {
    const row = this.db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    if (!row) return AuditLedger.genesis();
    return row.hash;
  }

  static genesis(): string {
    return '0'.repeat(64);
  }

  /**
   * Append a decision to the ledger. Returns the stored AuditEvent (with hash
   * chain resolved). Throws if a hash collision is detected (should never happen).
   */
  append(decision: Decision, receiptId?: string): AuditEvent {
    const now = new Date().toISOString();
    const prev = this.lastHash();

    const evt: AuditEvent = {
      seq: this.count() + 1,
      ts: now,
      agentId: decision.agentId,
      actionId: decision.actionId,
      kind: decision.kind ?? 'unknown',
      verdict: decision.verdict,
      reasonCode: decision.reason.code,
      detail: decision.reason.detail,
      prevHash: prev,
      hash: '',
      receiptId,
    };
    evt.hash = AuditLedger.hashEvent(
      [evt.seq, evt.ts, evt.agentId, evt.actionId, evt.kind, evt.verdict, evt.reasonCode, evt.detail, evt.prevHash].join('|'),
    );

    this.db
      .prepare(
        `INSERT INTO audit_events (ts, agent_id, action_id, kind, verdict, reason_code, detail, hash, prev_hash, receipt_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(evt.ts, evt.agentId, evt.actionId, evt.kind, evt.verdict, evt.reasonCode, evt.detail, evt.hash, evt.prevHash, receiptId ?? null);

    return evt;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number };
    return Number(row.n);
  }

  list(limit = 100, offset = 0): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as AuditEvent[];
    return rows.map(this.mapRow);
  }

  /**
   * Verify the chain integrity: recompute each hash from its fields + prevHash
   * and confirm the prevHash links match. Returns { valid, verified: n }.
   */
  verify(): { valid: boolean; verified: number } {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all() as unknown as AuditEvent[];
    let prev = AuditLedger.genesis();
    let verified = 0;
    for (const r of rows) {
      const e = this.mapRow(r);
      const recomputed = AuditLedger.hashEvent(
        [e.seq, e.ts, e.agentId, e.actionId, e.kind, e.verdict, e.reasonCode, e.detail, e.prevHash].join('|'),
      );
      if (e.prevHash !== prev || recomputed !== e.hash) {
        return { valid: false, verified };
      }
      prev = e.hash;
      verified++;
    }
    return { valid: true, verified };
  }

  /** Build a SignedProof artifact for a decision (what the X post links to). */
  makeProof(decision: Decision): SignedProof {
    const proofHash = AuditLedger.hashEvent(
      [decision.actionId, decision.decisionId, decision.agentId, decision.verdict, decision.reason.code, JSON.stringify(decision.approvedBinding ?? {})].join('|'),
    );
    return {
      actionId: decision.actionId,
      decisionId: decision.decisionId,
      agentId: decision.agentId,
      verdict: decision.verdict,
      reasonCode: decision.reason.code,
      proofHash,
      approved: (decision.approvedBinding ?? {}) as unknown as Record<string, unknown>,
      signedAt: new Date().toISOString(),
    };
  }

  private mapRow(r: AuditEvent & Record<string, unknown>): AuditEvent {
    return {
      seq: Number(r.seq ?? 0),
      ts: String(r.ts ?? ''),
      agentId: String(r.agent_id ?? ''),
      actionId: String(r.action_id ?? ''),
      kind: String(r.kind ?? ''),
      verdict: String(r.verdict ?? '') as AuditEvent['verdict'],
      reasonCode: String(r.reason_code ?? ''),
      detail: String(r.detail ?? ''),
      hash: String(r.hash ?? ''),
      prevHash: String(r.prev_hash ?? ''),
      receiptId: r.receipt_id ? String(r.receipt_id) : undefined,
    };
  }

  /** For dependency-injection tests / manual seeding. */
  _raw(): DatabaseSyncType {
    return this.db;
  }

  /** Seed a default policy if none exists yet (returns true if seeded). */
  seedPolicyIfAbsent(agentId: string, policyJson: string): boolean {
    const row = this.db.prepare('SELECT agent_id FROM policies WHERE agent_id = ?').get(agentId) as { agent_id: string } | undefined;
    if (row) return false;
    this.savePolicy(agentId, policyJson);
    return true;
  }

  savePolicy(agentId: string, policyJson: string): void {
    this.db
      .prepare('INSERT INTO policies (agent_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at')
      .run(agentId, policyJson, new Date().toISOString());
  }

  loadPolicies(): Record<string, string> {
    const rows = this.db.prepare('SELECT agent_id, json FROM policies').all() as Array<{ agent_id: string; json: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.agent_id] = r.json;
    return out;
  }

  getPolicy(agentId: string): string | null {
    const row = this.db.prepare('SELECT json FROM policies WHERE agent_id = ?').get(agentId) as { json: string } | undefined;
    return row?.json ?? null;
  }

  saveWindow(agentId: string, spent: string, count: number, windowStart: number): void {
    this.db
      .prepare('INSERT INTO windows (agent_id, spent, count, window_start) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET spent=excluded.spent, count=excluded.count, window_start=excluded.window_start')
      .run(agentId, spent, count, windowStart);
  }

  loadWindow(agentId: string): { spent: string; count: number; windowStart: number } | null {
    const row = this.db.prepare('SELECT spent, count, window_start FROM windows WHERE agent_id = ?').get(agentId) as
      | { spent: string; count: number; window_start: number }
      | undefined;
    if (!row) return null;
    return { spent: row.spent, count: row.count, windowStart: row.window_start };
  }

  setConfig(key: string, value: string): void {
    this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}