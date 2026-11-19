export { WikaClient, decodePage } from "./client";
export { createInjectedWallet } from "./wallet";
export { WikaError, formatAmount, validateUrl, validateCount } from "./utils";
export type { WikaErrorCode } from "./utils";
export type * from "./types";
export {
  canonicalPageUrl,
  PAGE_IDENTITY_VERSION,
  MAX_PAGE_URL_BYTES,
} from "./page-identity";
export { claimProofMessage, signClaimProof } from "./claim-proof";
export type { ClaimProofInput, SignedClaimProof } from "./claim-proof";
export { WikaClaimsClient } from "./claims-client";
export type {
  WikaClaimsApi,
  OwnershipAction,
  OwnershipQuote,
  OwnershipPeriodInfo,
  ReplacementInfo,
  ClaimPageInfo,
} from "./claims-client";

export { WikaPortfolioClient } from "./portfolio";
export type {
  PortfolioRecord,
  PortfolioSnapshot,
  PortfolioBatch,
  PortfolioCursors,
  PortfolioKind,
} from "./portfolio";
export { WikaReferralClient, encodeReferralPayload, referralPayloadForCall, decodeReferralPayload, hashReferralTerms, verifyReferralSignature, quoteReferral, validateReferral, recoverReferral, recoverDirectPayment, signingExpiry } from './referrals';
export type { ReferralPayload, ReferralEnvelope, ReferralQuote, HostKeyInfo } from './referrals';
export { createReferralIssuer } from './host-issuer';
export type { HostIssueInput } from './host-issuer';

export { getPageEconomics, quoteEconomics, hashEconomicTerms, hashPagePolicy, policySelection, parsePercentage } from './economics';
export type { PageEconomics, PagePolicy, PolicySelection, EconomicTerms, EconomicRules } from './economics';

export { recoverClaimTransaction } from './claim-recovery';
export type { ClaimRecovery, ClaimRecoveryResult } from './claim-recovery';
