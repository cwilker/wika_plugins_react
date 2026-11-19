// Public development fixtures only. Run against a disposable --dev chain.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiPromise,WsProvider,Keyring} from '@polkadot/api';
import {cryptoWaitReady} from '@polkadot/util-crypto';
import {u8aToHex} from '@polkadot/util';
import {WikaClient,getPageEconomics,policySelection,quoteEconomics,quoteReferral,createReferralIssuer,referralPayloadForCall} from '../packages/core/dist/index.js';
import {claimFixture} from '../../wika_node/compatibility/src/claims-fixture.mjs';
if(!process.env.WIKA_NODE_URL)throw new Error('WIKA_NODE_URL must be a disposable dev chain.');
const api=await ApiPromise.create({provider:new WsProvider(process.env.WIKA_NODE_URL),noInitWarn:true}),dir=await mkdtemp(join(tmpdir(),'wika-economics-'));
const result={passed:false,scope:'Isolated native macOS development node; public fixture signers',checks:[]};let fixture;
const check=s=>{result.checks.push(s);console.log(s);};
const pause=()=>new Promise(r=>setTimeout(r,1000));
const submit=(tx,pair)=>new Promise((resolve,reject)=>{let stop,done=false;const timer=setTimeout(()=>{done=true;stop?.();reject(new Error('Finality timeout'));},90000);tx.signAndSend(pair,{nonce:-1},r=>{if(!r.status.isFinalized||done)return;done=true;clearTimeout(timer);stop?.();resolve(r);}).then(s=>{stop=s;if(done)s();},e=>{clearTimeout(timer);reject(e)});});
const name=r=>r.dispatchError?.isModule?api.registry.findMetaError(r.dispatchError.asModule).name:r.dispatchError?.toString();
const okay=async(tx,pair)=>{const r=await submit(tx,pair);assert.equal(name(r),undefined);assert(!r.events.some(({event})=>event.section==='sudo'&&event.method==='Sudid'&&event.data[0].isErr));return r;};
try{
 assert((await api.rpc.system.chainType()).isDevelopment);await cryptoWaitReady();
 const ring=new Keyring({type:'sr25519'}),alice=ring.addFromUri('//Alice'),bob=ring.addFromUri('//Bob'),charlie=ring.addFromUri('//Charlie'),dave=ring.addFromUri('//Dave'),eve=ring.addFromUri('//Eve'),ferdie=ring.addFromUri('//Ferdie');
 const source='https://economics-host.wika.test/give',target='https://economics.wika.test/custom',legacy='https://economics.wika.test/legacy';
 assert.equal((await api.query.likes.economicsActive()).toString(),'false','Use a fresh test chain');
 await okay(api.tx.likes.like(legacy,'',1),dave);const oldQueue=(await api.query.likes.likes(dave.address,legacy)).toHex();
 const h=(await api.rpc.chain.getHeader()).number.toNumber()+4;
 const treasury=await api.query.likes.account?.()??'0x6d6f646c4c494b455f4d4521000000000000000000000000000000000000000000';
 await okay(api.tx.sudo.sudo(api.tx.likes.scheduleEconomics(h,{version:1,ownerMin:0,ownerMax:9800,supporterMin:100,supporterMax:9800,referralMin:100,referralMax:9800,protocolBps:100,minimumPrice:100,treasury},4500,4500,900,4)),alice);
 while((await api.query.likes.economicsActive()).toString()!=='true')await pause();
 assert.equal((await api.query.likes.likes(dave.address,legacy)).toHex(),oldQueue);assert.equal((await getPageEconomics(api,legacy)).policy.ownerBps,3300);check('Boundary preserves legacy queue and frozen allocation');
 // Register target with a reviewed, non-default policy through actual verification.
 for(const [i,page,owner,custom] of [[0,target,bob,true],[1,source,alice,false]]){
  const sub=join(dir,String(i));await mkdir(sub);fixture=await claimFixture(api,sub,page);
  const proof=await fixture.proof(owner);await fixture.publish(proof);
  if(custom){const state=await getPageEconomics(api,page);const selection=policySelection(state,2500,6000,1400,true);const claims=WikaClient.fromApi(api).claims;const q=await claims.quote(owner.address,{kind:'claim',proof,policy:selection});assert(q.affordable);await okay(api.tx.owners.claimPageWithPolicy(proof.content,selection),owner);}
  else await okay(api.tx.owners.claimPage(proof.content),owner);
  const start=Date.now();while((await api.query.owners.currentPeriod(page)).isNone){if(Date.now()-start>120000)throw new Error('Claim timeout');await pause();}
  await fixture.stop();fixture=null;
 }
 let state=await getPageEconomics(api,target);assert.equal(state.policy.ownerBps,2500);assert.equal(state.policy.referralBps,1400);assert.equal(state.lockedAt,null);check('Verified custom claim activates 25/60/14/1; source claim inherits');
 const host=ring.addFromSeed(new Uint8Array(32).fill(47));await okay(api.tx.likes.authorizeHost(source,u8aToHex(host.publicKey)),alice);
 const id=(await api.query.likes.hostKeys(source))[0][1].toString();
 const issue=createReferralIssuer(api,{source,authorizationId:id,publicKey:u8aToHex(host.publicKey),sign:b=>host.sign(b),isOfferedTarget:async t=>t===target});
 const issued=await issue({payer:charlie.address,target,count:1,clientOperationId:crypto.randomUUID()});assert.equal(issued.envelope.payload.termsVersion,2);assert.equal(issued.quote.terms.referralAmount,'140000000000');
 const paid=await okay(api.tx.likes.likeWithReferral(referralPayloadForCall(issued.envelope.payload),issued.envelope.publicKey,issued.envelope.signature),charlie);
 const distribution=paid.events.find(({event})=>event.method==='PaymentDistribution').event.data[3].toJSON();assert.equal(BigInt(distribution.gross),BigInt(distribution.debit)+BigInt(distribution.retained)+BigInt(distribution.legacyDust));assert.equal(BigInt(distribution.referralCredit),140000000000n);
 state=await getPageEconomics(api,target);assert.notEqual(state.lockedAt,null);check('Host signs v2 runtime terms; exact referral and distribution receipts; first payment locks');
 const sdk=WikaClient.fromApi(api);const direct=await sdk.quoteLike(dave.address,{url:target,count:2});assert.equal(direct.request.economicTerms.version,2);assert(direct.economicQuote.economics.referralToTarget);assert.equal(direct.economicQuote.economics.policy.supporterBps,6000);
 await okay(api.tx.likes.likeWithTerms(target,2,2,direct.request.economicTerms.hash),dave);check('SDK direct payment commits custom terms and unused referral funds target escrow');
 const self=await quoteEconomics(api,bob.address,target,'',1);assert.equal(self.economics.retainedOwner,'390000000000');await okay(api.tx.likes.likeWithTerms(target,1,2,self.termsHash),bob);check('Owner self-allocation retained; debit and credits conserve');
 assert.equal(name(await submit(api.tx.likes.like(target,'',1),eve)),'EconomicTermsRequired');
 const selection={ownerBps:4500,supporterBps:4500,referralBps:900,ruleset:1,expectedRevision:state.policy.revision,expectedHash:state.policyHash,inheritIfChanged:false};assert.equal(name(await submit(api.tx.likes.configurePagePolicy(target,1,selection),bob)),'PolicyLocked');check('Old direct call and locked-policy edits rejected');
 const old=await quoteEconomics(api,eve.address,legacy,'',1);await okay(api.tx.likes.likeWithTerms(legacy,1,2,old.termsHash),eve);assert.equal((await getPageEconomics(api,legacy)).policy.ownerBps,3300);check('Legacy page pays under frozen policy through v2 direct quote');
 const fresh='https://economics.wika.test/stale';const stale=await quoteEconomics(api,ferdie.address,fresh,'',1);
 await okay(api.tx.sudo.sudo(api.tx.likes.publishDefault(3500,5000,1400)),alice);
 assert.equal(name(await submit(api.tx.likes.likeWithTerms(fresh,1,2,stale.termsHash),ferdie)),'TermsChanged');assert.equal((await api.query.likes.urls(fresh)).isNone,true);check('Changed default invalidates stale quote and failed payment leaves no page or lock');
 assert.equal((await getPageEconomics(api,target)).policy.ownerBps,2500);check('Locked custom policy survives later default change');
 result.passed=true;result.genesisHash=api.genesisHash.toHex();result.runtimeVersion=api.runtimeVersion.specVersion.toNumber();result.target=target;result.source=source;result.authorizationId=id;result.receipt=distribution;result.hostPublicKey=u8aToHex(host.publicKey);
}finally{if(fixture)await fixture.stop();await api.disconnect();const path=process.env.WIKA_ECONOMICS_REPORT??join(dir,'result.json');await writeFile(path,JSON.stringify(result,null,2));console.log('Report:',path);}
