/** Server-only referral issuer. Supply a server-held sr25519 signer, never a browser wallet. */
import type { ApiPromise } from '@polkadot/api';
import { blake2AsU8a, decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { canonicalPageUrl } from './page-identity';
import { encodeReferralPayload, quoteReferral, validateReferral, type ReferralEnvelope, type ReferralQuote } from './referrals';
export interface HostIssueInput { payer: string; target: string; count: number; clientOperationId: string }
export function createReferralIssuer(api: ApiPromise, config: {
  source: string; authorizationId: string; publicKey: string;
  sign(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
  isOfferedTarget(target: string): Promise<boolean>;
  maxEntries?: number;
}) {
  const source = canonicalPageUrl(config.source);
  const cache = new Map<string, { fingerprint: string; expires: number; result: Promise<{ envelope: ReferralEnvelope; quote: ReferralQuote }> }>();
  let active = 0;
  return async (input: HostIssueInput) => {
    if (typeof input?.payer !== 'string' || typeof input?.target !== 'string' || input.payer.length > 100 || input.target.length > 2048 ||
      !Number.isSafeInteger(input.count) || input.count < 1 || input.count > 100 ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(input.clientOperationId)) throw new Error('Invalid referral request.');
    const payer = u8aToHex(decodeAddress(input.payer)), target = canonicalPageUrl(input.target);
    const fingerprint = JSON.stringify([payer,target,input.count]);
    const now = Date.now();
    for (const [id,entry] of cache) if (entry.expires <= now) cache.delete(id);
    const existing = cache.get(input.clientOperationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Operation ID already belongs to different payment terms.');
      const response = await existing.result;
      // Revalidate rather than returning a revoked/stale cached authorization.
      await validateReferral(api,response.envelope,payer,target);
      return response;
    }
    if (active >= 16 || cache.size >= (config.maxEntries ?? 1000)) throw new Error('Signing capacity reached. Try again shortly.');
    active++;
    const result = (async () => {
      if (!await config.isOfferedTarget(target)) throw new Error('This host does not offer the target page.');
      const quote = await quoteReferral(api,payer,target,source,input.count,config.authorizationId);
      const p = { domain: u8aToHex(new TextEncoder().encode('WIKA_HOST_REFERRAL')), version:1,
        genesisHash:api.genesisHash.toHex(), sourcePage:source, sourcePeriod:quote.terms.sourcePeriod,
        authorizationId:config.authorizationId,targetPage:target,payer,count:input.count,
        requestId:u8aToHex(crypto.getRandomValues(new Uint8Array(32))),issuedAt:quote.chainTime,
        expiresAt:(BigInt(quote.chainTime)+300000n).toString(),termsVersion:quote.terms.version,termsHash:quote.termsHash };
      const envelope = { payload:p,publicKey:config.publicKey,signature:u8aToHex(await config.sign(blake2AsU8a(encodeReferralPayload(p),256))) };
      await validateReferral(api,envelope,payer,target);
      return { envelope,quote };
    })();
    cache.set(input.clientOperationId,{ fingerprint,expires:now+300000,result });
    try { return await result; }
    catch (e) { cache.delete(input.clientOperationId); throw e; }
    finally { active--; }
  };
}
