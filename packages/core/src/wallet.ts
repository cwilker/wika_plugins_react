import type {
  Signer,
  Unsubscribe,
  WalletAccount,
  WalletAdapter,
} from "./types";
import { asError, notify, WikaError } from "./utils";

interface InjectedAccount {
  address: string;
  name?: string;
  genesisHash?: string | null;
  type?: string;
}
interface InjectedWallet {
  accounts: {
    get(): Promise<InjectedAccount[]>;
    subscribe?(
      callback: (accounts: InjectedAccount[]) => void,
    ): Unsubscribe | Promise<Unsubscribe>;
  };
  signer: Signer;
}
interface InjectedProvider {
  enable(appName: string): Promise<InjectedWallet>;
}
type WalletWindow = Window & {
  injectedWeb3?: Record<string, InjectedProvider>;
};

/** Uses the same injectedWeb3 interface as Polkadot dapps, without a browser-only dependency. */
export function createInjectedWallet(
  options: { sources?: string[] } = {},
): WalletAdapter {
  const sources = options.sources ?? ["wika"];
  const enabled = new Map<string, InjectedWallet>();
  const map = (source: string, accounts: InjectedAccount[]): WalletAccount[] =>
    accounts
      .filter(
        (a) =>
          !a.type ||
          a.type === "sr25519" ||
          a.type === "ed25519" ||
          a.type === "ecdsa",
      )
      .map((a) => ({
        address: a.address,
        name: a.name,
        source,
        genesisHash: a.genesisHash,
      }));
  return {
    async connect(appName) {
      if (typeof window === "undefined")
        throw new WikaError(
          "WALLET_UNAVAILABLE",
          "A browser wallet is required.",
        );
      if (!appName.trim())
        throw new WikaError(
          "WALLET_UNAVAILABLE",
          "Provide an application name for wallet authorization.",
        );
      const providers = Object.entries(
        (window as WalletWindow).injectedWeb3 ?? {},
      ).filter(([source]) => sources.includes(source));
      if (!providers.length)
        throw new WikaError(
          "WALLET_UNAVAILABLE",
          "Install or enable the Wika wallet, then try again.",
        );
      enabled.clear();
      const results = await Promise.allSettled(
        providers.map(async ([source, provider]) => {
          const wallet = await provider.enable(appName);
          const accounts = await wallet.accounts.get();
          enabled.set(source, wallet);
          return map(source, accounts);
        }),
      );
      const accounts = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      if (!enabled.size)
        throw asError(
          (
            results.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        );
      return accounts;
    },
    async getSigner(account) {
      const wallet = enabled.get(account.source);
      if (!wallet)
        throw new WikaError(
          "WALLET_UNAVAILABLE",
          "Connect this wallet before signing.",
        );
      // Account access may have been revoked since the UI last refreshed.
      if (
        !(await wallet.accounts.get()).some(
          (a) => a.address === account.address,
        )
      )
        throw new WikaError(
          "WALLET_UNAVAILABLE",
          "This account is no longer authorized. Reconnect your wallet.",
        );
      return wallet.signer;
    },
    async subscribeAccounts(callback) {
      const state = new Map<string, WalletAccount[]>();
      const stops: Unsubscribe[] = [];
      let active = true;
      const emit = () => {
        if (active) notify(callback, [...state.values()].flat());
      };
      try {
        // Seed every source before subscribing; do not temporarily clear accounts while another wallet loads.
        for (const [source, wallet] of enabled)
          state.set(source, map(source, await wallet.accounts.get()));
        emit();
        for (const [source, wallet] of enabled) {
          if (wallet.accounts.subscribe)
            stops.push(
              await wallet.accounts.subscribe((accounts) => {
                state.set(source, map(source, accounts));
                emit();
              }),
            );
        }
      } catch (error) {
        active = false;
        stops.forEach((stop) => stop());
        throw error;
      }
      return () => {
        if (active) {
          active = false;
          stops.forEach((stop) => stop());
        }
      };
    },
  };
}
