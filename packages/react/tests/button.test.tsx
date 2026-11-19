// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { WikaLike } from "../src";
import type {
  LikeQuote,
  PageInfo,
  Signer,
  SubmitOptions,
  WalletAccount,
  WikaClientLike,
} from "@wika/core";

beforeAll(() => {
  // happy-dom lacks the browser's modal top-layer implementation.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(cleanup);
const url = "https://example.org/story?q=one,two";
const accounts: WalletAccount[] = [
  { address: "alice", name: "Alice", source: "wika" },
];
const quote: LikeQuote = {
  request: { url, count: 1, referrerUrl: "" },
  price: 100n,
  maxLikes: 100,
  cost: 100n,
  estimatedFee: 5n,
  total: 105n,
  affordable: true,
  balance: {
    free: 10000n,
    frozen: 0n,
    existentialDeposit: 10n,
    spendable: 9990n,
  },
};
const receipt = { txHash: "0xtx", blockHash: "0xblock" };
function fixture() {
  const stop = vi.fn(),
    stopAccounts = vi.fn();
  let accountListener: ((value: WalletAccount[]) => void) | undefined;
  let pageListener: ((value: PageInfo) => void) | undefined;
  const client = {
    getNetwork: vi.fn(async () => ({
      name: "Local Wika",
      genesisHash: "0xchain",
      decimals: 2,
      symbol: "WIKA",
    })),
    getPage: vi.fn(async () => ({ url, likes: 7n, owner: null, mine: null })),
    subscribePage: vi.fn(async (_url, _address, callback) => {
      pageListener = callback;
      callback({ url, likes: 7n, owner: null, mine: null });
      return stop as () => void;
    }),
    quoteLike: vi.fn(async (_address, request) => ({ ...quote, request })),
    submitLike: vi.fn(
      async (
        _account: WalletAccount,
        _signer: Signer,
        _request: unknown,
        options?: SubmitOptions,
      ) => {
        options?.onStatus?.("finalized");
        return receipt;
      },
    ),
  } satisfies WikaClientLike;
  const wallet = {
    connect: vi.fn(async () => accounts),
    getSigner: vi.fn(async () => ({}) as Signer),
    subscribeAccounts: vi.fn(
      async (callback: (value: WalletAccount[]) => void) => {
        accountListener = callback;
        return stopAccounts;
      },
    ),
  };
  return {
    client,
    wallet,
    stop,
    stopAccounts,
    revoke: () => accountListener!([]),
    page: (value: PageInfo) => pageListener!(value),
  };
}
async function selectAccount() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Like with Wika" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Connect wallet",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "Connect wallet" }));
  await user.selectOptions(
    await screen.findByLabelText("Account"),
    "wika:alice",
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Approve in wallet",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  return user;
}

