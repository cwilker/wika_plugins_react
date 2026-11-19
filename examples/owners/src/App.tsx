import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WikaClient,
  canonicalPageUrl,
  createInjectedWallet,
  formatAmount,
  type ClaimPageInfo,
  type NetworkInfo,
  type OwnershipPeriodInfo,
  type OwnershipQuote,
  type WalletAccount,
  type WalletAdapter,
} from "@wika/core";
import { WikaClaim } from "@wika/react";
import { Hosts } from "./Hosts";
import { Portfolio } from "./Portfolio";
import {
  addPage,
  readPages,
  savePages,
  periodWindow,
  overview,
  MAX_PAGES,
  HISTORY_PAGE_SIZE,
  type PageEntry,
} from "./watchlist";
type Connection = Pick<
  WikaClient,
  "claims" | "getNetwork" | "disconnect" | "supportsSafeClaims"
> & { referrals?: WikaClient['referrals'] };
type Props = {
  connect?: (endpoint: string) => Promise<Connection>;
  wallet?: WalletAdapter;
};
const defaultConnect = (endpoint: string) =>
  WikaClient.connect({
    endpoint,
    genesisHash: import.meta.env.VITE_WIKA_GENESIS_HASH || undefined,
    timeoutMs: 12000,
  });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (ms: bigint) => new Date(Number(ms)).toLocaleString();
