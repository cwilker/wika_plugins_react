import type { ApiPromise } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";
import { u8aToHex, stringToU8a } from "@polkadot/util";
import { canonicalPageUrl } from "./page-identity";
import type { ReferralQuote } from "./referrals";

export interface PagePolicy {
  ruleset: number;
  revision: string;
  model: number;
  ownerBps: number;
  supporterBps: number;
  referralBps: number;
  protocolBps: number;
  rounds: number;
  treasury: string;
  configurator: string | null;
  ownerPeriod: string | null;
}
export interface EconomicRules {
  version: number;
  ownerMin: number;
  ownerMax: number;
  supporterMin: number;
  supporterMax: number;
  referralMin: number;
  referralMax: number;
  protocolBps: number;
  minimumPrice: string;
  treasury: string;
}
export interface PageEconomics {
  active: boolean;
  policy: PagePolicy;
  policyHash: string;
  lockedAt: string | null;
  legacy: boolean;
  rules: EconomicRules | null;
  price: string;
  defaultPolicy?: PagePolicy;
}
export interface PolicySelection {
  ownerBps: number;
  supporterBps: number;
  referralBps: number;
  ruleset: number;
  expectedRevision: string;
  expectedHash: string;
  inheritIfChanged: boolean;
}
export interface EconomicTerms {
  version: number;
  genesisHash: string;
  payer: string;
  target: string;
  source: string;
  sourcePeriod: string;
  authorizationId: string;
  count: number;
  price: string;
  cost: string;
  recipient: string;
  referralAmount: string;
  targetOwner: string;
  targetPeriod: string | null;
  policyHash: string;
  policy: PagePolicy;
  ownerAmount: string;
  supporterBudget: string;
  protocolAmount: string;
  referralToTarget: boolean;
  retainedOwner: string;
}
export const POLICY_TYPE = {
  ruleset: "u32",
  revision: "u64",
  model: "u8",
  ownerBps: "u16",
  supporterBps: "u16",
  referralBps: "u16",
  protocolBps: "u16",
  rounds: "u8",
  treasury: "AccountId32",
  configurator: "Option<AccountId32>",
  ownerPeriod: "Option<u64>",
};
export const TERMS_TYPE = {
  version: "u16",
  genesisHash: "[u8;32]",
  payer: "AccountId32",
  target: "Bytes",
  source: "Bytes",
  sourcePeriod: "u64",
  authorizationId: "u64",
  count: "u32",
  price: "u128",
  cost: "u128",
  recipient: "AccountId32",
  referralAmount: "u128",
  targetOwner: "AccountId32",
  targetPeriod: "Option<u64>",
  policyHash: "[u8;32]",
  policy: "WikaPolicyV1",
  ownerAmount: "u128",
  supporterBudget: "u128",
  protocolAmount: "u128",
  referralToTarget: "bool",
  retainedOwner: "u128",
};
export function registerEconomics(api: Pick<ApiPromise, "registry">) {
  api.registry.register({
    WikaPolicyV1: POLICY_TYPE,
    WikaEconomicTermsV2: TERMS_TYPE,
    WikaPageEconomicsV1: {
      active: "bool",
      policy: "WikaPolicyV1",
      policyHash: "[u8;32]",
      lockedAt: "Option<BlockNumber>",
      legacy: "bool",
    },
  });
}
function decimal(v: unknown): string {
  return BigInt(String(v)).toString();
}
function policy(v: Record<string, unknown>): PagePolicy {
  return {
    ...v,
    revision: decimal(v.revision),
    ownerPeriod: v.ownerPeriod == null ? null : decimal(v.ownerPeriod),
  } as unknown as PagePolicy;
}
const arg = (page: string) => u8aToHex(stringToU8a(canonicalPageUrl(page)));
function result(api: ApiPromise, type: string, hex: string) {
  registerEconomics(api);
  const d = api.registry.createType(
    `Result<${type},DispatchError>`,
    hex
  ) as unknown as {
    isErr: boolean;
    asErr: { toString(): string };
    asOk: { toJSON(): unknown; toU8a(): Uint8Array };
  };
  if (d.isErr)
    throw new Error(`Economic quote rejected: ${d.asErr.toString()}`);
  return d.asOk;
}
export async function getPageEconomics(
  api: ApiPromise,
  target: string,
  at?: string
): Promise<PageEconomics> {
  const hash = at ?? (await api.rpc.chain.getFinalizedHead()).toHex(),
    view = await api.at(hash);
  if (!view.query.likes.economicsActive)
    throw new Error("Upgrade the node for page payout settings.");
  const args = api.registry.createType("Bytes", arg(target));
  const data = await api.rpc.state.call(
    "EconomicsApi_page",
    u8aToHex(args.toU8a()),
    hash
  );
  const value = result(
    api,
    "WikaPageEconomicsV1",
    data.toHex()
  ).toJSON() as Record<string, unknown>;
  const [rules, price, defaultProfile] = await Promise.all([
    view.query.likes.economicRules(),
    view.query.likes.likePrice(),
    view.query.likes.defaultProfile(),
  ]);
  const r = rules.toJSON() as Record<string, unknown> | null;
  return {
    ...value,
    policy: policy(value.policy as Record<string, unknown>),
    lockedAt: value.lockedAt == null ? null : decimal(value.lockedAt),
    defaultPolicy: defaultProfile.toJSON()
      ? policy(defaultProfile.toJSON() as Record<string, unknown>)
      : undefined,
    rules: r
      ? ({
          ...r,
          minimumPrice: decimal(r.minimumPrice),
        } as unknown as EconomicRules)
      : null,
    price: price.toString(),
  } as PageEconomics;
}
export function hashEconomicTerms(
  api: Pick<ApiPromise, "registry">,
  terms: EconomicTerms
): string {
  registerEconomics(api);
  return blake2AsHex(
    api.registry
      .createType("WikaEconomicTermsV2", {
        ...terms,
        target: arg(terms.target),
        source: terms.source ? arg(terms.source) : "0x",
      })
      .toU8a(),
    256
  );
}
export function hashPagePolicy(
  api: Pick<ApiPromise, "registry">,
  target: string,
  p: PagePolicy
): string {
  registerEconomics(api);
  return blake2AsHex(
    api.registry
      .createType("([u8;19],Bytes,WikaPolicyV1)", [
        u8aToHex(stringToU8a("WIKA_PAGE_POLICY_V1")),
        arg(target),
        p,
      ])
      .toU8a(),
    256
  );
}
export async function quoteEconomics(
  api: ApiPromise,
  payer: string,
  target: string,
  source = "",
  count = 1,
  authorizationId = "0",
  at?: string
): Promise<ReferralQuote> {
  const blockHash = at ?? (await api.rpc.chain.getFinalizedHead()).toHex();
  const args = api.registry.createType("(AccountId32,Bytes,Bytes,u32,u64)", [
    payer,
    arg(target),
    source ? arg(source) : "0x",
    count,
    authorizationId,
  ]);
  const raw = await api.rpc.state.call(
    "EconomicsApi_quote",
    u8aToHex(args.toU8a()),
    blockHash
  );
  const decoded = result(api, "WikaEconomicTermsV2", raw.toHex()),
    t = decoded.toJSON() as Record<string, unknown>;
  const terms = {
    ...t,
    target: canonicalPageUrl(target),
    source: source ? canonicalPageUrl(source) : "",
    policy: policy(t.policy as Record<string, unknown>),
  } as unknown as EconomicTerms;
  for (const k of [
    "sourcePeriod",
    "authorizationId",
    "price",
    "cost",
    "referralAmount",
    "ownerAmount",
    "supporterBudget",
    "protocolAmount",
    "retainedOwner",
  ] as const)
    terms[k] = decimal(t[k]);
  terms.targetPeriod = t.targetPeriod == null ? null : decimal(t.targetPeriod);
  if (terms.version !== 2 || ![0, 1].includes(terms.policy.model))
    throw new Error("Unsupported economic policy.");
  const termsHash = blake2AsHex(decoded.toU8a(), 256);
  if (
    hashEconomicTerms(api, terms) !== termsHash ||
    hashPagePolicy(api, terms.target, terms.policy) !== terms.policyHash
  )
    throw new Error("Unsupported economic encoding.");
  const [header, view] = await Promise.all([
    api.rpc.chain.getHeader(blockHash),
    api.at(blockHash),
  ]);
  return {
    blockHash,
    blockNumber: header.number.toString(),
    chainTime: (await view.query.timestamp.now()).toString(),
    termsHash,
    economics: terms,
    terms: {
      ...terms,
      shareAuthor: terms.policy.ownerBps / 100,
      shareReferrer: terms.policy.referralBps / 100,
      shareSupporters: terms.policy.supporterBps / 100,
      rounds: terms.policy.rounds,
    },
  };
}
/** Does not infer launch constants. The runtime-provided rules define the editable range. */
export function policySelection(
  state: PageEconomics,
  ownerBps: number,
  supporterBps: number,
  referralBps: number,
  inheritIfChanged: boolean
): PolicySelection {
  const r = state.rules;
  if (!state.active || !r)
    throw new Error("Custom payout policies are not active on this network.");
  if (state.lockedAt !== null || state.legacy)
    throw new Error(
      "This page already has supporters; its payout policy is fixed."
    );
  if (
    ![ownerBps, supporterBps, referralBps].every(Number.isSafeInteger) ||
    ownerBps < r.ownerMin ||
    ownerBps > r.ownerMax ||
    supporterBps < r.supporterMin ||
    supporterBps > r.supporterMax ||
    referralBps < r.referralMin ||
    referralBps > r.referralMax ||
    ownerBps + supporterBps + referralBps + r.protocolBps !== 10000
  )
    throw new Error("Allocations must total 100% and meet network limits.");
  return {
    ownerBps,
    supporterBps,
    referralBps,
    ruleset: r.version,
    expectedRevision: state.policy.revision,
    expectedHash: state.policyHash,
    inheritIfChanged,
  };
}
export function parsePercentage(value: string): number {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(value))
    throw new Error("Use a percentage with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (n > 10000) throw new Error("Percentage cannot exceed 100.");
  return n;
}
