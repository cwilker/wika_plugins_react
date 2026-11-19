import { describe, it, expect } from "vitest";
import {
  addPage,
  readPages,
  savePages,
  periodWindow,
  overview,
  MAX_PAGES,
} from "./watchlist";
import type { ClaimPageInfo } from "@wika/core";
const page = (overrides: Partial<ClaimPageInfo> = {}): ClaimPageInfo => ({
  url: "https://example.com/post",
  atBlock: "0xblock",
  chainTime: 100n,
  unclaimed: 0n,
  current: null,
  pending: null,
  verificationPending: false,
  lastVerification: null,
  retry: null,
  ...overrides,
});
describe("saved owners pages", () => {
  it("deduplicates equivalent fragments but keeps queries and trailing slashes distinct", () => {
    let pages = addPage([], "https://EXAMPLE.com/post#one");
    pages = addPage(pages, "https://example.com/post#two");
    pages = addPage(pages, "https://example.com/post?q=1");
    pages = addPage(pages, "https://example.com/post/");
    expect(pages).toEqual([
      "https://example.com/post",
      "https://example.com/post?q=1",
      "https://example.com/post/",
    ]);
  });
  it("isolates watchlists by chain and rejects corrupt or oversized storage", () => {
    const map = new Map<string, string>(),
      storage = {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
      };
    savePages(storage, "chain-a", ["https://example.com/"]);
    expect(readPages(storage, "chain-a")).toEqual(["https://example.com/"]);
    expect(readPages(storage, "chain-b")).toEqual([]);
    storage.setItem(
      "wika:owners:v1:chain-b",
      JSON.stringify({ version: 1, pages: [42] }),
    );
    expect(() => readPages(storage, "chain-b")).toThrow();
    const full = Array.from(
      { length: MAX_PAGES },
      (_, n) => `https://example.com/${n}`,
    );
    expect(() => addPage(full, "https://example.com/new")).toThrow(/25/);
    expect(addPage(full, full[0]!)).toBe(full);
  });
  it("bounds history batches even for very large period ids", () => {
    expect(periodWindow(3n)).toEqual([3n, 2n, 1n]);
    const start = 2n ** 64n;
    expect(periodWindow(start)).toEqual([
      start,
      start - 1n,
      start - 2n,
      start - 3n,
      start - 4n,
    ]);
  });
  it("excludes failed reads and other wallets from exact earnings totals, and expired challenges from active counts", () => {
    const current = {
      id: 1n,
      owner: "alice",
      startedAt: 0n,
      endedAt: null,
      balance: 9007199254740993n,
      proof: "proof",
      verifiedAt: 0n,
      withdrawable: 7n,
    };
    const pending = {
      id: "id",
      candidate: "bob",
      previousPeriod: 1n,
      openedAt: 1n,
      earliestActivation: 80n,
      deadline: 200n,
      bond: 1n,
      ownerApproved: false,
      candidateApproved: false,
      objection: false,
    };
    const entries = {
      fresh: { data: page({ current, pending }) },
      stale: { data: page({ current }), error: "offline" },
      other: { data: page({ current: { ...current, owner: "carol" } }) },
      expired: { data: page({ pending: { ...pending, deadline: 100n } }) },
    };
    const equal = { isSameAccount: (a: string, b: string) => a === b };
    expect(overview(entries, "alice", equal)).toEqual({
      owned: 1,
      reserved: 9007199254740993n,
      withdrawable: 7n,
      challenges: 1,
    });
    expect(overview(entries, "bob", equal)).toEqual({
      owned: 0,
      reserved: 0n,
      withdrawable: 0n,
      challenges: 1,
    });
  });
});
