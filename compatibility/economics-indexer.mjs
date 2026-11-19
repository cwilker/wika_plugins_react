// Read-only acceptance against an explicitly selected disposable local index.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../../wika_etl/subql_wika/package.json',import.meta.url));const {Client}=require('pg');
const port=process.env.WIKA_TEST_DB_PORT,schema=process.env.WIKA_ECONOMICS_DB_SCHEMA,query=process.env.WIKA_ECONOMICS_QUERY_URL;
if(!port||!schema||!/^economics_[a-z_]+$/.test(schema)||!query||!['127.0.0.1','localhost'].includes(new URL(query).hostname))throw new Error('Explicit disposable DB port, economics_* schema and loopback query service required.');
const db=new Client({host:'127.0.0.1',port:Number(port),user:'postgres',password:'postgres',database:'postgres'});await db.connect();
const report={passed:false,scope:'Actual SubQuery replay → disposable PostgreSQL → bounded GraphQL queries',schema};
try{
 await db.query('BEGIN READ ONLY');
 const payments=(await db.query(`SELECT * FROM "${schema}".economic_payments WHERE upper_inf(_block_range) ORDER BY block_num,event_index LIMIT 100`)).rows;
 assert(payments.length>=4);assert(payments.some(p=>p.model===0));assert(payments.some(p=>p.model===1));
 for(const p of payments){assert.equal(BigInt(p.gross),BigInt(p.debit)+BigInt(p.retained)+BigInt(p.legacy_dust));assert.equal(BigInt(p.debit),BigInt(p.owner_credit)+BigInt(p.supporter_paid)+BigInt(p.supporter_fallback)+BigInt(p.referral_credit)+BigInt(p.protocol_credit));}
 const policy=(await db.query(`SELECT * FROM "${schema}".page_payout_policies WHERE id=$1 AND upper_inf(_block_range)`,['https://economics.wika.test/custom'])).rows[0];assert(policy.locked);assert.equal(policy.owner_bps,2500);assert.equal(policy.supporter_bps,6000);assert.equal(policy.referral_bps,1400);
 const outcomes=(await db.query(`SELECT attempt,account,applied,reason FROM "${schema}".policy_activities WHERE method='ClaimPolicyOutcome' AND upper_inf(_block_range) ORDER BY block_num LIMIT 100`)).rows;
 assert(outcomes.some(o=>o.applied&&o.reason==='Applied'));
 const history=(await db.query(`SELECT COUNT(*) AS count FROM "${schema}".supporter_payments WHERE upper_inf(_block_range)`)).rows[0];assert(BigInt(history.count)>0);
 await db.query('COMMIT');
 const response=await fetch(query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query { economicPayments(first:100) { nodes { id gross debit retained legacyDust ownerCredit supporterPaid supporterFallback referralCredit protocolCredit } } policyActivities(first:20,filter:{method:{equalTo:"ClaimPolicyOutcome"}}) { nodes { attempt applied reason } } }'})});
 const body=await response.json();assert.equal(body.errors,undefined,JSON.stringify(body.errors));assert.equal(body.data.economicPayments.nodes.length,payments.length);
 for(const p of body.data.economicPayments.nodes)assert.equal(BigInt(p.gross),BigInt(p.debit)+BigInt(p.retained)+BigInt(p.legacyDust));
 report.payments=payments.map(({id,model,gross,debit,retained,legacy_dust,policy_hash})=>({id,model,gross,debit,retained,legacyDust:legacy_dust,policyHash:policy_hash}));report.policy={ownerBps:policy.owner_bps,supporterBps:policy.supporter_bps,referralBps:policy.referral_bps,locked:policy.locked};report.claimOutcomes=outcomes;report.supporterPayments=history.count;report.graphql=true;report.passed=true;
 console.log('PASS',payments.length,'exact receipts, policy history, claim outcomes and bounded GraphQL');
}finally{await db.end();if(process.env.WIKA_ECONOMICS_INDEX_REPORT)await writeFile(process.env.WIKA_ECONOMICS_INDEX_REPORT,JSON.stringify(report,null,2));}
