import { useCallback, useEffect, useState } from 'react';
import {
  connectWallet,
  getConnectedAddress,
  getWalletNetwork,
  signWithFreighter,
} from './wallet.js';
import {
  buildPaymentXdr,
  getXlmBalance,
  submitSignedXdr,
  shorten,
  CONTRACT_ID,
} from './stellar.js';

const MONSTERS = [
  { emoji: '🔥', name: 'Embara', type: 'Fire', beats: 'Grass' },
  { emoji: '💧', name: 'Aquos', type: 'Water', beats: 'Fire' },
  { emoji: '🌿', name: 'Verda', type: 'Grass', beats: 'Water' },
];

export default function App() {
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState(null);
  const [network, setNetwork] = useState('');
  const [loadingBalance, setLoadingBalance] = useState(false);

  const [dest, setDest] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);

  // status: { kind: 'info'|'success'|'error', text, hash? }
  const [status, setStatus] = useState(null);

  const isConnected = !!address;
  const onTestnet = network === 'TESTNET';

  const refreshBalance = useCallback(async (addr) => {
    if (!addr) return;
    setLoadingBalance(true);
    try {
      const bal = await getXlmBalance(addr);
      setBalance(bal);
    } catch (e) {
      setStatus({ kind: 'error', text: `Failed to load balance: ${e.message}` });
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  // On load, restore the session if Freighter already authorized this site.
  useEffect(() => {
    (async () => {
      const addr = await getConnectedAddress();
      if (addr) {
        setAddress(addr);
        try {
          const net = await getWalletNetwork();
          setNetwork(net.network);
        } catch {
          /* ignore */
        }
        refreshBalance(addr);
      }
    })();
  }, [refreshBalance]);

  async function handleConnect() {
    setStatus(null);
    try {
      const addr = await connectWallet();
      setAddress(addr);
      const net = await getWalletNetwork();
      setNetwork(net.network);
      if (net.network !== 'TESTNET') {
        setStatus({
          kind: 'error',
          text: 'Freighter is not on Testnet. Switch the network to Testnet in the extension.',
        });
      }
      refreshBalance(addr);
    } catch (e) {
      setStatus({ kind: 'error', text: e.message });
    }
  }

  function handleDisconnect() {
    setAddress('');
    setBalance(null);
    setNetwork('');
    setStatus({ kind: 'info', text: 'Wallet disconnected.' });
  }

  async function handleSend(e) {
    e.preventDefault();
    setStatus(null);

    if (!dest.trim() || !amount) {
      setStatus({ kind: 'error', text: 'Enter a destination address and amount.' });
      return;
    }
    if (Number(amount) <= 0) {
      setStatus({ kind: 'error', text: 'Amount must be greater than 0.' });
      return;
    }

    setSending(true);
    setStatus({ kind: 'info', text: 'Building transaction…' });
    try {
      const xdr = await buildPaymentXdr(address, dest.trim(), amount);
      setStatus({ kind: 'info', text: 'Waiting for Freighter signature…' });
      const signed = await signWithFreighter(xdr, address);
      setStatus({ kind: 'info', text: 'Submitting to the network…' });
      const result = await submitSignedXdr(signed);

      setStatus({
        kind: 'success',
        text: `Sent ${amount} XLM successfully!`,
        hash: result.hash,
      });
      setAmount('');
      setDest('');
      refreshBalance(address);
    } catch (e) {
      // Surface Horizon's detailed error codes when available.
      const detail =
        e?.response?.data?.extras?.result_codes
          ? JSON.stringify(e.response.data.extras.result_codes)
          : e.message;
      setStatus({ kind: 'error', text: `Transaction failed: ${detail}` });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <h1>🐉 Monster Duel</h1>
        <p className="tagline">
          Trustless 1v1 monster battles on <strong>Stellar Testnet</strong>.
          Connect your wallet, check your balance, and send XLM to wager a duel.
        </p>
      </header>

      {/* ---- Wallet card ---- */}
      <section className="card">
        <div className="card-head">
          <h2>👛 Wallet</h2>
          {isConnected ? (
            <button className="btn ghost" onClick={handleDisconnect}>
              Disconnect
            </button>
          ) : (
            <button className="btn primary" onClick={handleConnect}>
              Connect Freighter
            </button>
          )}
        </div>

        {isConnected ? (
          <div className="wallet-info">
            <div className="row">
              <span className="label">Address</span>
              <span className="mono" title={address}>
                {shorten(address, 6, 6)}
              </span>
            </div>
            <div className="row">
              <span className="label">Network</span>
              <span className={`badge ${onTestnet ? 'ok' : 'warn'}`}>
                {network || 'unknown'}
              </span>
            </div>
            <div className="row">
              <span className="label">Balance</span>
              <span className="balance">
                {loadingBalance
                  ? 'Loading…'
                  : balance === null
                    ? 'Account not funded'
                    : `${Number(balance).toFixed(4)} XLM`}
                <button
                  className="btn tiny"
                  onClick={() => refreshBalance(address)}
                  disabled={loadingBalance}
                >
                  ↻
                </button>
              </span>
            </div>
            {balance === null && (
              <p className="hint">
                Fund this account with free test XLM at{' '}
                <a
                  href={`https://friendbot.stellar.org/?addr=${address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  friendbot.stellar.org
                </a>
                .
              </p>
            )}
          </div>
        ) : (
          <p className="hint">
            Connect the Freighter extension (set to Testnet) to get started.
          </p>
        )}
      </section>

      {/* ---- Send XLM card ---- */}
      <section className="card">
        <h2>⚔️ Send XLM (wager / tip)</h2>
        <form onSubmit={handleSend} className="send-form">
          <label>
            Destination address
            <input
              type="text"
              placeholder="G… (recipient public key)"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              disabled={!isConnected || sending}
            />
          </label>
          <label>
            Amount (XLM)
            <input
              type="number"
              step="0.0000001"
              min="0"
              placeholder="1.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={!isConnected || sending}
            />
          </label>
          <button
            className="btn primary"
            type="submit"
            disabled={!isConnected || sending}
          >
            {sending ? 'Sending…' : 'Send Payment'}
          </button>
        </form>

        {status && (
          <div className={`status ${status.kind}`}>
            <p>{status.text}</p>
            {status.hash && (
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${status.hash}`}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                View transaction: {shorten(status.hash, 8, 8)} ↗
              </a>
            )}
          </div>
        )}
      </section>

      {/* ---- Game roster (theme) ---- */}
      <section className="card">
        <h2>🎮 The Roster</h2>
        <div className="roster">
          {MONSTERS.map((m) => (
            <div className="monster" key={m.name}>
              <span className="monster-emoji">{m.emoji}</span>
              <strong>{m.name}</strong>
              <span className="muted">
                {m.type} · beats {m.beats}
              </span>
            </div>
          ))}
        </div>
        <p className="hint">
          On-chain duel contract:{' '}
          <a
            href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
            target="_blank"
            rel="noreferrer"
            className="mono"
          >
            {shorten(CONTRACT_ID, 6, 6)} ↗
          </a>
        </p>
      </section>

      <footer className="footer">
        Built on Stellar · Soroban · Testnet — MAD Builder Challenge Level 1
      </footer>
    </div>
  );
}
