import { expect, it } from 'vitest';
import { blake2AsHex } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { encodeReferralPayload, hashReferralTerms, verifyReferralSignature } from '../src/referrals';
import vector from './fixtures/host-referral-v1.json';
it('matches the runtime SCALE, economic commitment and sr25519 golden vector',async()=>{
  expect(u8aToHex(encodeReferralPayload(vector.envelope.payload))).toBe(vector.encoded);
  expect(hashReferralTerms(vector.terms)).toBe(vector.envelope.payload.termsHash);
  expect(blake2AsHex(encodeReferralPayload(vector.envelope.payload),256)).toBe(vector.digest);
  await verifyReferralSignature(vector.envelope);
});
it('rejects mutations in every signed field',async()=>{
  const p=vector.envelope.payload;
  const mutations={ domain:'0x'+'00'.repeat(18),version:2,genesisHash:'0x'+'05'.repeat(32),sourcePage:'https://other.example/',
    sourcePeriod:'3',authorizationId:'18',targetPage:'https://other.example/',payer:'0x'+'05'.repeat(32),count:2,requestId:'0x'+'06'.repeat(32),
    issuedAt:'600001',expiresAt:'900001',termsVersion:2,termsHash:'0x'+'07'.repeat(32) };
  for(const [field,value] of Object.entries(mutations)) await expect(verifyReferralSignature({...vector.envelope,payload:{...p,[field]:value}})).rejects.toThrow();
});
it('rejects noncanonical URLs, malformed integers, bounds and hex',()=>{
  for(const change of [{sourcePage:'https://host.example/give#x'},{count:-1},{issuedAt:'18446744073709551616'},{requestId:'0x01'}])
    expect(()=>encodeReferralPayload({...vector.envelope.payload,...change})).toThrow();
});
it('commits economic configurations and recipient identity independently of the envelope format',()=>{
  for(const changes of [{price:'2000000000000'},{shareReferrer:9,referralAmount:'90000000000'},{recipient:'0x'+'09'.repeat(32)},{rounds:6},{targetPeriod:'4'}])
    expect(hashReferralTerms({...vector.terms,...changes})).not.toBe(vector.envelope.payload.termsHash);
});

import { signingExpiry, recoverDirectPayment } from '../src/referrals';
it('derives mortality from the actual signed era without a wall-clock assumption',()=>{
  expect(signingExpiry('0x00000001','0x1500')).toBe('65'); // period 64, phase 1
  expect(signingExpiry('65','0x1500')).toBe('129');
  expect(signingExpiry('1','0x00')).toBe(null);
  expect(()=>signingExpiry('1','0x01')).toThrow();
});
it('recovers direct finalization, finalized failure and mortality expiry through bounded history',async()=>{
  const payer=vector.terms.payer,target=vector.terms.target;
  let method='Liked';
  const api={rpc:{chain:{getFinalizedHead:async()=>({toHex:()=> '0xhead'}),getHeader:async()=>({number:{toString:()=> '3'}}),
    getBlockHash:async(n:string)=>({toHex:()=> '0xblock'+n}),getBlock:async()=>({block:{extrinsics:[{hash:{toHex:()=> '0xtx'}}]}})}},
    at:async()=>({query:{system:{events:async()=>[{phase:{isApplyExtrinsic:true,asApplyExtrinsic:{toNumber:()=>0}},event:{section:method==='Liked'?'likes':'system',method,data:{toJSON:()=>[payer,u8aToHex(new TextEncoder().encode(target)),1]}}}]}}})} as never;
  const request={payer,target,count:1,nextBlock:'1',txHash:'0xtx'};
  expect((await recoverDirectPayment(api,request)).state).toBe('finalized');
  method='ExtrinsicFailed';expect((await recoverDirectPayment(api,request)).state).toBe('failed');
  method='ExtrinsicSuccess';expect((await recoverDirectPayment(api,{...request,deathBlock:'2'})).state).toBe('expired');
  expect(await recoverDirectPayment(api,request)).toEqual({state:'pending',nextBlock:'4'});
});
