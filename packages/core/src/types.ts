import type { Signer } from "@polkadot/api/types";
export type Unsubscribe = () => void;
export interface WalletAccount {
  address: string;
  name?: string;
  source: string;
  genesisHash?: string | null;
}
/** Implement this boundary for a mobile wallet, hardware signer, or another platform. */
export interface WalletAdapter {
  connect(appName: string): Promise<WalletAccount[]>;
  getSigner(account: WalletAccount): Promise<Signer>;
  subscribeAccounts?(
    callback: (accounts: WalletAccount[]) => void,
  ): Promise<Unsubscribe>;
}
export interface NetworkInfo {
  name: string;
  genesisHash: string;
  symbol: string;
  decimals: number;
}
export interface PageInfo {
  url: string;
  likes: bigint;
  owner: string | null;
  mine: { likesBefore: bigint; count: number; remaining: number } | null;
}
export interface Balance {
  free: bigint;
  frozen: bigint;
  existentialDeposit: bigint;
  /** Conservative amount available while retaining the account and respecting freezes. */
  spendable: bigint;
}
export interface LikeRequest {
  economicsVersion?: 1 | 2;
  economicTerms?: { version: number; hash: string };
  url: string;
  /** @deprecated Unsigned credited referrals are rejected after activation. */
  referrerUrl?: string;
  referral?: import("./referrals").ReferralEnvelope;
  count: number;
}
export interface LikeQuote {
  request: LikeRequest;
  price: bigint;
  maxLikes: number;
  cost: bigint;
  estimatedFee: bigint;
  total: bigint;
  balance: Balance;
  affordable: boolean;
  referralQuote?: import("./referrals").ReferralQuote;
  economicQuote?: import("./referrals").ReferralQuote;
}
export type TransactionStatus =
  | "signing"
  | "submitted"
  | "inBlock"
  | "finalized"
  | "retracted";
export interface LikeReceipt {
  txHash: string;
  blockHash: string;
  blockNumber?: string;
  eventIndex?: number;
}
export interface SubmitOptions {
  onStatus?: (status: TransactionStatus) => void;
  onBroadcast?: (txHash: string) => void;
  /** Durable recovery state must be written here; rejection prevents signing. */
  beforeSign?: () => void | Promise<void>;
  onSigningPayload?: (payload: import('@polkadot/types/types').SignerPayloadJSON) => void | Promise<void>;
  onSigningRejected?: (error: Error) => void;
  onFinalizedFailure?: (receipt: { txHash:string; blockHash:string }) => void;
  /** Stops local monitoring; cannot undo a transaction already signed or broadcast. */
  signal?: AbortSignal;
  timeoutMs?: number;
}
/** UI-facing contract; alternate transports and test clients can implement it. */
export interface WikaClientLike {
  getNetwork(): Promise<NetworkInfo>;
  getPage(url: string, address?: string): Promise<PageInfo>;
  subscribePage(
    url: string,
    address: string | undefined,
    callback: (page: PageInfo) => void,
    onError?: (error: Error) => void,
  ): Promise<Unsubscribe>;
  quoteLike(address: string, request: LikeRequest): Promise<LikeQuote>;
  submitLike(
    account: WalletAccount,
    signer: Signer,
    request: LikeRequest,
    options?: SubmitOptions,
  ): Promise<LikeReceipt>;
}
export type { Signer };
