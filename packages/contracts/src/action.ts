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

/**
 * Schema-forced execution (#6). Before an agent's action is ever evaluated,
 * the intent payload must validate against the PERMITTED action schema — not
 * just be described. A malformed payload (missing to/amount/chainId/token) is
 * rejected outright, so agents can't drift outside the enforced shape.
 */
export const FUNDING_KINDS = ['transfer', 'x402_payment', 'ixs_deposit', 'robinhood_order'] as const;
export type FundingKind = (typeof FUNDING_KINDS)[number];

export function isFundingKind(kind: string): kind is FundingKind {
  return (FUNDING_KINDS as readonly string[]).includes(kind);
}

export interface SchemaViolation {
  field: string;
  problem: string;
}

/** Validate a funding action's payload against the enforced schema. */
export function validateFundingPayload(
  kind: string,
  payload: Record<string, unknown>,
): SchemaViolation[] {
  const errs: SchemaViolation[] = [];
  if (!isFundingKind(kind)) {
    return [{ field: 'kind', problem: `unsupported funding kind '${kind}'` }];
  }
  const to = payload.to ?? payload.payTo;
  if (to === undefined || String(to) === '') errs.push({ field: 'to', problem: 'missing recipient' });
  const amt = String(payload.amount ?? '');
  if (amt === '' || !/^\d+(\.\d+)?$/.test(amt)) errs.push({ field: 'amount', problem: 'must be a numeric string' });
  if (payload.chainId === undefined) errs.push({ field: 'chainId', problem: 'missing chainId' });
  const token = payload.token;
  if (token === undefined || String(token) === '') errs.push({ field: 'token', problem: 'missing token' });
  return errs;
}

/** Explorer base URLs for explorer-linkable receipts (#9). */
const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  137: 'https://polygonscan.com',
  42161: 'https://arbiscan.io',
  10: 'https://optimistic.etherscan.io',
  43114: 'https://snowtrace.io',
  56: 'https://bscscan.com',
  84532: 'https://sepolia.basescan.org',
};

export function explorerBase(chainId: number): string {
  return EXPLORERS[chainId] ?? `https://etherscan.io`;
}

/** Explorer-linkable address URL for a recipient (the payee). */
export function explorerAddressUrl(chainId: number, address: string): string {
  return `${explorerBase(chainId)}/address/${address}`;
}

/** Explorer-linkable URL for a proof/receipt hash (solscan/etherscan-style). */
export function explorerHashUrl(chainId: number, hash: string): string {
  return `${explorerBase(chainId)}/tx/${hash}`;
}