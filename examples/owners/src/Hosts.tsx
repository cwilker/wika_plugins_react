import { useEffect, useRef, useState } from 'react';
import type { WikaReferralClient, WalletAdapter, HostKeyInfo } from '@wika/core';
export function Hosts({ client, wallet, source }: { client: WikaReferralClient; wallet: WalletAdapter; source: string }) {
  const [keys,setKeys]=useState<HostKeyInfo[] | null>(null),[publicKey,setPublicKey]=useState(''),[accounts,setAccounts]=useState<Awaited<ReturnType<WalletAdapter['connect']>>>([]);
  const [selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [generation,setGeneration]=useState(''),[refresh,setRefresh]=useState(0);
  const pending=useRef(false);
  useEffect(()=>{let live=true;client.keys(source).then(v=>{if(live)setKeys(v);},e=>{if(live)setMessage(e.message);});return()=>{live=false;};},[client,source,refresh]);
  async function connect(){try{setAccounts(await wallet.connect('Wika host management'));}catch(e){setMessage(String(e));}}
  async function act(revoke:boolean){
    const account=accounts.find(a=>a.address===selected);if(!account || pending.current)return;
    pending.current=true;setBusy(true);setMessage('Approve in your wallet.');
    try{
      const signer=await wallet.getSigner(account);
      const options={onStatus:(s:string)=>setMessage(s)};
      if(revoke){if(!/^[1-9][0-9]*$/.test(generation))throw new Error('Enter an authorization ID.');await client.revoke(account,signer,source,generation,options);}
      else {if(!/^0x[0-9a-f]{64}$/.test(publicKey))throw new Error('Enter a 32-byte lowercase hex public key.');await client.authorize(account,signer,source,publicKey,options);}
      setMessage('Finalized.');setRefresh(v=>v+1);
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);pending.current=false;}
  }
  return <section className="history"><h3>Referral host keys</h3>
    <p>Authorize a server public key for this exact page. Keep its secret on your server. Host keys sign referral requests and cannot spend your wallet funds.</p>
    <p>Only the current verified owner can manage keys. Previous ownership periods remain visible in stored records and cannot authorize payments.</p>
    {keys?.length ? <ul>{keys.map(k=><li key={k.authorizationId}>
      <strong>Authorization {k.authorizationId}</strong> · ownership period {k.period}
      <p>{k.eligible?'Currently eligible':'Currently ineligible'}{k.eligibilityError && <small> · {k.eligibilityError}</small>}</p>
      <code style={{overflowWrap:'anywhere'}}>{k.publicKey}</code>
    </li>)}</ul> : <p>No host keys loaded.</p>}
    <button type="button" disabled={busy} onClick={()=>void connect()}>Connect owning wallet</button>
    <label>Owning account<select value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">Choose account</option>{accounts.map(a=><option key={a.address} value={a.address}>{a.name??a.address}</option>)}</select></label>
    <label>Server public key<input value={publicKey} disabled={busy} onChange={e=>setPublicKey(e.target.value)} placeholder="0x… (public key only)" /></label>
    <button type="button" disabled={busy||!selected} onClick={()=>void act(false)}>Authorize key</button>
    <label>Authorization ID to revoke<input value={generation} disabled={busy} onChange={e=>setGeneration(e.target.value)} inputMode="numeric" /></label>
    <button type="button" disabled={busy||!selected} onClick={()=>void act(true)}>Revoke authorization</button>
    <p>To rotate, authorize the new key, switch your server to its new authorization ID, then revoke the old ID. Reauthorizing the same key also creates a new generation.</p>
    <p role="status">{message}</p>
  </section>;
}
