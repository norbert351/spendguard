// Email + password owner auth for the SpendGuard control plane.
// Zero-dependency: node:crypto scrypt hashing + node:sqlite persistence,
// HMAC-free random session tokens in an HttpOnly cookie.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface Owner {
  id: number;
  email: string;
}

export interface Session {
  token: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'sg_session';

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec = SESSION_TTL_MS / 1000): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export class AuthStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owners(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions(
        token TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
    `);
  }

  private hash(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString('hex');
  }

  register(email: string, password: string): { owner: Owner } | { error: string } {
    const norm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) return { error: 'invalid email' };
    if (typeof password !== 'string' || password.length < 8) {
      return { error: 'password must be at least 8 characters' };
    }
    const exists = this.db.prepare('SELECT id FROM owners WHERE email = ?').get(norm);
    if (exists) return { error: 'email already registered' };
    const salt = randomBytes(16).toString('hex');
    const hash = this.hash(password, salt);
    const now = new Date().toISOString();
    const r = this.db
      .prepare('INSERT INTO owners(email, pass_hash, salt, created_at) VALUES(?,?,?,?)')
      .run(norm, hash, salt, now);
    return { owner: { id: Number(r.lastInsertRowid), email: norm } };
  }

  login(email: string, password: string): Owner | null {
    const norm = email.trim().toLowerCase();
    const row = this.db.prepare('SELECT id, email, pass_hash, salt FROM owners WHERE email = ?').get(norm) as
      | { id: number; email: string; pass_hash: string; salt: string }
      | undefined;
    if (!row) return null;
    const candidate = Buffer.from(this.hash(password, row.salt), 'hex');
    const stored = Buffer.from(row.pass_hash, 'hex');
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return null;
    return { id: row.id, email: row.email };
  }

  createSession(ownerId: number): Session {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db
      .prepare('INSERT INTO sessions(token, owner_id, created_at, expires_at) VALUES(?,?,?,?)')
      .run(token, ownerId, now, expiresAt);
    return { token, expiresAt };
  }

  getSession(token?: string | null): Owner | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT s.owner_id AS owner_id, o.email AS email, s.expires_at AS expires_at
         FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.token = ?`,
      )
      .get(token) as { owner_id: number; email: string; expires_at: number } | undefined;
    if (!row || typeof row.expires_at !== 'number' || row.expires_at < Date.now()) return null;
    return { id: row.owner_id, email: row.email };
  }

  deleteSession(token?: string | null): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
}