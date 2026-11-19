import {recoverClaimTransaction,type ClaimRecovery} from "./claim-recovery";
import { getPageEconomics, policySelection, type PageEconomics, type PolicySelection } from "./economics";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type {
  WalletAccount,
  Signer,
  SubmitOptions,
  NetworkInfo,
} from "./types";
import { canonicalPageUrl } from "./page-identity";
import { signClaimProof, type SignedClaimProof } from "./claim-proof";
import { submitFinalized } from "./transactions";
import { integer, unwrapOption, WikaError } from "./utils";
import {
  blake2AsHex,
  decodeAddress,
  signatureVerify,
  cryptoWaitReady,
} from "@polkadot/util-crypto";
import { hexToU8a, u8aEq } from "@polkadot/util";
export interface OwnershipPeriodInfo {
  id: bigint;
  owner: string;
  startedAt: bigint;
  startedBlock?: bigint;
  startedEventIndex?: bigint;
  endedBlock?: bigint | null;
  endedEventIndex?: bigint | null;
  endedAt: bigint | null;
  balance: bigint;
  proof: string;
  verifiedAt: bigint | null;
  verificationFresh?:boolean;
  withdrawable: bigint;
}
export interface ReplacementInfo {
  id: string;
  candidate: string;
  previousPeriod: bigint;
  openedAt: bigint;
  earliestActivation: bigint;
  deadline: bigint;
  bond: bigint;
  ownerApproved: boolean;
  candidateApproved: boolean;
  objection: boolean;
}
export interface ClaimPageInfo {
  blockNumber?:string;
  economics?: PageEconomics;
  pendingPolicy?: {attempt:string;account:string;ownerBps:number;supporterBps:number;referralBps:number}|null;
  policyOutcome?: { attempt: string; account: string; applied: boolean; reason?:string } | null;
  url: string;
  atBlock: string;
  chainTime: bigint;
  unclaimed: bigint;
  current: OwnershipPeriodInfo | null;
  pending: ReplacementInfo | null;
  verificationPending: boolean;
  lastVerification: {
    account: string;
    purpose: string;
    outcome: string;
    checkedAt: bigint;
  } | null;
  retry: { account: string; remaining: number; expiresAt: bigint } | null;
}
export type OwnershipAction =
  | { kind: "claim"; proof: SignedClaimProof; policy?: PolicySelection }
  | { kind: "configure"; url:string; period:bigint; policy:PolicySelection }
  | { kind: "verify"; url: string; period: bigint }
  | { kind: "withdraw"; url: string; period: bigint; amount: bigint }
  | {
      kind: "finalize" | "approve" | "object" | "cancel";
      url: string;
      id: string;
    }
  | { kind: "expire" | "retry"; url: string };
export interface OwnershipQuote {
  account: string;
  action: OwnershipAction;
  networkFee: bigint;
  verificationFee: bigint;
  refundableBond: bigint;
  totalRequired: bigint;
  affordable: boolean;
  atBlock: string;
}
const FRESHNESS = 90n * 24n * 60n * 60n * 1000n;
function json<T>(codec: unknown): T {
  return (codec as { toJSON(): T }).toJSON();
}
function bytes(codec: unknown): string {
  const j = json<string | number[]>(codec);
  return typeof j === "string"
    ? new TextDecoder().decode(hexToU8a(j))
    : new TextDecoder().decode(Uint8Array.from(j));
}
function optionalInt(codec: unknown): bigint | null {
  const value = unwrapOption(codec);
  return value === null ? null : integer(value);
}

