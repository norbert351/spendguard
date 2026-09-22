import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AuditLedger } from './ledger.js';
import type { Decision } from '@spendguard/contracts';

function decision(verdict: Decision['verdict'], over: Partial<Decision> = {}): Decision {
  return {
    decisionId: randomUUID(),
    actionId: randomUUID(),
    agentId: 'trader-1',
    verdict,
    reason: { code: verdict === 'deny' ? 'over_spend_limit' : 'ok', detail: 'test' },
    decidedAt: new Date().toISOString(),
    nonce: 'x',
    ...over,
  } as Decision;
}

describe('AuditLedger (node:sqlite hash chain)', () => {
  it('appends events with a valid hash chain', () => {
    const l = new AuditLedger(':memory:');
    l.append(decision('allow'));
    l.append(decision('deny'));
    l.append(decision('require_human'));
    expect(l.count()).toBe(3);
    const res = l.verify();
    expect(res.valid).toBe(true);
    expect(res.verified).toBe(3);
    l.close();
  });

  it('detects a tampered event in the chain', () => {
    const l = new AuditLedger(':memory:');
    l.append(decision('allow'));
    l.append(decision('deny'));
    // corrupt a stored row's detail
    l._raw().prepare('UPDATE audit_events SET detail = ? WHERE seq = 2').run('MUTATED!');
    const res = l.verify();
    expect(res.valid).toBe(false);
    l.close();
  });

  it('rejects a mid-chain prevHash mismatch', () => {
    const l = new AuditLedger(':memory:');
    l.append(decision('allow'));
    l.append(decision('allow'));
    // break the link so seq2's prev_hash no longer matches seq1's hash
    l._raw().prepare(`UPDATE audit_events SET prev_hash = ?2 WHERE seq = ?1`).run(2, 'a'.repeat(64));
    const res = l.verify();
    expect(res.valid).toBe(false);
    l.close();
  });

  it('genesis hash for an empty ledger and first event', () => {
    const l = new AuditLedger(':memory:');
    const evt = l.append(decision('allow'));
    expect(evt.prevHash).toBe(AuditLedger.genesis());
    expect(evt.hash).toHaveLength(64);
    l.close();
  });

  it('lists events newest-first', () => {
    const l = new AuditLedger(':memory:');
    const a = l.append(decision('allow'));
    const b = l.append(decision('deny'));
    const list = l.list();
    expect(list.length).toBe(2);
    expect(list[0]?.actionId).toBe(b.actionId);
    expect(list[1]?.actionId).toBe(a.actionId);
    l.close();
  });

  it('binds a receipt id to an allowed decision', () => {
    const l = new AuditLedger(':memory:');
    const evt = l.append(decision('allow'), 'tx:0xabc');
    expect(evt.receiptId).toBe('tx:0xabc');
    l.close();
  });

  it('records the decision kind directly (fix: no more derived "unknown")', () => {
    const l = new AuditLedger(':memory:');
    const d = { ...decision('deny'), kind: 'robinhood_order' };
    const evt = l.append(d);
    expect(evt.kind).toBe('robinhood_order');
    l.close();
  });
});