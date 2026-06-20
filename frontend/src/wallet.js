// Wrapper around the Freighter browser extension API.
// Docs: https://docs.freighter.app / @stellar/freighter-api
import {
  isConnected,
  requestAccess,
  getAddress,
  getNetwork,
  signTransaction,
} from '@stellar/freighter-api';
import { NETWORK_PASSPHRASE } from './stellar.js';

/** True if the Freighter extension is installed in this browser. */
export async function isFreighterInstalled() {
  const res = await isConnected();
  return !!res?.isConnected;
}

/**
 * Prompt the user to connect Freighter and return their public key.
 * Throws a friendly error if Freighter is missing or access is denied.
 */
export async function connectWallet() {
  if (!(await isFreighterInstalled())) {
    throw new Error(
      'Freighter not detected. Install it from freighter.app, then refresh.'
    );
  }
  const access = await requestAccess();
  if (access?.error) throw new Error(access.error);
  return access.address;
}

/** Return the already-authorized address, or '' if not connected. */
export async function getConnectedAddress() {
  try {
    const res = await getAddress();
    if (res?.error) return '';
    return res.address || '';
  } catch {
    return '';
  }
}

/** Get the network Freighter is currently set to ({ network, networkPassphrase }). */
export async function getWalletNetwork() {
  const net = await getNetwork();
  if (net?.error) throw new Error(net.error);
  return net;
}

/** Ask Freighter to sign a transaction XDR on testnet. Returns signed XDR. */
export async function signWithFreighter(xdr, address) {
  const res = await signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });
  if (res?.error) throw new Error(res.error);
  return res.signedTxXdr;
}
