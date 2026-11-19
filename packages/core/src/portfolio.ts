import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { canonicalPageUrl } from "./page-identity";

export type PortfolioKind = "periods" | "replacements" | "verifications";
export interface PortfolioRecord {
  id: string;
  url: string;
  kind: PortfolioKind;
  period?: bigint;
}
export interface PortfolioSnapshot {
  height: number;
  indexedHeight: number;
  finalizedHeight: number;
  updatedAt: string | null;
  healthy: boolean;
}
export type PortfolioCursors = Record<PortfolioKind, string | null | false>;
export interface PortfolioBatch {
  records: PortfolioRecord[];
  cursors: PortfolioCursors;
}
const feeds = {
  periods: {
    field: "ownershipPeriods",
    filter: "owner: { equalTo: $account }",
    fields: "period",
  },
  replacements: {
    field: "pageReplacements",
    filter: "candidate: { equalTo: $account }, active: { equalTo: true }",
    fields: "",
  },
  verifications: {
    field: "claimVerifications",
    filter: "account: { equalTo: $account }, finishedBlock: { isNull: true }",
    fields: "",
  },
} as const;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid portfolio response.");
  return v as Record<string, unknown>;
};
function height(v: unknown): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0)
    throw new Error("Indexer did not report a valid block height.");
  return Number(v);
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.length)
    throw new Error("Invalid portfolio record.");
  return v;
}
function timestamp(value: unknown): string | null {
  const millis =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? /^\d+$/.test(value)
          ? Number(value)
          : Date.parse(value)
        : NaN;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) && millis >= 0
    ? date.toISOString()
    : null;
}
/** Discovery only. Node reads and transaction authorization remain authoritative. */
export class WikaPortfolioClient {
  readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(
        "Use an http:// or https:// indexer URL without credentials or a fragment.",
      );
    this.endpoint = url.href;
  }
  private async query(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      credentials: "omit",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Indexer request failed (${response.status}).`);
    const body = object(await response.json());
    if (body.errors)
      throw new Error(
        "Indexer could not answer the portfolio query. Check its schema and history configuration.",
      );
    return object(body.data);
  }
  async snapshot(
    genesisHash: string,
    finalizedHeight: number,
    signal?: AbortSignal,
  ): Promise<PortfolioSnapshot> {
    const data = await this.query(
      `query PortfolioStatus { _metadata {
      genesisHash lastProcessedHeight lastProcessedTimestamp startHeight indexerHealthy
    } }`,
      {},
      signal,
    );
    const m = object(data._metadata);
    if (text(m.genesisHash).toLowerCase() !== genesisHash.toLowerCase())
      throw new Error(
        "The indexer belongs to a different chain. Choose the indexer for this node.",
      );
    if (height(m.startHeight) > 1)
      throw new Error(
        "Portfolio discovery requires indexer history from block 1.",
      );
    const indexedHeight = height(m.lastProcessedHeight);
    height(finalizedHeight);
    if (!indexedHeight)
      throw new Error("The indexer has not processed any blocks yet.");
    return {
      height: Math.min(indexedHeight, finalizedHeight),
      indexedHeight,
      finalizedHeight,
      updatedAt: timestamp(m.lastProcessedTimestamp),
      healthy: m.indexerHealthy === true,
    };
  }
  async load(
    address: string,
    snapshot: PortfolioSnapshot,
    cursors: PortfolioCursors = {
      periods: null,
      replacements: null,
      verifications: null,
    },
    signal?: AbortSignal,
  ): Promise<PortfolioBatch> {
    // The Wika indexer stores AccountId32 values in the chain's SS58 format (42).
    const account = encodeAddress(decodeAddress(address), 42);
    const next = { ...cursors };
    const results = await Promise.all(
      (Object.keys(feeds) as PortfolioKind[]).map(async (kind) => {
        if (cursors[kind] === false) return [];
        const feed = feeds[kind];
        const data = await this.query(
          `query WalletPortfolio($account: String!, $after: Cursor, $height: String!) {
        ${feed.field}(first: 20, after: $after, orderBy: PRIMARY_KEY_ASC, blockHeight: $height,
          filter: { ${feed.filter} }) {
          nodes { id url ${feed.fields} } pageInfo { hasNextPage endCursor }
        }
      }`,
          { account, after: cursors[kind], height: String(snapshot.height) },
          signal,
        );
        const connection = object(data[feed.field]),
          info = object(connection.pageInfo);
        if (
          !Array.isArray(connection.nodes) ||
          connection.nodes.length > 20 ||
          typeof info.hasNextPage !== "boolean"
        )
          throw new Error("Invalid portfolio pagination.");
        next[kind] = info.hasNextPage ? text(info.endCursor) : false;
        if (next[kind] && next[kind] === cursors[kind])
          throw new Error("Indexer pagination did not advance.");
        return connection.nodes.map((value): PortfolioRecord => {
          const row = object(value),
            url = text(row.url);
          if (canonicalPageUrl(url) !== url)
            throw new Error("Indexer returned a noncanonical page URL.");
          let period: bigint | undefined;
          if (kind === "periods") {
            if (
              typeof row.period !== "string" ||
              !/^[1-9][0-9]*$/.test(row.period)
            )
              throw new Error("Invalid ownership period.");
            period = BigInt(row.period);
          }
          return { id: text(row.id), url, kind, period };
        });
      }),
    );
    return { records: results.flat(), cursors: next };
  }
}
