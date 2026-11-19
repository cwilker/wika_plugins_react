import { useCallback, useEffect, useRef, useState } from "react";
import {
  WikaPortfolioClient,
  formatAmount,
  type WikaClaimsClient,
  type NetworkInfo,
  type PortfolioRecord,
  type PortfolioSnapshot,
  type PortfolioCursors,
  type ClaimPageInfo,
  type OwnershipPeriodInfo,
} from "@wika/core";

type Checked = {
  page?: ClaimPageInfo;
  period?: OwnershipPeriodInfo;
  error?: string;
};
type Props = {
  address: string;
  network: NetworkInfo;
  claims: WikaClaimsClient;
  onOpen: (url: string, period?: bigint) => void;
  refreshVersion?: number;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const key = (r: PortfolioRecord) =>
  r.kind === "periods" ? `${r.kind}:${r.url}:${r.period}` : `${r.kind}:${r.id}`;
export function Portfolio({
  address,
  network,
  claims,
  onOpen,
  refreshVersion = 0,
}: Props) {
  const [input, setInput] = useState(
    import.meta.env.VITE_WIKA_INDEXER_URL || "http://127.0.0.1:3000",
  );
  const [endpoint, setEndpoint] = useState(input),
    [revision, setRevision] = useState(0);
  const [records, setRecords] = useState<PortfolioRecord[]>([]);
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [cursors, setCursors] = useState<PortfolioCursors | null>(null);
  const [checked, setChecked] = useState<Record<string, Checked>>({});
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [clock, setClock] = useState(Date.now());
  const session = useRef(0),
    request = useRef<AbortController | null>(null),
    loading = useRef(false);
  const load = useCallback(
    async (more: boolean) => {
      if (loading.current) return;
      const token = session.current,
        controller = new AbortController();
      request.current = controller;
      loading.current = true;
      setBusy(true);
      setError("");
      try {
        const client = new WikaPortfolioClient(endpoint);
        const at =
          more && snapshot
            ? snapshot
            : await client.snapshot(
                network.genesisHash,
                await claims.getFinalizedHeight(),
                controller.signal,
              );
        const batch = await client.load(
          address,
          at,
          more && cursors ? cursors : undefined,
          controller.signal,
        );
        if (token !== session.current || controller.signal.aborted) return;
        setSnapshot(at);
        setCursors(batch.cursors);
        setRecords((old) => {
          const unique = new Map(
            (more ? old : []).map((row) => [key(row), row]),
          );
          batch.records.forEach((row) => unique.set(key(row), row));
          return [...unique.values()];
        });
      } catch (e) {
        if (token === session.current && !controller.signal.aborted)
          setError(message(e));
      } finally {
        if (token === session.current) {
          loading.current = false;
          setBusy(false);
        }
      }
    },
    [endpoint, network.genesisHash, claims, address, snapshot, cursors],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    session.current++;
    request.current?.abort();
    loading.current = false;
    setRecords([]);
    setChecked({});
    setCheckedAt(null);
    setSnapshot(null);
    setCursors(null);
    void loadRef.current(false);
    return () => {
      session.current++;
      request.current?.abort();
      loading.current = false;
    };
  }, [endpoint, revision, address, network.genesisHash, claims]);
  useEffect(() => {
    let active = true,
      running = false;
    const verify = async () => {
      if (running) return;
      running = true;
      // Never retain an old successful amount after a failed refresh.
      const values: Record<string, Checked> = {};
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, records.length) }, async () => {
          while (active && next < records.length) {
            const row = records[next++]!;
            try {
              const page = await claims.getPage(row.url);
              if (!active) return;
              const period =
                row.period === undefined
                  ? undefined
                  : page.current?.id === row.period
                    ? page.current
                    : await claims.getPeriod(row.url, row.period);
              if (
                row.kind === "periods" &&
                (!period ||
                  period.id !== row.period ||
                  !claims.isSameAccount(period.owner, address))
              )
                throw new Error(
                  "This indexed period does not belong to this wallet on the node.",
                );
              values[key(row)] = { page, period: period ?? undefined };
            } catch (e) {
              values[key(row)] = { error: message(e) };
            }
          }
        }),
      );
      if (active) {
        setChecked(values);
        setCheckedAt(new Date());
      }
      running = false;
    };
    void verify();
    const timer = setInterval(() => {
      setClock(Date.now());
      if (document.visibilityState === "visible") void verify();
    }, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [records, claims, address, refreshVersion]);
  const more =
    cursors && Object.values(cursors).some((value) => value !== false);
  const money = (value: bigint) =>
    formatAmount(value, network.decimals, network.symbol);
  let current = 0n,
    historical = 0n,
    available = 0n,
    failed = 0;
  for (const row of records) {
    const value = checked[key(row)];
    if (value?.error) failed++;
    if (value?.period && !value.error) {
      if (value.period.endedAt === null) current += value.period.balance;
      else historical += value.period.balance;
      available += value.period.withdrawable;
    }
  }
  const lag = snapshot
    ? Math.max(0, snapshot.finalizedHeight - snapshot.height)
    : 0;
  const age = snapshot?.updatedAt
    ? Math.max(0, Math.floor((clock - Date.parse(snapshot.updatedAt)) / 60000))
    : null;
  return (
    <section className="pages-panel portfolio" aria-label="Wallet portfolio">
      <div className="section-heading">
        <h2>Wallet portfolio</h2>
        <button
          className="secondary compact"
          disabled={busy}
          onClick={() => setRevision((n) => n + 1)}
        >
          Refresh discovery
        </button>
      </div>
      <p className="muted">
        Find current pages, earlier earnings and pending claims for this wallet.
        Your saved watchlist stays below.
      </p>
      <form
        className="inline"
        onSubmit={(event) => {
          event.preventDefault();
          setEndpoint(input.trim());
          setRevision((n) => n + 1);
        }}
      >
        <label className="sr-only" htmlFor="indexer-url">
          Portfolio indexer URL
        </label>
        <input
          id="indexer-url"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
        />
        <button disabled={busy}>Connect indexer</button>
      </form>
      {error && (
        <p role="alert" className="error-text">
          {error} Your saved pages remain available below. Check that the query
          service is running and allows this dashboard’s origin.
        </p>
      )}
      {snapshot && (
        <p className="scope-note" role="status">
          Indexed snapshot: block {snapshot.height} · node finalized block{" "}
          {snapshot.finalizedHeight} · {lag} blocks behind at discovery.
          {snapshot.updatedAt
            ? ` Indexer last processed a block at ${new Date(snapshot.updatedAt).toLocaleString()}${age !== null && Number.isFinite(age) ? ` (${age} minutes ago)` : ""}.`
            : " Indexer update time unavailable."}
          {!snapshot.healthy &&
            " Indexer health is unconfirmed; results may be incomplete."}
          {lag > 0 && " Recent pages and claims may be missing."}{" "}
          {more
            ? "More records available; load the next batch."
            : "All indexed records at this snapshot have been loaded."}{" "}
          Refresh discovery to find newer changes.
        </p>
      )}
      {records.length > 0 && (
        <>
          <p className="portfolio-totals">
            Current reserved: <strong>{money(current)}</strong> · Earlier
            reserved: <strong>{money(historical)}</strong> · Withdrawable:{" "}
            <strong>{money(available)}</strong>
          </p>
          <p className="scope-note">
            Totals cover node-checked ownership periods loaded here, excluding
            failed reads ({failed}).{" "}
            {records.filter((row) => !checked[key(row)]).length} records
            awaiting node checks.
            {checkedAt &&
              ` Node checks refreshed ${checkedAt.toLocaleTimeString()}.`}{" "}
            Checks refresh every 30 seconds while visible. Each row is a
            separate node snapshot.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Page / period</th>
                  <th>Node status</th>
                  <th>Reserved earnings</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {records.map((row) => {
                  const value = checked[key(row)],
                    page = value?.page,
                    period = value?.period;
                  const status =
                    row.kind === "periods"
                      ? period?.endedAt === null
                        ? "Owned now"
                        : "Earlier ownership"
                      : row.kind === "replacements"
                        ? page?.pending &&
                          claims.isSameAccount(page.pending.candidate, address)
                          ? "Replacement pending"
                          : "Replacement no longer pending"
                        : page?.verificationPending
                          ? "Verification pending (indexed account)"
                          : "Verification no longer pending";
                  return (
                    <tr key={key(row)}>
                      <td>
                        {row.url}
                        <small>
                          {row.period !== undefined
                            ? `Period #${row.period}`
                            : row.kind === "replacements"
                              ? "Replacement candidate"
                              : "Claim / verification request"}
                        </small>
                      </td>
                      <td>
                        {value?.error ? (
                          <span className="error-text">
                            Node check failed: {value.error}
                          </span>
                        ) : !value ? (
                          "Checking node…"
                        ) : (
                          status
                        )}
                        {page?.pending && (
                          <small>
                            {page.chainTime < page.pending.deadline
                              ? "Withdrawals held"
                              : "Replacement expired"}{" "}
                            · completion deadline{" "}
                            {new Date(
                              Number(page.pending.deadline),
                            ).toLocaleString()}
                          </small>
                        )}
                      </td>
                      <td>
                        {period && !value?.error ? (
                          <>
                            {money(period.balance)}
                            <small>
                              {money(period.withdrawable)} withdrawable
                            </small>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <button
                          className="secondary compact"
                          disabled={!page || !!value?.error}
                          onClick={() =>
                            onOpen(
                              row.url,
                              period?.endedAt !== null ? row.period : undefined,
                            )
                          }
                        >
                          Manage page
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {busy && <p role="status">Finding wallet pages…</p>}
      {!busy && !error && snapshot && records.length === 0 && (
        <p>
          No pages or pending claims found in this indexed snapshot. Recent
          activity may still be indexing.
        </p>
      )}
      {more && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load more portfolio records
        </button>
      )}
    </section>
  );
}
