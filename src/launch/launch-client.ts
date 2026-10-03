import { encodeFunctionData, type Address, type Hex } from "viem";
import { sendTransaction } from "../wallet.js";
import {
  PONS_CHAIN_ID,
  PONS_ROUTER,
  decimalUint,
  parsePreparedLaunch,
  ponsReadAbi,
  type LaunchIndex,
  type LaunchPolicy,
  type PairCheck,
  type PreparedLaunch,
  type PrepareInput,
  type VerifiedLaunch,
} from "./pons.js";
import { readPendingLaunch, recordLaunchHash } from "./pending-launch.js";

/**
 * Browser client for /api/launch. Reads never touch the wallet. sendApproval and sendLaunch open the wallet
 * through src/wallet.js and must only be called from an explicit user action (a click), never from an effect.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}

async function launchApi<T>(
  action: string,
  query: Record<string, string | number | null | undefined> = {},
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams({ action });
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  const deadline = AbortSignal.timeout(45_000);
  let response: Response;
  try {
    response = await fetch(`/api/launch?${params}`, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(
      "The launch service is unreachable. Check the connection and try again.",
      "NETWORK",
      0,
    );
  }
  const value: any = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      typeof value?.error === "string"
        ? value.error
        : "The request could not be completed.",
      typeof value?.code === "string" ? value.code : "LAUNCH_UNAVAILABLE",
      response.status,
    );
  if (!value || typeof value !== "object")
    throw new ApiError(
      "The launch service returned an invalid response.",
      "LAUNCH_UNAVAILABLE",
      response.status,
    );
  return value as T;
}

/** Live protocol terms (fee, tax cap, curve, balances when an account is given). pairToken defaults to ETH. */
export const fetchLaunchPolicy = (
  query: { pairToken?: string; account?: string | null; configId?: number } = {},
  signal?: AbortSignal,
) => launchApi<LaunchPolicy>("policy", query, undefined, signal);

/** Whether a quote asset is approved for launches and its curve economics. */
export const fetchPairCheck = (address: string, signal?: AbortSignal) =>
  launchApi<PairCheck>("pair", { address }, undefined, signal);

/** One page of verified Kelvo launches; pass coverage.nextBefore to continue. */
export const fetchLaunches = (before?: string | null, signal?: AbortSignal) =>
  launchApi<LaunchIndex>("launches", { before }, undefined, signal);

/** Raw receipt verification; prefer checkLaunchReceipt, which also updates the pending record. */
export const fetchLaunchReceipt = (hash: string, signal?: AbortSignal) =>
  launchApi<VerifiedLaunch>("receipt", { hash }, undefined, signal);

/** Ask the server to prepare and simulate, then re-verify everything locally before returning it. */
export async function prepareCheckedLaunch(
  input: PrepareInput,
  signal?: AbortSignal,
): Promise<PreparedLaunch> {
  const value = await launchApi<unknown>("prepare", {}, input, signal);
  return parsePreparedLaunch(value, input);
}

export type WalletTransaction = {
  from: Address;
  to: Address;
  data: Hex;
  value: string;
  gas?: string;
};

/** approve(router, exact amount) on the quote token. Never an unlimited allowance. */
export function approvalTransaction(prepared: PreparedLaunch): WalletTransaction {
  const approval = prepared.approval;
  if (
    prepared.simulation !== "approval-required" ||
    !approval ||
    approval.spender.toLowerCase() !== PONS_ROUTER.toLowerCase() ||
    !decimalUint(approval.amount) ||
    BigInt(approval.amount) <= 0n ||
    !prepared.policy.account
  )
    throw new Error("No exact quote allowance is requested.");
  return {
    from: prepared.policy.account.toLowerCase() as Address,
    to: approval.token.toLowerCase() as Address,
    data: encodeFunctionData({
      abi: ponsReadAbi,
      functionName: "approve",
      args: [PONS_ROUTER, BigInt(approval.amount)],
    }),
    value: "0",
  };
}

