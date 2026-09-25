import type { PaymentBinding } from '@spendguard/contracts';
import { explorerHashUrl } from '@spendguard/contracts';

/**
 * REAL rail broadcaster — closes the "the guardrail never broadcasts a cent"
 * honest-scope gap. This module is the ONLY place a real wallet signs and
 * broadcasts. It is OFF by default (REAL_RAIL!=1) so the guardrail's 60+ tests
 * stay shape-only and never touch a chain.
 *
 * Honest boundary (we do NOT fabricate an on-chain result):
 *   - only the NATIVE token (base ETH on Base Sepolia) is broadcastable here.
 *     Token (USDC) bindings are refused with a clear error, not faked.
 *   - only ONE configured real chain (REAL_CHAIN, default 84532 Base Sepolia).
 */

const REAL_RAIL_FN = () => (process.env.REAL_RAIL ?? '') === '1';
const PRIVATE_KEY_FN = () => process.env.REAL_WALLET_PK ?? '';
const CHAIN_FN = () => Number(process.env.REAL_CHAIN ?? 84532);
const RPC_FN = () => process.env.REAL_RPC ?? 'https://sepolia.base.org';

export interface BroadcastReceipt {
  txHash: string;
  from: string;
  to: string;
  value: string;
  chainId: number;
  network: string;
  explorerUrl: string;
}

export function realRailEnabled(): boolean {
  return REAL_RAIL_FN() && PRIVATE_KEY_FN() !== '';
}

/** Load ethers lazily so the zero-dep default path never imports it. */
async function loadEthers() {
  return import(process.env.ETHERS_PATH ?? 'ethers');
}

export async function broadcastBoundTransfer(binding: PaymentBinding): Promise<BroadcastReceipt> {
  const REAL_RAIL = REAL_RAIL_FN();
  const PRIVATE_KEY = PRIVATE_KEY_FN();
  const CHAIN = CHAIN_FN();
  const RPC_URL = RPC_FN();
  if (!realRailEnabled()) {
    throw new Error('REAL_RAIL is not enabled — refusing to sign (set REAL_RAIL=1 + REAL_WALLET_PK)');
  }
  if (binding.token !== 'native' && binding.token.toLowerCase() !== 'eth') {
    throw new Error(
      `real rail only broadcasts NATIVE (base ETH); binding token '${binding.token}' is not wired (no fake ERC20 broadcast)`,
    );
  }
  if (binding.chainId !== CHAIN) {
    throw new Error(`real rail bound to chainId ${CHAIN}; binding chainId ${binding.chainId} rejected`);
  }

  const { Wallet, JsonRpcProvider, parseEther } = await loadEthers();
  const provider = new JsonRpcProvider(RPC_URL, CHAIN);
  const wallet = new Wallet(PRIVATE_KEY, provider);
  const from = wallet.address;
  const value = parseEther(binding.amount);

  const tx = await wallet.sendTransaction({ to: binding.payTo, value });
  const receipt = await tx.wait();

  return {
    txHash: receipt?.hash ?? tx.hash,
    from,
    to: binding.payTo,
    value: binding.amount,
    chainId: CHAIN,
    network: CHAIN === 84532 ? 'Base Sepolia' : `chain-${CHAIN}`,
    explorerUrl: explorerHashUrl(CHAIN, (receipt?.hash ?? tx.hash)),
  };
}