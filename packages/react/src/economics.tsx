import { useEffect, useRef, useState } from "react";
import {
  formatAmount,
  parsePercentage,
  policySelection,
  type PageEconomics,
  type PolicySelection,
} from "@wika/core";
export function PayoutEditor({
  state,
  onSelect,
  forClaim,
  disabled = false,
  readOnly = false,
  decimals = 12,
  symbol = "WIKA",
}: {
  state: PageEconomics;
  onSelect: (p: PolicySelection | null) => void;
  forClaim: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  decimals?: number;
  symbol?: string;
}) {
  const [custom, setCustom] = useState(false),
    [a, setA] = useState(""),
    [s, setS] = useState(""),
    [r, setR] = useState(""),
    [consent, setConsent] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  useEffect(() => {
    const p = state.defaultPolicy ?? state.policy;
    setA(String(p.ownerBps / 100));
    setS(String(p.supporterBps / 100));
    setR(String(p.referralBps / 100));
    setConsent(false);
    setSaved(false);
    setError("");
    callback.current(null);
  }, [state.policyHash]);
  const p = state.policy;
  const format = (v: bigint) => formatAmount(v, decimals, symbol);
  let unallocated: number | undefined;
  let preview: { a: bigint; s: bigint; r: bigint; p: bigint } | undefined;
  try {
    const price = BigInt(state.price),
      ab = parsePercentage(a),
      sb = parsePercentage(s),
      rb = parsePercentage(r);
    unallocated = 10000 - ab - sb - rb - p.protocolBps;
    if (unallocated === 0)
      preview = {
        a: (price * BigInt(ab)) / 10000n,
        s: (price * BigInt(sb)) / 10000n,
        r: (price * BigInt(rb)) / 10000n,
        p:
          price -
          (price * BigInt(ab)) / 10000n -
          (price * BigInt(sb)) / 10000n -
          (price * BigInt(rb)) / 10000n,
      };
  } catch {}
  const change = () => {
    setSaved(false);
    setError("");
    onSelect(null);
  };
  return (
    <fieldset disabled={disabled} className="wika-economics">
      <legend>Payout split</legend>
      <p>
        Current: {p.ownerBps / 100}% owner · {p.supporterBps / 100}% supporters
        · {p.referralBps / 100}% referrals · {p.protocolBps / 100}% protocol.
      </p>
      {readOnly ? (
        <p>
          Ownership replacement inherits the effective policy. An incoming owner
          may configure it after activation if no payment has locked it.
        </p>
      ) : !state.active ? (
        <p>Custom payouts are awaiting network activation.</p>
      ) : state.lockedAt !== null || state.legacy ? (
        <p>
          This page already has supporters; its{" "}
          {state.legacy ? "inherited legacy " : ""}payout policy is fixed.
          Ownership changes preserve it.
        </p>
      ) : (
        <>
          <label>
            Selection{" "}
            <select
              aria-label="Selection"
              value={custom ? "custom" : "default"}
              onChange={(e) => {
                setCustom(e.target.value === "custom");
                if (e.target.value === "default") {
                  const p = state.defaultPolicy ?? state.policy;
                  setA(String(p.ownerBps / 100));
                  setS(String(p.supporterBps / 100));
                  setR(String(p.referralBps / 100));
                }
                change();
              }}
            >
              <option value="default">Network default</option>
              <option value="custom">Custom split</option>
            </select>
          </label>
          {(
            [
              ["Owner", a, setA],
              ["Supporters", s, setS],
              ["Referrals", r, setR],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label}>
              {label} (%)
              <input
                inputMode="decimal"
                value={value}
                disabled={!custom}
                onChange={(e) => {
                  set(e.target.value);
                  change();
                }}
              />
            </label>
          ))}
          <p>
            Protocol: {p.protocolBps / 100}% (fixed). Total must equal 100%.
            Referral minimum: {(state.rules?.referralMin ?? 0) / 100}%. Amounts
            are rounded to base units; protocol receives rounding residue.
          </p>
          {unallocated !== undefined && (
            <p role="status">
              {unallocated < 0
                ? `Over allocated: ${-unallocated / 100}%.`
                : `Remaining to allocate: ${unallocated / 100}%.`}
            </p>
          )}
          {preview && (
            <div aria-label="One endorsement preview">
              <p>
                With an eligible host: {format(preview.a)} owner,{" "}
                {format(preview.s)} supporter budget, {format(preview.r)} host,{" "}
                {format(preview.p)} protocol.
              </p>
              <p>
                Without an eligible host: {format(preview.a + preview.r)}{" "}
                target-owner entitlement. Unclaimed rewards are held in funded
                page escrow. Empty supporter budgets go to the likes pot.
                Self-owner allocations are retained by the payer. Network fees
                are additional.
              </p>
            </div>
          )}
          <p>
            The first successful paid endorsement locks this split and the FIFO
            supporter model. Someone can pay before your claim finishes.
            Supporter payouts come from future payments; a percentage does not
            predict a return.
          </p>
          {forClaim && (
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => {
                  setConsent(e.target.checked);
                  change();
                }}
              />
              If a payment or relevant rules change prevents this selection from
              activating, claim the page using its effective policy instead.
            </label>
          )}
          <button
            type="button"
            disabled={disabled || (forClaim && !consent)}
            onClick={() => {
              try {
                onSelect(
                  policySelection(
                    state,
                    parsePercentage(a),
                    parsePercentage(s),
                    parsePercentage(r),
                    forClaim && consent
                  )
                );
                setError("");
                setSaved(true);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Use this split for review
          </button>
          {saved && (
            <p role="status">
              Split selected. Review the transaction before signing.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </fieldset>
  );
}