describe("WikaLike", () => {
  it("renders on the server without requesting wallet access", () => {
    const f = fixture();
    expect(
      renderToString(
        <WikaLike client={f.client} wallet={f.wallet} url={url} />,
      ),
    ).toContain("Like with Wika");
    expect(f.wallet.connect).not.toHaveBeenCalled();
  });
  it("reads counts without wallet authorization and signs only after an explicit click", async () => {
    const f = fixture(),
      onSuccess = vi.fn();
    render(
      <WikaLike
        client={f.client}
        wallet={f.wallet}
        url={url}
        referrerUrl="https://ref.example/"
        onSuccess={onSuccess}
      />,
    );
    expect(await screen.findByText("7 likes")).toBeTruthy();
    expect(f.wallet.connect).not.toHaveBeenCalled();
    const user = await selectAccount();
    expect(screen.getByText("1.05 WIKA")).toBeTruthy();
    expect(f.client.submitLike).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve in wallet" }));
    expect(
      await screen.findByText("Your like is finalized. Thank you!"),
    ).toBeTruthy();
    expect(f.client.submitLike).toHaveBeenCalledWith(
      accounts[0],
      {},
      { url, referrerUrl: "https://ref.example/", count: 1 },
      expect.anything(),
    );
    expect(onSuccess).toHaveBeenCalledWith(receipt);
  });
  it("blocks zero and insufficient balances", async () => {
    const f = fixture();
    render(<WikaLike client={f.client} wallet={f.wallet} url={url} />);
    const user = await selectAccount();
    await user.clear(screen.getByLabelText("Number of likes"));
    await user.type(screen.getByLabelText("Number of likes"), "0");
    expect(
      await screen.findByText("Enter a positive whole number of likes."),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve in wallet",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    f.client.quoteLike.mockResolvedValueOnce({ ...quote, affordable: false });
    fireEvent.change(screen.getByLabelText("Number of likes"), {
      target: { value: "2" },
    });
    expect(
      await screen.findByText(
        "Insufficient spendable balance for these likes and the fee.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve in wallet",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("displays wallet rejection and allows retry", async () => {
    const f = fixture(),
      onError = vi.fn();
    f.wallet.getSigner.mockRejectedValueOnce(
      new Error("User rejected signing"),
    );
    render(
      <WikaLike
        client={f.client}
        wallet={f.wallet}
        url={url}
        onError={onError}
      />,
    );
    const user = await selectAccount();
    await user.click(screen.getByRole("button", { name: "Approve in wallet" }));
    expect(await screen.findByText("User rejected signing")).toBeTruthy();
    expect(onError).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Approve in wallet",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Approve in wallet" }));
    expect(
      await screen.findByText("Your like is finalized. Thank you!"),
    ).toBeTruthy();
  });
  it("prevents duplicate submissions and keeps observing when the dialog closes", async () => {
    const f = fixture();
    let complete: ((value: typeof receipt) => void) | undefined;
    f.client.submitLike.mockImplementation((_a, _s, _r, options) => {
      options?.onStatus?.("inBlock");
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    render(<WikaLike client={f.client} wallet={f.wallet} url={url} />);
    const user = await selectAccount();
    const button = screen.getByRole("button", { name: "Approve in wallet" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(f.client.submitLike).toHaveBeenCalledOnce());
    expect(
      screen.getByText("Included in a block. Waiting for finality…"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Wika dialog" }));
    expect(f.client.submitLike.mock.calls[0][3]?.signal?.aborted).toBe(false);
    await act(async () => {
      complete!(receipt);
    });
    await user.click(screen.getByRole("button", { name: "Like with Wika" }));
    expect(screen.getByText("Your like is finalized. Thank you!")).toBeTruthy();
  });
  it("handles account revocation and filters other chains", async () => {
    const f = fixture();
    f.wallet.connect.mockResolvedValueOnce([
      ...accounts,
      { address: "bob", source: "other", genesisHash: "0xwrong" },
    ]);
    render(<WikaLike client={f.client} wallet={f.wallet} url={url} />);
    await selectAccount();
    expect(screen.queryByRole("option", { name: /bob/ })).toBeNull();
    act(() => f.revoke());
    expect(
      await screen.findByText(
        "No accounts are available for this network. Add or authorize an account in your wallet.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve in wallet",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("shows existing queue membership instead of offering another like", async () => {
    const f = fixture();
    render(<WikaLike client={f.client} wallet={f.wallet} url={url} />);
    await selectAccount();
    act(() =>
      f.page({
        url,
        likes: 9n,
        owner: null,
        mine: { count: 2, likesBefore: 7n, remaining: 20 },
      }),
    );
    expect(await screen.findByText(/already in the reward queue/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Approve in wallet" }),
    ).toBeNull();
  });
  it("aborts monitoring and releases subscriptions on unmount", async () => {
    const f = fixture();
    f.client.submitLike.mockImplementation(() => new Promise(() => {}));
    const view = render(
      <WikaLike client={f.client} wallet={f.wallet} url={url} />,
    );
    const user = await selectAccount();
    await user.click(screen.getByRole("button", { name: "Approve in wallet" }));
    await waitFor(() => expect(f.client.submitLike).toHaveBeenCalledOnce());
    view.unmount();
    expect(f.client.submitLike.mock.calls[0][3]?.signal?.aborted).toBe(true);
    expect(f.stopAccounts).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalled();
  });
  it("releases a subscription that resolves after unmount", async () => {
    const f = fixture();
    let finish: ((value: () => void) => void) | undefined;
    f.client.subscribePage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(
      <WikaLike client={f.client} wallet={f.wallet} url={url} />,
    );
    view.unmount();
    await act(async () => finish!(f.stop));
    expect(f.stop).toHaveBeenCalledOnce();
  });
});
