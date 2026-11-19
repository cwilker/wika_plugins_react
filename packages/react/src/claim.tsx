import { PayoutEditor } from "./economics";
import {signingExpiry} from "@wika/core";
import type { ClaimRecovery } from "@wika/core";
import type { PolicySelection } from "@wika/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalPageUrl,
  createInjectedWallet,
  formatAmount,
  type ClaimPageInfo,
  type WikaClaimsApi,
  type WalletAdapter,
  type WalletAccount,
  type SignedClaimProof,
  type OwnershipAction,
  type OwnershipQuote,
  type NetworkInfo,
} from "@wika/core";
export interface WikaClaimProps {
  client: WikaClaimsApi;
  url: string;
  wallet?: WalletAdapter;
  appName?: string;
}
/** Page controls; indexed multi-page/historical portfolios belong in the owners dashboard. */
export function WikaClaim({
  client,
  url,
  wallet: supplied,
  appName = "Wika page ownership",
}: WikaClaimProps) {
  const wallet = useMemo(() => supplied ?? createInjectedWallet(), [supplied]);
  const [accounts, setAccounts] = useState<WalletAccount[]>([]),
    [selected, setSelected] = useState("");
  const [page, setPage] = useState<ClaimPageInfo | null>(null),
    [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [proof, setProof] = useState<SignedClaimProof | null>(null),
    [quote, setQuote] = useState<OwnershipQuote | null>(null);
  const pendingKey=`wika.claim.pending.v2:${client.genesisHash}:${canonicalPageUrlSafe(url)}`;
  const [pending,setPending]=useState<ClaimRecovery|null>(()=>readPending(pendingKey));
  const pendingRef=useRef(pending);pendingRef.current=pending;
  function remember(value:ClaimRecovery|null){if(value)localStorage.setItem(pendingKey,JSON.stringify(value));else localStorage.removeItem(pendingKey);pendingRef.current=value;setPending(value);}
  useEffect(()=>{setPending(readPending(pendingKey));},[pendingKey]);
  const [policy,setPolicy]=useState<PolicySelection|null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const generation = useRef(0),
    mounted = useRef(true),
    working = useRef(false);
  const monitors = useRef(new Set<AbortController>());
  let canonical: string;
  try {
    canonical = canonicalPageUrl(url);
  } catch {
    canonical = "";
  }
  const identity = useRef({ canonical, selected, client });
  if (
    identity.current.canonical !== canonical ||
    identity.current.selected !== selected ||
    identity.current.client !== client
  ) {
    generation.current++;
    identity.current = { canonical, selected, client };
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      for (const monitor of monitors.current) monitor.abort();
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setPolicy(null);
    setProof(null);
    setQuote(null);
    setError("");
    setNotice("");
  }, [canonical, selected, client]);
  useEffect(() => {
    let active = true,
      inFlight = false;
    setPage(null);
    setNetwork(null);
    const refresh = async () => {
      if (!canonical || inFlight) return;
      inFlight = true;
      try {
        const [p, n] = await Promise.all([
          client.getPage(canonical),
          client.getNetwork(),
        ]);
        if (active) {
          setPage(p);
          setNetwork(n);
        }
      } catch (e) {
        if (active) setError(String((e as Error).message));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [canonical, client]);
  const account = accounts.find((a) => a.address === selected);
  const run = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      const list = await wallet.connect(appName);
      if (!mounted.current) return;
      setAccounts(list);
      setSelected(list[0]?.address ?? "");
    });
  const sign = () =>
    run(async () => {
      if (!account || !canonical) return;
      const token = generation.current;
      const result = await client.createProof(
        account,
        await wallet.getSigner(account),
        canonical,
      );
      if (mounted.current && token === generation.current) setProof(result);
    });
  const review = (action: OwnershipAction) =>
    run(async () => {
      if (!account) return;
      const token = generation.current;
      const result = await client.quote(account.address, action);
      if (mounted.current && token === generation.current) setQuote(result);
    });
  const send = () =>
    run(async () => {
      if (!account || !quote || pendingRef.current) return;
      const token = generation.current;
      const monitor = new AbortController();
      monitors.current.add(monitor);
      let result;
      try {
        const signer = await wallet.getSigner(account);
        if (!mounted.current || token !== generation.current) {
          monitor.abort();
          return;
        }
        result = await client.submit(
          account,
          signer,
          quote.action,
          { maxTotal: quote.totalRequired, signal: monitor.signal,
            beforeSign:client.recover?()=>remember({genesisHash:client.genesisHash,payer:account.address,target:canonical,nextBlock:page?.blockNumber??'0'}):undefined,
            onSigningPayload:payload=>{const p=pendingRef.current;if(p)remember({...p,nonce:BigInt(payload.nonce).toString(),method:payload.method,deathBlock:signingExpiry(payload.blockNumber,payload.era)});},
            onBroadcast:hash=>{const p=pendingRef.current;if(p)remember({...p,txHash:hash});},
            onSigningRejected:()=>remember(null),onFinalizedFailure:()=>remember(null),
          },
        );
      } finally {
        monitors.current.delete(monitor);
      }
      if (mounted.current && token === generation.current) {
        remember(null);
        setQuote(null);
        setNotice(
          `Transaction finalized: ${result.txHash}. Website verification, when required, continues separately.`,
        );
        setPage(await client.getPage(canonical));
      }
    });
  const amount = (value: bigint) =>
    formatAmount(value, network?.decimals ?? 12, network?.symbol ?? "WIKA");
  const owner = Boolean(
    account &&
      page?.current &&
      client.isSameAccount(account.address, page.current.owner),
  );
  const candidate = Boolean(
    account &&
      page?.pending &&
      client.isSameAccount(account.address, page.pending.candidate),
  );
  const time = (value: bigint) => new Date(Number(value)).toLocaleString();
  const field = (content: string) =>
    `<meta name="wika-claim" content="${content}">`;
  return (
    <section className="wika-claim" aria-label="Wika publishing control">
      <h2>Page ownership</h2>
      <p>
        Verify control of this page’s publishing field. A claim does not
        establish copyright or original authorship.
      </p>
      {!canonical ? (
        <p role="alert">Enter a supported page URL.</p>
      ) : (
        <p>
          Page: <code>{canonical}</code>
        </p>
      )}
      <p>
        Chain: <code>{client.genesisHash}</code>
      </p>
      {!accounts.length ? (
        <button type="button" disabled={busy} onClick={connect}>
          Connect wallet
        </button>
      ) : (
        <label>
          Wallet{" "}
          <select
            disabled={busy}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={`${a.source}:${a.address}`} value={a.address}>
                {a.name ?? a.address}
              </option>
            ))}
          </select>
        </label>
      )}
      {page && (
        <>
          <p>Current wallet: {page.current?.owner ?? "Unclaimed"}</p>
          <p>Unclaimed author rewards: {amount(page.unclaimed)}</p>
          {page.current && (
            <>
              <p>
                Reserved earnings: {amount(page.current.balance)} ·
                Withdrawable: {amount(page.current.withdrawable)}
              </p>
              {owner && (
                <details>
                  <summary>Restore your accepted publishing tag</summary>
                  <label>Your accepted proof<textarea readOnly value={field(page.current.proof)} /></label>
                  <p>Restore this exact tag in the server-delivered HTML head if it was removed. Ordinary page edits do not require a new claim.</p>
                </details>
              )}
              <p>
                Last verified:{" "}
                {page.current.verifiedAt === null
                  ? "Verification required"
                  : time(page.current.verifiedAt)}
                . This records a check, not continuous monitoring.
              </p>
            </>
          )}
          {page.economics && <PayoutEditor key={`${canonical}:${selected}`} state={page.economics} forClaim={!owner&&!page.current} readOnly={Boolean(page.current&&!owner)} disabled={busy} decimals={network?.decimals} symbol={network?.symbol} onSelect={p=>{setPolicy(p);setQuote(null);}} />}
          {page.pendingPolicy&&<p role="status">Pending claim policy attempt {page.pendingPolicy.attempt} for {page.pendingPolicy.account}: {page.pendingPolicy.ownerBps/100}% owner · {page.pendingPolicy.supporterBps/100}% supporters · {page.pendingPolicy.referralBps/100}% referrals. This selection is awaiting verified activation; the effective policy above still governs payments.</p>}
          {page.policyOutcome && <p role="status">Claim policy attempt {page.policyOutcome.attempt}: {page.policyOutcome.applied?'Selected payout policy applied.':page.policyOutcome.reason==='Locked'?'Page claimed; payout policy inherited because a payment arrived first.':'Page claimed; existing payout policy inherited because terms changed.'}</p>}
          {owner && page.current && policy && <button type="button" disabled={busy} onClick={()=>void review({kind:'configure',url:canonical,period:page.current!.id,policy})}>Review payout settings</button>}
          {page.verificationPending && (
            <p role="status">
              Website verification is pending. Funds remain held until the
              required checks succeed.
            </p>
          )}
          {page.lastVerification && !page.verificationPending && (
            <p role="status">
              Last proof check for {page.lastVerification.account}:{" "}
              {page.lastVerification.outcome} (
              {time(page.lastVerification.checkedAt)}).
              {page.lastVerification.outcome === "InvalidProof" &&
                " Check the exact signed tag in the server-delivered head. Author rewards remain held."}
              {page.lastVerification.outcome === "Inconclusive" &&
                " Verification was unavailable or there was insufficient agreement. Author rewards remain held; an eligible retry has no additional verification charge."}
              {page.lastVerification.outcome === "Expired" &&
                " The verification request expired. Create a new proof or retry the appropriate current check."}
            </p>
          )}
          {page.pending && (
            <aside role="alert">
              <h3>Ownership replacement pending</h3>
              <p>
                Proposed wallet: {page.pending.candidate}. Earliest activation:{" "}
                {time(page.pending.earliestActivation)}. Completion deadline:{" "}
                {time(page.pending.deadline)}.
              </p>
              <p>
                Page withdrawals are held. Earlier earnings stay reserved for
                their original wallet. Restore your accepted head tag to
                demonstrate continued publishing control. A signed objection is
                visible but does not veto a proven replacement.
              </p>
              {owner && page.current && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void review({
                        kind: "object",
                        url: canonical,
                        id: page.pending!.id,
                      })
                    }
                  >
                    Review objection
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void review({
                        kind: "approve",
                        url: canonical,
                        id: page.pending!.id,
                      })
                    }
                  >
                    Review cooperative approval
                  </button>
                </>
              )}
              {candidate && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void review({
                        kind: "approve",
                        url: canonical,
                        id: page.pending!.id,
                      })
                    }
                  >
                    Review cooperative approval
                  </button>
                  <button
                    type="button"
                    disabled={busy || page.verificationPending}
                    onClick={() =>
                      void review({
                        kind: "cancel",
                        url: canonical,
                        id: page.pending!.id,
                      })
                    }
                  >
                    Review cancellation
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      page.verificationPending ||
                      (page.chainTime < page.pending.earliestActivation &&
                        !(
                          page.pending.ownerApproved &&
                          page.pending.candidateApproved
                        ))
                    }
                    onClick={() =>
                      void review({
                        kind: "finalize",
                        url: canonical,
                        id: page.pending!.id,
                      })
                    }
                  >
                    Review final verification
                  </button>
                </>
              )}
              {account && page.chainTime >= page.pending.deadline && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void review({ kind: "expire", url: canonical })
                  }
                >
                  Review expired replacement cleanup
                </button>
              )}
            </aside>
          )}
          {account && !owner && !page.pending && !page.verificationPending && (
            <>
              <button type="button" disabled={busy} onClick={sign}>
                Sign publishing proof
              </button>
              {proof && proof.page === canonical && (
                <>
                  <label>
                    Publish exactly one tag in the server-delivered HTML head
                    <textarea readOnly value={field(proof.content)} />
                  </label>
                  <p>
                    Body text, comments, scripts and templates cannot prove
                    control. Verification rejects redirects; use the final
                    public HTTPS URL on port 443. Keep this tag published for
                    future withdrawal checks.
                  </p>
                  <button
                    type="button"
                    disabled={busy || Boolean(page.economics?.active && page.economics.lockedAt===null && !page.current && !policy)}
                    onClick={() => void review({ kind: "claim", proof, policy:!page.current?policy??undefined:undefined })}
                  >
                    Published the tag — review claim
                  </button>
                </>
              )}
            </>
          )}
          {owner &&
            page.current &&
            !page.pending &&
            !page.verificationPending && (
              <>
                {(page.current.verificationFresh===false || (page.current.balance > 0n &&
                  page.current.withdrawable === 0n)) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void review({
                          kind: "verify",
                          url: canonical,
                          period: page.current!.id,
                        })
                      }
                    >
                      Review proof verification
                    </button>
                  )}
                {page.current.withdrawable > 0n && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void review({
                        kind: "withdraw",
                        url: canonical,
                        period: page.current!.id,
                        amount: page.current!.withdrawable,
                      })
                    }
                  >
                    Review withdrawal
                  </button>
                )}
              </>
            )}
          {account &&
            page.retry &&
            client.isSameAccount(account.address, page.retry.account) &&
            page.retry.remaining > 0 &&
            page.chainTime < page.retry.expiresAt &&
            !page.verificationPending && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void review({ kind: "retry", url: canonical })}
              >
                Review no-quorum retry
              </button>
            )}
        </>
      )}
      {quote &&
        quote.account === selected &&
        canonicalPageUrl(
          quote.action.kind === "claim"
            ? quote.action.proof.page
            : quote.action.url,
        ) === canonical && (
          <div aria-label="Transaction quote">
            <h3>Review before signing</h3>
            <p>
              {
                (
                  {
                    configure: "Change this page’s payout split before its first paid endorsement. First-payment ordering is final.",
                    claim: page?.current
                      ? "A valid challenger proof opens a pending replacement and freezes page withdrawals; ownership changes only after the required final verification."
                      : "A successful first claim reserves the unclaimed author rewards for this wallet. Withdraw them after verification succeeds.",
                    verify:
                      "This checks the accepted head tag and refreshes withdrawal eligibility. Rewards stay held while verification is pending.",
                    withdraw:
                      "This pays reserved author rewards to the wallet signing the transaction.",
                    approve:
                      "If both wallets approve, a fresh valid proof may transfer control before the 14-day window ends. Earlier earnings stay with their original wallets.",
                    object:
                      "This records an objection. It does not veto a replacement that proves publishing control.",
                    cancel:
                      "This cancels your pending replacement and returns its held bond. Verification charges already incurred are not refunded.",
                    finalize:
                      "This requests a new website check. A successful quorum activates the new wallet for future author earnings.",
                    expire:
                      "This clears the expired replacement and returns its bond. The current period still needs fresh verification before withdrawal.",
                    retry:
                      "This uses an eligible no-quorum retry without another verification charge. Network fees and any refundable challenger bond still apply.",
                  } satisfies Record<OwnershipAction["kind"], string>
                )[quote.action.kind]
              }
            </p>

            {(quote.action.kind==='configure'||(quote.action.kind==='claim'&&quote.action.policy))&&<p>Reviewed split: {quote.action.policy!.ownerBps/100}% owner · {quote.action.policy!.supporterBps/100}% supporters · {quote.action.policy!.referralBps/100}% referrals. {quote.action.policy!.inheritIfChanged?'If customization loses a race, ownership may activate with the inherited policy.':'The runtime rejects changed terms.'}</p>}
            <p>Network fee: {amount(quote.networkFee)}</p>
            <p>Verification fee: {amount(quote.verificationFee)}</p>
            <p>Refundable bond: {amount(quote.refundableBond)}</p>
            <p>
              Total required: {amount(quote.totalRequired)}. Network fees are
              estimates. Invalid challenger proof can forfeit the bond; verifier
              outages do not.
            </p>
            <button
              type="button"
              disabled={busy || !quote.affordable || Boolean(pending)}
              onClick={send}
            >
              Submit for wallet approval
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setQuote(null)}
            >
              Close quote
            </button>
            {!quote.affordable && <p>Insufficient spendable balance.</p>}
          </div>
        )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {pending&&<aside role="status"><p>A previous transaction needs reconciliation. New submissions stay locked until its finalized result or expiry is known.</p><button type="button" disabled={busy} onClick={()=>void run(async()=>{if(!client.recover)return;const result=await client.recover(pending);if(result.state==='pending'){remember({...pending,nextBlock:result.nextBlock});setNotice('Still waiting for finality. Check again shortly.');}else{remember(null);setQuote(null);setPage(await client.getPage(canonical));setNotice(result.state==='finalized'?'Transaction recovered. See the current ownership and actual policy outcome above.':`Transaction ${result.state}; no successful execution was found.`);}})}>Reconcile previous transaction</button></aside>}
      <p>
        Challenge notices appear when you open Wika interfaces. Email and push
        delivery are not available.
      </p>
    </section>
  );
}

function canonicalPageUrlSafe(url:string){try{return canonicalPageUrl(url);}catch{return url;}}
function readPending(key:string):ClaimRecovery|null{try{const p=JSON.parse(localStorage.getItem(key)??'null');return p&&typeof p.genesisHash==='string'&&typeof p.payer==='string'&&/^\d+$/.test(p.nextBlock)?p:null;}catch{return null;}}
