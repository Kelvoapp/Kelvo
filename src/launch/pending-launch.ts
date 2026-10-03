import type { Hex } from "viem";

// The browser's own record of launch transactions it submitted. Wallet activity stays the authority;
// this only blocks a second launch while one is waiting and remembers the last 50 hashes.
const key = "kelvo.pending-launch.v1";
const historyKey = "kelvo.launch-transactions.v1";
export const pendingEvent = "kelvo:pending-launch";
export type LaunchHashStatus =
  | "submitted"
  | "confirmed"
  | "reverted"
  | "unverified"
  | "dropped";
export type LaunchHistoryItem = {
  hash: Hex;
  status: LaunchHashStatus;
  updatedAt: string;
};
const HASH = /^0x[\da-f]{64}$/i;
const STATUSES = new Set<LaunchHashStatus>([
  "submitted",
  "confirmed",
  "reverted",
  "unverified",
  "dropped",
]);
let memory: Hex | null = null;

const announce = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(pendingEvent));
};

export function readPendingLaunch(): Hex | null {
  try {
    const hash = localStorage.getItem(key);
    if (hash && HASH.test(hash)) return hash.toLowerCase() as Hex;
  } catch {
    /* In-memory status survives route changes when storage is blocked. */
  }
  return memory;
}
export function readLaunchHistory(): LaunchHistoryItem[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(historyKey) || "[]");
    return Array.isArray(stored)
      ? stored.filter(
          (item): item is LaunchHistoryItem =>
            item &&
            typeof item.hash === "string" &&
            HASH.test(item.hash) &&
            STATUSES.has(item.status) &&
            typeof item.updatedAt === "string",
        )
      : [];
  } catch {
    return [];
  }
}
export function recordLaunchHash(hash: Hex, status: LaunchHashStatus) {
  if (!HASH.test(hash) || !STATUSES.has(status))
    throw new Error("Invalid launch hash.");
  const normalized = hash.toLowerCase() as Hex;
  try {
    const items = readLaunchHistory().filter(
      (item) => item.hash.toLowerCase() !== normalized,
    );
    localStorage.setItem(
      historyKey,
      JSON.stringify(
        [
          { hash: normalized, status, updatedAt: new Date().toISOString() },
          ...items,
        ].slice(0, 50),
      ),
    );
  } catch {
    /* Wallet activity is the authoritative transaction history. */
  }
  if (status === "submitted") {
    memory = normalized;
    try {
      localStorage.setItem(key, normalized);
    } catch {
      /* Keep the memory copy. */
    }
  } else if (readPendingLaunch() === normalized) {
    memory = null;
    try {
      localStorage.removeItem(key);
    } catch {
      /* The visible receipt still reports the result. */
    }
  }
  announce();
}
/** Release the launch lock for a transaction the wallet dropped or replaced (an explicit user action). */
export function clearPendingLaunch() {
  const hash = readPendingLaunch();
  if (hash) recordLaunchHash(hash, "dropped");
}
