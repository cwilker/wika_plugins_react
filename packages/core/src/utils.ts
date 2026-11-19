export type WikaErrorCode =
  | "UNSUPPORTED_SIGNING"
  | "INVALID_URL"
  | "INVALID_COUNT"
  | "WRONG_NETWORK"
  | "UNSUPPORTED_CHAIN"
  | "ALREADY_LIKED"
  | "INSUFFICIENT_BALANCE"
  | "TRANSACTION_FAILED"
  | "TIMEOUT"
  | "ABORTED"
  | "WALLET_UNAVAILABLE";
export class WikaError extends Error {
  constructor(
    public readonly code: WikaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WikaError";
  }
}
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
/** Validate without rewriting: URL bytes are the chain's identity, shared with the wallet. */
export function validateUrl(url: string, allowEmpty = false): string {
  if (allowEmpty && url === "") return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WikaError("INVALID_URL", "Enter an absolute HTTP or HTTPS URL.");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    url.trim() !== url
  ) {
    throw new WikaError(
      "INVALID_URL",
      "Use an HTTP or HTTPS URL without credentials or surrounding whitespace.",
    );
  }
  // Wika 4.x rejects URLs of 255 bytes or more (UTF-8, not JavaScript characters).
  if (new TextEncoder().encode(url).length >= 255)
    throw new WikaError(
      "INVALID_URL",
      "The URL must be shorter than 255 UTF-8 bytes.",
    );
  return url;
}
export function validateCount(count: number, max = 0xffffffff): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > max)
    throw new WikaError(
      "INVALID_COUNT",
      `Choose a whole number of likes between 1 and ${max}.`,
    );
}
export function unwrapOption(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "object" && "isNone" in value) {
    const option = value as { isNone: boolean; unwrap(): unknown };
    return option.isNone ? null : option.unwrap();
  }
  return value;
}
export function tuple(value: unknown): unknown[] {
  const unwrapped = unwrapOption(value);
  return unwrapped == null ? [] : Array.from(unwrapped as Iterable<unknown>);
}
export function integer(value: unknown): bigint {
  return BigInt(value == null ? "0" : String(value));
}
/** Exact decimal rendering, with no floating point conversion or invented fiat exchange rate. */
export function formatAmount(
  amount: bigint,
  decimals = 12,
  symbol = "WIKA",
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new RangeError("Invalid token decimals");
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}${symbol ? ` ${symbol}` : ""}`;
}
/** Consumer callbacks must not break chain monitoring or leak subscriptions. */
export function notify<T>(
  callback: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    callback?.(value);
  } catch (error) {
    console.error("Wika callback failed", error);
  }
}
