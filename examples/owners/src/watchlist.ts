import {
  canonicalPageUrl,
  type ClaimPageInfo,
  type WikaClaimsClient,
} from "@wika/core";
export const MAX_PAGES = 25;
export const HISTORY_PAGE_SIZE = 5;
export function storageKey(genesis: string) {
  return `wika:owners:v1:${genesis}`;
}
export function readPages(
  storage: Pick<Storage, "getItem">,
  genesis: string,
): string[] {
  const raw = storage.getItem(storageKey(genesis));
  if (!raw) return [];
  if (raw.length > 16000) throw new Error("Saved page list is too large.");
  const record = JSON.parse(raw);
  if (
    record.version !== 1 ||
    !Array.isArray(record.pages) ||
    record.pages.length > MAX_PAGES
  )
    throw new Error("Unsupported saved page list.");
  return [
    ...new Set(
      record.pages.map((page: unknown) => {
        if (typeof page !== "string") throw new Error("Invalid saved page.");
        return canonicalPageUrl(page);
      }),
    ),
  ] as string[];
}
export function savePages(
  storage: Pick<Storage, "setItem">,
  genesis: string,
  pages: string[],
) {
  if (pages.length > MAX_PAGES)
    throw new Error(`Track up to ${MAX_PAGES} pages in this preview.`);
  storage.setItem(storageKey(genesis), JSON.stringify({ version: 1, pages }));
}
export function addPage(pages: string[], input: string): string[] {
  const page = canonicalPageUrl(input);
  if (pages.includes(page)) return pages;
  if (pages.length >= MAX_PAGES)
    throw new Error(
      `Track up to ${MAX_PAGES} pages. Remove one before adding another.`,
    );
  return [...pages, page];
}
export function periodWindow(start: bigint): bigint[] {
  const ids: bigint[] = [];
  for (let id = start; id > 0n && ids.length < HISTORY_PAGE_SIZE; id--)
    ids.push(id);
  return ids;
}
export type PageEntry = { data?: ClaimPageInfo; error?: string };
export function overview(
  entries: Record<string, PageEntry>,
  wallet: string,
  claims: Pick<WikaClaimsClient, "isSameAccount">,
) {
  let owned = 0,
    reserved = 0n,
    withdrawable = 0n,
    challenges = 0;
  for (const { data, error } of Object.values(entries)) {
    if (!data || error) continue;
    const mine = Boolean(
      wallet &&
      data.current &&
      claims.isSameAccount(wallet, data.current.owner),
    );
    if (mine && data.current) {
      owned++;
      reserved += data.current.balance;
      withdrawable += data.current.withdrawable;
    }
    if (
      data.pending &&
      data.chainTime < data.pending.deadline &&
      (!wallet || mine || claims.isSameAccount(wallet, data.pending.candidate))
    )
      challenges++;
  }
  return { owned, reserved, withdrawable, challenges };
}
