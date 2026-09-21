import { z } from 'zod';

/**
 * Append-only audit event. Every "considered / did / declined & why" lands here.
 * `prevHash` forms a hash chain => tamper-evident and reproducible.
 */
export const AuditEvent = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  agentId: z.string(),
  actionId: z.string(),
  kind: z.string(),
  verdict: z.enum(['allow','deny','require_human']),
  reasonCode: z.string(),
  detail: z.string(),
  hash: z.string().length(64), // sha256 hex
  prevHash: z.string().length(64),
  /** Optional signed artifact reference (e.g. tx hash after actual exec). */
  receiptId: z.string().optional(),
});

export type AuditEvent = z.infer<typeof AuditEvent>;

/** The signed proof artifact — what gets shown on-chain / in the X post. */
export const SignedProof = z.object({
  actionId: z.string(),
  decisionId: z.string(),
  agentId: z.string(),
  verdict: z.enum(['allow','deny','require_human']),
  reasonCode: z.string(),
  proofHash: z.string().length(64),
  /** A normalized, binding-frozen snapshot of what was approved & signed. */
  approved: z.custom<Record<string, unknown>>(),
  signedAt: z.string().datetime(),
});

export type SignedProof = z.infer<typeof SignedProof>;