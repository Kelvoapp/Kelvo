import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  PONS_FACTORY,
  SALT_PREFIX,
  decodeLaunchCall,
  isContractAddress,
  type DecodedLaunch,
  type LaunchIndex,
  type VerifiedLaunch,
} from "../src/launch/pons.js";
import { intentReady, verifyIntentSalt, verifyReceipt } from "./launch.js";
import {
  LaunchError,
  Reader,
  amount,
  object,
  sameAddress,
  uintHex,
} from "./source.js";

/**
 * Launch index: Pons V2 TokenLaunched logs, newest first, kept only when the launch transaction carries a
 * valid Kelvo provenance salt and its receipt verifies in full. One page reads at most 5,000 blocks, inspects
 * at most 24 launch transactions and returns at most 2 new launches; `coverage.nextBefore` continues the scan.
 * The first page also merges launches this server instance has already verified (receipt checks and earlier
 * scans). That memory is per instance and not durable; dedupe by `token` when appending pages.
 */

// Floor for the backward scan when KELVO_LAUNCH_START_BLOCK is unset: a Robinhood Chain block read on
// 2026-10-02, before Kelvo had an intent secret anywhere, so no Kelvo launch can be older than it.
export const DEFAULT_LAUNCH_START_BLOCK = 78_750_000n;
const PAGE_BLOCKS = 5_000n;
const MAX_INSPECTED = 24;
const MAX_NEW_ITEMS = 2;
const MEMORY_LIMIT = 100;
const TOKEN_LAUNCHED = keccak256(
  toHex("TokenLaunched(address,address,address,address,uint256,uint256)"),
);

let memory: VerifiedLaunch[] = [];
const newestFirst = (a: VerifiedLaunch, b: VerifiedLaunch) => {
  const blocks = BigInt(b.blockNumber) - BigInt(a.blockNumber);
  return blocks > 0n ? 1 : blocks < 0n ? -1 : a.hash < b.hash ? -1 : 1;
};
function merge(existing: VerifiedLaunch[], incoming: VerifiedLaunch[]) {
  const byToken = new Map<string, VerifiedLaunch>();
  for (const item of [...existing, ...incoming])
    if (item?.provenanceVerified === true && isContractAddress(item.token))
      byToken.set(item.token.toLowerCase(), item);
  return [...byToken.values()].sort(newestFirst);
}
/** Keep a verified launch in this instance's memory so the first page shows it at once. */
export function rememberLaunch(item: VerifiedLaunch): void {
  memory = merge(memory, [item]).slice(0, MEMORY_LIMIT);
}
export function rememberedLaunches(): VerifiedLaunch[] {
  return [...memory];
}

export function launchStartBlock(): bigint {
  const value = process.env.KELVO_LAUNCH_START_BLOCK;
  return value && /^\d{1,20}$/.test(value)
    ? BigInt(value)
    : DEFAULT_LAUNCH_START_BLOCK;
}

const recent = new Map<string, { result: LaunchIndex; expires: number }>();
const scans = new Map<string, Promise<LaunchIndex>>();
// These stop the index instead of degrading it to a stale or empty page.
const FATAL = new Set(["PROTOCOL_CHANGED", "INTENT_NOT_CONFIGURED"]);

function withMemory(result: LaunchIndex, firstPage: boolean): LaunchIndex {
  if (!firstPage) return result;
  const items = merge(result.items, memory);
  return {
    ...result,
    items,
    status:
      result.status === "unavailable" && items.length ? "cached" : result.status,
  };
}

/** GET launches: one page of the provenance-filtered launch index. `before` is "<block>:<logIndex>". */
export async function listLaunches(before?: unknown): Promise<LaunchIndex> {
  const cursorText = before === undefined || before === null ? "" : before;
  if (
    typeof cursorText !== "string" ||
    cursorText.length > 32 ||
    (cursorText && !/^\d{1,20}:\d{1,10}$/.test(cursorText))
  )
    throw new LaunchError(
      "Provide a valid launch-page cursor.",
      400,
      "INVALID_INPUT",
    );
  if (!intentReady())
    throw new LaunchError(
      "Verified launch registration is not configured yet.",
      503,
      "INTENT_NOT_CONFIGURED",
    );
  const firstPage = !cursorText;
  const cached = recent.get(cursorText);
  if (cached && cached.expires > Date.now())
    return withMemory(
      {
        ...cached.result,
        status:
          cached.result.status === "unavailable" ? "unavailable" : "cached",
      },
      firstPage,
    );
  const running = scans.get(cursorText);
  if (running) return withMemory(await running, firstPage);
  if (scans.size >= 2)
    throw new LaunchError(
      "Recent launch discovery is busy. Try again shortly.",
      429,
      "RATE_LIMITED",
    );
  const task = scan(cursorText, cached?.result);
  scans.set(cursorText, task);
  try {
    return withMemory(await task, firstPage);
  } finally {
    scans.delete(cursorText);
  }
}

