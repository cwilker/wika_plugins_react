import { beforeAll, expect, it, vi } from 'vitest';
import { cryptoWaitReady, sr25519PairFromSeed, sr25519Sign } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import vector from './fixtures/host-referral-v1.json';
vi.mock('../src/referrals',async original=>{
  const actual=await original<typeof import('../src/referrals')>();
  return {...actual,quoteReferral:vi.fn(async()=>({blockHash:'0xblock',blockNumber:'100',chainTime:'600000',termsHash:vector.envelope.payload.termsHash,terms:vector.terms})),
    validateReferral:vi.fn(async(_api,e)=>{await actual.verifyReferralSignature(e);return {terms:vector.terms};})};
});
import { createReferralIssuer } from '../src/host-issuer';
import { verifyReferralSignature } from '../src/referrals';
beforeAll(async()=>{await cryptoWaitReady();});
it('issues one payer-bound envelope for concurrent identical operations and rejects repurposing',async()=>{
  const pair=sr25519PairFromSeed(new Uint8Array(32).fill(7)),sign=vi.fn((digest:Uint8Array)=>sr25519Sign(digest,pair));
  const api={genesisHash:{toHex:()=>vector.terms.genesisHash}} as never;
  const offered=vi.fn(async()=>true);
  const issue=createReferralIssuer(api,{source:vector.terms.source,authorizationId:'17',publicKey:u8aToHex(pair.publicKey),sign,isOfferedTarget:offered});
  const input={payer:vector.terms.payer,target:vector.terms.target,count:1,clientOperationId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
  const [a,b]=await Promise.all([issue(input),issue(input)]);
  expect(a).toEqual(b);expect(sign).toHaveBeenCalledOnce();expect(a.envelope.payload.payer).toBe(input.payer);
  expect(BigInt(a.envelope.payload.expiresAt)-BigInt(a.envelope.payload.issuedAt)).toBe(300000n);
  await verifyReferralSignature(a.envelope);
  await expect(issue({...input,count:2})).rejects.toThrow('different payment');
});
it('does not sign unsupported targets or allow client overrides and bounds issuance memory',async()=>{
  const api={genesisHash:{toHex:()=>vector.terms.genesisHash}} as never,sign=vi.fn(()=>new Uint8Array(64));
  const issue=createReferralIssuer(api,{source:vector.terms.source,authorizationId:'17',publicKey:vector.envelope.publicKey,sign,isOfferedTarget:async()=>false,maxEntries:1});
  await expect(issue({payer:vector.terms.payer,target:vector.terms.target,count:1,clientOperationId:'aaaaaaaaaaaaaaaa'})).rejects.toThrow('does not offer');
  expect(sign).not.toHaveBeenCalled();
  await expect(issue({payer:vector.terms.payer,target:vector.terms.target,count:0,clientOperationId:'aaaaaaaaaaaaaaaa'})).rejects.toThrow('Invalid');
});
