import { beforeAll, describe, expect, it, vi } from "vitest";
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex, u8aWrapBytes } from "@polkadot/util";
import { claimProofMessage, signClaimProof } from "../src/claim-proof";
import type { Signer } from "../src/types";
const input = { genesisHash: `0x${"01".repeat(32)}`, page: "HTTPS://Example.com:443/a#comments", nonce: `0x${"02".repeat(32)}`, expiresAt: 123456n };
beforeAll(async () => { await cryptoWaitReady(); });
describe("wallet-authenticated page proof", () => {
  it.each([false, true])("signs and validates with standard wallet wrapping=%s", async wrap => {
    const pair = sr25519PairFromSeed(new Uint8Array(32).fill(7));
    const account = { address: u8aToHex(pair.publicKey), source: "test" };
    const signRaw = vi.fn(async ({ data }: { data: string }) => {
      const message = hexToU8a(data);
      return { id: 1, signature: u8aToHex(sr25519Sign(wrap ? u8aWrapBytes(message) : message, pair)) };
    });
    const proof = await signClaimProof(account, { signRaw } as Signer, input);
    expect(proof.page).toBe("https://example.com/a");
    expect(proof.content).toMatch(/^wika-claim-v1:[0-9a-f]+\.01[0-9a-f]{128}$/);
    expect(proof.proofDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signRaw).toHaveBeenCalledWith({ address: account.address, data: u8aToHex(claimProofMessage(account.address, input).message), type: "bytes" });
  });
  it("reports unsupported wallets and rejects signatures from another wallet", async () => {
    const pair = sr25519PairFromSeed(new Uint8Array(32).fill(7));
    const account = { address: u8aToHex(pair.publicKey), source: "test" };
    await expect(signClaimProof(account, {}, input)).rejects.toMatchObject({ code: "UNSUPPORTED_SIGNING" });
    await expect(signClaimProof(account, { signRaw: async () => ({ id: 1, signature: u8aToHex(new Uint8Array(64)) }) }, input)).rejects.toThrow("invalid proof signature");
  });
  it("binds chain, page, wallet, nonce, method, version and expiry in the signed bytes", () => {
    const pair = sr25519PairFromSeed(new Uint8Array(32).fill(7));
    const address = u8aToHex(pair.publicKey);
    const original = claimProofMessage(address, input).message;
    for (const changed of [{ page: "https://example.com/b" }, { genesisHash: `0x${"03".repeat(32)}` }, { nonce: `0x${"04".repeat(32)}` }, { expiresAt: 123457n }]) {
      expect(claimProofMessage(address, { ...input, ...changed }).message).not.toEqual(original);
    }
    expect(claimProofMessage(u8aToHex(new Uint8Array(32).fill(8)), input).message).not.toEqual(original);
    expect(() => claimProofMessage(address, { ...input, page: "http://example.com/" })).toThrow();
    expect(() => claimProofMessage(address, { ...input, page: "https://example.com:8443/" })).toThrow();
    expect(() => claimProofMessage(address, { ...input, expiresAt: 0n })).toThrow();
    expect(() => claimProofMessage(address, { ...input, expiresAt: 2n ** 64n })).toThrow();
  });
});

import fixtures from './fixtures/claim-proof-v1.json';
it('matches shared Rust/verifier SCALE and signing-message fixtures', () => {
  for (const fixture of fixtures.cases) {
    const result = claimProofMessage(fixture.account, { ...fixture, expiresAt: BigInt(fixture.expiresAt) });
    expect(u8aToHex(result.body)).toBe(fixture.body);
    expect(u8aToHex(result.message)).toBe(fixture.message);
  }
});