async function scan(
  before: string,
  previous: LaunchIndex | undefined,
): Promise<LaunchIndex> {
  let result: LaunchIndex;
  try {
    const reader = new Reader("scan");
    const { block: current } = await reader.verifiedBlock();
    const cursor = before ? before.split(":").map(BigInt) : null;
    const latest = BigInt(current) > 0n ? BigInt(current) - 1n : 0n;
    const to = cursor && cursor[0] < latest ? cursor[0] : latest;
    const floor = launchStartBlock();
    if (floor > latest)
      throw new LaunchError("The launch index start block is ahead of the chain.");
    const from = to > floor + PAGE_BLOCKS - 1n ? to - (PAGE_BLOCKS - 1n) : floor;
    if (to < from)
      return {
        items: [],
        status: "live",
        capturedAt: new Date().toISOString(),
        error: null,
        coverage: {
          fromBlock: floor.toString(),
          toBlock: to.toString(),
          nextBefore: null,
          partial: false,
          scannedTransactions: 0,
        },
      };
    const raw = await reader.rpc("eth_getLogs", [
      {
        address: PONS_FACTORY,
        topics: [TOKEN_LAUNCHED],
        fromBlock: toHex(from),
        toBlock: toHex(to),
      },
    ]);
    if (!Array.isArray(raw))
      throw new LaunchError("The launch event source returned malformed data.");
    const logs = raw
      .map((value) => {
        const row = object(value);
        if (
          !sameAddress(row.address, PONS_FACTORY) ||
          typeof row.transactionHash !== "string" ||
          !/^0x[\da-f]{64}$/i.test(row.transactionHash) ||
          row.removed === true
        )
          throw new LaunchError(
            "The launch event source returned an invalid identity.",
          );
        const block = amount(row.blockNumber),
          index = amount(row.logIndex);
        if (block < from || block > to)
          throw new LaunchError(
            "The launch event source returned a block outside the requested range.",
          );
        return { hash: row.transactionHash.toLowerCase() as Hex, block, index };
      })
      .filter(
        (row) =>
          !cursor ||
          row.block < cursor[0] ||
          (row.block === cursor[0] && row.index < cursor[1]),
      )
      .sort((a, b) =>
        a.block === b.block
          ? a.index === b.index
            ? 0
            : a.index > b.index
              ? -1
              : 1
          : a.block > b.block
            ? -1
            : 1,
      );
    const items: VerifiedLaunch[] = [];
    let inspected = 0,
      partial = false,
      error: string | null = null;
    let nextBefore: string | null = before || `${to}:4294967295`;
    const seen = new Set<string>();
    for (const log of logs) {
      if (
        inspected >= MAX_INSPECTED ||
        items.length >= MAX_NEW_ITEMS ||
        reader.signal.aborted
      ) {
        partial = true;
        break;
      }
      if (seen.has(log.hash)) {
        nextBefore = `${log.block}:${log.index}`;
        continue;
      }
      seen.add(log.hash);
      try {
        const transaction = object(
          await reader.rpc("eth_getTransactionByHash", [log.hash]),
        );
        inspected++;
        if (
          !isContractAddress(transaction.from) ||
          !isContractAddress(transaction.to) ||
          amount(transaction.blockNumber) !== log.block
        )
          throw new LaunchError(
            "A launch transaction is not yet available for this event.",
          );
        let call: DecodedLaunch | null = null;
        try {
          call = decodeLaunchCall(
            transaction.to,
            uintHex(transaction.input),
            transaction.from,
          );
        } catch {
          /* Other launch frontends and wrappers are outside this index. */
        }
        if (
          call &&
          call.params.salt.toLowerCase().startsWith(`0x${SALT_PREFIX}`) &&
          verifyIntentSalt(transaction.from as Address, call)
        ) {
          const verified = await verifyReceipt(log.hash, reader, current);
          items.push(verified);
          rememberLaunch(verified);
        }
        nextBefore = `${log.block}:${log.index}`;
      } catch (failure) {
        if (failure instanceof LaunchError && FATAL.has(failure.code))
          throw failure;
        partial = true;
        error =
          "Some transactions could not be verified in this capture. Continue or refresh the scan.";
        break;
      }
    }
    if (!partial) nextBefore = from > floor ? `${from}:0` : null;
    result = {
      items,
      status: "live",
      capturedAt: new Date().toISOString(),
      error:
        error ??
        (partial ? "This bounded capture has more transactions to inspect." : null),
      coverage: {
        fromBlock: from.toString(),
        toBlock: to.toString(),
        nextBefore,
        partial,
        scannedTransactions: inspected,
      },
    };
  } catch (failure) {
    if (failure instanceof LaunchError && FATAL.has(failure.code)) throw failure;
    const message =
      failure instanceof LaunchError
        ? failure.message
        : "The launch source is unavailable.";
    result =
      previous?.capturedAt &&
      Date.now() - Date.parse(previous.capturedAt) < 300_000
        ? {
            ...previous,
            status: "cached",
            error: message,
            coverage: { ...previous.coverage, partial: true },
          }
        : {
            items: [],
            capturedAt: null,
            status: "unavailable",
            error: message,
            coverage: {
              fromBlock: null,
              toBlock: null,
              nextBefore: null,
              partial: true,
              scannedTransactions: 0,
            },
          };
  }
  if (recent.size >= 8) recent.delete(recent.keys().next().value!);
  recent.set(before, { result, expires: Date.now() + 30_000 });
  return result;
}
