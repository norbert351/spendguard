// AuthStore unit tests — email+password registration, login, session lifecycle.
// Imports the BUILT auth module (npm run build -w @spendguard/api first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, parseCookies, sessionCookie, clearSessionCookie } from '../dist/auth.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-auth-'));
  const store = new AuthStore(join(dir, 'a.sqlite'));
  return { store, dir };
}

test('register -> login -> session -> me round-trip', async () => {
  const { store, dir } = fresh();
  try {
    const reg = store.register('Ops@Fleet.com', 'correct-horse-battery');
    assert.ok(!('error' in reg), 'register ok');
    assert.equal(reg.owner?.email, 'ops@fleet.com', 'email normalized to lowercase');

    // duplicate rejected
    assert.equal(store.register('ops@fleet.com', 'whatever9').error, 'email already registered');

    // bad password rejected
    assert.equal(store.register('x@y.co', 'short').error, 'password must be at least 8 characters');

    // wrong password rejected, right one accepted
    assert.equal(store.login('ops@fleet.com', 'wrong-password'), null);
    const owner = store.login('ops@fleet.com', 'correct-horse-battery');
    assert.equal(owner?.email, 'ops@fleet.com');

    // session valid + then invalid after expiry
    const sess = store.createSession(owner.id);
    assert.equal(store.getSession(sess.token)?.email, 'ops@fleet.com');
    store.deleteSession(sess.token);
    assert.equal(store.getSession(sess.token), null, 'logout kills the session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cookies: parse, set, clear', () => {
  assert.deepEqual(parseCookies('a=1; sg_session=tok'), { a: '1', sg_session: 'tok' });
  const set = sessionCookie('tok');
  assert.match(set, /sg_session=tok/);
  assert.match(set, /HttpOnly/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});