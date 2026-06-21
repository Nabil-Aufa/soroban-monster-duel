import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import type { ClientOptions } from "@stellar/stellar-sdk/contract";
import { Client } from "../bindings/index.ts";

const networkPassphrase = import.meta.env.VITE_STELLAR_NETWORK_PASSPHRASE;
const rpcUrl = import.meta.env.VITE_STELLAR_RPC_URL;
const contractId = import.meta.env.VITE_STELLAR_CONTRACT_ID;

/** Prompt Freighter and return the active public key. */
export async function connectFreighter(): Promise<string> {
  const check = await isConnected();
  if (!check.isConnected) {
    throw new Error("Freighter is not installed. Install it at https://www.freighter.app");
  }
  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message ?? String(access.error));
  return access.address;
}

/**
 * Read the account currently *active* in Freighter (reflects in-extension
 * account switches). Throws if the site isn't allowed yet — callers should
 * fall back to {@link connectFreighter} in that case.
 */
export async function getActiveAddress(): Promise<string> {
  const res = await getAddress();
  if (res.error) throw new Error(res.error.message ?? String(res.error));
  if (!res.address) throw new Error("No active account in Freighter.");
  return res.address;
}

/** The network Freighter is currently set to, e.g. "TESTNET". */
export async function getNetworkName(): Promise<string> {
  try {
    const net = await getNetwork();
    if (net?.error) return "unknown";
    return net.network ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** A contract client bound to a wallet, signing through Freighter (official pattern). */
export function createContractClient(walletAddress: string) {
  return new Client({
    contractId,
    networkPassphrase,
    rpcUrl,
    publicKey: walletAddress,
    signTransaction: async (
      xdr: string,
      opts?: Parameters<NonNullable<ClientOptions["signTransaction"]>>[1],
    ) => {
      const result = await freighterSignTransaction(xdr, {
        networkPassphrase,
        address: walletAddress,
        ...opts,
      });
      if (result.error) throw new Error(result.error.message ?? String(result.error));
      return result;
    },
  });
}

/** Unwrap a contract `Result<T>` (Ok/Err) into T, throwing a readable error on Err. */
export function unwrap<T>(r: any): T {
  if (r == null) return r;
  if (typeof r.unwrap === "function") return r.unwrap();
  if ("tag" in r) {
    if (r.tag === "ok") return r.value;
    throw new Error(r.error?.message ?? "The contract rejected this action.");
  }
  return r;
}
