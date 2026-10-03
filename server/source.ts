import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  PONS_CHAIN_ID,
  PONS_CODE_HASHES,
  PONS_DEPLOYER,
  PONS_FACTORY,
  PONS_MEME_HOOK,
  PONS_ROUTER,
  isContractAddress,
  ponsFactoryAbi,
  ponsRouterAbi,
  type LaunchErrorCode,
} from "../src/launch/pons.js";

// Helpers shared by the launch, pair and launch-index modules: response guards, error type, rate budgets
// and one RPC reader that pins a block only after the chain, the code hashes and the wiring check out.

type Obj = Record<string, unknown>;
export const object = (value: unknown): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
export const address = (value: unknown, native = false): Address | null =>
  typeof value === "string" &&
  /^0x[a-fA-F0-9]{40}$/.test(value) &&
  (native || !/^0x0{40}$/i.test(value))
    ? (value.toLowerCase() as Address)
    : null;
export const sameAddress = (a: unknown, b: string) =>
  isContractAddress(a) && a.toLowerCase() === b.toLowerCase();

export class LaunchError extends Error {
  constructor(
    message: string,
    public status = 503,
    public code: LaunchErrorCode = "LAUNCH_UNAVAILABLE",
  ) {
    super(message);
  }
}

export async function limitedJson(
  response: Response,
  max = 4_000_000,
): Promise<unknown> {
  if (
    !response.headers.get("content-type")?.includes("json") ||
    Number(response.headers.get("content-length") || 0) > max
  )
    throw new Error("The source returned an unsupported response.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The source response was empty.");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new Error("The source response exceeded its size limit.");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

// A dedicated endpoint first when the server has one (its URL carries a token, so it lives only in env),
// the public ones after. Read per call so tests and long-lived instances see the current env.
export const rpcUrls = (): string[] =>
  [
    process.env.ROBINHOOD_RPC_URL,
    "https://rpc.mainnet.chain.robinhood.com",
    "https://evm.privacycash.org/rpc/robinhood",
  ].filter((url): url is string => Boolean(url));

// In-memory budgets per instance: operations per minute and RPC calls per minute.
const LIMITS = {
  launch: 12,
  receipt: 30,
  pair: 24,
  rpc: 320,
  scan: 80,
} as const;
const stamps: Record<keyof typeof LIMITS, number[]> = {
  launch: [],
  receipt: [],
  pair: [],
  rpc: [],
  scan: [],
};
export function budget(kind: keyof typeof LIMITS, message?: string) {
  const now = Date.now();
  stamps[kind] = stamps[kind].filter((time) => time > now - 60_000);
  if (stamps[kind].length >= LIMITS[kind])
    throw new LaunchError(
      message ?? "Launch checks are cooling down. Try again in one minute.",
      429,
      "RATE_LIMITED",
    );
  stamps[kind].push(now);
}

export const uintHex = (value: unknown): Hex => {
  if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value))
    throw new LaunchError("The chain RPC returned malformed data.");
  return value as Hex;
};
export const amount = (value: unknown): bigint => {
  const result = BigInt(uintHex(value));
  if (result >= 1n << 256n)
    throw new LaunchError("The chain RPC returned an invalid amount.");
  return result;
};

const SIMULATIONS = new Set(["eth_call", "eth_estimateGas"]);
// Deterministic answers from the EVM: another endpoint would say the same, so they stop the fallback.
const reverted = (error: unknown) => {
  const e = object(error);
  return (
    e.code === 3 ||
    (typeof e.message === "string" &&
      /revert|insufficient funds|gas required exceeds|out of gas|invalid opcode/i.test(
        e.message,
      ))
  );
};

export type VerifiedBlock = { block: Hex; forwarderReady: boolean };