const short = (url: string) => {
  const u = new URL(url);
  return u.host + u.pathname + u.search;
};
export function OwnersApp({
  connect = defaultConnect,
  wallet: supplied,
}: Props) {
  const wallet = useMemo(() => supplied ?? createInjectedWallet(), [supplied]);
  const [endpoint, setEndpoint] = useState(
    import.meta.env.VITE_WIKA_NODE_URL || "ws://127.0.0.1:9944",
  );
  const [connection, setConnection] = useState<Connection | null>(null),
    [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [connecting, setConnecting] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pages, setPages] = useState<string[]>([]),
    [input, setInput] = useState(""),
    [selected, setSelected] = useState(""),
    [entries, setEntries] = useState<Record<string, PageEntry>>({});
  const [addressInput, setAddressInput] = useState(""),
    [address, setAddress] = useState(""),
    [filter, setFilter] = useState<"all" | "mine" | "challenges">("all");
  const [history, setHistory] = useState<OwnershipPeriodInfo[]>([]),
    [historyStart, setHistoryStart] = useState<bigint | null>(null),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState("");
  const [review, setReview] = useState<{
      quote: OwnershipQuote;
      account: WalletAccount;
    } | null>(null),
    [acting, setActing] = useState(false);
  const [portfolioRefresh, setPortfolioRefresh] = useState(0);
  const [walletAccounts, setWalletAccounts] = useState<WalletAccount[]>([]);
  const [portfolioPage, setPortfolioPage] = useState("");
  const [portfolioPeriod, setPortfolioPeriod] = useState<bigint | undefined>();
  const trackedPages = useMemo(
    () => [...new Set([...pages, ...(portfolioPage ? [portfolioPage] : [])])],
    [pages, portfolioPage],
  );
  const [updated, setUpdated] = useState<Date | null>(null);
  const live = useRef(true),
    connectionRef = useRef<Connection | null>(null),
    epoch = useRef(0),
    connectRun = useRef(0),
    refreshRun = useRef<number | null>(null),
    historyRun = useRef(0),
    actionRun = useRef(0),
    actionBusy = useRef(false);
  const pagesRef = useRef(trackedPages);
  pagesRef.current = trackedPages;
  const monitors = useRef(new Set<AbortController>());
  const claims = connection?.claims;
  const money = (n: bigint) =>
    formatAmount(n, network?.decimals ?? 12, network?.symbol ?? "WIKA");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      epoch.current++;
      connectRun.current++;
      historyRun.current++;
      actionRun.current++;
      for (const monitor of monitors.current) monitor.abort();
      void connectionRef.current?.disconnect();
    };
  }, []);
  useEffect(() => {
    setReview(null);
    actionRun.current++;
    for (const monitor of monitors.current) monitor.abort();
  }, [address, selected, connection]);
  const open = async () => {
    if (connecting) return;
    const token = ++connectRun.current;
    setConnecting(true);
    setError("");
    let candidate: Connection | undefined;
    try {
      const u = new URL(endpoint);
      if (!["ws:", "wss:"].includes(u.protocol) || u.username || u.password)
        throw new Error(
          "Use a ws:// or wss:// node address without embedded credentials.",
        );
      candidate = await connect(endpoint);
      if (!candidate.supportsSafeClaims)
        throw new Error(
          "Connect to a node supporting safe page claims (runtime 402 or later).",
        );
      const info = await candidate.getNetwork();
      if (!live.current || token !== connectRun.current) {
        await candidate.disconnect();
        return;
      }
      const old = connectionRef.current;
      connectionRef.current = candidate;
      epoch.current++;
      refreshRun.current = null;
      historyRun.current++;
      setConnection(candidate);
      setNetwork(info);
      setWalletAccounts([]);
      setPortfolioPage("");
      setPortfolioPeriod(undefined);
      setEntries({});
      setHistory([]);
      setUpdated(null);
      setNotice("");
      setRefreshing(false);
      let saved: string[] = [];
      try {
        saved = readPages(localStorage, info.genesisHash);
      } catch {
        setNotice("Saved pages could not be restored. You can add them again.");
      }
      setPages(saved);
      setSelected(saved[0] ?? "");
      await old?.disconnect();
    } catch (e) {
      if (candidate && candidate !== connectionRef.current)
        await candidate.disconnect();
      if (live.current) setError(errorText(e));
    } finally {
      if (live.current && token === connectRun.current) setConnecting(false);
    }
  };
  const refresh = useCallback(async () => {
    if (!connection || refreshRun.current === epoch.current) return;
    const token = epoch.current;
    refreshRun.current = token;
    setRefreshing(true);
    const queue = [...pagesRef.current];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (next < queue.length) {
          const url = queue[next++]!;
          try {
            const data = await connection.claims.getPage(url);
            if (
              live.current &&
              token === epoch.current &&
              pagesRef.current.includes(url)
            )
              setEntries((old) => ({ ...old, [url]: { data } }));
          } catch (e) {
            if (
              live.current &&
              token === epoch.current &&
              pagesRef.current.includes(url)
            )
              setEntries((old) => ({
                ...old,
                [url]: { data: old[url]?.data, error: errorText(e) },
              }));
          }
        }
      }),
    );
    if (live.current && token === epoch.current) {
      setUpdated(new Date());
      setRefreshing(false);
      refreshRun.current = null;
      if (pagesRef.current.some((url) => !queue.includes(url))) void refresh();
    }
  }, [connection]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [refresh, trackedPages]);
  const persist = (value: string[]) => {
    setPages(value);
    if (!network) return;
    try {
      savePages(localStorage, network.genesisHash, value);
    } catch {
      setNotice(
        "Pages are kept for this session, but this browser could not save them.",
      );
    }
  };
  const track = (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const canonical = canonicalPageUrl(input.trim());
      const list = addPage(pages, input.trim());
      persist(list);
      setSelected(canonical);
      setInput("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const forget = (url: string) => {
    const list = pages.filter((p) => p !== url);
    persist(list);
    setEntries((old) => {
      const next = { ...old };
      delete next[url];
      return next;
    });
    if (selected === url) setSelected(list[0] ?? "");
  };
  const viewWallet = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!claims) return;
    const value = addressInput.trim();
    if (value && !claims.isSameAccount(value, value)) {
      setError("Enter a valid Wika wallet address.");
      return;
    }
    setAddress(value);
    setError("");
    setFilter("all");
  };
  useEffect(() => {
    setPortfolioPage("");
    setPortfolioPeriod(undefined);
    setSelected((current) =>
      pagesRef.current.includes(current) && pages.includes(current)
        ? current
        : (pages[0] ?? ""),
    );
  }, [address]);
  const useWallet = async () => {
    const token = epoch.current;
    setError("");
    try {
      const accounts = (await wallet.connect("Wika owners")).filter(
        (a) =>
          !a.genesisHash ||
          a.genesisHash.toLowerCase() === network?.genesisHash.toLowerCase(),
      );
      if (!live.current || token !== epoch.current) return;
      setWalletAccounts(accounts);
      if (!accounts.length)
        throw new Error("No wallet accounts are available.");
      setAddressInput(accounts[0]!.address);
      setAddress(accounts[0]!.address);
      setFilter("all");
    } catch (e) {
      if (live.current) setError(errorText(e));
    }
  };
  const totals = claims
    ? overview(
        Object.fromEntries(pages.map((url) => [url, entries[url] ?? {}])),
        address,
        claims,
      )
    : null;
  const selectedData = selected ? entries[selected]?.data : undefined;
  const activeMine = (data: ClaimPageInfo) =>
    Boolean(
      address &&
        data.current &&
        claims?.isSameAccount(address, data.current.owner),
    );
  const involved = (data: ClaimPageInfo) =>
    Boolean(
      data.pending &&
        (!address ||
          activeMine(data) ||
          claims?.isSameAccount(address, data.pending.candidate)),
    );
  const visible = pages.filter((url) => {
    const data = entries[url]?.data;
    if (filter === "mine") return data && activeMine(data);
    if (filter === "challenges") return data && involved(data);
    return true;
  });
  const alerts = pages.filter((url) => {
    const row = entries[url];
    return row?.data && !row.error && involved(row.data) && row.data.pending;
  });
  const loadHistory = useCallback(
    async (start: bigint) => {
      if (!connection || !selected) return;
      const run = ++historyRun.current,
        token = epoch.current;
      setHistoryBusy(true);
      setHistoryError("");
      setHistory([]);
      setHistoryStart(start);
      try {
        const values = await Promise.all(
          periodWindow(start).map((id) =>
            connection.claims.getPeriod(selected, id),
          ),
        );
        if (
          live.current &&
          token === epoch.current &&
          run === historyRun.current
        )
          setHistory(
            values.filter((p): p is OwnershipPeriodInfo => p !== null),
          );
      } catch (e) {
        if (
          live.current &&
          token === epoch.current &&
          run === historyRun.current
        )
          setHistoryError(errorText(e));
      } finally {
        if (live.current && run === historyRun.current) setHistoryBusy(false);
      }
    },
    [connection, selected],
  );
  const currentId = selectedData?.current?.id;
  useEffect(() => {
    historyRun.current++;
    setHistory([]);
    setHistoryError("");
    setHistoryBusy(false);
    setHistoryStart(null);
    if (currentId && currentId > 1n)
      void loadHistory(
        portfolioPage === selected &&
          portfolioPeriod &&
          portfolioPeriod < currentId
          ? portfolioPeriod
          : currentId - 1n,
      );
  }, [loadHistory, currentId, address, portfolioPage, portfolioPeriod]);
  const reviewHistorical = async (period: OwnershipPeriodInfo) => {
    if (!claims || actionBusy.current) return;
    const token = actionRun.current;
    actionBusy.current = true;
    setActing(true);
    setError("");
    try {
      const accounts = await wallet.connect("Wika owners");
      const account = accounts.find((a) =>
        claims.isSameAccount(a.address, period.owner),
      );
      if (!account)
        throw new Error(
          "Connect the wallet that owns these historical earnings.",
        );
      const quote = await claims.quote(account.address, {
        kind: "withdraw",
        url: selected,
        period: period.id,
        amount: period.withdrawable,
      });
      if (live.current && token === actionRun.current)
        setReview({ quote, account });
    } catch (e) {
      if (live.current && token === actionRun.current) setError(errorText(e));
    } finally {
      actionBusy.current = false;
      if (live.current) setActing(false);
    }
  };
  const withdrawHistorical = async () => {
    if (!review || !claims || actionBusy.current) return;
    const token = actionRun.current;
    actionBusy.current = true;
    setActing(true);
    setError("");
    const monitor = new AbortController();
    monitors.current.add(monitor);
    try {
      const signer = await wallet.getSigner(review.account);
      if (
        !live.current ||
        token !== actionRun.current ||
        monitor.signal.aborted
      )
        return;
      const receipt = await claims.submit(
        review.account,
        signer,
        review.quote.action,
        { maxTotal: review.quote.totalRequired, signal: monitor.signal },
      );
      if (live.current && token === actionRun.current) {
        setReview(null);
        setNotice(`Historical withdrawal finalized: ${receipt.txHash}`);
        setPortfolioRefresh((n) => n + 1);
        await refresh();
        if (historyStart !== null) await loadHistory(historyStart);
      }
    } catch (e) {
      if (live.current && token === actionRun.current) setError(errorText(e));
    } finally {
      monitors.current.delete(monitor);
      actionBusy.current = false;
      if (live.current) setActing(false);
    }
  };
  return (
    <div className="owners-shell">
      <aside className="sidebar">
        <a className="brand" href="#top">
          <span className="brand-mark">w</span> wika
          <span className="brand-suffix">owners</span>
        </a>
        <span className="preview-label">LOCAL PREVIEW</span>
        <h2>Your workspace</h2>
        <p>Page ownership, author earnings, and challenges.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void open();
          }}
        >
          <label htmlFor="node">Node connection</label>
          <input
            id="node"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            spellCheck={false}
          />
          <button disabled={connecting}>
            {connecting
              ? "Connecting…"
              : connection
                ? "Change node"
                : "Connect node"}
          </button>
        </form>
        {network && (
          <div className="node-card">
            <span className="status-dot" /> Connected to {network.name}
            <small>Chain identity</small>
            <code>{network.genesisHash}</code>
          </div>
        )}
        <div className="sidebar-foot">
          <strong>Your wallet stays yours.</strong>
          <p>
            This site never asks for a seed phrase or private key. Actions go
            through your wallet.
          </p>
        </div>
      </aside>
      <main id="top">
        <header className="page-header">
          <div>
            <div className="eyebrow">PUBLISHING CONTROL / EARNINGS</div>
            <h1>Your pages, in one place.</h1>
            <p>
              Track ownership, respond to challenges, and collect what your
              pages earn.
            </p>
          </div>
          <button
            className="secondary"
            disabled={!connection || refreshing}
            onClick={() => {
              setPortfolioRefresh((n) => n + 1);
              void refresh();
            }}
          >
            {refreshing ? "Refreshing…" : "Refresh balances"}
          </button>
        </header>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            {notice}
          </div>
        )}
        {!connection ? (
          <section className="welcome">
            <span className="section-kicker">START HERE</span>
            <h2>Connect your Wika node.</h2>
            <p>
              Then view your wallet portfolio or add pages to watch. You can
              view a wallet address without signing in; signing is only needed
              when you take an action.
            </p>
            <p className="muted">
              Automatic discovery uses a Wika indexer. Saved pages also work
              directly with your node.
            </p>
          </section>
        ) : (
          <>
            <section className="wallet-bar" aria-label="Wallet view">
              <form onSubmit={viewWallet}>
                <label htmlFor="wallet">
                  Wallet to view{" "}
                  <span className="muted">· optional, read only</span>
                </label>
                <div className="inline">
                  <input
                    id="wallet"
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    placeholder="Paste your Wika address"
                    spellCheck={false}
                  />
                  <button>View wallet</button>
                </div>
              </form>
              <button className="secondary" onClick={() => void useWallet()}>
                Use connected wallet
              </button>
            </section>
            {walletAccounts.length > 1 && (
              <div className="wallet-account">
                <label htmlFor="portfolio-account">
                  Wallet account to view
                </label>
                <select
                  id="portfolio-account"
                  value={
                    walletAccounts.some((a) => a.address === address)
                      ? address
                      : ""
                  }
                  onChange={(e) => {
                    setAddressInput(e.target.value);
                    setAddress(e.target.value);
                    setFilter("all");
                  }}
                >
                  <option value="" disabled>
                    Choose an account
                  </option>
                  {walletAccounts.map((a) => (
                    <option key={`${a.source}:${a.address}`} value={a.address}>
                      {a.name || a.address} · {a.source}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {address && network && (
              <Portfolio
                key={`${network.genesisHash}:${address}`}
                address={address}
                network={network}
                claims={connection.claims}
                refreshVersion={portfolioRefresh}
                onOpen={(url, period) => {
                  setPortfolioPage(url);
                  setPortfolioPeriod(period);
                  setSelected(url);
                  setTimeout(
                    () =>
                      document
                        .getElementById("page-details")
                        ?.scrollIntoView({ behavior: "smooth" }),
                    0,
                  );
                }}
              />
            )}
            <h2>Saved watchlist overview</h2>
            <section className="stats" aria-label="Saved page overview">
              <article>
                <span>Pages tracked</span>
                <strong>
                  {pages.length}
                  <small> / {MAX_PAGES}</small>
                </strong>
              </article>
              <article>
                <span>Owned now</span>
                <strong>{address ? totals?.owned : "—"}</strong>
              </article>
              <article>
                <span>Current reserved earnings</span>
                <strong className="amount">
                  {address ? money(totals?.reserved ?? 0n) : "Choose a wallet"}
                </strong>
                <small>
                  {address
                    ? `${money(totals?.withdrawable ?? 0n)} withdrawable`
                    : "View an address above"}
                </small>
              </article>
              <article className={totals?.challenges ? "attention" : ""}>
                <span>Active challenges</span>
                <strong>{totals?.challenges ?? 0}</strong>
              </article>
            </section>
            <p className="scope-note">
              Totals cover successfully loaded saved pages and current ownership
              periods. Historical earnings are shown separately below. Pages are
              saved only in this browser, separately for each chain.
            </p>
            {alerts.length > 0 && (
              <section className="challenge-list" aria-label="Ownership alerts">
                <h2>Ownership needs your attention</h2>
                {alerts.map((url) => {
                  const page = entries[url]!.data!,
                    pending = page.pending!;
                  return (
                    <div className="challenge" key={url}>
                      <div>
                        <strong>
                          {page.chainTime >= pending.deadline
                            ? "Replacement expired — cleanup available"
                            : "Replacement pending — withdrawals held"}
                        </strong>
                        <p>{short(url)}</p>
                        <small>
                          Standard waiting window ends{" "}
                          {when(pending.earliestActivation)} · completion
                          deadline {when(pending.deadline)}
                        </small>
                      </div>
                      <button
                        className="secondary"
                        onClick={() => {
                          setSelected(url);
                          document
                            .getElementById("page-details")
                            ?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        Review challenge
                      </button>
                    </div>
                  );
                })}
                <p className="muted">
                  Restoring your accepted head tag can defeat the final check. A
                  wallet objection is visible, but does not veto a valid
                  replacement.
                </p>
              </section>
            )}
            <section className="pages-panel">
              <div className="section-heading">
                <h2>Saved pages</h2>
                <span className="muted">
                  {updated
                    ? `Last refresh ${updated.toLocaleTimeString()}`
                    : "Waiting for page data"}
                </span>
              </div>
              <form className="add-page inline" onSubmit={track}>
                <label className="sr-only" htmlFor="page-url">
                  Page URL
                </label>
                <input
                  id="page-url"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="https://your-site.com/a-page"
                />
                <button>Add page</button>
              </form>
              <div className="filters" aria-label="Page filters">
                {(["all", "mine", "challenges"] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={filter === value}
                    disabled={value === "mine" && !address}
                    onClick={() => setFilter(value)}
                  >
                    {value === "all"
                      ? "All saved"
                      : value === "mine"
                        ? "Owned by this wallet"
                        : "Challenges"}
                  </button>
                ))}
              </div>
              {visible.length === 0 ? (
                <div className="empty">
                  <h3>
                    {pages.length
                      ? "No pages match this view."
                      : "Add your first page."}
                  </h3>
                  <p>
                    {pages.length
                      ? "Try another filter."
                      : "Save a page to check its claim, earnings, and ownership changes."}
                  </p>
                </div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Page</th>
                        <th>Status</th>
                        <th>Current earnings</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((url) => {
                        const row = entries[url],
                          data = row?.data;
                        return (
                          <tr
                            key={url}
                            className={selected === url ? "selected" : ""}
                          >
                            <td>
                              <button
                                className="page-link"
                                onClick={() => setSelected(url)}
                              >
                                {short(url)}
                              </button>
                              {data?.current && (
                                <small>
                                  {activeMine(data)
                                    ? "Owned by this wallet"
                                    : `Owner: ${data.current.owner}`}
                                </small>
                              )}
                            </td>
                            <td>
                              <span
                                className={`badge ${row?.error ? "danger" : data?.pending ? "amber" : data?.current ? "green" : ""}`}
                              >
                                {row?.error
                                  ? "Refresh failed"
                                  : !data
                                    ? "Loading…"
                                    : data.pending
                                      ? "Replacement pending"
                                      : data.current
                                        ? "Claimed"
                                        : "Unclaimed"}
                              </span>
                              {row?.error && (
                                <small role="status">
                                  {row.error} Balances below are last seen.
                                </small>
                              )}
                            </td>
                            <td>
                              {data
                                ? money(data.current?.balance ?? data.unclaimed)
                                : "—"}
                              <small>
                                {data?.current
                                  ? `${money(data.current.withdrawable)} currently withdrawable`
                                  : "Held until first claim"}
                              </small>
                            </td>
                            <td>
                              <button
                                className="secondary compact"
                                onClick={() => setSelected(url)}
                              >
                                Manage
                              </button>
                              <button
                                className="text-button"
                                aria-label={`Stop tracking ${url}`}
                                onClick={() => forget(url)}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {selected && (
              <section id="page-details" className="detail-panel">
                <div className="section-heading">
                  <div>
                    <span className="section-kicker">PAGE ACTIONS</span>
                    <h2>Manage publishing control.</h2>
                  </div>
                </div>
                <p className="muted">
                  Choose the signing wallet in the controls below. Viewing an
                  address above does not authorize that wallet.
                </p>
                <WikaClaim
                  key={`${network?.genesisHash}:${selected}`}
                  client={connection.claims}
                  url={selected}
                  wallet={wallet}
                  appName="Wika owners"
                />
                {connection.referrals && <Hosts client={connection.referrals} wallet={wallet} source={selected} />}
                {currentId && currentId > 1n ? (
                  <section className="history">
                    <div className="section-heading">
                      <div>
                        <span className="section-kicker">
                          EARLIER OWNERSHIP
                        </span>
                        <h3>Reserved historical earnings</h3>
                      </div>
                      <button
                        className="secondary compact"
                        disabled={historyBusy || historyStart === null}
                        onClick={() =>
                          historyStart !== null &&
                          void loadHistory(historyStart)
                        }
                      >
                        Refresh history
                      </button>
                    </div>
                    <p>
                      Earlier earnings stay with their original wallet. Closed
                      periods do not need current website proof; pending
                      replacements still freeze page withdrawals.
                    </p>
                    {historyError && (
                      <p role="alert" className="error-text">
                        {historyError}
                      </p>
                    )}
                    {historyBusy ? (
                      <p role="status">Loading earlier periods…</p>
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Period</th>
                              <th>Original wallet</th>
                              <th>Reserved</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {history
                              .filter(
                                (p) =>
                                  !address ||
                                  claims!.isSameAccount(address, p.owner),
                              )
                              .map((p) => (
                                <tr key={String(p.id)}>
                                  <td>
                                    #{String(p.id)}
                                    <small>
                                      {when(p.startedAt)} —{" "}
                                      {p.endedAt === null
                                        ? "Current"
                                        : when(p.endedAt)}
                                    </small>
                                  </td>
                                  <td>
                                    <code>{p.owner}</code>
                                  </td>
                                  <td>{money(p.balance)}</td>
                                  <td>
                                    <button
                                      disabled={acting || p.withdrawable === 0n}
                                      className="secondary compact"
                                      onClick={() => void reviewHistorical(p)}
                                    >
                                      Review withdrawal
                                    </button>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                        {!history.some(
                          (p) =>
                            !address || claims!.isSameAccount(address, p.owner),
                        ) && <p>No periods for this wallet in this batch.</p>}
                      </div>
                    )}
                    <div className="history-nav">
                      <button
                        className="secondary compact"
                        disabled={
                          historyBusy ||
                          historyStart === null ||
                          historyStart >= currentId - 1n
                        }
                        onClick={() =>
                          void loadHistory(
                            historyStart! + BigInt(HISTORY_PAGE_SIZE) >
                              currentId - 1n
                              ? currentId - 1n
                              : historyStart! + BigInt(HISTORY_PAGE_SIZE),
                          )
                        }
                      >
                        Newer periods
                      </button>
                      <span>Up to {HISTORY_PAGE_SIZE} periods per batch</span>
                      <button
                        className="secondary compact"
                        disabled={
                          historyBusy ||
                          historyStart === null ||
                          historyStart <= BigInt(HISTORY_PAGE_SIZE)
                        }
                        onClick={() =>
                          void loadHistory(
                            historyStart! - BigInt(HISTORY_PAGE_SIZE),
                          )
                        }
                      >
                        Older periods
                      </button>
                    </div>
                  </section>
                ) : null}
                {review && (
                  <section
                    className="history-quote"
                    aria-label="Historical withdrawal quote"
                  >
                    <h3>Review historical withdrawal</h3>
                    <p>
                      Signing wallet: <code>{review.account.address}</code>
                    </p>
                    {review.quote.action.kind === "withdraw" && (
                      <p>
                        Period #{String(review.quote.action.period)} · Amount:{" "}
                        {money(review.quote.action.amount)}
                        <br />
                        Page: {review.quote.action.url}
                      </p>
                    )}
                    <p>
                      Network fee estimate: {money(review.quote.networkFee)} ·
                      Verification charge: {money(review.quote.verificationFee)}{" "}
                      · Refundable bond: {money(review.quote.refundableBond)}
                    </p>
                    <p>
                      This pays the selected period’s reserved rewards to its
                      original wallet. No new website control is required.
                    </p>
                    <button
                      disabled={acting || !review.quote.affordable}
                      onClick={() => void withdrawHistorical()}
                    >
                      Submit historical withdrawal
                    </button>
                    <button
                      disabled={acting}
                      className="secondary"
                      onClick={() => setReview(null)}
                    >
                      Cancel review
                    </button>
                    {!review.quote.affordable && (
                      <p>
                        Fund this wallet to cover its network fee before
                        withdrawing.
                      </p>
                    )}
                  </section>
                )}
              </section>
            )}
          </>
        )}
        <footer>
          Wika owners preview · Alerts appear while this dashboard is open.
          Email and push delivery are not enabled.
          <br />A broader role-based monitoring app is planned; this preview
          does not control node or validator keys.
        </footer>
      </main>
    </div>
  );
}
