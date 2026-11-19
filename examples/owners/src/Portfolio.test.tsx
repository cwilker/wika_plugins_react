// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Portfolio } from "./Portfolio";
import { encodeAddress } from "@polkadot/util-crypto";
import type { ClaimPageInfo, WikaClaimsClient } from "@wika/core";
const address = encodeAddress(new Uint8Array(32).fill(1));
const network = {
  genesisHash: "0xchain",
  name: "Test",
  decimals: 0,
  symbol: "WIKA",
};
const url = "https://example.com/";
const period = {
  id: 1n,
  owner: address,
  balance: 123456789012345678901234567890n,
  withdrawable: 7n,
  endedAt: 1n,
  startedAt: 0n,
  proof: "proof",
  verifiedAt: null,
};
const page: ClaimPageInfo = {
  url,
  current: { ...period, id: 9n, owner: "other", endedAt: null },
  atBlock: "block",
  chainTime: 10n,
  unclaimed: 0n,
  pending: null,
  verificationPending: false,
  lastVerification: null,
  retry: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const claims = {
    getFinalizedHeight: vi.fn(async () => 110),
    getPage: vi.fn(async () => page),
    getPeriod: vi.fn(async (_url: string, id: bigint) => ({ ...period, id })),
    isSameAccount: (a: string, b: string) => a === b,
  };
  const fetcher = vi.fn(async (_: unknown, options?: RequestInit) => {
    const { query, variables } = JSON.parse(String(options?.body));
    const feed = query.includes("ownershipPeriods")
      ? "ownershipPeriods"
      : query.includes("pageReplacements")
        ? "pageReplacements"
        : "claimVerifications";
    const data = query.includes("PortfolioStatus")
      ? {
          _metadata: {
            genesisHash: "0xchain",
            startHeight: 1,
            lastProcessedHeight: 100,
            indexerHealthy: true,
            lastProcessedTimestamp: new Date().toISOString(),
          },
        }
      : {
          [feed]: {
            nodes:
              feed === "ownershipPeriods"
                ? [
                    {
                      id: variables.after ? "p2" : "p1",
                      url,
                      period: variables.after ? "2" : "1",
                    },
                  ]
                : [],
            pageInfo: {
              hasNextPage: feed === "ownershipPeriods" && !variables.after,
              endCursor: "next",
            },
          },
        };
    return new Response(JSON.stringify({ data }));
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    claims,
    fetcher,
    props: {
      address,
      network,
      claims: claims as unknown as WikaClaimsClient,
      onOpen: vi.fn(),
    },
  };
}
it("shows lag, checks historical earnings with the node and opens the exact old period", async () => {
  const f = setup(),
    user = userEvent.setup();
  render(<Portfolio {...f.props} />);
  expect(await screen.findByText(/10 blocks behind/)).toBeTruthy();
  expect(await screen.findByText("Earlier ownership")).toBeTruthy();
  expect(f.claims.getPeriod).toHaveBeenCalledWith(url, 1n);
  expect(
    screen.getByText(/123456789012345678901234567890 WIKA/, {
      selector: "strong",
    }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Manage page" }));
  expect(f.props.onOpen).toHaveBeenCalledWith(url, 1n);
  await user.click(
    screen.getByRole("button", { name: "Load more portfolio records" }),
  );
  await waitFor(() => expect(f.claims.getPeriod).toHaveBeenCalledWith(url, 2n));
  expect(
    await screen.findByText(/All indexed records at this snapshot/),
  ).toBeTruthy();
});
it("keeps a failed node check out of totals and offers the watchlist when the indexer fails", async () => {
  const f = setup();
  f.claims.getPage.mockRejectedValue(new Error("offline"));
  render(<Portfolio {...f.props} />);
  expect(await screen.findByText(/Node check failed: offline/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage page" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText(/Earlier reserved/).textContent).toContain("0 WIKA");
  f.fetcher.mockRejectedValue(new Error("query service offline"));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Refresh discovery" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Your saved pages remain available"),
  );
  expect(screen.queryByText("Earlier ownership")).toBeNull();
});
it("discards an old wallet's delayed discovery response", async () => {
  const f = setup();
  let release!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<Portfolio {...f.props} />);
  await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  view.rerender(
    <Portfolio
      {...f.props}
      address={encodeAddress(new Uint8Array(32).fill(2))}
    />,
  );
  await screen.findByText(/10 blocks behind/);
  await act(async () =>
    release(
      new Response(
        JSON.stringify({ data: { _metadata: { genesisHash: "evil" } } }),
      ),
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("removes a previously successful amount from totals when the periodic node refresh fails", async () => {
  const f = setup();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const interval = vi.spyOn(globalThis, "setInterval");
  render(<Portfolio {...f.props} />);
  await screen.findByText("Earlier ownership");
  f.claims.getPage.mockRejectedValue(new Error("connection lost"));
  const refresh = interval.mock.calls
    .filter((call) => call[1] === 30000)
    .at(-1)?.[0] as () => void;
  await act(async () => refresh());
  expect(
    await screen.findByText(/Node check failed: connection lost/),
  ).toBeTruthy();
  expect(screen.getByText(/Earlier reserved/).textContent).toContain("0 WIKA");
  expect(screen.getByRole("button", { name: "Manage page" })).toHaveProperty(
    "disabled",
    true,
  );
});
