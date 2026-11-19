import { it, expect } from "vitest";
import {
  recoverClaimTransaction,
  type ClaimRecovery,
} from "../src/claim-recovery";
const payer = "0x" + "01".repeat(32),
  input: ClaimRecovery = {
    payer,
    target: "https://claim.example/",
    genesisHash: "0xgenesis",
    nextBlock: "1",
    nonce: "7",
    method: "0x1234",
    deathBlock: "8",
  };
function fixture(method = "0x1234", failed = false) {
  const tx = {
    isSigned: true,
    signer: { toString: () => payer },
    nonce: { toString: () => "7" },
    method: { toHex: () => method },
    hash: { toHex: () => "0xtx" },
  };
  const event = {
    phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => 0 } },
    event: {
      section: "system",
      method: failed ? "ExtrinsicFailed" : "ExtrinsicSuccess",
    },
  };
  return {
    genesisHash: { toHex: () => "0xgenesis" },
    rpc: {
      chain: {
        getFinalizedHead: async () => "0xblock",
        getHeader: async () => ({ number: { toString: () => "8" } }),
        getBlockHash: async () => ({ toHex: () => "0xblock" }),
        getBlock: async () => ({ block: { extrinsics: [tx] } }),
      },
    },
    at: async () => ({ query: { system: { events: async () => [event] } } }),
  } as unknown as Parameters<typeof recoverClaimTransaction>[0];
}
it("recovers only the actual signed method/nonce, even before its hash was saved", async () => {
  expect(await recoverClaimTransaction(fixture(), input)).toMatchObject({
    state: "finalized",
    receipt: { txHash: "0xtx", blockNumber: "1" },
  });
  expect(await recoverClaimTransaction(fixture("0x5678"), input)).toMatchObject(
    { state: "expired" }
  );
  expect(
    await recoverClaimTransaction(fixture(), { ...input, txHash: "0xother" })
  ).toMatchObject({ state: "expired" });
});
it("separates finalized failure from unknown pending and rejects another chain", async () => {
  expect(
    await recoverClaimTransaction(fixture("0x1234", true), input)
  ).toMatchObject({ state: "failed" });
  expect(
    await recoverClaimTransaction(fixture("0x5678"), {
      ...input,
      deathBlock: "100",
    })
  ).toMatchObject({ state: "pending", nextBlock: "9" });
  await expect(
    recoverClaimTransaction(fixture(), { ...input, genesisHash: "0xother" })
  ).rejects.toThrow(/different chain/);
});
