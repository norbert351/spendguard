import { z } from 'zod';
import type { PaymentBinding } from './action.js';

/** Verdict of the decision engine. */
export const DecisionVerdict = z.enum(['allow', 'deny', 'require_human']);

export type DecisionVerdict = z.infer<typeof DecisionVerdict>;

/** Why a decision was reached — human-readable + a stable reason code. */
export const DecisionReason = z.object({
  code: z.enum([
    'ok',
    'over_spend_limit',
    'over_window_limit',
    'payee_not_allowed',
    'kind_not_allowed',
    'amount_mismatch',
    'payee_mismatch',
    'chain_mismatch',
    'token_mismatch',
    'no_approved_binding',
    'binding_mismatch',
    'injection_detected',
    'shadow_verify_failed',
    'human_required',
  ]),
  detail: z.string(),
});

export type DecisionReason = z.infer<typeof DecisionReason>;

/** The decision the engine emits for ONE action. */
export const Decision = z.object({
  decisionId: z.string().uuid(),
  actionId: z.string(),
  agentId: z.string(),
  verdict: DecisionVerdict,
  reason: DecisionReason,
  /** The approved binding (when allow / require_human). NOT set on deny. */
  approvedBinding: z.custom<PaymentBinding>().optional(),
  decidedAt: z.string().datetime(),
  /** recomputed hash input (what the proof binds). */
  nonce: z.string(),
});

export type Decision = z.infer<typeof Decision>;