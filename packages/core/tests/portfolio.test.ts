import { describe, it, expect, vi } from "vitest";
import { encodeAddress } from "@polkadot/util-crypto";
import { WikaPortfolioClient, type PortfolioSnapshot } from "../src/portfolio";
const address = encodeAddress(new Uint8Array(32).fill(1), 0);
const canonicalAddress = encodeAddress(new Uint8Array(32).fill(1), 42);
const snapshot: PortfolioSnapshot = {
  height: 100,
  indexedHeight: 100,
  finalizedHeight: 110,
  updatedAt: null,
  healthy: true,
};
const connection = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: !!cursor, endCursor: cursor },
});
const reply = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
describe("indexed wallet discovery", () => {
  it("calls the browser's native fetch with its global receiver", async () => {
    const request = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        reply({
          _metadata: {
            genesisHash: "chain",
            lastProcessedHeight: 1,
            startHeight: 1,
          },
        }),
      );
    });
    vi.stubGlobal("fetch", request);
    try {
      expect(
        (
          await new WikaPortfolioClient("http://localhost:3000").snapshot(
            "chain",
            1,
          )
        ).height,
      ).toBe(1);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    [1794873600000, "2026-11-17T00:00:00.000Z"],
    ["1794873600000", "2026-11-17T00:00:00.000Z"],
    ["2026-11-17T00:00:00Z", "2026-11-17T00:00:00.000Z"],
    [0, "1970-01-01T00:00:00.000Z"],
    [null, null],
    ["invalid", null],
    ["99999999999999999999999", null],
    [-1, null],
  ])(
    "normalizes live metadata timestamp %s for display",
    async (value, expected) => {
      const request = vi.fn(async () =>
        reply({
          _metadata: {
            genesisHash: "chain",
            lastProcessedHeight: 100,
            startHeight: 1,
            indexerHealthy: true,
            lastProcessedTimestamp: value,
          },
        }),
      );
      expect(
        (
          await new WikaPortfolioClient(
            "http://localhost:3000",
            request,
          ).snapshot("chain", 100)
        ).updatedAt,
      ).toBe(expected);
    },
  );
  it("pins the snapshot to finalized history and rejects another chain or incomplete replay", async () => {
    const metadata = {
      genesisHash: "0xCHAIN",
      lastProcessedHeight: 120,
      startHeight: 1,
      indexerHealthy: true,
      lastProcessedTimestamp: "2026-11-17T00:00:00Z",
    };
    const request = vi.fn(async () => reply({ _metadata: metadata }));
    const client = new WikaPortfolioClient("http://localhost:3000", request);
    expect(await client.snapshot("0xchain", 110)).toMatchObject({
      height: 110,
      indexedHeight: 120,
      finalizedHeight: 110,
      healthy: true,
    });
    await expect(client.snapshot("0xother", 110)).rejects.toThrow(
      "different chain",
    );
    metadata.startHeight = 50;
    await expect(client.snapshot("0xchain", 110)).rejects.toThrow("block 1");
  });
  it("paginates each indexed account feed independently using canonical SS58 and exact period ids", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const request = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      calls.push(body);
      if (body.query.includes("ownershipPeriods"))
        return reply({
          ownershipPeriods: connection(
            [
              {
                id: "period",
                url: "https://example.com/",
                period: "9007199254740993",
              },
            ],
            body.variables.after ? null : "cursor",
          ),
        });
      if (body.query.includes("pageReplacements"))
        return reply({
          pageReplacements: connection([
            { id: "candidate", url: "https://example.org/" },
          ]),
        });
      return reply({ claimVerifications: connection([]) });
    });
    const client = new WikaPortfolioClient("http://localhost:3000", request);
    const first = await client.load(address, snapshot);
    expect(first.records[0]?.period).toBe(9007199254740993n);
    expect(first.cursors).toEqual({
      periods: "cursor",
      replacements: false,
      verifications: false,
    });
    const next = await client.load(address, snapshot, first.cursors);
    expect(next.cursors.periods).toBe(false);
    expect(calls).toHaveLength(4);
    expect(
      calls.every(
        (c) =>
          c.variables.account === canonicalAddress &&
          c.variables.height === "100",
      ),
    ).toBe(true);
    expect(calls[3]?.variables.after).toBe("cursor");
    expect(calls[2]?.query).toContain("finishedBlock: { isNull: true }");
  });
  it("rejects partial GraphQL success, repeated cursors and invalid records instead of displaying complete results", async () => {
    let response: unknown = { errors: [{ message: "broken" }], data: {} };
    const request = vi.fn(async () => new Response(JSON.stringify(response)));
    const client = new WikaPortfolioClient("http://localhost:3000", request);
    const cursors = {
      periods: "same",
      replacements: false as const,
      verifications: false as const,
    };
    await expect(client.load(address, snapshot, cursors)).rejects.toThrow(
      "could not answer",
    );
    response = { data: { ownershipPeriods: connection([], "same") } };
    await expect(client.load(address, snapshot, cursors)).rejects.toThrow(
      "did not advance",
    );
    response = {
      data: {
        ownershipPeriods: connection([
          { id: "bad", url: "https://example.com/#fragment", period: "1" },
        ]),
      },
    };
    await expect(client.load(address, snapshot, cursors)).rejects.toThrow(
      "noncanonical",
    );
  });
  it("passes cancellation, omits credentials and reports HTTP errors", async () => {
    const request = vi.fn(
      async () => new Response("unavailable", { status: 503 }),
    );
    const controller = new AbortController();
    const client = new WikaPortfolioClient("http://localhost:3000", request);
    await expect(
      client.snapshot("chain", 1, controller.signal),
    ).rejects.toThrow("503");
    const options = (
      request.mock.calls as unknown as [unknown, RequestInit][]
    )[0]![1];
    expect(options.credentials).toBe("omit");
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
    expect(
      () => new WikaPortfolioClient("http://user:password@localhost"),
    ).toThrow("without credentials");
  });
});
