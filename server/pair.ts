import type { Address } from "viem";
import {
  LAUNCH_LIMITS,
  NATIVE_QUOTE,
  PONS_FACTORY,
  ponsFactoryAbi,
  ponsReadAbi,
  type PairCheck,
} from "../src/launch/pons.js";
import { LaunchError, Reader, address, budget } from "./source.js";

/**
 * Pair check: is a quote asset approved for Pons V2 launches, and with which curve economics. Native ETH
 * (the zero address) reads launch configuration 0; any other token reads the factory's approved-pair list
 * and must report the same decimals live as its recorded launch terms. Code hashes and wiring are checked
 * first on every uncached read. Results are cached for 30 seconds per address.
 */
const checks = new Map<string, { result: PairCheck; expires: number }>();
const pending = new Map<string, Promise<PairCheck>>();

export async function getPair(input: unknown): Promise<PairCheck> {
  const contract = address(input, true);
  if (!contract)
    throw new LaunchError(
      "Enter a valid 20-byte quote asset contract.",
      400,
      "INVALID_INPUT",
    );
  const cached = checks.get(contract);
  if (cached && cached.expires > Date.now())
    return { ...cached.result, status: "cached" };
  const running = pending.get(contract);
  if (running) return running;
  const task = (async (): Promise<PairCheck> => {
    budget("pair", "Pair checks are cooling down. Try again in one minute.");
    const reader = new Reader();
    const { block } = await reader.verifiedBlock();
    const read = <T>(name: string, args: readonly unknown[] = []) =>
      reader.read<T>(PONS_FACTORY, ponsFactoryAbi, name, args, block);
    let approved: boolean;
    let economics: PairCheck["economics"] = null;
    if (contract === NATIVE_QUOTE) {
      const count = await read<bigint>("launchConfigCount");
      if (count < 1n || count > 32n)
        throw new LaunchError(
          "The launch configuration list requires a new protocol review.",
          503,
          "PROTOCOL_CHANGED",
        );
      const config = await read<{
        phantomQuote: bigint;
        graduationThreshold: bigint;
        enabled: boolean;
      }>("getLaunchConfig", [0n]);
      approved = config.enabled;
      economics = {
        phantomQuote: config.phantomQuote.toString(),
        graduationThreshold: config.graduationThreshold.toString(),
        decimals: 18,
      };
    } else {
      approved = (await read<boolean>("approvedPairTokens", [contract])) === true;
      if (approved) {
        const [terms, tokenDecimals] = await Promise.all([
          read<readonly [bigint, bigint, number]>("pairTokenEconomics", [
            contract,
          ]),
          reader.read<number>(
            contract as Address,
            ponsReadAbi,
            "decimals",
            [],
            block,
          ),
        ]);
        const [phantomQuote, graduationThreshold, pairDecimals] = terms;
        if (tokenDecimals !== pairDecimals)
          throw new LaunchError(
            "The quote asset decimals no longer match its launch terms.",
            422,
            "PAIR_CHANGED",
          );
        economics = {
          phantomQuote: phantomQuote.toString(),
          graduationThreshold: graduationThreshold.toString(),
          decimals: pairDecimals,
        };
      }
    }
    if (
      approved &&
      (!economics ||
        BigInt(economics.phantomQuote) <= 0n ||
        BigInt(economics.graduationThreshold) <= 0n ||
        economics.decimals < 0 ||
        economics.decimals > LAUNCH_LIMITS.pairDecimals)
    )
      throw new LaunchError(
        "The quote asset has unusable launch economics.",
        422,
        "PAIR_UNAVAILABLE",
      );
    const result: PairCheck = {
      address: contract,
      approval: approved ? "approved" : "rejected",
      status: "live",
      checkedAt: new Date().toISOString(),
      blockNumber: BigInt(block).toString(),
      economics: approved ? economics : null,
      error: approved
        ? null
        : "This quote asset is not currently enabled for launches.",
    };
    if (checks.size >= 64) checks.delete(checks.keys().next().value!);
    checks.set(contract, { result, expires: Date.now() + 30_000 });
    return result;
  })();
  pending.set(contract, task);
  try {
    return await task;
  } finally {
    pending.delete(contract);
  }
}
