import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  createInjectedWallet,
  formatAmount,
  type LikeQuote,
  type ReferralEnvelope,
  type LikeReceipt,
  type NetworkInfo,
  type PageInfo,
  type TransactionStatus,
  type WalletAccount,
  type WalletAdapter,
  type WikaClientLike,
} from "@wika/core";

export interface WikaLikeProps {
  /** Shared caller-owned connection. Disconnect it when your application is finished with it. */
  client: WikaClientLike;
  /** Exact URL identity used by the node and wallet; never inferred from the widget's location. */
  url: string;
  referrerUrl?: string;
  /** Called after account selection. Host source comes from server configuration. */
  getReferral?: (payer: string, target: string, count: number) => Promise<ReferralEnvelope>;
  fixedCount?: number;
  onBroadcast?: (hash: string) => void;
  onAttempt?: (request: import("@wika/core").LikeRequest, account: WalletAccount) => void | Promise<void>;
  onSigningPayload?: import('@wika/core').SubmitOptions['onSigningPayload'];
  onSigningRejected?: import('@wika/core').SubmitOptions['onSigningRejected'];
  onFinalizedFailure?: import('@wika/core').SubmitOptions['onFinalizedFailure'];
  wallet?: WalletAdapter;
  appName?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  onSuccess?: (receipt: LikeReceipt) => void;
  onError?: (error: Error) => void;
}
const messages: Record<TransactionStatus, string> = {
  signing: "Approve the transaction in your wallet.",
  submitted: "Transaction submitted. Waiting for inclusion…",
  inBlock: "Included in a block. Waiting for finality…",
  finalized: "Your like is finalized.",
  retracted: "Block was retracted. Waiting for inclusion again…",
};
const toError = (value: unknown) =>
  value instanceof Error ? value : new Error(String(value));