/** The simulated launch transaction exactly as prepared (value and gas as decimal strings). */
export function launchTransaction(prepared: PreparedLaunch): WalletTransaction {
  const tx = prepared.transaction;
  if (prepared.simulation !== "passed" || !tx || tx.chainId !== PONS_CHAIN_ID)
    throw new Error("Review the launch again before signing.");
  return {
    from: tx.account.toLowerCase() as Address,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
  };
}

/** Click handler only. Re-verifies the preparation, then sends the exact approval. Returns the hash. */
export async function sendApproval(
  prepared: PreparedLaunch,
  input: PrepareInput,
): Promise<Hex> {
  const checked = parsePreparedLaunch(prepared, input);
  return (await sendTransaction(approvalTransaction(checked))) as Hex;
}

/**
 * Click handler only. Refuses while another launch is waiting, re-verifies the preparation (it expires after
 * about 90 seconds), sends through the wallet and records the hash as pending. Returns the hash.
 */
export async function sendLaunch(
  prepared: PreparedLaunch,
  input: PrepareInput,
): Promise<Hex> {
  if (readPendingLaunch())
    throw new Error("A launch is still waiting for its receipt.");
  const checked = parsePreparedLaunch(prepared, input);
  const hash = (await sendTransaction(launchTransaction(checked))) as Hex;
  recordLaunchHash(hash, "submitted");
  return hash;
}

export type ReceiptCheck =
  | { state: "confirmed"; launch: VerifiedLaunch }
  | { state: "waiting"; code: string; message: string }
  | { state: "reverted"; code: "REVERTED"; message: string }
  | { state: "unverified"; code: string; message: string };
const TERMINAL = new Set([
  "INVALID_RECEIPT",
  "PROVENANCE_NOT_VERIFIED",
  "UNSUPPORTED_TRANSACTION",
]);

/** One receipt check. Confirmed, reverted and unverified results update the pending record. */
export async function checkLaunchReceipt(
  hash: Hex,
  signal?: AbortSignal,
): Promise<ReceiptCheck> {
  try {
    const launch = await fetchLaunchReceipt(hash, signal);
    if (
      typeof launch.hash !== "string" ||
      launch.hash.toLowerCase() !== hash.toLowerCase() ||
      launch.chainId !== PONS_CHAIN_ID ||
      launch.provenanceVerified !== true
    )
      return {
        state: "waiting",
        code: "LAUNCH_UNAVAILABLE",
        message: "The receipt answer did not match this launch. Checking again.",
      };
    recordLaunchHash(hash, "confirmed");
    return { state: "confirmed", launch };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "REVERTED") {
      recordLaunchHash(hash, "reverted");
      return { state: "reverted", code: "REVERTED", message: error.message };
    }
    if (TERMINAL.has(error.code)) {
      recordLaunchHash(hash, "unverified");
      return { state: "unverified", code: error.code, message: error.message };
    }
    return { state: "waiting", code: error.code, message: error.message };
  }
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Poll the receipt every intervalMs while the tab is visible, at most `attempts` checks. */
export async function pollLaunchReceipt(
  hash: Hex,
  options: {
    signal?: AbortSignal;
    attempts?: number;
    intervalMs?: number;
    onUpdate?: (check: ReceiptCheck) => void;
  } = {},
): Promise<ReceiptCheck> {
  const { signal, attempts = 12, intervalMs = 7_000, onUpdate } = options;
  let last: ReceiptCheck = {
    state: "waiting",
    code: "PENDING",
    message: "Waiting for the launch receipt.",
  };
  for (let checks = 0; checks < attempts; ) {
    await delay(intervalMs, signal);
    if (typeof document !== "undefined" && document.hidden) continue;
    checks++;
    last = await checkLaunchReceipt(hash, signal);
    onUpdate?.(last);
    if (last.state !== "waiting") return last;
  }
  return last;
}
