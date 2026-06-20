// Thin wrapper around @stellar/stellar-sdk for the Stellar **testnet**:
// reading balances from Horizon and building / submitting XLM payments.
import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from '@stellar/stellar-sdk';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NETWORK_PASSPHRASE = Networks.TESTNET;

// Our deployed Monster Duel contract (shown in the UI footer to tie the app
// to the on-chain game).
export const CONTRACT_ID =
  'CCRZGZLNJR4B2NQAR6EAAY3XPK5XNKDPLJYX55ZIB4AAEVIVN4DDS7TA';

export const server = new Horizon.Server(HORIZON_URL);

/**
 * Fetch the native XLM balance of an account.
 * Returns the balance string, or `null` if the account is not funded yet.
 */
export async function getXlmBalance(address) {
  try {
    const account = await server.loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return native ? native.balance : '0';
  } catch (e) {
    // Horizon returns 404 for accounts that exist as keypairs but have never
    // been funded on the network.
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/**
 * Build an unsigned XLM payment transaction and return its XDR so the wallet
 * (Freighter) can sign it.
 */
export async function buildPaymentXdr(source, destination, amount) {
  const account = await server.loadAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: String(amount),
      })
    )
    .setTimeout(120)
    .build();
  return tx.toXDR();
}

/** Submit a signed transaction XDR to Horizon and return the result. */
export async function submitSignedXdr(signedXdr) {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  return server.submitTransaction(tx);
}

/** Short helper to render addresses / hashes as `ABCD…WXYZ`. */
export function shorten(str, head = 4, tail = 4) {
  if (!str) return '';
  if (str.length <= head + tail) return str;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}
