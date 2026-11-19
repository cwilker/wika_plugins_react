import type { ApiPromise } from "@polkadot/api";
import { decodeAddress } from "@polkadot/util-crypto";
import { u8aEq } from "@polkadot/util";
import type { LikeReceipt } from "./types";
export interface ClaimRecovery {
  genesisHash: string;
  payer: string;
  target: string;
  nextBlock: string;
  txHash?: string;
  nonce?: string;
  method?: string;
  deathBlock?: string | null;
}
export interface ClaimRecoveryResult {
  state: "pending" | "finalized" | "failed" | "expired";
  nextBlock: string;
  receipt?: LikeReceipt;
}
/** Bounded finalized scan of the exact signed method and nonce. Never resubmits. */
export async function recoverClaimTransaction(
  api: ApiPromise,
  input: ClaimRecovery
): Promise<ClaimRecoveryResult> {
  if (api.genesisHash.toHex() !== input.genesisHash)
    throw new Error("Recovery belongs to a different chain.");
  if (!input.txHash && (!input.method || input.nonce === undefined))
    return { state: "expired", nextBlock: input.nextBlock };
  const tip = await api.rpc.chain.getHeader(
    await api.rpc.chain.getFinalizedHead()
  );
  let next = BigInt(input.nextBlock),
    upper = BigInt(tip.number.toString());
  for (let n = 0; n < 64 && next <= upper; n++, next++) {
    const hash = (await api.rpc.chain.getBlockHash(next.toString())).toHex();
    const [block, view] = await Promise.all([
      api.rpc.chain.getBlock(hash),
      api.at(hash),
    ]);
    const index = block.block.extrinsics.findIndex(
      (tx) =>
        tx.isSigned &&
        (!input.txHash || tx.hash.toHex() === input.txHash) &&
        u8aEq(
          decodeAddress(tx.signer.toString()),
          decodeAddress(input.payer)
        ) &&
        (input.nonce === undefined ||
          tx.nonce.toString() === BigInt(input.nonce).toString()) &&
        (!input.method || tx.method.toHex() === input.method)
    );
    if (index >= 0) {
      const events = await view.query.system.events();
      for (const r of events as unknown as Iterable<{
        phase: {
          isApplyExtrinsic: boolean;
          asApplyExtrinsic: { toNumber(): number };
        };
        event: { section: string; method: string };
      }>) {
        if (
          r.phase.isApplyExtrinsic &&
          r.phase.asApplyExtrinsic.toNumber() === index &&
          r.event.section === "system"
        ) {
          if (r.event.method === "ExtrinsicFailed")
            return { state: "failed", nextBlock: (next + 1n).toString() };
          if (r.event.method === "ExtrinsicSuccess")
            return {
              state: "finalized",
              nextBlock: (next + 1n).toString(),
              receipt: {
                txHash: block.block.extrinsics[index].hash.toHex(),
                blockHash: hash,
                blockNumber: next.toString(),
              },
            };
        }
      }
    }
    if (input.deathBlock && next >= BigInt(input.deathBlock))
      return { state: "expired", nextBlock: (next + 1n).toString() };
  }
  return { state: "pending", nextBlock: next.toString() };
}