export function WikaLike({
  client,
  url,
  referrerUrl = "",
  getReferral,
  fixedCount,
  onBroadcast,
  onAttempt,
  onSigningPayload,
  onSigningRejected,
  onFinalizedFailure,
  wallet: suppliedWallet,
  appName = "Wika Like",
  label = "Like with Wika",
  className = "",
  disabled,
  onSuccess,
  onError,
}: WikaLikeProps) {
  const wallet = useMemo(
    () => suppliedWallet ?? createInjectedWallet(),
    [suppliedWallet],
  );
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const transaction = useRef<AbortController>();
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [selected, setSelected] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [count, setCount] = useState(String(fixedCount ?? 1));
  const [quote, setQuote] = useState<LikeQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [status, setStatus] = useState<TransactionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<LikeReceipt | null>(null);
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ onSuccess, onError });
  callbacks.current = { onSuccess, onError };
  const available = accounts.filter(
    (a) =>
      !a.genesisHash ||
      a.genesisHash.toLowerCase() === network?.genesisHash.toLowerCase(),
  );
  const account = available.find(
    (a) => `${a.source}:${a.address}` === selected,
  );

  useEffect(() => {
    let active = true;
    setNetwork(null);
    client.getNetwork().then(
      (value) => {
        if (active) setNetwork(value);
      },
      (e) => {
        if (active) setReadError(toError(e).message);
      },
    );
    return () => {
      active = false;
    };
  }, [client, retry]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    setPage(null);
    setReadError(null);
    client
      .subscribePage(
        url,
        account?.address,
        (value) => {
          if (active) setPage(value);
        },
        (e) => {
          if (active) setReadError(e.message);
        },
      )
      .then(
        (unsubscribe) => {
          if (active) stop = unsubscribe;
          else unsubscribe();
        },
        (e) => {
          if (active) setReadError(toError(e).message);
        },
      );
    return () => {
      active = false;
      stop?.();
    };
  }, [client, url, account?.address, retry]);

  useEffect(() => {
    pending.current = false;
    setReceipt(null);
    setStatus(null);
    setBusy(false);
    setConnecting(false);
    setError(null);
    return () => {
      transaction.current?.abort();
      transaction.current = undefined;
    };
  }, [client, url, referrerUrl, wallet]);

  useEffect(() => {
    if (!connected || !wallet.subscribeAccounts) return;
    let active = true;
    let stop: (() => void) | undefined;
    wallet
      .subscribeAccounts((next) => {
        if (active) setAccounts(next);
      })
      .then(
        (unsubscribe) => {
          if (active) stop = unsubscribe;
          else unsubscribe();
        },
        (e) => {
          if (active) setError(toError(e).message);
        },
      );
    return () => {
      active = false;
      stop?.();
    };
  }, [wallet, connected]);

  useEffect(() => {
    setConnected(false);
    setAccounts([]);
    setSelected("");
    setConnecting(false);
  }, [wallet]);

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);

  useEffect(() => {
    let active = true;
    setQuote(null);
    setQuoteError(null);
    setQuoteLoading(false);
    if (!open || !account || !network || busy || receipt || page?.mine) return;
    if (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count))) {
      setQuoteError("Enter a positive whole number of likes.");
      return;
    }
    setQuoteLoading(true);
    Promise.resolve(getReferral?.(account.address, url, fixedCount ?? Number(count)))
      .then(referral => client.quoteLike(account.address, { url, referrerUrl, count: fixedCount ?? Number(count), referral }))
      .then(
        (value) => {
          if (active) {
            setQuote(value);
            setQuoteLoading(false);
          }
        },
        (e) => {
          if (active) {
            setQuoteError(toError(e).message);
            setQuoteLoading(false);
          }
        },
      );
    return () => {
      active = false;
    };
  }, [
    client,
    open,
    account?.address,
    account?.source,
    network,
    url,
    referrerUrl,
    getReferral,
    fixedCount,
    count,
    busy,
    receipt,
    page?.mine?.count,
    retry,
  ]);

  const report = (value: unknown) => {
    const failure = toError(value);
    setError(failure.message);
    try {
      callbacks.current.onError?.(failure);
    } catch (e) {
      console.error("Wika onError callback failed", e);
    }
  };
  const connectWallet = async () => {
    setConnecting(true);
    setError(null);
    // Ignore an authorization response if the component changes or unmounts meanwhile.
    const controller = new AbortController();
    transaction.current?.abort();
    transaction.current = controller;
    try {
      const next = await wallet.connect(appName);
      if (controller.signal.aborted) return;
      setAccounts(next);
      setSelected("");
      setConnected(true);
    } catch (e) {
      if (!controller.signal.aborted) report(e);
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  };
  const submit = async () => {
    // Ref guard covers repeated clicks before React commits the disabled state.
    if (!account || !quote || pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    transaction.current?.abort();
    transaction.current = controller;
    setBusy(true);
    setStatus("signing");
    setError(null);
    try {
      const signer = await wallet.getSigner(account);
      if (controller.signal.aborted) return;
      const result = await client.submitLike(account, signer, quote.request, {
        signal: controller.signal,
        onBroadcast,
        beforeSign: () => onAttempt?.(quote.request,account),
        onSigningPayload,
        onSigningRejected,
        onFinalizedFailure,
        onStatus: (next) => {
          if (!controller.signal.aborted) setStatus(next);
        },
      });
      if (controller.signal.aborted) return;
      setReceipt(result);
      setStatus("finalized");
      try {
        callbacks.current.onSuccess?.(result);
      } catch (e) {
        console.error("Wika onSuccess callback failed", e);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setStatus(null);
        report(e);
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        pending.current = false;
        transaction.current = undefined;
      }
    }
  };
  const amount = (value: bigint) =>
    formatAmount(value, network?.decimals ?? 12, network?.symbol ?? "WIKA");
  return (
    <div className={`wika-like ${className}`}>
      <button
        type="button"
        className="wika-like__trigger"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {page && (
        <span className="wika-like__count" aria-live="polite">
          {page.likes.toString()} likes
        </span>
      )}
      <dialog
        ref={dialog}
        className="wika-like__dialog"
        aria-labelledby={`${id}-title`}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      >
        <div className="wika-like__heading">
          <h2 id={`${id}-title`}>{label}</h2>
          <button
            type="button"
            aria-label="Close Wika dialog"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <p className="wika-like__url">{url}</p>
        {network && (
          <p className="wika-like__network">Network: {network.name}</p>
        )}
        {readError && (
          <p role="alert">
            {readError}{" "}
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry connection
            </button>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {receipt ? (
          <div role="status">
            <p>Your like is finalized. Thank you!</p>
            <p className="wika-like__hash">Transaction: {receipt.txHash}</p>
          </div>
        ) : (
          <>
            {!connected ? (
              <button
                type="button"
                disabled={connecting || !network || busy}
                onClick={() => void connectWallet()}
              >
                {connecting ? "Waiting for wallet…" : "Connect wallet"}
              </button>
            ) : (
              <>
                <label htmlFor={`${id}-account`}>Account</label>
                <select
                  id={`${id}-account`}
                  value={account ? selected : ""}
                  disabled={busy}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setError(null);
                  }}
                >
                  <option value="">Choose an account</option>
                  {available.map((a) => (
                    <option
                      key={`${a.source}:${a.address}`}
                      value={`${a.source}:${a.address}`}
                    >
                      {a.name ?? a.address} ({a.source})
                    </option>
                  ))}
                </select>
                {!available.length && (
                  <p>
                    No accounts are available for this network. Add or authorize
                    an account in your wallet.
                  </p>
                )}
                <button
                  type="button"
                  className="wika-like__secondary"
                  disabled={busy || connecting}
                  onClick={() => void connectWallet()}
                >
                  Refresh wallet accounts
                </button>
                {page?.mine ? (
                  <p role="status">
                    This account is already in the reward queue for this URL (
                    {page.mine.count} likes).
                  </p>
                ) : (
                  <>
                    {!fixedCount && <><label htmlFor={`${id}-count`}>Number of likes</label>
                    <input
                      id={`${id}-count`}
                      type="number"
                      min="1"
                      step="1"
                      max={quote?.maxLikes}
                      value={count}
                      disabled={busy}
                      onChange={(event) => {
                        setCount(event.target.value);
                        setError(null);
                      }}
                    />
                    </>}
                    {quoteLoading && <p role="status">Estimating cost…</p>}
                    {quoteError && <p role="alert">{quoteError} <button type="button" onClick={() => setRetry(v=>v+1)}>Refresh quote</button></p>}
                    {quote && (
                      <>
                        {quote.economicQuote?.economics && <div aria-label="Payout policy"><p>{quote.economicQuote.economics.policy.ownerBps/100}% owner · {quote.economicQuote.economics.policy.supporterBps/100}% supporters · {quote.economicQuote.economics.policy.referralBps/100}% referrals · {quote.economicQuote.economics.policy.protocolBps/100}% protocol.</p><p>{quote.economicQuote.economics.referralToTarget?'Unused referral goes to target-owner entitlement.':'Referral goes to the recipient below.'} Owner entitlement may be held in escrow. Gross cost is shown; your own owner allocation may be retained. Supporter budget does not predict a return.</p><p>{quote.economicQuote.economics.policy.model===0?'Endorsement debit at most':'Endorsement debit'}: {amount(BigInt(quote.economicQuote.economics.cost)-BigInt(quote.economicQuote.economics.retainedOwner))}. Network fees are additional.</p><p>Owner: {amount(BigInt(quote.economicQuote.economics.ownerAmount))} · Supporters: {amount(BigInt(quote.economicQuote.economics.supporterBudget))} · Referral: {amount(BigInt(quote.economicQuote.economics.referralAmount))} · Protocol: {amount(BigInt(quote.economicQuote.economics.protocolAmount))}. Retained owner allocation: {amount(BigInt(quote.economicQuote.economics.retainedOwner))}.</p></div>}
                        {quote.referralQuote && <dl>
                          <dt>Referral host</dt><dd>{quote.referralQuote.terms.source}</dd>
                          <dt>Referral recipient</dt><dd>{quote.referralQuote.terms.recipient}</dd>
                          <dt>Referral allocation</dt><dd>{amount(BigInt(quote.referralQuote.terms.referralAmount))}</dd>
                        </dl>}
                        <dl>
                          <dt>Payment cost</dt>
                          <dd>{amount(quote.cost)}</dd>
                          <dt>Estimated network fee</dt>
                          <dd>{amount(quote.estimatedFee)}</dd>
                          <dt>Estimated total</dt>
                          <dd>{amount(quote.total)}</dd>
                          <dt>Spendable balance</dt>
                          <dd>{amount(quote.balance.spendable)}</dd>
                        </dl>
                        {!quote.affordable && (
                          <p role="alert">
                            Insufficient spendable balance for these likes and
                            the fee.
                          </p>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      disabled={
                        !quote?.affordable ||
                        quoteLoading ||
                        busy ||
                        !account ||
                        !network ||
                        !!readError
                      }
                      onClick={() => void submit()}
                    >
                      Approve in wallet
                    </button>
                  </>
                )}
              </>
            )}
            {status && <p role="status">{messages[status]}</p>}
            {busy && (
              <p>
                You can close this dialog while waiting. Closing it does not
                cancel the transaction.
              </p>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}
export { WikaClaim } from "./claim";
export type { WikaClaimProps } from "./claim";
