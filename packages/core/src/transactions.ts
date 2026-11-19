import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { ISubmittableResult } from "@polkadot/types/types";
import type { DispatchError } from "@polkadot/types/interfaces";
import type {
  WalletAccount,
  Signer,
  SubmitOptions,
  LikeReceipt,
  Unsubscribe,
} from "./types";
import { asError, notify, WikaError } from "./utils";
export async function submitFinalized(
  api: ApiPromise,
  tx: SubmittableExtrinsic<"promise">,
  account: WalletAccount,
  signer: Signer,
  options: SubmitOptions = {},
): Promise<LikeReceipt> {
  if (
    account.genesisHash &&
    account.genesisHash.toLowerCase() !== api.genesisHash.toHex().toLowerCase()
  )
    throw new WikaError(
      "WRONG_NETWORK",
      "Choose an account for this Wika network.",
    );
  try { await options.beforeSign?.(); } catch(error) { notify(options.onSigningRejected,asError(error)); throw error; }
  return new Promise<LikeReceipt>((resolve, reject) => {
    let unsubscribe: Unsubscribe | undefined;
    let done = false;
    let signingStarted = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      unsubscribe?.();
    };
    const fail = (error: unknown) => {
      if (!done) {
        done = true;
        cleanup();
        reject(asError(error));
      }
    };
    const abort = () => {
      const error=new WikaError("ABORTED", "Stopped watching the transaction. A signed transaction may still complete.");
      if(!signingStarted) notify(options.onSigningRejected,error);
      fail(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          new WikaError(
            "TIMEOUT",
            "Transaction monitoring timed out. Check your wallet before trying again; it may still complete.",
          ),
        ),
      options.timeoutMs ?? 120000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    notify(options.onStatus, "signing");
    if (done) return;
    const onResult = (result: ISubmittableResult) => {
      if (done) return;
      try {
        const { status } = result;
        // A retracted inclusion can be included again. Report failures only on the finalized fork.
        if (status.isFinalized) {
          const eventFailure = result.events.find(
            ({ event }) =>
              event.section === "system" && event.method === "ExtrinsicFailed",
          );
          const error =
            result.dispatchError ??
            (eventFailure?.event.data[0] as DispatchError | undefined);
          if (error) {
            notify(options.onFinalizedFailure,{txHash:tx.hash.toHex(),blockHash:status.asFinalized.toHex()});
            fail(
              new WikaError("TRANSACTION_FAILED", describeError(api, error)),
            );
            return;
          }
          if (
            !result.events.some(
              ({ event }) =>
                event.section === "system" &&
                event.method === "ExtrinsicSuccess",
            )
          ) {
            fail(
              new WikaError(
                "TRANSACTION_FAILED",
                "Finalized transaction did not report successful execution.",
              ),
            );
            return;
          }
          done = true;
          cleanup();
          notify(options.onStatus, "finalized");
          const blockHash = status.asFinalized.toHex();
          void Promise.resolve().then(() => api.rpc.chain.getHeader(blockHash)).then(header => resolve({
            txHash: tx.hash.toHex(), blockHash, blockNumber: header.number.toString(),
          }), () => resolve({ txHash: tx.hash.toHex(), blockHash }));
        } else if (
          status.isInvalid ||
          status.isDropped ||
          status.isUsurped ||
          status.isFinalityTimeout
        ) {
          fail(
            new WikaError(
              "TRANSACTION_FAILED",
              `Transaction ${status.type}. Check the wallet before retrying.`,
            ),
          );
        } else if (status.isRetracted) notify(options.onStatus, "retracted");
        else if (status.isInBlock) notify(options.onStatus, "inBlock");
        else if (status.isReady || status.isBroadcast) {
          notify(options.onBroadcast, tx.hash.toHex());
          notify(options.onStatus, "submitted");
        }
      } catch (error) {
        fail(error);
      }
    };
    try {
      const monitored = Object.create(signer) as Signer;
      monitored.update = signer.update?.bind(signer);
      monitored.signRaw = signer.signRaw?.bind(signer);
      if (signer.signPayload) monitored.signPayload = async payload => {
        try { await options.onSigningPayload?.(payload); return await signer.signPayload!.call(signer,payload); }
        catch(error) { notify(options.onSigningRejected,asError(error)); throw error; }
      };
      signingStarted=true;
      Promise.resolve(
        tx.signAndSend(account.address, { signer: monitored, era:64 }, onResult),
      ).then((stop) => {
        unsubscribe = stop;
        if (done) stop();
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function describeError(api: ApiPromise, error: DispatchError): string {
  if (error.isModule) {
    const meta = api.registry.findMetaError(error.asModule);
    return `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
  }
  return error.toString();
}
