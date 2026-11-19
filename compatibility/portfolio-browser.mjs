import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(
  new URL(
    "../../wika_browser_ext_react/v2/node_modules/playwright/index.mjs",
    import.meta.url,
  ).href
);
import { writeFile, unlink } from "node:fs/promises";
const root = fileURLToPath(new URL("../examples/owners", import.meta.url));
const output = fileURLToPath(
  new URL("./reports/portfolio-browser/", import.meta.url),
);
await mkdir(output, { recursive: true });
const name = `__portfolio_review_${process.pid}__`;
const html = root + `/${name}.html`,
  source = root + `/src/${name}.tsx`;
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { OwnersApp } from './App';
import '@wika/react/styles.css';
import './style.css';
const address='5C62Ck4UrFPiBtoCmeSrgF7x9yv9mn38446dhCpsi2mLHiFT';
const old={id:1n,owner:address,startedAt:1000n,endedAt:2000n,balance:18000000000000n,proof:'proof',verifiedAt:null,withdrawable:18000000000000n};
const current={...old,id:7n,owner:'5FNewOwner',endedAt:null,balance:23000000000000n,withdrawable:0n};
const claims={ getFinalizedHeight:async()=>120, isSameAccount:(a,b)=>a===b,
 getNetwork:async()=>network,
 getPage:async(url)=>({url,atBlock:'0xblock',chainTime:1000n,unclaimed:0n,current:url.includes('current')?{...current,owner:address}:current,pending:null,verificationPending:url.includes('pending'),lastVerification:null,retry:null}),
 getPeriod:async(url,id)=>({...old,id}), quote:async(account,action)=>({account,action,networkFee:100000000n,verificationFee:0n,refundableBond:0n,totalRequired:100000000n,affordable:true,atBlock:'0xblock'}) };
const network={name:'Wika development',genesisHash:'0xreview',decimals:12,symbol:'WIKA'};
window.fetch=async(_url,options)=>{const {query}=JSON.parse(options.body);const field=query.includes('ownershipPeriods')?'ownershipPeriods':query.includes('pageReplacements')?'pageReplacements':'claimVerifications';return new Response(JSON.stringify({data:query.includes('PortfolioStatus')?{_metadata:{genesisHash:'0xreview',startHeight:1,lastProcessedHeight:117,indexerHealthy:true,lastProcessedTimestamp:new Date().toISOString()}}:{[field]:{nodes:field==='ownershipPeriods'?[{id:'old',url:'https://journal.example/first-story',period:'1'},{id:'current',url:'https://journal.example/current-story',period:'7'}]:field==='claimVerifications'?[{id:'pending',url:'https://journal.example/pending-story'}]:[],pageInfo:{hasNextPage:false,endCursor:null}}}}));};
createRoot(document.getElementById('review')).render(<OwnersApp connect={async()=>({claims,getNetwork:async()=>network,supportsSafeClaims:true,disconnect:async()=>{}})} wallet={{connect:async()=>[{address,name:'Alice',source:'review'}],getSigner:async()=>({})}}/>);`;
let browser,
  ownsHtml = false,
  ownsSource = false;
try {
  await writeFile(
    html,
    `<html><head><title>Portfolio review fixture</title></head><body><div id="review"></div><script type="module" src="/src/${name}.tsx"></script></body></html>`,
    { flag: "wx" },
  );
  ownsHtml = true;
  await writeFile(source, fixture, { flag: "wx" });
  ownsSource = true;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: "chromium" }),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `${process.env.WIKA_OWNERS_REVIEW_URL || "http://127.0.0.1:3016"}/${name}.html`,
  );
  await page.getByRole("button", { name: "Connect node", exact: true }).click();
  await page
    .getByRole("button", { name: "Use connected wallet", exact: true })
    .click();
  await page.getByText("Earlier ownership", { exact: true }).waitFor();
  await page.screenshot({ path: output + "/desktop.png", fullPage: true });
  await page
    .getByRole("button", { name: "Manage page", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Review withdrawal", exact: true })
    .first()
    .click();
  await page
    .getByRole("region", { name: "Historical withdrawal quote" })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + "/mobile.png", fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw new Error("Page overflows mobile viewport");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: true,
      desktop: "1440x1080",
      mobile: "390x844",
      oldPeriodQuote: true,
      bodyOverflow: false,
      pageErrors: errors,
      scope: "controlled browser node/indexer fixture; not a live chain",
    }),
  );
} finally {
  await browser?.close();
  if (ownsSource) await unlink(source);
  if (ownsHtml) await unlink(html);
}
