import { z } from 'zod';

/** Per-agent spend policy. Zero-dep, schema-validated. */
export const SpendPolicy = z.object({
  /** Hard ceiling in token units (decimal string). */
  maxAmountPerAction: z.string().regex(/^\d+(\.\d+)?$/),
  /** Running limit over a TTL window (e.g. per-day). */
  maxAmountPerWindow: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
  /** Window length in ms. Unset => window limit disabled. */
  windowMs: z.number().int().positive().optional(),
  /** Allowed recipient addresses / asset ids. Empty = explicit whitelist off. */
  allowedPayees: z.array(z.string()).default([]),
  /** Allowed action kinds. Empty = allow kinds declared by adapter. */
  allowedKinds: z.array(z.enum(['transfer','robinhood_order','x402_payment','ixs_deposit','contract_call'])).default([]),
  /** Require a human to approve actions above this amount. */
  humanInLoopThreshold: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  /** Max number of funding actions allowed inside windowMs (velocity guard). */
  maxActionsPerWindow: z.number().int().positive().optional(),
  /** Emergency freeze — when true, ALL funding actions are denied. */
  frozen: z.boolean().optional(),
});

export type SpendPolicy = z.infer<typeof SpendPolicy>;

/** The full per-agent policy bundle (the one thing an operator sets once). */
export const AgentPolicy = z.object({
  agentId: z.string().min(3).max(64),
  spend: SpendPolicy,
  /** Human who must sign off on HITL-flagged actions. */
  guardianAddress: z.string().optional(),
  /** Free-form notes for the audit trail. */
  note: z.string().max(500).optional(),
});

export type AgentPolicy = z.infer<typeof AgentPolicy>;