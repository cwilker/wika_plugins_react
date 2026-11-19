// Isolated development-chain test. Public fixture keys only; never run on a public network.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { createReferralIssuer, quoteReferral, validateReferral, referralPayloadForCall, recoverReferral } from '../packages/core/dist/index.js';
import { claimFixture } from '../../wika_node/compatibility/src/claims-fixture.mjs';
const endpoint=process.env.WIKA_NODE_URL;
if(!endpoint)throw new Error('WIKA_NODE_URL must point to an isolated dev chain.');
const api=await ApiPromise.create({provider:new WsProvider(endpoint),noInitWarn:true});
const directory=await mkdtemp(join(tmpdir(),'wika-host-referral-'));
const report={passed:false,scope:'Native macOS development chain; test fixture website proofs and public development signers',payments:[]};
let fixture;
try {
  assert((await api.rpc.system.chainType()).isDevelopment);
  await cryptoWaitReady();
  const ring=new Keyring({type:'sr25519'}), alice=ring.addFromUri('//Alice'),bob=ring.addFromUri('//Bob'),charlie=ring.addFromUri('//Charlie');
  const target='https://article.wika.test/shared',sources=['https://aggregator.wika.test/give','https://second.wika.test/give'];
  const hosts=[];
  for(let i=0;i<sources.length;i++){
    console.log('Registering host',i+1);
    const source=sources[i],dir=join(directory,String(i));await mkdir(dir);
    fixture=await claimFixture(api,dir,source);
    const proof=await fixture.proof(alice);await fixture.publish(proof);
    await fixture.submit(api.tx.owners.claimPage(proof.content));
    const started=Date.now();
    while((await api.query.owners.currentPeriod(source)).isNone){if(Date.now()-started>120000)throw new Error('Claim verification timed out');await new Promise(r=>setTimeout(r,1000));}
    const host=ring.addFromSeed(new Uint8Array(32).fill(21+i));
    await fixture.submit(api.tx.likes.authorizeHost(source,u8aToHex(host.publicKey)));
    const keys=await api.query.likes.hostKeys(source),id=keys[0][1].toString();
    const issue=createReferralIssuer(api,{source,authorizationId:id,publicKey:u8aToHex(host.publicKey),sign:d=>host.sign(d),isOfferedTarget:async t=>t===target});
    console.log('Host authorized',source,id);
    hosts.push({source,host,id,issue});
    await fixture.stop();fixture=null;
  }
  // Small finalized transaction helper; fees and nonce use the real chain.
  const submit=(tx,pair)=>new Promise((resolve,reject)=>{
    let stop,done=false;const timer=setTimeout(()=>{done=true;stop?.();reject(new Error('Finality timeout'));},90000);
    tx.signAndSend(pair,{nonce:-1},r=>{if(!r.status.isFinalized||done)return;done=true;clearTimeout(timer);stop?.();resolve(r);}).then(s=>{stop=s;if(done)s();},reject);
  });
  const call=e=>api.tx.likes.likeWithReferral(referralPayloadForCall(e.payload),e.publicKey,e.signature);
  const name=r=>r.dispatchError?.isModule?api.registry.findMetaError(r.dispatchError.asModule).name:r.dispatchError?.toString();
  for(let i=0;i<hosts.length;i++){
    const payer=i===0?bob:charlie,host=hosts[i],op=crypto.randomUUID();
    console.log('Issuing payment for host',i+1);
    const issued=await host.issue({payer:payer.address,target,count:1,clientOperationId:op});
    assert.deepEqual((await host.issue({payer:payer.address,target,count:1,clientOperationId:op})).envelope,issued.envelope);
    await assert.rejects(host.issue({payer:alice.address,target,count:1,clientOperationId:op}),/different payment/);
    await validateReferral(api,issued.envelope,payer.address,target);
    const before=BigInt((await api.query.system.account(alice.address)).data.free.toString());
    const paid=await submit(call(issued.envelope),payer);assert.equal(name(paid),undefined);
    assert(paid.events.some(({event})=>event.method==='ReferralPaid'));
    const after=BigInt((await api.query.system.account(alice.address)).data.free.toString());
    assert.equal(after-before,BigInt(issued.quote.terms.referralAmount));
    const replay=await submit(call(issued.envelope),payer);assert.equal(name(replay),'RequestConsumed');
    const recovered=await recoverReferral(api,issued.envelope,issued.quote.blockNumber);assert.equal(recovered.state,'finalized');
    assert.equal(recovered.receipt.txHash,paid.txHash.toHex());
    report.payments.push({host:host.source,requestId:issued.envelope.payload.requestId,terms:issued.quote.terms,receipt:recovered.receipt});
  }
  const raw=await submit(api.tx.likes.like('https://article.wika.test/unsigned',sources[0],1),bob);assert.equal(name(raw),'SignedReferralRequired');
  const direct=await submit(api.tx.likes.like('https://article.wika.test/direct','',1),bob);assert.equal(name(direct),undefined);
  // Economic settings can change behind the quote interface with no codec change.
  const issued=await hosts[0].issue({payer:bob.address,target,count:2,clientOperationId:crypto.randomUUID()});
  await submit(api.tx.sudo.sudo(api.tx.system.setStorage([[api.query.likes.shareReferrer.key(),'0x09'],[api.query.likes.shareAuthor.key(),'0x2d'],[api.query.likes.sharePreviousLikers.key(),'0x2d'] ])),alice);
  const stale=await submit(call(issued.envelope),bob);assert.equal(name(stale),'TermsChanged');
  const quote=await quoteReferral(api,bob.address,target,sources[0],2,hosts[0].id);assert.equal(quote.terms.shareReferrer,9);
  assert.notEqual(quote.termsHash,issued.quote.termsHash);
  // Revocation invalidates an already-issued request before payment execution.
  const next=await hosts[0].issue({payer:alice.address,target,count:1,clientOperationId:crypto.randomUUID()});
  await submit(api.tx.likes.revokeHost(sources[0],hosts[0].id),alice);
  const revoked=await submit(call(next.envelope),alice);assert.equal(name(revoked),'HostNotAuthorized');
  report.passed=true;report.runtime=api.runtimeVersion.specVersion.toString();report.genesisHash=api.genesisHash.toHex();
  console.log('PASS: two registered hosts, real payouts, idempotency, replay, recovery, unsigned cutoff, direct payment, economic changes and revocation');
} finally {
  await fixture?.stop();
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));
  console.log('Report:',join(directory,'result.json'));
  await api.disconnect();
}
