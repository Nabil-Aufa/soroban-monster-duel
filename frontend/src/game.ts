// Game logic helpers for Monster Duel: monster roster, commit–reveal crypto
// (kept byte-for-byte identical to the Rust contract), per-match secret storage,
// stake conversion, and friendly error mapping.
import { Buffer } from "buffer";

export const STROOPS_PER_XLM = 10_000_000;

export type Element = "Fire" | "Water" | "Grass";

export interface Monster {
  id: number; // matches the contract: 0 = Fire, 1 = Water, 2 = Grass
  name: string;
  element: Element;
  emoji: string;
  beats: Element;
  accent: string; // hex, tied to the theme
}

export const MONSTERS: Monster[] = [
  { id: 0, name: "Embara", element: "Fire", emoji: "🔥", beats: "Grass", accent: "#FF6B3D" },
  { id: 1, name: "Aquos", element: "Water", emoji: "💧", beats: "Fire", accent: "#39A0FF" },
  { id: 2, name: "Verda", element: "Grass", emoji: "🌿", beats: "Water", accent: "#54D072" },
];

export const monsterById = (id?: number | null): Monster | undefined =>
  id == null ? undefined : MONSTERS.find((m) => m.id === id);

/** 32 random bytes used as the commit–reveal salt. */
export function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * commit = sha256( monster_id as u32 big-endian (4 bytes) || secret (32 bytes) ).
 * This MUST match `compute_commit` in the Rust contract exactly.
 */
export async function computeCommit(monster: number, secret: Uint8Array): Promise<Buffer> {
  const monsterBytes = new Uint8Array(4);
  new DataView(monsterBytes.buffer).setUint32(0, monster, false); // big-endian
  const data = new Uint8Array(36);
  data.set(monsterBytes, 0);
  data.set(secret, 4);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(digest));
}

// --- per-match secret storage so reveal needs no manual input ----------------

interface StoredPick {
  monster: number;
  secretHex: string;
}

const keyFor = (matchId: number, address: string) => `md:secret:${matchId}:${address}`;

export function savePick(matchId: number, address: string, monster: number, secret: Uint8Array): void {
  const pick: StoredPick = { monster, secretHex: Buffer.from(secret).toString("hex") };
  localStorage.setItem(keyFor(matchId, address), JSON.stringify(pick));
}

export function loadPick(matchId: number, address: string): { monster: number; secret: Uint8Array } | null {
  const raw = localStorage.getItem(keyFor(matchId, address));
  if (!raw) return null;
  try {
    const { monster, secretHex } = JSON.parse(raw) as StoredPick;
    return { monster, secret: new Uint8Array(Buffer.from(secretHex, "hex")) };
  } catch {
    return null;
  }
}

// --- formatting --------------------------------------------------------------

export const xlmToStroops = (xlm: number): bigint => BigInt(Math.round(xlm * STROOPS_PER_XLM));
export const stroopsToXlm = (stroops: bigint): number => Number(stroops) / STROOPS_PER_XLM;

export function shorten(s: string, head = 4, tail = 4): string {
  if (!s) return "";
  return s.length <= head + tail ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Map raw wallet / RPC errors into the three required, human-readable categories. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const low = msg.toLowerCase();
  if (low.includes("not installed") || low.includes("not found") || low.includes("could not be found"))
    return "Wallet not found — install Freighter and set it to Testnet.";
  if (low.includes("declined") || low.includes("rejected") || low.includes("denied") || low.includes("user reject"))
    return "Transaction rejected in your wallet.";
  if (low.includes("insufficient") || low.includes("underfunded") || low.includes("txinsufficientbalance") || low.includes("balance"))
    return "Insufficient balance for this stake plus network fees.";
  return msg;
}
