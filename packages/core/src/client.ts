import { getPageEconomics, quoteEconomics } from "./economics";
import { WikaReferralClient, validateReferral, referralPayloadForCall, recoverReferral, recoverDirectPayment } from "./referrals";
import { submitFinalized } from "./transactions";
import { WikaClaimsClient } from "./claims-client";
import { canonicalPageUrl } from "./page-identity";
import { ApiPromise, WsProvider } from "@polkadot/api";
import type { QueryableStorageEntry } from "@polkadot/api/types";
import type {
  Balance,
  LikeQuote,
  LikeReceipt,
  LikeRequest,
  NetworkInfo,
  PageInfo,
  Signer,
  SubmitOptions,
  Unsubscribe,
  WalletAccount,
  WikaClientLike,
} from "./types";
import {
  asError,
  integer,
  notify,
  tuple,
  unwrapOption,
  validateCount,
  validateUrl,
  WikaError,
} from "./utils";

export class WikaClient implements WikaClientLike {
  private constructor(
    private readonly api: ApiPromise,
    private readonly ownsConnection: boolean,
  ) {
    for (const method of ["urls", "likes", "likePrice", "maxLikes"]) {
      if (typeof api.query.likes?.[method] !== "function")
        throw new WikaError(
          "UNSUPPORTED_CHAIN",
          `This node does not expose likes.${method}.`,
        );
    }
    if (
      typeof api.tx.likes?.like !== "function" ||
      typeof api.query.owners?.owners !== "function"
    )
      throw new WikaError(
        "UNSUPPORTED_CHAIN",
        "This node does not support Wika likes and ownership.",
      );
  }
  static async connect(options: {
    endpoint: string;
    genesisHash?: string;
    timeoutMs?: number;
  }): Promise<WikaClient> {
    const provider = new WsProvider(options.endpoint);
    const api = new ApiPromise({ provider, noInitWarn: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        api.isReadyOrError,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WikaError(
                  "TIMEOUT",
                  "Connecting to the Wika node timed out.",
                ),
              ),
            options.timeoutMs ?? 20000,
          );
        }),
      ]);
      if (
        options.genesisHash &&
        options.genesisHash.toLowerCase() !==
          api.genesisHash.toHex().toLowerCase()
      )
        throw new WikaError(
          "WRONG_NETWORK",
          "The node genesis hash does not match the configured network.",
        );
      return new WikaClient(api, true);
    } catch (error) {
      await provider.disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Wrap a caller-owned connection. disconnect() will leave it open. */
  static fromApi(api: ApiPromise): WikaClient {
    return new WikaClient(api, false);
  }
  async disconnect(): Promise<void> {
    if (this.ownsConnection) await this.api.disconnect();
  }
  async getFinalizedCheckpoint() {
    const hash=(await this.api.rpc.chain.getFinalizedHead()).toHex();
    return {blockHash:hash,blockNumber:(await this.api.rpc.chain.getHeader(hash)).number.toString(),genesisHash:this.api.genesisHash.toHex()};
  }
  recoverDirectPayment(input: Parameters<typeof recoverDirectPayment>[1]) { return recoverDirectPayment(this.api,input); }
  recoverReferral(envelope: import("./referrals").ReferralEnvelope, fromBlock: string) { return recoverReferral(this.api, envelope, fromBlock); }
  private referralClient?: WikaReferralClient;
  get referrals(): WikaReferralClient { return this.referralClient ??= new WikaReferralClient(this.api); }
  getPageEconomics(url: string) { return getPageEconomics(this.api,url); }
  private claimsClient?: WikaClaimsClient;
  get supportsSafeClaims(): boolean { return Boolean(this.api.query.owners?.currentPeriod); }
  get claims(): WikaClaimsClient { return this.claimsClient ??= new WikaClaimsClient(this.api); }
  private pageIdentity(url: string): string { return this.api.query.owners?.currentPeriod ? canonicalPageUrl(url) : validateUrl(url); }
  async getNetwork(): Promise<NetworkInfo> {
    return {
      name: (await this.api.rpc.system.chain()).toString(),
      genesisHash: this.api.genesisHash.toHex(),
      decimals: this.api.registry.chainDecimals[0] ?? 12,
      symbol: this.api.registry.chainTokens[0] ?? "WIKA",
    };
  }
  async getPage(url: string, address?: string): Promise<PageInfo> {
    url = this.pageIdentity(url);
    const [page, owner, mine] = await Promise.all([
      this.api.query.likes.urls(url),
      this.api.query.owners.owners(url),
      address ? this.api.query.likes.likes(address, url) : undefined,
    ]);
    return decodePage(url, page, owner, mine);
  }
  async subscribePage(
    url: string,
    address: string | undefined,
    callback: (page: PageInfo) => void,
    onError?: (error: Error) => void,
  ): Promise<Unsubscribe> {
    url = this.pageIdentity(url);
    const entries: [QueryableStorageEntry<"promise">, ...unknown[]][] = [
      [this.api.query.likes.urls, url],
      [this.api.query.owners.owners, url],
    ];
    if (address) entries.push([this.api.query.likes.likes, [address, url]]);
    let active = true;
    const unsubscribe = await this.api.queryMulti(entries, (values) => {
      if (!active) return;
      try {
        notify(callback, decodePage(url, values[0], values[1], values[2]));
      } catch (error) {
        notify(onError, asError(error));
      }
    });
    return () => {
      if (active) {
        active = false;
        unsubscribe();
      }
    };
  }
  async getBalance(address: string): Promise<Balance> {
    const account = await this.api.query.system.account(address);
    const data = (
      account as unknown as {
        data: {
          free: unknown;
          frozen?: unknown;
          miscFrozen?: unknown;
          feeFrozen?: unknown;
        };
      }
    ).data;
    const free = integer(data.free);
    const frozen = [
      data.frozen,
      data.miscFrozen,
      data.feeFrozen,
    ].reduce<bigint>(
      (max, value) => (integer(value) > max ? integer(value) : max),
      0n,
    );
    const existentialDeposit = integer(
      this.api.consts.balances.existentialDeposit,
    );
    const reserve = frozen > existentialDeposit ? frozen : existentialDeposit;
    return {
      free,
      frozen,
      existentialDeposit,
      spendable: free > reserve ? free - reserve : 0n,
    };
  }
  async quoteLike(address: string, input: LikeRequest): Promise<LikeQuote> {
    const request = {
      url: this.pageIdentity(input.url),
      referrerUrl: input.referrerUrl ? this.pageIdentity(input.referrerUrl) : "",
      count: input.count,
      referral: input.referral,
      economicTerms: input.economicTerms,
      economicsVersion:input.economicsVersion,
    };
    if (request.referrerUrl && !request.referral && this.api.tx.likes.likeWithReferral)
      throw new Error('SignedReferralRequired: supply a host-signed authorization or remove referrerUrl.');
    if (request.referral && (request.referral.payload.count !== request.count || (request.referrerUrl && request.referrerUrl !== request.referral.payload.sourcePage))) throw new Error('Referral request mismatch.');
    const referralQuote = request.referral ? await validateReferral(this.api, request.referral, address, request.url) : undefined;
    const active=this.api.query.likes.economicsActive && (await this.api.query.likes.economicsActive()).toString()==='true';
    const version=active?2:1;
    if(input.economicsVersion!==undefined&&input.economicsVersion!==version)throw new Error('TermsChanged: economic activation changed; review a new quote.');
    request.economicsVersion=version;
    const economicQuote=active ? referralQuote ?? await quoteEconomics(this.api,address,request.url,'',request.count) : undefined;
    if(economicQuote && !request.referral) {
      if(input.economicTerms && (input.economicTerms.version!==2 || input.economicTerms.hash!==economicQuote.termsHash))throw new Error('TermsChanged: review a new payout quote before signing.');
      request.economicTerms={version:2,hash:economicQuote.termsHash};
    }
    validateCount(request.count);
    const [priceValue, maxValue, balance, page] = await Promise.all([
      this.api.query.likes.likePrice(),
      this.api.query.likes.maxLikes(),
      this.getBalance(address),
      this.getPage(request.url, address),
    ]);
    const price = integer(priceValue),
      maxLikes = Number(maxValue.toString());
    validateCount(request.count, maxLikes);
    if (page.mine)
      throw new WikaError(
        "ALREADY_LIKED",
        "This account is already in the reward queue for this URL.",
      );
    const tx = request.referral
      ? this.api.tx.likes.likeWithReferral(referralPayloadForCall(request.referral.payload), request.referral.publicKey, request.referral.signature)
      : request.economicTerms ? this.api.tx.likes.likeWithTerms(request.url,request.count,request.economicTerms.version,request.economicTerms.hash) : this.api.tx.likes.like(request.url, request.referrerUrl, request.count);
    const estimatedFee = integer((await tx.paymentInfo(address)).partialFee);
    const cost = referralQuote ? BigInt(referralQuote.terms.cost) : price * BigInt(request.count),
      total = cost + estimatedFee;
    return {
      request,
      price,
      maxLikes,
      cost,
      estimatedFee,
      total,
      balance,
      affordable: total <= balance.spendable && cost < balance.free,
      referralQuote,
      economicQuote,
    };
  }
  async submitLike(
    account: WalletAccount,
    signer: Signer,
    request: LikeRequest,
    options: SubmitOptions = {},
  ): Promise<LikeReceipt> {
    const checkAbort = () => {
      if (options.signal?.aborted)
        throw new WikaError(
          "ABORTED",
          "Stopped watching the transaction. A signed transaction may still complete.",
        );
    };
    checkAbort();
    if (
      account.genesisHash &&
      account.genesisHash.toLowerCase() !==
        this.api.genesisHash.toHex().toLowerCase()
    )
      throw new WikaError(
        "WRONG_NETWORK",
        "Choose an account for this Wika network.",
      );
    // Recheck just before signing: prices, balances, and queue membership can change.
    const quote = await this.quoteLike(account.address, request);
    checkAbort();
    if (!quote.affordable)
      throw new WikaError(
        "INSUFFICIENT_BALANCE",
        "Your spendable balance does not cover these likes and the estimated fee.",
      );
    const tx = quote.request.referral
      ? this.api.tx.likes.likeWithReferral(referralPayloadForCall(quote.request.referral.payload), quote.request.referral.publicKey, quote.request.referral.signature)
      : quote.request.economicTerms ? this.api.tx.likes.likeWithTerms(quote.request.url,quote.request.count,quote.request.economicTerms.version,quote.request.economicTerms.hash) : this.api.tx.likes.like(quote.request.url, quote.request.referrerUrl, quote.request.count);
    return submitFinalized(this.api, tx, account, signer, options);
  }
}
export function decodePage(
  url: string,
  page: unknown,
  owner: unknown,
  mine: unknown,
): PageInfo {
  const p = tuple(page),
    m = tuple(mine),
    o = unwrapOption(owner);
  return {
    url,
    likes: integer(p[0]),
    owner: o == null ? null : String(o),
    mine:
      m.length && integer(m[1]) > 0n
        ? {
            likesBefore: integer(m[0]),
            count: Number(String(m[1])),
            remaining: Number(String(m[2])),
          }
        : null,
  };
}
