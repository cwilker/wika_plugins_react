import { blake2AsHex, cryptoWaitReady, decodeAddress, signatureVerify } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import { canonicalPageUrl } from "./page-identity";
import type { Signer, WalletAccount } from "./types";
import { WikaError } from "./utils";

export interface ClaimProofInput {
  genesisHash: string;
  page: string;
  /** 32 random bytes, hex. Never reuse a nonce for a different request. */
  nonce: string;
  /** Initial expiry in Unix milliseconds, checked against chain timestamp. */
  expiresAt: bigint;
}
export interface SignedClaimProof {
  page: string;
  content: string;
  proofDigest: string;
}
const DOMAIN = new TextEncoder().encode("wika/page-claim/v1\0");
function bytes32(hex: string): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error("Expected 32 bytes of lowercase hex.");
  return hexToU8a(hex);
}
/** SCALE layout shared with pallet-owners::proof::Envelope. No JSON serialization in signatures. */
export function claimProofMessage(address: string, input: ClaimProofInput): { page: string; body: Uint8Array; message: Uint8Array } {
  const page = canonicalPageUrl(input.page);
  const parsed = new URL(page);
  if (parsed.protocol !== "https:" || parsed.port) throw new Error("Claims require HTTPS on port 443.");
  const account = decodeAddress(address);
  if (account.length !== 32) throw new Error("Claims require an AccountId32 wallet.");
  if (input.expiresAt <= 0n || input.expiresAt > 0xffffffffffffffffn) throw new RangeError("Invalid claim expiry.");
  const url = new TextEncoder().encode(page);
  const length = url.length < 64 ? Uint8Array.of(url.length << 2) : Uint8Array.of(((url.length << 2) | 1) & 255, url.length >> 6);
  const expiry = new Uint8Array(8);
  new DataView(expiry.buffer).setBigUint64(0, input.expiresAt, true);
  const body = Uint8Array.from([1, 1, ...bytes32(input.genesisHash), ...length, ...url, ...account, ...bytes32(input.nonce), ...expiry]);
  return { page, body, message: Uint8Array.from([...DOMAIN, ...body]) };
}

/** Request wallet message authorization; never submit a transaction or publish metadata here. */
export async function signClaimProof(account: WalletAccount, signer: Signer, input: ClaimProofInput): Promise<SignedClaimProof> {
  if (!signer.signRaw) throw new WikaError("UNSUPPORTED_SIGNING", "This wallet cannot sign page proofs. Choose a wallet with message signing support.");
  if (account.genesisHash && account.genesisHash.toLowerCase() !== input.genesisHash) throw new WikaError("WRONG_NETWORK", "This account is restricted to a different network.");
  const { page, body, message } = claimProofMessage(account.address, input);
  const { signature } = await signer.signRaw({ address: account.address, data: u8aToHex(message), type: "bytes" });
  await cryptoWaitReady();
  const result = signatureVerify(message, signature, account.address);
  if (!result.isValid) throw new Error("The wallet returned an invalid proof signature.");
  const kind = { ed25519: 0, sr25519: 1, ecdsa: 2 }[result.crypto as "ed25519" | "sr25519" | "ecdsa"];
  if (kind === undefined) throw new Error("Unsupported proof signature scheme.");
  const raw = hexToU8a(signature);
  // signRaw convention is raw signature bytes. Refuse ambiguous prefixed/malformed lengths.
  if (raw.length !== (kind === 2 ? 65 : 64)) throw new Error("Unexpected wallet signature encoding.");
  const content = `wika-claim-v1:${u8aToHex(body).slice(2)}.${u8aToHex(Uint8Array.from([kind, ...raw])).slice(2)}`;
  return { page, content, proofDigest: blake2AsHex(content, 256) };
}