/** All critical reads use one node block. ETL portfolio data is never an authorization source. */
export class WikaClaimsClient {
  constructor(private readonly api: ApiPromise) {
    if (!api.query.owners?.currentPeriod || !api.tx.owners?.claimPage)
      throw new WikaError(
        "UNSUPPORTED_CHAIN",
        "This node does not support safe page claims.",
      );
  }
  get genesisHash(): string {
    return this.api.genesisHash.toHex();
  }
  isSameAccount(a: string, b: string): boolean {
    try {
      return u8aEq(decodeAddress(a), decodeAddress(b));
    } catch {
      return false;
    }
  }
  async getFinalizedHeight(): Promise<number> {
    const hash = await this.api.rpc.chain.getFinalizedHead();
    return (await this.api.rpc.chain.getHeader(hash)).number.toNumber();
  }
  async getNetwork(): Promise<NetworkInfo> {
    return {
      name: (await this.api.rpc.system.chain()).toString(),
      genesisHash: this.genesisHash,
      decimals: this.api.registry.chainDecimals[0] ?? 12,
      symbol: this.api.registry.chainTokens[0] ?? "WIKA",
    };
  }
  async createProof(
    account: WalletAccount,
    signer: Signer,
    page: string,
  ): Promise<SignedClaimProof> {
    const now = integer(await this.api.query.timestamp.now());
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return signClaimProof(account, signer, {
      genesisHash: this.api.genesisHash.toHex(),
      page,
      nonce: `0x${Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("")}`,
      expiresAt: now + 3_600_000n,
    });
  }
  recover(input:ClaimRecovery) { return recoverClaimTransaction(this.api,input); }
  getPageEconomics(url:string) { return getPageEconomics(this.api,url); }
  async getPage(input: string): Promise<ClaimPageInfo> {
    const url = canonicalPageUrl(input),
      header = await this.api.rpc.chain.getHeader();
    const view = await this.api.at(header.hash);
    const [time, id, unclaimed, pending, check, retryOpt, lastOpt] =
      await Promise.all([
        view.query.timestamp.now(),
        view.query.owners.currentPeriod(url),
        view.query.owners.unclaimedRewards(url),
        view.query.owners.pendingReplacements(url),
        view.query.owners.claimChecks(url),
        view.query.owners.retryCredits(url),
        view.query.owners.lastClaimResults?.(url) ?? null,
      ]);
    const chainTime = integer(time),
      periodId = optionalInt(id);
    const pendingValue = unwrapOption(pending);
    let replacement: ReplacementInfo | null = null;
    if (pendingValue) {
      const p = pendingValue as unknown as Record<string, unknown>;
      replacement = {
        id: String(p.id),
        candidate: String(p.candidate),
        previousPeriod: integer(p.previousPeriod),
        openedAt: integer(p.openedAt),
        earliestActivation: integer(p.earliestActivation),
        deadline: integer(p.deadline),
        bond: integer(p.bond),
        ownerApproved: json<boolean>(p.ownerApproved),
        candidateApproved: json<boolean>(p.candidateApproved),
        objection: json<boolean>(p.objection),
      };
    }
    const current =
      periodId === null
        ? null
        : this.decodePeriod(
            periodId,
            unwrapOption(await view.query.owners.periods(url, periodId)),
            chainTime,
            replacement,
          );
    const retryValue = unwrapOption(retryOpt) as Record<string, unknown> | null;
    const retryCheck = retryValue?.check as Record<string, unknown> | undefined;
    const retry =
      retryValue && retryCheck
        ? {
            account: String(retryValue.account),
            remaining: Number(String(retryCheck.retriesRemaining)),
            expiresAt: integer(retryCheck.expiresAt),
          }
        : null;
    const last = unwrapOption(lastOpt) as Record<string, unknown> | null;
    const lastVerification = last
      ? {
          account: String(last.account),
          purpose: String(
            (last.purpose as { type?: string }).type ?? last.purpose,
          ),
          outcome: String(last.outcome),
          checkedAt: integer(last.checkedAt),
        }
      : null;
    const economics=view.query.likes?.economicsActive ? await getPageEconomics(this.api,url,header.hash.toHex()) : undefined;
    const outcome=view.query.owners.lastPolicyOutcomes ? unwrapOption(await view.query.owners.lastPolicyOutcomes(url)) as Record<string,unknown>|null : null;
    const intent=view.query.owners.policyIntents?unwrapOption(await view.query.owners.policyIntents(url)) as Record<string,unknown>|null:null;
    const intentSelection=intent?.selection as Record<string,unknown>|undefined;
    return {
      pendingPolicy:intent&&intentSelection?{attempt:String(intent.attempt),account:String(intent.account),ownerBps:Number(String(intentSelection.ownerBps)),supporterBps:Number(String(intentSelection.supporterBps)),referralBps:Number(String(intentSelection.referralBps))}:null,
      economics,
      blockNumber:header.number.toString(),
      policyOutcome:outcome?{attempt:String(outcome.attempt),account:String(outcome.account),applied:(outcome.applied as {toString():string}).toString()==='true',reason:outcome.reason?String(outcome.reason):undefined}:null,
      lastVerification,
      retry,
      url,
      atBlock: header.hash.toHex(),
      chainTime,
      unclaimed: integer(unclaimed),
      current,
      pending: replacement,
      verificationPending: unwrapOption(check) !== null,
    };
  }
  async getPeriod(
    url: string,
    id: bigint,
  ): Promise<OwnershipPeriodInfo | null> {
    const page = await this.getPage(url);
    const view = await this.api.at(page.atBlock);
    return this.decodePeriod(
      id,
      unwrapOption(await view.query.owners.periods(page.url, id)),
      page.chainTime,
      page.pending,
    );
  }
  private decodePeriod(
    id: bigint,
    codec: unknown,
    time: bigint,
    pending: ReplacementInfo | null,
  ): OwnershipPeriodInfo | null {
    if (codec === null) return null;
    const p = codec as Record<string, unknown>,
      balance = integer(p.balance),
      verifiedAt = optionalInt(p.verifiedAt),
      endedAt = optionalInt(p.endedAt);
    const frozen = pending !== null && time < pending.deadline;
    const fresh =
      verifiedAt !== null &&
      time >= verifiedAt &&
      time - verifiedAt < FRESHNESS;
    return {
      id,
      owner: String(p.owner),
      startedAt: integer(p.startedAt),
      startedBlock:
        p.startedBlock === undefined ? undefined : integer(p.startedBlock),
      startedEventIndex:
        p.startedEventIndex === undefined
          ? undefined
          : integer(p.startedEventIndex),
      endedBlock:
        p.endedBlock === undefined ? undefined : optionalInt(p.endedBlock),
      endedEventIndex:
        p.endedEventIndex === undefined
          ? undefined
          : optionalInt(p.endedEventIndex),
      endedAt,
      balance,
      proof: bytes(p.proof),
      verifiedAt,
      verificationFresh:fresh,
      withdrawable: !frozen && (endedAt !== null || fresh) ? balance : 0n,
    };
  }
  private transaction(
    action: OwnershipAction,
  ): SubmittableExtrinsic<"promise"> {
    if (action.kind === "claim")
      return action.policy ? this.api.tx.owners.claimPageWithPolicy(action.proof.content,action.policy) : this.api.tx.owners.claimPage(action.proof.content);
    if (action.kind === "configure") return this.api.tx.likes.configurePagePolicy(canonicalPageUrl(action.url),action.period,action.policy);
    const url = canonicalPageUrl(action.url);
    switch (action.kind) {
      case "verify":
        return this.api.tx.owners.verifyWithdrawal(url, action.period);
      case "withdraw":
        if (action.amount <= 0n)
          throw new Error("Withdrawal must be positive.");
        return this.api.tx.owners.withdrawRewards(
          url,
          action.period,
          action.amount,
        );
      case "finalize":
        return this.api.tx.owners.finalizeReplacement(url, action.id);
      case "approve":
        return this.api.tx.owners.approveReplacement(url, action.id);
      case "object":
        return this.api.tx.owners.objectReplacement(url, action.id);
      case "cancel":
        return this.api.tx.owners.cancelReplacement(url, action.id);
      case "expire":
        return this.api.tx.owners.expireReplacement(url);
      case "retry":
        return this.api.tx.owners.retryVerification(url);
    }
  }
  private async validateProof(
    account: string,
    proof: SignedClaimProof,
  ): Promise<void> {
    const match = /^wika-claim-v1:((?:[0-9a-f]{2})+)\.((?:[0-9a-f]{2})+)$/.exec(
      proof.content,
    );
    if (
      !match ||
      proof.content.length > 2048 ||
      blake2AsHex(proof.content, 256) !== proof.proofDigest
    )
      throw new Error("Invalid signed claim proof.");
    const body = hexToU8a(`0x${match[1]}`),
      sig = hexToU8a(`0x${match[2]}`);
    const value = this.api.registry.createType(
      "(u8,u8,H256,Bytes,AccountId,H256,u64)",
      body,
    ) as unknown as Iterable<unknown>;
    if (!u8aEq((value as unknown as { toU8a(): Uint8Array }).toU8a(), body))
      throw new Error("Noncanonical claim encoding.");
    const [version, method, genesis, page, owner, , expiry] = Array.from(value);
    if (
      String(version) !== "1" ||
      String(method) !== "1" ||
      String(genesis) !== this.api.genesisHash.toHex() ||
      bytes(page) !== canonicalPageUrl(proof.page) ||
      !u8aEq(decodeAddress(String(owner)), decodeAddress(account)) ||
      integer(expiry) <= integer(await this.api.query.timestamp.now())
    )
      throw new Error(
        "The proof does not match this page, wallet, chain or claim deadline.",
      );
    await cryptoWaitReady();
    const message = Uint8Array.from([
      ...new TextEncoder().encode("wika/page-claim/v1\0"),
      ...body,
    ]);
    const result = signatureVerify(message, sig.slice(1), account);
    if (
      !result.isValid ||
      result.crypto !== ["ed25519", "sr25519", "ecdsa"][sig[0]!]
    )
      throw new Error("Invalid claim signature.");
  }
  async quote(
    account: string,
    action: OwnershipAction,
  ): Promise<OwnershipQuote> {
    if (action.kind === "claim")
      await this.validateProof(account, action.proof);
    if(action.kind==='configure' || (action.kind==='claim' && action.policy)) {
      const state=await getPageEconomics(this.api,action.kind==='claim'?action.proof.page:action.url);
      const selection=action.policy!;
      policySelection(state,selection.ownerBps,selection.supporterBps,selection.referralBps,selection.inheritIfChanged);
      if(selection.expectedRevision!==state.policy.revision || selection.expectedHash!==state.policyHash || selection.ruleset!==state.rules?.version)throw new Error('TermsChanged: review the current payout policy.');
      if(action.kind==='claim' && !selection.inheritIfChanged)throw new Error('Review and accept conditional policy inheritance.');
      if(action.kind==='configure') {
        const page=await this.getPage(action.url);
        if(!page.current || page.current.id!==action.period || !this.isSameAccount(page.current.owner,account) || page.current.verifiedAt===null || page.chainTime-page.current.verifiedAt>=FRESHNESS)throw new Error('A freshly verified current owner must configure payouts.');
      }
    }
    const tx = this.transaction(action),
      header = await this.api.rpc.chain.getHeader(),
      view = await this.api.at(header.hash);
    const [fee, price, bond, balance] = await Promise.all([
      tx.paymentInfo(account),
      view.query.owners.requestPrice(),
      view.query.owners.replacementBond(),
      view.query.system.account(account),
    ]);
    const pageUrl = canonicalPageUrl(
      action.kind === "claim" ? action.proof.page : action.url,
    );
    const [pendingOpt, checkOpt, currentIdOpt, time] = await Promise.all([
      view.query.owners.pendingReplacements(pageUrl),
      view.query.owners.claimChecks(pageUrl),
      view.query.owners.currentPeriod(pageUrl),
      view.query.timestamp.now(),
    ]);
    const pending = unwrapOption(pendingOpt) as Record<string, unknown> | null,
      currentId = optionalInt(currentIdOpt),
      now = integer(time);
    const queued = unwrapOption(checkOpt) !== null;
    if (
      ["claim", "verify", "finalize", "retry", "cancel"].includes(
        action.kind,
      ) &&
      queued
    )
      throw new Error("A verification is already pending for this page.");
    if ((action.kind === "claim" || action.kind === "verify") && pending)
      throw new Error(
        "Resolve the pending replacement before starting another check.",
      );
    if (action.kind === "claim" && currentId !== null) {
      const record = unwrapOption(
        await view.query.owners.periods(pageUrl, currentId),
      ) as Record<string, unknown> | null;
      if (record && this.isSameAccount(String(record.owner), account))
        throw new Error(
          "You already own this page. Verify its accepted proof for withdrawal.",
        );
    }
    if (action.kind === "verify" || action.kind === "withdraw") {
      const record = unwrapOption(
        await view.query.owners.periods(pageUrl, action.period),
      ) as Record<string, unknown> | null;
      if (!record || !this.isSameAccount(String(record.owner), account))
        throw new Error("This wallet does not own these reserved earnings.");
      if (action.kind === "verify" && currentId !== action.period)
        throw new Error(
          "A historical period does not require website verification.",
        );
      if (action.kind === "withdraw") {
        if (pending && now < integer(pending.deadline))
          throw new Error(
            "A pending replacement freezes this page's withdrawals.",
          );
        const period = this.decodePeriod(
          action.period,
          record,
          now,
          pending
            ? ({ deadline: integer(pending.deadline) } as ReplacementInfo)
            : null,
        )!;
        if (action.amount > period.withdrawable)
          throw new Error(
            "These earnings require a fresh successful verification before withdrawal.",
          );
      }
    }
    if (
      ["finalize", "approve", "object", "cancel", "expire"].includes(
        action.kind,
      )
    ) {
      if (!pending) throw new Error("No replacement is pending for this page.");
      if (action.kind === "expire") {
        if (now < integer(pending.deadline))
          throw new Error("The replacement has not expired.");
      } else if ("id" in action) {
        if (String(pending.id) !== action.id)
          throw new Error(
            "The replacement changed. Review the current request.",
          );
        if (now >= integer(pending.deadline))
          throw new Error("This replacement expired; clear it first.");
        const candidate = this.isSameAccount(
          String(pending.candidate),
          account,
        );
        const old = unwrapOption(
          await view.query.owners.periods(
            pageUrl,
            integer(pending.previousPeriod),
          ),
        ) as Record<string, unknown> | null;
        const owner = old && this.isSameAccount(String(old.owner), account);
        if (
          ((action.kind === "finalize" || action.kind === "cancel") &&
            !candidate) ||
          (action.kind === "object" && !owner) ||
          (action.kind === "approve" && !owner && !candidate)
        )
          throw new Error(
            "This wallet cannot perform that replacement action.",
          );
        if (
          action.kind === "finalize" &&
          now < integer(pending.earliestActivation) &&
          !(
            json<boolean>(pending.ownerApproved) &&
            json<boolean>(pending.candidateApproved)
          )
        )
          throw new Error(
            "Wait for the transfer window or both wallets' approval.",
          );
      }
    }
    const verificationFee = ["claim", "verify", "finalize"].includes(
      action.kind,
    )
      ? integer(price)
      : 0n;
    const current =
      action.kind === "claim"
        ? unwrapOption(
            await view.query.owners.currentPeriod(
              canonicalPageUrl(action.proof.page),
            ),
          )
        : null;
    const refundableBond =
      action.kind === "claim" && current !== null ? integer(bond) : 0n;
    // Retrying a replacement's inconclusive first check re-reserves the returned bond.
    let retryBond = 0n;
    if (action.kind === "retry") {
      const credit = unwrapOption(
        await view.query.owners.retryCredits(canonicalPageUrl(action.url)),
      ) as Record<string, unknown> | null;
      if (!credit || !this.isSameAccount(String(credit.account), account))
        throw new Error("No no-quorum retry is available for this wallet.");
      const c = credit.check as Record<string, unknown>;
      if (
        integer(c.expiresAt) <= integer(await view.query.timestamp.now()) ||
        integer(c.retriesRemaining) === 0n
      )
        throw new Error("The retry allowance has expired.");
      if (String(c.purpose) === "ReplacementInitial") retryBond = integer(bond);
    }
    const networkFee = integer(fee.partialFee),
      totalRequired = networkFee + verificationFee + refundableBond + retryBond;
    const data = (
      balance as unknown as { data: { free: unknown; frozen: unknown } }
    ).data;
    const reserve = [
      integer(data.frozen),
      integer(this.api.consts.balances.existentialDeposit),
    ].reduce((a, b) => (a > b ? a : b));
    return {
      account,
      action,
      networkFee,
      verificationFee,
      refundableBond: refundableBond + retryBond,
      totalRequired,
      affordable: integer(data.free) >= totalRequired + reserve,
      atBlock: header.hash.toHex(),
    };
  }
  async submit(
    account: WalletAccount,
    signer: Signer,
    action: OwnershipAction,
    options: SubmitOptions & { maxTotal?: bigint } = {},
  ) {
    const quote = await this.quote(account.address, action);
    if (
      options.maxTotal !== undefined &&
      quote.totalRequired > options.maxTotal
    )
      throw new Error(
        "Fees or bond changed. Review a new quote before signing.",
      );
    if (!quote.affordable)
      throw new WikaError(
        "INSUFFICIENT_BALANCE",
        "Your balance does not cover the fee and refundable bond.",
      );
    return submitFinalized(
      this.api,
      this.transaction(action),
      account,
      signer,
      options,
    );
  }
}

/** UI transport boundary; a wallet background can implement this over its message port. */
export type WikaClaimsApi = Partial<Pick<WikaClaimsClient,"recover">> & Pick<
  WikaClaimsClient,
  | "genesisHash"
  | "isSameAccount"
  | "getNetwork"
  | "getPage"
  | "getPeriod"
  | "createProof"
  | "quote"
  | "submit"
>;
