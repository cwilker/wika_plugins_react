import { quoteEconomics, hashEconomicTerms, type EconomicTerms } from './economics';
import { TypeRegistry } from '@polkadot/types/create';
import type { ApiPromise } from '@polkadot/api';
import { blake2AsHex, cryptoWaitReady, decodeAddress, sr25519Verify } from '@polkadot/util-crypto';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { canonicalPageUrl } from './page-identity';
import type { WalletAccount, Signer, SubmitOptions } from './types';
import { submitFinalized } from './transactions';

/** JSON wire representation. Integer values are decimal strings, never JS floats. */
export interface ReferralPayload {
  domain: string; version: number; genesisHash: string; sourcePage: string; sourcePeriod: string;
  authorizationId: string; targetPage: string; payer: string; count: number; requestId: string;
  issuedAt: string; expiresAt: string; termsVersion: number; termsHash: string;
}
export interface ReferralEnvelope { payload: ReferralPayload; publicKey: string; signature: string }
export interface ReferralQuote {
  economics?: EconomicTerms;
  blockHash: string; blockNumber: string; chainTime: string; termsHash: string;
  terms: { version: number; genesisHash: string; payer: string; target: string; source: string;
    sourcePeriod: string; authorizationId: string; count: number; price: string; cost: string;
    recipient: string; referralAmount: string; targetOwner: string; targetPeriod: string | null;
    shareAuthor: number; shareReferrer: number; shareSupporters: number; rounds: number };
}
const encoder = new TextEncoder();
function fixed(hex: string, length: number): Uint8Array {
  if (!new RegExp(`^0x[0-9a-f]{${length * 2}}$`).test(hex)) throw new Error('Invalid referral hex.');
  return hexToU8a(hex);
}
function uint(value: string | number, width: number): Uint8Array {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid referral integer.');
  let n = BigInt(value);
  if (n >= 1n << BigInt(width * 8)) throw new Error('Referral integer overflow.');
  return Uint8Array.from({ length: width }, () => { const b = Number(n & 255n); n >>= 8n; return b; });
}
function page(value: string): Uint8Array {
  if (canonicalPageUrl(value) !== value) throw new Error('Noncanonical referral page.');
  const b = encoder.encode(value);
  const prefix = b.length < 64 ? uint(b.length << 2, 1) : uint((b.length << 2) | 1, 2);
  return Uint8Array.from([...prefix, ...b]);
}
const join = (...values: Uint8Array[]) => Uint8Array.from(values.flatMap(v => [...v]));
function account(value: string) { const b = decodeAddress(value); if (b.length !== 32) throw new Error('AccountId32 required.'); return b; }
/** Exact SCALE layout of pallet_likes::ReferralPayload<AccountId32>. */
export function encodeReferralPayload(p: ReferralPayload): Uint8Array {
  if (p.domain !== u8aToHex(encoder.encode('WIKA_HOST_REFERRAL')) || p.version !== 1 || ![1,2].includes(p.termsVersion)) throw new Error('Unsupported referral protocol.');
  return join(fixed(p.domain, 18), uint(p.version,2), fixed(p.genesisHash,32), page(p.sourcePage), uint(p.sourcePeriod,8),
    uint(p.authorizationId,8), page(p.targetPage), account(p.payer), uint(p.count,4), fixed(p.requestId,32),
    uint(p.issuedAt,8), uint(p.expiresAt,8), uint(p.termsVersion,2), fixed(p.termsHash,32));
}
export function hashReferralTerms(t: ReferralQuote['terms']): string {
  if(t.version===2) return hashEconomicTerms({registry:new TypeRegistry()} as unknown as ApiPromise,t as unknown as EconomicTerms);
  return blake2AsHex(join(uint(t.version,2), fixed(t.genesisHash,32), account(t.payer), page(t.target), page(t.source),
    uint(t.sourcePeriod,8), uint(t.authorizationId,8), uint(t.count,4), uint(t.price,16), uint(t.cost,16),
    account(t.recipient), uint(t.referralAmount,16), account(t.targetOwner),
    t.targetPeriod === null ? uint(0,1) : join(uint(1,1),uint(t.targetPeriod,8)),
    uint(t.shareAuthor,1),uint(t.shareReferrer,1),uint(t.shareSupporters,1),uint(t.rounds,1)),256);
}
export function referralPayloadForCall(p: ReferralPayload) {
  encodeReferralPayload(p);
  return { ...p, sourcePage: u8aToHex(encoder.encode(p.sourcePage)), targetPage: u8aToHex(encoder.encode(p.targetPage)) };
}
export function decodeReferralPayload(value: { toJSON(): unknown }): ReferralPayload {
  const raw = value.toJSON() as Record<string, unknown>;
  const decimal = (key: string) => { const v = raw[key]; return typeof v === 'string' && v.startsWith('0x') ? BigInt(v).toString() : String(v); };
  return { domain: String(raw.domain), version: Number(raw.version), genesisHash: String(raw.genesisHash),
    sourcePage: new TextDecoder('utf-8', { fatal: true }).decode(hexToU8a(String(raw.sourcePage))),
    sourcePeriod: decimal('sourcePeriod'), authorizationId: decimal('authorizationId'),
    targetPage: new TextDecoder('utf-8', { fatal: true }).decode(hexToU8a(String(raw.targetPage))),
    payer: String(raw.payer), count: Number(raw.count), requestId: String(raw.requestId), issuedAt: decimal('issuedAt'),
    expiresAt: decimal('expiresAt'), termsVersion: Number(raw.termsVersion), termsHash: String(raw.termsHash) };
}
export async function verifyReferralSignature(e: ReferralEnvelope): Promise<void> {
  await cryptoWaitReady();
  if (!sr25519Verify(fixed(blake2AsHex(encodeReferralPayload(e.payload),256),32), fixed(e.signature,64), fixed(e.publicKey,32)))
    throw new Error('Invalid host referral signature.');
}
const pageArg = (v: string) => u8aToHex(encoder.encode(canonicalPageUrl(v)));
/** Read-only quote API. Raw state_call avoids reliance on custom RPC server registration. */
export async function quoteReferral(api: ApiPromise, payer: string, target: string, source: string, count: number, authorizationId: string, at?: string): Promise<ReferralQuote> {
  const blockHash = at ?? (await api.rpc.chain.getFinalizedHead()).toHex();
  const state = await api.at(blockHash);
  if(state.query.likes.economicsActive && (await state.query.likes.economicsActive()).toString()==='true') return quoteEconomics(api,payer,target,source,count,authorizationId,blockHash);
  const targetBytes = page(canonicalPageUrl(target)), sourceBytes = page(canonicalPageUrl(source));
  const args = join(account(payer), targetBytes, sourceBytes, uint(count,4), uint(authorizationId,8));
  const result = await api.rpc.state.call('ReferralApi_quote', u8aToHex(args), blockHash);
  const tx = api.tx.likes.likeWithReferral;
  if (!tx) throw new Error('This runtime does not support signed referrals.');
  // The types are discoverable in metadata through the call's payload; terms use a fixed v1 schema.
  api.registry.register({ WikaReferralTermsV1: {
    version:'u16',genesisHash:'[u8;32]',payer:'AccountId32',target:'Bytes',source:'Bytes',sourcePeriod:'u64',authorizationId:'u64',
    count:'u32',price:'u128',cost:'u128',recipient:'AccountId32',referralAmount:'u128',targetOwner:'AccountId32',targetPeriod:'Option<u64>',
    shareAuthor:'u8',shareReferrer:'u8',shareSupporters:'u8',rounds:'u8'
  }});
  const decoded = api.registry.createType('Result<WikaReferralTermsV1, DispatchError>', result.toHex()) as unknown as {
    isErr: boolean; asErr: { toString(): string }; asOk: { toJSON(): unknown; toU8a(): Uint8Array }
  };
  if (decoded.isErr) throw new Error(`Referral quote rejected: ${decoded.asErr.toString()}`);
  const t = decoded.asOk.toJSON() as Record<string, unknown>;
  const decimal = (k: string) => typeof t[k] === 'string' && String(t[k]).startsWith('0x') ? BigInt(String(t[k])).toString() : String(t[k]);
  const terms: ReferralQuote['terms'] = { version:Number(t.version), genesisHash:String(t.genesisHash), payer:String(t.payer),
    target:canonicalPageUrl(target),source:canonicalPageUrl(source),sourcePeriod:decimal('sourcePeriod'),authorizationId:decimal('authorizationId'),
    count:Number(t.count),price:decimal('price'),cost:decimal('cost'),recipient:String(t.recipient),referralAmount:decimal('referralAmount'),
    targetOwner:String(t.targetOwner),targetPeriod:t.targetPeriod == null ? null : decimal('targetPeriod'),shareAuthor:Number(t.shareAuthor),
    shareReferrer:Number(t.shareReferrer),shareSupporters:Number(t.shareSupporters),rounds:Number(t.rounds) };
  const [header, time] = await Promise.all([api.rpc.chain.getHeader(blockHash), state.query.timestamp.now()]);
  const termsHash = blake2AsHex(decoded.asOk.toU8a(),256);
  if (hashReferralTerms(terms) !== termsHash) throw new Error('Unsupported economic terms encoding.');
  return { blockHash, blockNumber:header.number.toString(), chainTime:time.toString(), terms, termsHash };
}
/** Independent validation used by client, server and official wallet. */
export async function validateReferral(api: ApiPromise, envelope: ReferralEnvelope, payer: string, expectedTarget?: string, at?: string): Promise<ReferralQuote> {
  await verifyReferralSignature(envelope);
  const p = envelope.payload;
  if (u8aToHex(account(p.payer)) !== u8aToHex(account(payer)) || p.genesisHash !== api.genesisHash.toHex() || (expectedTarget && p.targetPage !== canonicalPageUrl(expectedTarget))) throw new Error('Referral payer, target or chain mismatch.');
  const quote = await quoteReferral(api, payer, p.targetPage, p.sourcePage, p.count, p.authorizationId, at);
  const now = BigInt(quote.chainTime), start = BigInt(p.issuedAt), end = BigInt(p.expiresAt);
  if (start > now || end <= now || end <= start || end - start > 300000n) throw new Error('Referral request expired or not yet valid.');
  if (p.sourcePeriod !== quote.terms.sourcePeriod) throw new Error('Host ownership changed.');
  if (p.termsHash !== quote.termsHash || p.termsVersion !== quote.terms.version) throw new Error('TermsChanged: refresh the quote and approve again.');
  const state = await api.at(quote.blockHash);
  const keys = await state.query.likes.hostKeys(pageArg(p.sourcePage));
  const found = [...(keys as unknown as Iterable<Iterable<{ toString(): string; toHex?(): string }>>)].some(row => {
    const [period,id,key] = [...row]; return period.toString() === p.sourcePeriod && id.toString() === p.authorizationId && key.toHex?.() === envelope.publicKey;
  });
  if (!found) throw new Error('Host key is no longer authorized.');
  const used = await state.query.likes.usedRequests(p.authorizationId,p.requestId);
  if (!(used as unknown as { isNone: boolean }).isNone) throw new Error('Referral request has already been used.');
  return quote;
}
export interface HostKeyInfo { period: string; authorizationId: string; publicKey: string; eligible: boolean; eligibilityError?: string }
export class WikaReferralClient {
  constructor(readonly api: ApiPromise) {}
  quote(payer: string,target: string,source: string,count: number,id: string) { return quoteReferral(this.api,payer,target,source,count,id); }
  authorize(account: WalletAccount, signer: Signer, source: string, publicKey: string, options?: SubmitOptions) {
    return submitFinalized(this.api,this.api.tx.likes.authorizeHost(pageArg(source),u8aToHex(fixed(publicKey,32))),account,signer,options);
  }
  revoke(account: WalletAccount, signer: Signer, source: string, id: string, options?: SubmitOptions) {
    return submitFinalized(this.api,this.api.tx.likes.revokeHost(pageArg(source),id),account,signer,options);
  }
  async keys(source: string) {
    const at = await this.api.at(await this.api.rpc.chain.getFinalizedHead());
    const records = await at.query.likes.hostKeys(pageArg(source));
    const owner = await at.query.owners.owners(pageArg(source));
    const payer = (owner as unknown as { isNone: boolean; unwrap(): { toString(): string } }).isNone ? undefined
      : (owner as unknown as { unwrap(): { toString(): string } }).unwrap().toString();
    const result: HostKeyInfo[] = [];
    for (const record of records as unknown as Iterable<Iterable<{ toString(): string; toHex(): string }>>) {
      const [period,id,key] = [...record];
      const entry: HostKeyInfo = { period:period.toString(), authorizationId:id.toString(), publicKey:key.toHex(), eligible:false };
      if (payer) try { await quoteReferral(this.api,payer,source,source,1,entry.authorizationId,at.registry.createdAtHash?.toHex()); entry.eligible=true; }
      catch(error) { entry.eligibilityError = error instanceof Error ? error.message : String(error); }
      result.push(entry);
    }
    return result;
  }
}
/** Bounded receipt recovery. Persist nextBlock and continue if historical scanning needs another batch. */
export async function recoverReferral(api: ApiPromise, envelope: ReferralEnvelope, fromBlock: string): Promise<{
  state: 'pending' | 'finalized' | 'expired'; nextBlock: string; receipt?: import('./types').LikeReceipt;
}> {
  const finalized = (await api.rpc.chain.getFinalizedHead()).toHex();
  const tip = await api.rpc.chain.getHeader(finalized);
  let next = BigInt(fromBlock), upper = BigInt(tip.number.toString());
  for (let n=0; n<64 && next<=upper; n++,next++) {
    const hash = (await api.rpc.chain.getBlockHash(next.toString())).toHex();
    const state = await api.at(hash);
    const [events,time] = await Promise.all([state.query.system.events(),state.query.timestamp.now()]);
    for (const record of events as unknown as Iterable<{ phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber():number } }; event: { section:string;method:string;data:{toJSON():unknown} } }>) {
      if (record.event.section !== 'likes' || record.event.method !== 'ReferralPaid') continue;
      const d = record.event.data.toJSON() as unknown[];
      if (BigInt(String(d[5])).toString() === envelope.payload.authorizationId && String(d[6]) === envelope.payload.requestId) {
        const block = await api.rpc.chain.getBlock(hash);
        const index = record.phase.asApplyExtrinsic.toNumber();
        return { state:'finalized',nextBlock:(next+1n).toString(),receipt:{txHash:block.block.extrinsics[index].hash.toHex(),blockHash:hash,blockNumber:next.toString()} };
      }
    }
    if (BigInt(time.toString()) >= BigInt(envelope.payload.expiresAt)) return { state:'expired',nextBlock:(next+1n).toString() };
  }
  return { state:'pending',nextBlock:next.toString() };
}
/** SCALE mortal-era death, derived from the actual wallet signing payload. */
export function signingExpiry(blockNumber: string, era: string): string | null {
  const b=hexToU8a(era);
  if(b.length===1 && b[0]===0)return null;
  if(b.length!==2)throw new Error('Invalid signing era.');
  const encoded=b[0]+b[1]*256,period=BigInt(2 << (encoded & 15)),factor=period>>12n || 1n;
  const phase=BigInt(encoded>>4)*factor,current=BigInt(blockNumber);
  if(phase>=period || current<phase)throw new Error('Invalid signing era phase.');
  return (((current-phase)/period)*period+phase+period).toString();
}
export async function recoverDirectPayment(api: ApiPromise, input: {payer:string;target:string;count:number;nextBlock:string;txHash?:string|null;deathBlock?:string|null}): Promise<{
 state:'pending'|'finalized'|'failed'|'expired';nextBlock:string;receipt?:import('./types').LikeReceipt;
}> {
 const tip=await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead());
 let next=BigInt(input.nextBlock),upper=BigInt(tip.number.toString());
 for(let n=0;n<64 && next<=upper;n++,next++){
  const hash=(await api.rpc.chain.getBlockHash(next.toString())).toHex(),at=await api.at(hash);
  const [block,events]=await Promise.all([api.rpc.chain.getBlock(hash),at.query.system.events()]);
  const txIndex=input.txHash?block.block.extrinsics.findIndex(tx=>tx.hash.toHex()===input.txHash):-1;
  for(const r of events as unknown as Iterable<{phase:{isApplyExtrinsic:boolean;asApplyExtrinsic:{toNumber():number}};event:{section:string;method:string;data:{toJSON():unknown}}}>){
   if(!r.phase.isApplyExtrinsic)continue;
   const index=r.phase.asApplyExtrinsic.toNumber(),e=r.event;
   if(txIndex>=0 && index===txIndex && e.section==='system' && e.method==='ExtrinsicFailed')return{state:'failed',nextBlock:(next+1n).toString()};
   if(e.section==='likes' && e.method==='Liked'){
    const d=e.data.toJSON() as unknown[];
    if(u8aToHex(decodeAddress(String(d[0])))===u8aToHex(decodeAddress(input.payer)) &&
      new TextDecoder().decode(hexToU8a(String(d[1])))===canonicalPageUrl(input.target) && Number(d[2])===input.count &&
      (!input.txHash || index===txIndex))return{state:'finalized',nextBlock:(next+1n).toString(),receipt:{txHash:block.block.extrinsics[index].hash.toHex(),blockHash:hash,blockNumber:next.toString()}};
   }
  }
  if(input.deathBlock && next>=BigInt(input.deathBlock))return{state:'expired',nextBlock:(next+1n).toString()};
 }
 return {state:'pending',nextBlock:next.toString()};
}
