import { z } from 'zod';

/**
 * An action an agent wants to take — the unit the guardrail evaluates.
 * Rail-agnostic: agentkit-transfer, robinhood-order, x402-payment, ixs-deposit.
 */
export const ActionKind = z.enum([
  'transfer',
  'robinhood_order',
  'x402_payment',
  'ixs_deposit',
  'contract_call',
]);

export const agentIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9_.:-]+$/, 'agent id must be url-safe');

/** An action intent produced by an agent, awaiting verification. */
export const ActionIntent = z.object({
  id: z.string().uuid(),
  agentId: agentIdSchema,
  kind: ActionKind,
  createdAt: z.string().datetime(), // ISO
  /** Full tool call the agent wants to fire (payload to be bound). */
  payload: z.unknown(),
});

export type ActionIntent = z.infer<typeof ActionIntent>;

/**
 * The x402 / bill-swap binding descriptor. The core security invariant:
 * what was APPROVED must equal what gets SIGNED.
 */
export const PaymentBinding = z.object({
  /** Recipient the agent believes it is paying. */
  payTo: z.string().min(1),
  /** Exact amount approved (string to avoid float corruption). */
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be numeric string'),
  /** Chain id the payment is bound to. */
  chainId: z.number().int().positive(),
  /** Token contract (or 'native'). */
  token: z.string().min(1),
});

export type PaymentBinding = z.infer<typeof PaymentBinding>;

/** A presented signable bundle that MUST match the approved binding. */
export const SignableBundle = z.object({
  binding: PaymentBinding,
  /** The actual payload/calldata about to be signed. */
  signPayload: z.string(),
  /** round trip so a retry (the 402 second contact) can be fingerprinted. */
  requestId: z.string().min(1),
});

export type SignableBundle = z.infer<typeof SignableBundle>;