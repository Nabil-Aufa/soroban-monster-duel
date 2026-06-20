# 🐉 Monster Duel — Trustless 1v1 Staking Battles on Stellar (Soroban)

> A provably-fair, on-chain monster battle game where two players stake tokens,
> secretly pick a monster, and the **smart contract itself** decides the winner
> and pays out the pot — no referee, no house that can cheat, no way to peek at
> your opponent's choice.

Built for **Build On Stellar Bootcamp — Yogyakarta** and submitted to the
**Monthly Builder Challenges (MAD Program)**.

---

## 🌟 Why this is different

Most beginner contracts are just "a database on a blockchain" (store a note,
read a note). Monster Duel is **payment-native**: the entire point of the
contract is to *move real value between wallets according to rules nobody can
break*. That is the thing Stellar does best — fast (2–5s) and almost free
(~$0.00001 per tx) — and the thing a Web2 backend simply cannot do without a
trusted bank in the middle.

**The mental model:** the smart contract is **not** the game engine. It is the
**bank + referee**. The flashy battle animation lives in the frontend; the
contract only guarantees the money is escrowed fairly and paid to the rightful
winner.

---

## 🎮 How the game works

### The monsters (rock–paper–scissors typing)

| Monster   | Type  | Beats   |
| --------- | ----- | ------- |
| 🔥 Embara | Fire  | Grass   |
| 💧 Aquos  | Water | Fire    |
| 🌿 Verda  | Grass | Water   |

Your strategy is to guess what your opponent will pick and counter it.

### The flow of a duel

```
create_match  →  WAITING    Player 1 stakes + submits a hidden commitment
join_match    →  COMMITTED  Player 2 matches the stake + their own commitment
reveal (x2)   →  RESOLVED   Both choices are revealed & verified, winner paid
```

### Fairness: commit–reveal

If your opponent could see your monster first, they would always win. To stop
this, each player first submits only a **fingerprint** of their choice:

```
commit = sha256(monster_id || secret)
```

The actual monster stays hidden. Later, both players **reveal** their monster +
secret, and the contract checks the fingerprint matches. Nobody can copy, and
nobody can change their pick after seeing the opponent.

### Fairness: deterministic, un-riggable outcome

When both players reveal, the contract computes:

```
power = BASE (50) + TYPE_BONUS (+30 if your type wins) + LUCK (0–19)
```

The **LUCK** value comes from `sha256(secret1 || secret2 || match_id)`, so it
depends on **both** players' secrets — no single player can predict or control
the result. Higher power wins; the whole pot (minus a small house fee) is sent
to the winner automatically.

### Anti-griefing: timeout protection

A dishonest player who realizes they'll lose might refuse to reveal. The
`claim_timeout` function protects against this:

- Nobody joined → the creator is refunded.
- One player revealed, the other ghosted → **the honest player wins the pot**.
- Neither revealed → both stakes are refunded.

---

## 🔧 Contract interface

| Function                                  | Description                                       |
| ----------------------------------------- | ------------------------------------------------- |
| `initialize(token, admin, fee_bps)`       | One-time setup: stake token, fee receiver, fee %. |
| `create_match(player1, stake, commit1)`   | Open a duel and escrow player 1's stake.          |
| `join_match(match_id, player2, commit2)`  | Join a duel and escrow player 2's stake.          |
| `reveal(match_id, player, monster, secret)`| Reveal your pick; auto-resolves when both do.     |
| `claim_timeout(match_id)`                 | Rescue funds if an opponent stalls.               |
| `get_match(match_id)`                     | Read a duel's current state (for the frontend).   |
| `get_config()`                            | Read the global configuration.                    |

---

## 🚀 Deployed contract (Stellar Testnet)

| Item              | Value                                  |
| ----------------- | -------------------------------------- |
| **Network**       | Stellar Testnet                        |
| **Contract ID**   | `CCRZGZLNJR4B2NQAR6EAAY3XPK5XNKDPLJYX55ZIB4AAEVIVN4DDS7TA` |
| **Stake token**   | Native XLM (Stellar Asset Contract)    |
| **Explorer**      | https://stellar.expert/explorer/testnet/contract/CCRZGZLNJR4B2NQAR6EAAY3XPK5XNKDPLJYX55ZIB4AAEVIVN4DDS7TA |

---

## 🛠️ Build & deploy (Online Soroban Studio)

This project was built and deployed entirely in a **browser-based Soroban IDE**
(e.g. Okashi, Stellar Lab, or the Soroban Playground) — no local toolchain
required. The exact buttons differ per studio, but the flow is the same:

### 1. Add the code

Create a contract project in the studio and paste in:
- `contracts/monster-duel/src/lib.rs` — the contract
- `contracts/monster-duel/Cargo.toml` and the workspace `Cargo.toml`

> If the studio pins a different `soroban-sdk` version, match it in `Cargo.toml`.

### 2. Build

Use the studio's **Build / Compile** action to produce the contract WASM.

### 3. Run the tests (if supported)

If the studio exposes a **Test** action, run it — all unit tests in
`src/test.rs` should pass (happy path, timeouts, and anti-cheat checks).

### 4. Connect a testnet wallet

Connect a wallet (e.g. **Freighter**) set to **Testnet** and fund it with free
test XLM from <https://friendbot.stellar.org> or the studio's "Fund account"
button.

### 5. Deploy to Testnet

Use the studio's **Deploy** action with the network set to **Testnet**. After
deployment the studio shows your **Contract ID** — copy it into the
*Deployed contract* table above.

### 6. Initialize

Call `initialize` once from the studio's contract-invoke panel:

| Argument  | Value                                                              |
| --------- | ----------------------------------------------------------------- |
| `token`   | Native XLM SAC on testnet: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| `admin`   | Your own wallet public key (receives the house fee)               |
| `fee_bps` | `200` (= 2% house fee)                                             |

The contract is now live on testnet and ready to host duels. 🎉

> **Alternative — local Stellar CLI:** if you prefer building locally, the same
> steps map to: `stellar contract build` → `stellar keys generate duelist --fund`
> → `stellar contract deploy --source-account duelist --network testnet` →
> `stellar contract invoke ... -- initialize ...`. Run `cargo test` to test.

---

## ✅ Submission checklist (Bootcamp + MAD Program)

- [x] Smart contract is **different** from the workshop "Notes" example — this is
      a payment-native staking game with escrow and commit–reveal.
- [x] **English README** describing the app, its features, and the contract interface.
- [x] **Testnet Contract ID** filled into the *Deployed contract* table above.
- [x] GitHub repository named to match the app: **`soroban-monster-duel`**.
- [x] Built with **AI assistance**, as allowed by the rules.
- [ ] Submitted **before the workshop ends**.

**MAD Program target — 🟡 Yellow Belt (Level 2):** smart contracts, token
transaction handling, and **real-time event synchronization** via emitted events
(`created`, `joined`, `resolved`, `timeout`) that a frontend can subscribe to.

---

## 🗺️ Roadmap

- [ ] React + Stellar Wallet Kit frontend with an animated battle replay.
- [ ] Best-of-3 team battles (3 monsters per player).
- [ ] On-chain leaderboard and win streaks.
- [ ] NFT monster skins.

---

## 📄 License

MIT