export class Reader {
  readonly signal = AbortSignal.timeout(35_000);
  private index = 0;
  constructor(private readonly kind: "rpc" | "scan" = "rpc") {}
  async rpc(method: string, params: unknown[]): Promise<unknown> {
    budget(
      this.kind,
      this.kind === "scan"
        ? "Recent launch discovery is cooling down. Try again shortly."
        : "The chain RPC request budget is exhausted. Try again shortly.",
    );
    const urls = rpcUrls();
    let throttled = false;
    for (let attempt = 0; attempt < urls.length; attempt++) {
      if (this.signal.aborted) break;
      const index = (this.index + attempt) % urls.length;
      let response: Response;
      try {
        response = await fetch(urls[index], {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(12_000)]),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      } catch {
        continue;
      }
      if (!response.ok) {
        throttled ||= response.status === 429;
        await response.body?.cancel().catch(() => {});
        continue;
      }
      let body: Obj;
      try {
        body = object(await limitedJson(response, 2_000_000));
      } catch {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (body.jsonrpc !== "2.0" || body.id !== 1) continue;
      if (body.error) {
        if (SIMULATIONS.has(method) && reverted(body.error))
          throw new LaunchError(
            "The contract rejected this check. Verify funds, allowance, launch access and current protocol terms.",
            422,
            "SIMULATION_REJECTED",
          );
        continue;
      }
      if (!("result" in body)) continue;
      this.index = index;
      return body.result;
    }
    if (throttled)
      throw new LaunchError(
        "The chain RPC is rate limiting requests. Try again in a minute.",
        429,
        "RATE_LIMITED",
      );
    throw new LaunchError(
      "The chain RPC is unavailable. No launch has been submitted.",
    );
  }
  async read<T>(
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    block: Hex,
  ): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args });
    const value = await this.rpc("eth_call", [{ to, data }, block]);
    try {
      return decodeFunctionResult({
        abi,
        functionName,
        data: uintHex(value),
      }) as T;
    } catch (error) {
      if (error instanceof LaunchError) throw error;
      throw new LaunchError("The chain RPC returned malformed data.");
    }
  }
  /**
   * Pin one block for the whole request after checking the chain, the runtime code hashes of the factory,
   * router and deployer, and the wiring between them. Nothing else is read before this passes.
   */
  async verifiedBlock(): Promise<VerifiedBlock> {
    if (amount(await this.rpc("eth_chainId", [])) !== BigInt(PONS_CHAIN_ID))
      throw new LaunchError("The RPC returned the wrong chain.");
    const block = uintHex(await this.rpc("eth_blockNumber", []));
    const contracts = [
      ["factory", PONS_FACTORY],
      ["router", PONS_ROUTER],
      ["deployer", PONS_DEPLOYER],
    ] as const;
    const codes = await Promise.all(
      contracts.map(([, contract]) => this.rpc("eth_getCode", [contract, block])),
    );
    contracts.forEach(([key], i) => {
      if (keccak256(uintHex(codes[i])) !== PONS_CODE_HASHES[key])
        throw new LaunchError(
          `The ${key} contract code requires a new protocol review.`,
          503,
          "PROTOCOL_CHANGED",
        );
    });
    const factory = <T>(name: string) =>
      this.read<T>(PONS_FACTORY, ponsFactoryAbi, name, [], block);
    const [deployer, forwarder, hook, routerFactory] = await Promise.all([
      factory<Address>("launchDeployer"),
      factory<Address>("launchForwarder"),
      factory<Address>("memeHook"),
      this.read<Address>(PONS_ROUTER, ponsRouterAbi, "factory", [], block),
    ]);
    if (
      !sameAddress(deployer, PONS_DEPLOYER) ||
      !sameAddress(routerFactory, PONS_FACTORY) ||
      !sameAddress(hook, PONS_MEME_HOOK)
    )
      throw new LaunchError(
        "The protocol wiring requires a new review.",
        503,
        "PROTOCOL_CHANGED",
      );
    return { block, forwarderReady: sameAddress(forwarder, PONS_ROUTER) };
  }
}
