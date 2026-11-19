// Real extension + shared claim form, disposable development accounts/profile only.
import {ApiPromise,WsProvider,Keyring} from '@polkadot/api';
import {cryptoWaitReady} from '@polkadot/util-crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {claimFixture} from '../../wika_node/compatibility/src/claims-fixture.mjs';
const {chromium}=await import('../../wika_browser_ext_react/v2/node_modules/playwright/index.mjs');
const endpoint=process.env.WIKA_NODE_URL,ext=process.env.WIKA_EXTENSION_PATH,server=process.env.WIKA_OWNERS_REVIEW_URL;
if(!endpoint||!ext||!server||!['127.0.0.1','localhost'].includes(new URL(server).hostname))throw new Error('Explicit disposable endpoint, extension and loopback owners server required.');
const api=await ApiPromise.create({provider:new WsProvider(endpoint),noInitWarn:true});assert((await api.rpc.system.chainType()).isDevelopment);
const root=fileURLToPath(new URL('../examples/owners/',import.meta.url)),profile=await mkdtemp(join(tmpdir(),'wika-economics-browser-'));
const output=process.env.WIKA_ECONOMICS_REPORT_DIR??fileURLToPath(new URL('./reports/page-economics/',import.meta.url));await mkdir(output,{recursive:true});
const name='__economics_review_'+process.pid,html=join(root,name+'.html'),source=join(root,'src',name+'.tsx');
const report={passed:false,stages:[],errors:[]};let fixture,context,ownsHtml=false,ownsSource=false;
try{
 await writeFile(html,`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/${name}.tsx"></script></body></html>`,{flag:'wx'});ownsHtml=true;
 await writeFile(source,`import React from 'react';import {createRoot} from 'react-dom/client';import {WikaClient} from '@wika/core';import {WikaClaim} from '@wika/react';import '@wika/react/styles.css';const client=await WikaClient.connect({endpoint:${JSON.stringify(endpoint)}});createRoot(document.getElementById('root')!).render(<main style={{maxWidth:760,margin:'auto',padding:16,fontFamily:'system-ui'}}><WikaClaim client={client.claims} url={new URLSearchParams(location.search).get('page')??''}/></main>);`,{flag:'wx'});ownsSource=true;
 context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 let [worker]=context.serviceWorkers();worker??=await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 const rpc=async(type,payload={})=>{const r=await popup.evaluate(async({type,payload})=>chrome.runtime.sendMessage({kind:'req',id:crypto.randomUUID(),type,payload}),{type,payload});if(!r.ok)throw new Error(JSON.stringify(r.error));return r.data;};
 const password='public development test only';await rpc('vault.create',{password});await cryptoWaitReady();const bob=new Keyring({type:'sr25519'}).addFromUri('//Bob');await rpc('account.add',{source:'json',name:'Policy owner',json:bob.toJson(password),password});await rpc('prefs.update',{networkId:'custom:'+endpoint,theme:'light'});
 const pages=[['native','https://economics.wika.test/browser-native',true],['react','https://economics.wika.test/browser-react',true],['inherited','https://economics.wika.test/legacy',false]];
 for(const [mode,target,custom]of pages){
  const dir=join(profile,mode);await mkdir(dir);fixture=await claimFixture(api,dir,target);
  const page=mode==='native'||mode==='inherited'?popup:await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(mode==='native'||mode==='inherited'?`chrome-extension://${id}/popup.html`:`${server}/${name}.html?page=${encodeURIComponent(target)}`);
  if(mode!=='react'){await page.getByRole('link',{name:'Claim',exact:true}).click();await page.getByLabel('Page address',{exact:true}).fill(target);}
  await page.getByRole('heading',{name:'Page ownership',exact:true}).waitFor();
  const connect=page.getByRole('button',{name:'Connect wallet',exact:true});
  if(mode==='react'){
   const approval=context.waitForEvent('page');await connect.click();const win=await approval;await win.getByRole('button',{name:'Connect',exact:true}).click();
  }else await connect.click();
  if(custom){await page.getByLabel('Selection',{exact:true}).selectOption('custom');for(const [field,value]of [['Owner (%)','25'],['Supporters (%)','60'],['Referrals (%)','14']])await page.getByLabel(field,{exact:true}).fill(value);await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Use this split for review',exact:true}).click();}
  else await page.getByText(/inherited legacy payout policy is fixed/).waitFor();
  if(mode==='react'){
   const approval=context.waitForEvent('page');await page.getByRole('button',{name:'Sign publishing proof',exact:true}).click();const win=await approval;await win.getByRole('button',{name:'Sign',exact:true}).click();
  }else await page.getByRole('button',{name:'Sign publishing proof',exact:true}).click();
  const tag=await page.getByLabel('Publish exactly one tag in the server-delivered HTML head').inputValue();const content=/content="([^"]+)"/.exec(tag)?.[1];assert(content);await fixture.publish({content});
  await page.getByRole('button',{name:'Published the tag — review claim',exact:true}).click();await page.getByText('Review before signing',{exact:true}).waitFor();
  if(custom)assert((await page.locator('body').innerText()).includes('25% owner'));
  await page.setViewportSize({width:375,height:800});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(output,mode+'-claim-review.png'),fullPage:true});
  if(mode==='react'){
   const approval=context.waitForEvent('page');await page.getByRole('button',{name:'Submit for wallet approval',exact:true}).click();const win=await approval;await win.getByText('Page payout selection',{exact:true}).waitFor();await win.screenshot({path:join(output,'injected-policy-approval.png'),fullPage:true});await win.getByRole('button',{name:'Sign',exact:true}).click();
  }else await page.getByRole('button',{name:'Submit for wallet approval',exact:true}).click();
  const started=Date.now();while((await api.query.owners.currentPeriod(target)).isNone){if(Date.now()-started>150000)throw new Error('Browser claim verification timeout');await new Promise(r=>setTimeout(r,1000));}
  if(custom){const policy=(await api.query.likes.pagePolicies(target)).unwrap();assert.equal(policy.ownerBps.toNumber(),2500);assert.equal(policy.referralBps.toNumber(),1400);await page.getByText(/Selected payout policy applied/).waitFor({timeout:15000});}
  else assert.equal((await api.query.likes.pagePolicies(target)).isNone,true);
  await page.reload();if(mode!=='react'){await page.getByRole('link',{name:'Claim',exact:true}).click();await page.getByLabel('Page address',{exact:true}).fill(target);}await page.getByRole('heading',{name:'Page ownership',exact:true}).waitFor();await page.screenshot({path:join(output,mode+'-activated.png'),fullPage:true});
  report.stages.push(`${mode}: actual proof signing → selected/inherited terms review → on-chain verification → correct active policy → reload`);await fixture.stop();fixture=null;
 }
 assert.deepEqual(report.errors,[]);report.passed=true;console.log('PASS',report.stages);
}catch(e){for(const p of context?.pages()??[])console.log('PAGE',p.url(),await p.locator('body').innerText().catch(()=>''));throw e;}
finally{if(fixture)await fixture.stop();await writeFile(join(output,'browser-claims.json'),JSON.stringify(report,null,2));await context?.close();await api.disconnect();if(ownsHtml)await rm(html,{force:true});if(ownsSource)await rm(source,{force:true});await rm(profile,{recursive:true,force:true});}
