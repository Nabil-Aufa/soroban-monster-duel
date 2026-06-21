import { useState } from "react";
import { Buffer } from "buffer";
import { Status, type Match } from "../bindings/index.ts";
import { connectFreighter, getActiveAddress, createContractClient, getNetworkName, unwrap } from "./stellar";
import {
  MONSTERS,
  monsterById,
  generateSecret,
  computeCommit,
  savePick,
  loadPick,
  xlmToStroops,
  stroopsToXlm,
  shorten,
  friendlyError,
  type Monster,
} from "./game";

const CONTRACT_ID = import.meta.env.VITE_STELLAR_CONTRACT_ID as string;
const EXPLORER = "https://stellar.expert/explorer/testnet";

type Tx =
  | { kind: "idle" }
  | { kind: "pending"; msg: string }
  | { kind: "success"; msg: string; hash?: string }
  | { kind: "error"; msg: string };

function extractHash(sent: any): string | undefined {
  return (
    sent?.sendTransactionResponse?.hash ??
    sent?.getTransactionResponse?.txHash ??
    sent?.hash ??
    undefined
  );
}

export default function App() {
  const [wallet, setWallet] = useState("");
  const [network, setNetwork] = useState("");
  const [match, setMatch] = useState<Match | null>(null);
  const [tx, setTx] = useState<Tx>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  // create form
  const [createMonster, setCreateMonster] = useState<number | null>(null);
  const [stake, setStake] = useState("10");
  // join form
  const [joinId, setJoinId] = useState("");
  const [joinMonster, setJoinMonster] = useState<number | null>(null);

  const onTestnet = network.toUpperCase() === "TESTNET";

  // ---- wallet ----
  async function connect() {
    setTx({ kind: "pending", msg: "Reading active Freighter account…" });
    try {
      // Prefer the account currently *active* in Freighter (so "switch" picks up
      // an in-extension account change); fall back to requesting access first.
      let addr: string;
      try {
        addr = await getActiveAddress();
      } catch {
        addr = await connectFreighter();
      }
      setWallet(addr);
      setNetwork(await getNetworkName());
      if (match) await loadMatch(match.id); // refresh state for the new account
      setTx({ kind: "success", msg: `Active account: ${shorten(addr, 5, 5)}` });
    } catch (e) {
      setTx({ kind: "error", msg: friendlyError(e) });
    }
  }
  function disconnect() {
    setWallet("");
    setMatch(null);
    setNetwork("");
    setTx({ kind: "idle" });
  }

  // ---- contract helpers ----
  async function loadMatch(id: number) {
    const client = createContractClient(wallet);
    const res = await client.get_match({ match_id: id });
    setMatch(unwrap<Match>(res.result));
  }

  async function doCreate() {
    if (createMonster === null) return setTx({ kind: "error", msg: "Pick your monster first." });
    const xlm = Number(stake);
    if (!xlm || xlm <= 0) return setTx({ kind: "error", msg: "Enter a stake greater than 0." });
    setBusy(true);
    try {
      setTx({ kind: "pending", msg: "Sealing your secret pick…" });
      const secret = generateSecret();
      const commit1 = await computeCommit(createMonster, secret);
      const client = createContractClient(wallet);
      const assembled = await client.create_match({
        player1: wallet,
        stake: xlmToStroops(xlm),
        commit1,
      });
      setTx({ kind: "pending", msg: "Confirm the stake in Freighter…" });
      const sent: any = await assembled.signAndSend();
      const newId = unwrap<number>(sent.result);
      savePick(newId, wallet, createMonster, secret);
      setTx({ kind: "success", msg: `Duel #${newId} created — share the ID with your rival.`, hash: extractHash(sent) });
      await loadMatch(newId);
    } catch (e) {
      setTx({ kind: "error", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function loadById() {
    const id = Number(joinId);
    if (!Number.isInteger(id) || id <= 0) return setTx({ kind: "error", msg: "Enter a valid Match ID." });
    setBusy(true);
    try {
      setTx({ kind: "pending", msg: `Loading duel #${id}…` });
      await loadMatch(id);
      setTx({ kind: "idle" });
    } catch (e) {
      setTx({ kind: "error", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doJoin() {
    if (!match) return;
    if (joinMonster === null) return setTx({ kind: "error", msg: "Pick your monster first." });
    setBusy(true);
    try {
      setTx({ kind: "pending", msg: "Sealing your secret pick…" });
      const secret = generateSecret();
      const commit2 = await computeCommit(joinMonster, secret);
      const client = createContractClient(wallet);
      const assembled = await client.join_match({
        match_id: match.id,
        player2: wallet,
        commit2,
      });
      setTx({ kind: "pending", msg: "Confirm the stake in Freighter…" });
      const sent: any = await assembled.signAndSend();
      savePick(match.id, wallet, joinMonster, secret);
      setTx({ kind: "success", msg: "You're in! Both fighters have committed.", hash: extractHash(sent) });
      await loadMatch(match.id);
    } catch (e) {
      setTx({ kind: "error", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doReveal() {
    if (!match) return;
    const pick = loadPick(match.id, wallet);
    if (!pick) return setTx({ kind: "error", msg: "No saved pick for this wallet on this device. Reveal must run where you committed." });
    setBusy(true);
    try {
      setTx({ kind: "pending", msg: "Revealing your monster…" });
      const client = createContractClient(wallet);
      const assembled = await client.reveal({
        match_id: match.id,
        player: wallet,
        monster: pick.monster,
        secret: Buffer.from(pick.secret),
      });
      setTx({ kind: "pending", msg: "Confirm in Freighter…" });
      const sent: any = await assembled.signAndSend();
      setTx({ kind: "success", msg: "Revealed! If both sides are in, the winner is paid automatically.", hash: extractHash(sent) });
      await loadMatch(match.id);
    } catch (e) {
      setTx({ kind: "error", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doClaimTimeout() {
    if (!match) return;
    setBusy(true);
    try {
      setTx({ kind: "pending", msg: "Claiming timeout…" });
      const client = createContractClient(wallet);
      const assembled = await client.claim_timeout({ match_id: match.id });
      setTx({ kind: "pending", msg: "Confirm in Freighter…" });
      const sent: any = await assembled.signAndSend();
      setTx({ kind: "success", msg: "Timeout settled — funds released.", hash: extractHash(sent) });
      await loadMatch(match.id);
    } catch (e) {
      setTx({ kind: "error", msg: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  // ---- derived ----
  const statusVal = match ? Number(match.status) : -1;
  const role = match ? (wallet === match.player1 ? 1 : wallet === match.player2 ? 2 : 0) : 0;
  const myRevealed = match ? (role === 1 ? match.monster1 != null : role === 2 ? match.monster2 != null : false) : false;
  const canJoin = !!match && statusVal === Status.Waiting && role === 0 && match.player2 == null;
  const canReveal = !!match && statusVal === Status.Committed && role !== 0 && !myRevealed && !!loadPick(match.id, wallet);
  const iWon = !!match && match.winner === wallet;

  return (
    <div className="arena-grid min-h-svh">
      {/* ---- header ---- */}
      <header className="sticky top-0 z-20 border-b border-line/70 bg-arena/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚔️</span>
            <span className="font-display text-lg font-700 tracking-tight">
              MONSTER<span className="text-gold">DUEL</span>
            </span>
          </div>
          {wallet ? (
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 font-mono text-xs ${onTestnet ? "bg-grass/15 text-grass" : "bg-fire/15 text-fire"}`}>
                {network || "—"}
              </span>
              <span className="hidden rounded-lg border border-line bg-panel px-2.5 py-1 font-mono text-xs text-muted sm:block" title={wallet}>
                {shorten(wallet, 5, 5)}
              </span>
              <button onClick={connect} className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink" title="Re-read the active Freighter account">
                switch
              </button>
              <button onClick={disconnect} className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition hover:text-ink">
                exit
              </button>
            </div>
          ) : (
            <button onClick={connect} className="rounded-xl bg-gold px-4 py-2 text-sm font-600 text-arena transition hover:brightness-110">
              Connect Freighter
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-24 pt-8">
        {/* ---- tx banner ---- */}
        {tx.kind !== "idle" && (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
              tx.kind === "success"
                ? "border-grass/40 bg-grass/10 text-grass"
                : tx.kind === "error"
                  ? "border-fire/40 bg-fire/10 text-fire"
                  : "border-gold/40 bg-gold/10 text-gold"
            }`}>
            <div className="flex items-center gap-2">
              {tx.kind === "pending" && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              <span>{tx.msg}</span>
            </div>
            {tx.kind === "success" && tx.hash && (
              <a href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer" className="mt-1 block font-mono text-xs underline opacity-90">
                view tx {shorten(tx.hash, 8, 8)} ↗
              </a>
            )}
          </div>
        )}

        {!onTestnet && wallet && (
          <p className="mb-6 rounded-xl border border-fire/40 bg-fire/10 px-4 py-3 text-sm text-fire">
            Freighter isn't on Testnet. Switch the network to <b>Testnet</b> in the extension.
          </p>
        )}

        {/* ---- not connected ---- */}
        {!wallet && <Hero onConnect={connect} />}

        {/* ---- lobby ---- */}
        {wallet && !match && (
          <div className="grid gap-5 md:grid-cols-2">
            {/* create */}
            <section className="rounded-2xl border border-line bg-panel/70 p-5">
              <h2 className="font-display text-base font-700">Open a duel</h2>
              <p className="mt-1 text-sm text-muted">Pick a fighter, set the stake. Your choice is sealed until reveal.</p>
              <MonsterPicker selected={createMonster} onSelect={setCreateMonster} disabled={busy} />
              <label className="mt-4 block text-xs text-muted">Stake (XLM)</label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-lg border border-line bg-arena-2 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-gold"
              />
              <button
                onClick={doCreate}
                disabled={busy || createMonster === null}
                className="mt-4 w-full rounded-xl bg-gold py-2.5 text-sm font-700 text-arena transition hover:brightness-110 disabled:opacity-40">
                {busy ? "Working…" : "Create duel"}
              </button>
            </section>

            {/* join */}
            <section className="rounded-2xl border border-line bg-panel/70 p-5">
              <h2 className="font-display text-base font-700">Join a duel</h2>
              <p className="mt-1 text-sm text-muted">Got a Match ID from a rival? Load it and pick your counter.</p>
              <label className="mt-4 block text-xs text-muted">Match ID</label>
              <div className="mt-1 flex gap-2">
                <input
                  type="number"
                  min="1"
                  value={joinId}
                  onChange={(e) => setJoinId(e.target.value)}
                  disabled={busy}
                  placeholder="e.g. 7"
                  className="w-full rounded-lg border border-line bg-arena-2 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-gold"
                />
                <button onClick={loadById} disabled={busy} className="rounded-lg border border-line px-4 text-sm text-ink transition hover:border-gold disabled:opacity-40">
                  Load
                </button>
              </div>
              <p className="mt-4 text-xs text-muted">
                Playing both sides on one device? Create a duel, then click <b className="text-ink">switch</b> to load your other Freighter account and join.
              </p>
            </section>
          </div>
        )}

        {/* ---- arena ---- */}
        {wallet && match && (
          <Arena
            match={match}
            role={role}
            statusVal={statusVal}
            canJoin={canJoin}
            canReveal={canReveal}
            iWon={iWon}
            busy={busy}
            joinMonster={joinMonster}
            setJoinMonster={setJoinMonster}
            onJoin={doJoin}
            onReveal={doReveal}
            onTimeout={doClaimTimeout}
            onRefresh={() => loadMatch(match.id)}
            onBack={() => {
              setMatch(null);
              setTx({ kind: "idle" });
            }}
          />
        )}
      </main>

      <footer className="border-t border-line/70 py-6 text-center">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 px-4">
          <TypeWheel />
          <a href={`${EXPLORER}/contract/${CONTRACT_ID}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted underline">
            contract {shorten(CONTRACT_ID, 6, 6)} ↗
          </a>
          <p className="text-xs text-muted">Trustless 1v1 on Stellar Testnet · escrow + commit-reveal</p>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Hero({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="rounded-3xl border border-line bg-panel/60 p-8 text-center">
      <div className="mb-4 flex justify-center gap-3 text-5xl">
        <span className="clash" style={{ ["--clash" as any]: "5px", ["--clash-rot" as any]: "-3deg" }}>🔥</span>
        <span className="text-2xl self-center text-muted">vs</span>
        <span className="clash" style={{ ["--clash" as any]: "-5px", ["--clash-rot" as any]: "3deg" }}>🌿</span>
      </div>
      <h1 className="font-display text-3xl font-700 tracking-tight sm:text-4xl">
        Stake. Pick. <span className="text-gold">Duel.</span>
      </h1>
      <p className="mx-auto mt-3 max-w-md text-sm text-muted">
        Two fighters lock a wager, secretly choose a monster, and the contract crowns the winner — no referee, no peeking, no cheating.
      </p>
      <button onClick={onConnect} className="mt-6 rounded-xl bg-gold px-6 py-3 text-sm font-700 text-arena transition hover:brightness-110">
        Connect Freighter to enter
      </button>
    </section>
  );
}

function MonsterPicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: number | null;
  onSelect: (id: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 grid grid-cols-3 gap-2">
      {MONSTERS.map((m) => {
        const active = selected === m.id;
        return (
          <button
            key={m.id}
            onClick={() => onSelect(m.id)}
            disabled={disabled}
            className={`flex flex-col items-center gap-1 rounded-xl border p-3 transition disabled:opacity-50 ${
              active ? "border-transparent" : "border-line bg-arena-2 hover:border-muted"
            }`}
            style={active ? { borderColor: m.accent, background: `${m.accent}1a` } : undefined}>
            <span className="text-2xl">{m.emoji}</span>
            <span className="text-sm font-600" style={{ color: active ? m.accent : undefined }}>
              {m.name}
            </span>
            <span className="text-[10px] text-muted">beats {m.beats}</span>
          </button>
        );
      })}
    </div>
  );
}

function Plate({ monster, hidden, label, you }: { monster?: Monster; hidden?: boolean; label: string; you?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center">
      <div
        className="flex h-28 w-28 items-center justify-center rounded-2xl border text-5xl"
        style={{
          borderColor: monster ? monster.accent : "var(--color-line)",
          background: monster ? `${monster.accent}1a` : "var(--color-arena-2)",
        }}>
        {hidden ? <span className="text-3xl text-muted">❔</span> : monster ? monster.emoji : <span className="text-2xl text-muted">…</span>}
      </div>
      <p className="mt-2 text-sm font-600">{monster ? monster.name : hidden ? "Sealed" : "Empty"}</p>
      <p className="text-[11px] text-muted">{label}{you ? " · you" : ""}</p>
    </div>
  );
}

function Arena({
  match,
  role,
  statusVal,
  canJoin,
  canReveal,
  iWon,
  busy,
  joinMonster,
  setJoinMonster,
  onJoin,
  onReveal,
  onTimeout,
  onRefresh,
  onBack,
}: {
  match: Match;
  role: number;
  statusVal: number;
  canJoin: boolean;
  canReveal: boolean;
  iWon: boolean;
  busy: boolean;
  joinMonster: number | null;
  setJoinMonster: (id: number) => void;
  onJoin: () => void;
  onReveal: () => void;
  onTimeout: () => void;
  onRefresh: () => void;
  onBack: () => void;
}) {
  const m1 = monsterById(match.monster1);
  const m2 = monsterById(match.monster2);
  const pot = stroopsToXlm(match.stake) * 2;
  const resolved = statusVal === Status.Resolved;
  const refunded = statusVal === Status.Refunded;
  const committed = statusVal === Status.Committed;

  const statusLabel =
    statusVal === Status.Waiting
      ? "Waiting for an opponent"
      : committed
        ? "Both committed — reveal time"
        : resolved
          ? "Resolved"
          : "Refunded";

  return (
    <section className="rounded-2xl border border-line bg-panel/70 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-xs text-muted hover:text-ink">← lobby</button>
          <span className="font-mono text-sm">Duel #{match.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-arena-2 px-2.5 py-1 text-xs text-muted">{statusLabel}</span>
          <button onClick={onRefresh} disabled={busy} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-40" title="Refresh from chain">↻</button>
        </div>
      </div>

      {/* VS arena */}
      <div className="flex items-stretch gap-3 rounded-2xl border border-line bg-arena-2/60 p-5">
        <Plate monster={m1} hidden={committed && !m1} label="Player 1" you={role === 1} />
        <div className="flex flex-col items-center justify-center">
          <div className={`flex h-14 w-14 items-center justify-center rounded-full border border-gold/50 bg-gold/10 font-mono text-sm font-700 text-gold ${resolved ? "" : "pulse-gold"}`}>
            VS
          </div>
          <p className="mt-2 font-mono text-xs text-gold">{pot} XLM</p>
          <p className="text-[10px] text-muted">pot</p>
        </div>
        <Plate monster={m2} hidden={committed && !m2} label="Player 2" you={role === 2} />
      </div>

      {/* contextual action */}
      <div className="mt-5">
        {canJoin && (
          <div>
            <p className="mb-2 text-sm text-muted">
              Match the stake of <span className="font-mono text-ink">{stroopsToXlm(match.stake)} XLM</span> and pick your counter:
            </p>
            <MonsterPicker selected={joinMonster} onSelect={setJoinMonster} disabled={busy} />
            <button onClick={onJoin} disabled={busy || joinMonster === null} className="mt-4 w-full rounded-xl bg-gold py-2.5 text-sm font-700 text-arena transition hover:brightness-110 disabled:opacity-40">
              {busy ? "Working…" : `Join & stake ${stroopsToXlm(match.stake)} XLM`}
            </button>
          </div>
        )}

        {canReveal && (
          <button onClick={onReveal} disabled={busy} className="w-full rounded-xl bg-gold py-2.5 text-sm font-700 text-arena transition hover:brightness-110 disabled:opacity-40">
            {busy ? "Working…" : "Reveal my monster"}
          </button>
        )}

        {committed && role !== 0 && !canReveal && (
          <p className="rounded-xl border border-line bg-arena-2 px-4 py-3 text-center text-sm text-muted">
            {(role === 1 ? match.monster1 : match.monster2) != null
              ? "You've revealed — waiting for your opponent."
              : "No saved pick on this device for this account — reveal must run where you committed."}
          </p>
        )}

        {statusVal === Status.Waiting && role === 1 && (
          <p className="rounded-xl border border-line bg-arena-2 px-4 py-3 text-center text-sm text-muted">
            Share <span className="font-mono text-ink">Match ID #{match.id}</span> with your rival. They join from any device.
          </p>
        )}

        {resolved && (
          <div className="rounded-xl border border-gold/40 bg-gold/10 p-5 text-center">
            <p className="font-display text-xl font-700 text-gold">
              {role === 0 ? "Duel resolved" : iWon ? "🏆 You won!" : "Defeated"}
            </p>
            <p className="mt-1 text-sm text-muted">
              Winner <span className="font-mono text-ink">{shorten(match.winner ?? "", 5, 5)}</span> took <span className="text-gold">{pot} XLM</span> (minus house fee).
            </p>
          </div>
        )}

        {refunded && (
          <p className="rounded-xl border border-line bg-arena-2 px-4 py-3 text-center text-sm text-muted">Stakes were refunded.</p>
        )}

        {/* timeout escape hatch */}
        {(statusVal === Status.Waiting || committed) && role !== 0 && (
          <button onClick={onTimeout} disabled={busy} className="mt-3 w-full rounded-xl border border-line py-2 text-xs text-muted transition hover:text-ink disabled:opacity-40">
            Claim timeout (if your opponent stalls past the deadline)
          </button>
        )}
      </div>
    </section>
  );
}

function TypeWheel() {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
      <span className="text-fire">Fire</span><span>▸</span>
      <span className="text-grass">Grass</span><span>▸</span>
      <span className="text-water">Water</span><span>▸</span>
      <span className="text-fire">Fire</span>
    </div>
  );
}
