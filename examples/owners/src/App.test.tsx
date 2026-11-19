// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OwnersApp } from "./App";
import type { ClaimPageInfo, WikaClient } from "@wika/core";
vi.mock("@wika/react", () => ({
  WikaClaim: ({ url }: { url: string }) => <div>Claim controls: {url}</div>,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const url = "https://example.com/post";
const state: ClaimPageInfo = {
  url,
  atBlock: "0xblock",
  chainTime: 1000n,
  unclaimed: 50n,
  current: {
    id: 2n,
    owner: "alice",
    startedAt: 0n,
    endedAt: null,
    balance: 12n,
    proof: "proof",
    verifiedAt: 0n,
    withdrawable: 0n,
  },
  pending: {
    id: "replacement",
    candidate: "bob",
    previousPeriod: 2n,
    openedAt: 10n,
    earliestActivation: 10000n,
    deadline: 20000n,
    bond: 1n,
    ownerApproved: false,
    candidateApproved: false,
    objection: false,
  },
  verificationPending: false,
  lastVerification: null,
  retry: null,
};
function fixture(getPage = vi.fn(async () => state)) {
  const claims = {
    getPage,
    getPeriod: vi.fn(async () => ({
      ...state.current!,
      id: 1n,
      endedAt: 1n,
      balance: 8n,
      withdrawable: 8n,
    })),
    isSameAccount: (a: string, b: string) => a === b,
    quote: vi.fn(),
    submit: vi.fn(),
  };
  const disconnect = vi.fn(async () => {});
  const connection = {
    claims,
    getNetwork: async () => ({
      name: "Test chain",
      genesisHash: "0xowners-test",
      decimals: 0,
      symbol: "WIKA",
    }),
    supportsSafeClaims: true,
    disconnect,
  } as unknown as WikaClient;
  return { connection, claims, disconnect };
}
it("saves pages, surfaces a challenge and reviews historical earnings only with the original wallet", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const account = { address: "alice", name: "Alice", source: "test" };
  const wallet = { connect: vi.fn(async () => [account]), getSigner: vi.fn() };
  f.claims.quote.mockImplementation(
    async (account: string, action: unknown) => ({
      account,
      action,
      networkFee: 1n,
      verificationFee: 0n,
      refundableBond: 0n,
      totalRequired: 1n,
      affordable: true,
      atBlock: "0xblock",
    }),
  );
  render(<OwnersApp connect={async () => f.connection} wallet={wallet} />);
  await user.click(screen.getByRole("button", { name: "Connect node" }));
  await user.type(await screen.findByLabelText("Page URL"), `${url}#fragment`);
  await user.click(screen.getByRole("button", { name: "Add page" }));
  expect(
    await screen.findByText("Replacement pending — withdrawals held"),
  ).toBeTruthy();
  expect(screen.getByText(/completion deadline/)).toBeTruthy();
  expect(
    JSON.parse(localStorage.getItem("wika:owners:v1:0xowners-test")!).pages,
  ).toEqual([url]);
  await user.click(
    await screen.findByRole("button", { name: "Review withdrawal" }),
  );
  expect(
    await screen.findByRole("region", { name: "Historical withdrawal quote" }),
  ).toBeTruthy();
  expect(screen.getByText(/Amount: 8 WIKA/)).toBeTruthy();
  expect(f.claims.quote).toHaveBeenCalledWith("alice", {
    kind: "withdraw",
    url,
    period: 1n,
    amount: 8n,
  });
  expect(f.claims.submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel review" }));
  wallet.connect.mockResolvedValue([{ ...account, address: "bob" }]);
  await user.click(screen.getByRole("button", { name: "Review withdrawal" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Connect the wallet that owns these historical earnings.",
  );
  expect(f.claims.quote).toHaveBeenCalledTimes(1);
});
it("does not resurrect a removed page when its pending node read completes", async () => {
  let resolve!: (value: ClaimPageInfo) => void;
  const f = fixture(
    vi.fn(
      () =>
        new Promise<ClaimPageInfo>((done) => {
          resolve = done;
        }),
    ),
  );
  const user = userEvent.setup();
  render(<OwnersApp connect={async () => f.connection} />);
  await user.click(screen.getByRole("button", { name: "Connect node" }));
  await user.type(await screen.findByLabelText("Page URL"), url);
  await user.click(screen.getByRole("button", { name: "Add page" }));
  await waitFor(() => expect(f.claims.getPage).toHaveBeenCalled());
  await user.click(
    screen.getByRole("button", { name: `Stop tracking ${url}` }),
  );
  await act(async () => resolve(state));
  expect(
    screen.queryByText("Replacement pending — withdrawals held"),
  ).toBeNull();
  expect(screen.getByText("Add your first page.")).toBeTruthy();
});

it("does not submit a reviewed withdrawal if the page is removed while the wallet signer is loading", async () => {
  const f = fixture();
  const user = userEvent.setup();
  let release!: (value: never) => void;
  const account = { address: "alice", name: "Alice", source: "test" };
  const wallet = {
    connect: vi.fn(async () => [account]),
    getSigner: vi.fn(
      () =>
        new Promise<never>((resolve) => {
          release = resolve;
        }),
    ),
  };
  f.claims.quote.mockImplementation(
    async (account: string, action: unknown) => ({
      account,
      action,
      networkFee: 1n,
      verificationFee: 0n,
      refundableBond: 0n,
      totalRequired: 1n,
      affordable: true,
      atBlock: "0xblock",
    }),
  );
  render(<OwnersApp connect={async () => f.connection} wallet={wallet} />);
  await user.click(screen.getByRole("button", { name: "Connect node" }));
  await user.type(await screen.findByLabelText("Page URL"), url);
  await user.click(screen.getByRole("button", { name: "Add page" }));
  await user.click(
    await screen.findByRole("button", { name: "Review withdrawal" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Submit historical withdrawal" }),
  );
  await waitFor(() => expect(wallet.getSigner).toHaveBeenCalled());
  await user.click(
    screen.getByRole("button", { name: `Stop tracking ${url}` }),
  );
  await act(async () => release({} as never));
  expect(f.claims.submit).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Historical withdrawal quote" }),
  ).toBeNull();
});

it("discovers an unsaved historical page and reviews its exact old period after choosing a wallet account", async () => {
  const { encodeAddress } = await import("@polkadot/util-crypto");
  const alice = encodeAddress(new Uint8Array(32).fill(1));
  const bob = encodeAddress(new Uint8Array(32).fill(2));
  const f = fixture(
    vi.fn(async () => ({
      ...state,
      current: { ...state.current!, id: 10n, owner: bob },
      pending: null,
    })),
  );
  Object.assign(f.claims, { getFinalizedHeight: vi.fn(async () => 110) });
  f.claims.getPeriod.mockImplementation(async (_url?: string, id?: bigint) => ({
    ...state.current!,
    id: id ?? 1n,
    owner: alice,
    endedAt: 1n,
    balance: 8n,
    withdrawable: 8n,
  }));
  f.claims.quote.mockImplementation(
    async (account: string, action: unknown) => ({
      account,
      action,
      networkFee: 1n,
      verificationFee: 0n,
      refundableBond: 0n,
      totalRequired: 1n,
      affordable: true,
      atBlock: "block",
    }),
  );
  const wallet = {
    connect: vi.fn(async () => [
      { address: bob, source: "test", name: "Bob" },
      { address: alice, source: "test", name: "Alice" },
    ]),
    getSigner: vi.fn(),
  };
  const fetcher = vi.fn(async (_: unknown, options?: RequestInit) => {
    const { query, variables } = JSON.parse(String(options?.body));
    const field = query.includes("ownershipPeriods")
      ? "ownershipPeriods"
      : query.includes("pageReplacements")
        ? "pageReplacements"
        : "claimVerifications";
    return new Response(
      JSON.stringify({
        data: query.includes("PortfolioStatus")
          ? {
              _metadata: {
                genesisHash: "0xowners-test",
                startHeight: 1,
                lastProcessedHeight: 100,
                indexerHealthy: true,
              },
            }
          : {
              [field]: {
                nodes:
                  field === "ownershipPeriods" && variables.account === alice
                    ? [{ id: "p1", url, period: "1" }]
                    : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    render(<OwnersApp connect={async () => f.connection} wallet={wallet} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Connect node" }));
    await user.click(
      screen.getByRole("button", { name: "Use connected wallet" }),
    );
    await user.selectOptions(
      await screen.findByLabelText("Wallet account to view"),
      alice,
    );
    await user.click(
      await screen.findByRole("button", { name: "Manage page" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review withdrawal" }),
    );
    expect(
      await screen.findByRole("region", {
        name: "Historical withdrawal quote",
      }),
    ).toBeTruthy();
    expect(f.claims.quote).toHaveBeenCalledWith(alice, {
      kind: "withdraw",
      url,
      period: 1n,
      amount: 8n,
    });
    expect(f.claims.getPeriod).toHaveBeenCalledWith(url, 1n);
    expect(localStorage.getItem("wika:owners:v1:0xowners-test")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
