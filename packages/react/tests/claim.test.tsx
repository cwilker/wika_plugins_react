// @vitest-environment happy-dom
import { afterEach, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WikaClaim } from "../src";
import type {
  ClaimPageInfo,
  OwnershipAction,
  WikaClaimsClient,
  WalletAdapter,
} from "@wika/core";
afterEach(cleanup);
const url = "https://example.com/post";
function fixture(page: Partial<ClaimPageInfo> = {}) {
  const proof = {
    page: url,
    content: "wika-claim-v1:aa.bb",
    proofDigest: "0xhash",
  };
  const state: ClaimPageInfo = {
    url,
    atBlock: "0xblock",
    chainTime: 1000n,
    unclaimed: 100n,
    current: null,
    pending: null,
    verificationPending: false,
    lastVerification: null,
    retry: null,
    ...page,
  };
  const client = {
    genesisHash: "0xgenesis",
    getPage: vi.fn(async () => state),
    getNetwork: vi.fn(async () => ({
      name: "Test",
      genesisHash: "0xgenesis",
      decimals: 0,
      symbol: "WIKA",
    })),
    isSameAccount: (a: string, b: string) => a === b,
    createProof: vi.fn(async () => proof),
    quote: vi.fn(async (_account: string, action: OwnershipAction) => ({
      account: "alice",
      action,
      networkFee: 1n,
      verificationFee: 5n,
      refundableBond: 3n,
      totalRequired: 9n,
      affordable: true,
      atBlock: "0xblock",
    })),
    submit: vi.fn(async () => ({ txHash: "0xtx", blockHash: "0xblock" })),
  };
  const wallet: WalletAdapter = {
    connect: vi.fn(async () => [
      { address: "alice", name: "Alice", source: "test" },
    ]),
    getSigner: vi.fn(async () => ({})),
  };
  return { client, wallet, proof, state };
}
it("signs proof, gives head-only instructions, quotes each cost, then requires explicit submission", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(
    <WikaClaim
      client={f.client as unknown as WikaClaimsClient}
      url={url}
      wallet={f.wallet}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
  await user.click(
    await screen.findByRole("button", { name: "Sign publishing proof" }),
  );
  expect(
    await screen.findByLabelText(
      "Publish exactly one tag in the server-delivered HTML head",
    ),
  ).toHaveProperty(
    "value",
    `<meta name="wika-claim" content="${f.proof.content}">`,
  );
  await user.click(
    screen.getByRole("button", { name: "Published the tag — review claim" }),
  );
  expect(await screen.findByText("Network fee: 1 WIKA")).toBeTruthy();
  expect(screen.getByText("Verification fee: 5 WIKA")).toBeTruthy();
  expect(screen.getByText("Refundable bond: 3 WIKA")).toBeTruthy();
  expect(f.client.submit).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Submit for wallet approval" }),
  );
  await waitFor(() =>
    expect(f.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({ address: "alice" }),
      {},
      { kind: "claim", proof: f.proof },
      expect.objectContaining({
        maxTotal: 9n,
        signal: expect.any(AbortSignal),
      }),
    ),
  );
  expect(
    await screen.findByText(
      /Website verification, when required, continues separately/,
    ),
  ).toBeTruthy();
});
it("makes challenges visible and offers owner responses while withdrawals are frozen", async () => {
  const f = fixture({
    current: {
      id: 1n,
      owner: "alice",
      startedAt: 100n,
      endedAt: null,
      balance: 100n,
      proof: "accepted-proof",
      verifiedAt: null,
      withdrawable: 0n,
    },
    pending: {
      id: "0xid",
      candidate: "bob",
      previousPeriod: 1n,
      openedAt: 500n,
      earliestActivation: 2000n,
      deadline: 3000n,
      bond: 3n,
      ownerApproved: false,
      candidateApproved: false,
      objection: false,
    },
  });
  const user = userEvent.setup();
  render(
    <WikaClaim
      client={f.client as unknown as WikaClaimsClient}
      url={url}
      wallet={f.wallet}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
  expect(await screen.findByText("Ownership replacement pending")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review objection" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Review cooperative approval" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Review withdrawal" }),
  ).toBeNull();
  expect(screen.getByLabelText("Your accepted proof")).toHaveProperty(
    "value",
    '<meta name="wika-claim" content="accepted-proof">',
  );
});
it("discards a proof signature that finishes after the page changes", async () => {
  const f = fixture();
  let finish!: (proof: typeof f.proof) => void;
  f.client.createProof.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  const view = render(
    <WikaClaim
      client={f.client as unknown as WikaClaimsClient}
      url={url}
      wallet={f.wallet}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
  await user.click(
    await screen.findByRole("button", { name: "Sign publishing proof" }),
  );
  view.rerender(
    <WikaClaim
      client={f.client as unknown as WikaClaimsClient}
      url="https://example.com/other"
      wallet={f.wallet}
    />,
  );
  await act(async () => finish(f.proof));
  expect(
    screen.queryByLabelText(
      "Publish exactly one tag in the server-delivered HTML head",
    ),
  ).toBeNull();
  expect(f.client.submit).not.toHaveBeenCalled();
});

it("does not submit an old page quote after an asynchronous signer lookup", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const view = render(<WikaClaim client={f.client as unknown as WikaClaimsClient} url={url} wallet={f.wallet} />);
  await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
  await user.click(await screen.findByRole('button', { name: 'Sign publishing proof' }));
  await user.click(screen.getByRole('button', { name: 'Published the tag — review claim' }));
  await screen.findByText('Network fee: 1 WIKA');
  let resolveSigner!: (value: {}) => void;
  vi.mocked(f.wallet.getSigner).mockImplementationOnce(() => new Promise(resolve => { resolveSigner = resolve; }));
  await user.click(screen.getByRole('button', { name: 'Submit for wallet approval' }));
  view.rerender(<WikaClaim client={f.client as unknown as WikaClaimsClient} url="https://example.com/another-page" wallet={f.wallet} />);
  await act(async () => { resolveSigner({}); });
  expect(f.client.submit).not.toHaveBeenCalled();
});

it('lets a current owner restore the accepted tag before any challenge, without reclaiming', async () => {
  const f = fixture({ current: { id: 1n, owner: 'alice', startedAt: 100n, endedAt: null, balance: 100n, proof: 'persistent-accepted-proof', verifiedAt: null, withdrawable: 0n } });
  const user = userEvent.setup();
  render(<WikaClaim client={f.client as unknown as WikaClaimsClient} url={url} wallet={f.wallet} />);
  await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
  await user.click(await screen.findByText('Restore your accepted publishing tag'));
  expect(screen.getByLabelText('Your accepted proof')).toHaveProperty('value', '<meta name="wika-claim" content="persistent-accepted-proof">');
  expect(screen.queryByRole('button', { name: 'Sign publishing proof' })).toBeNull();
  expect(f.client.submit).not.toHaveBeenCalled();
});
