import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  LAUNCH_LIMITS,
  MAX_LAUNCH_GAS,
  NATIVE_QUOTE,
  PONS_CHAIN_ID,
  PONS_FACTORY,
  PONS_MEME_HOOK,
  PONS_ROUTER,
  PREPARE_TTL_MS,
  SALT_PATTERN,
  SALT_PREFIX,
  decodeLaunchCall,
  encodeDecodedLaunch,
  encodeLaunchCall,
  initialBuyUnits,
  isContractAddress,
  launchFingerprint,
  ponsFactoryAbi,
  ponsReadAbi,
  ponsRouterAbi,
  quoteInitialBuy,
  tokenParams,
  validateLaunchRequest,
  type DecodedLaunch,
  type LaunchPolicy,
  type LaunchSocials,
  type PreparedLaunch,
  type PrepareInput,
  type VerifiedLaunch,
} from "../src/launch/pons.js";
import {
  LaunchError,
  Reader,
  address,
  amount,
  budget,
  object,
  sameAddress,
  uintHex,
} from "./source.js";

/**
 * Kelvo launch server for Pons V2: read the live launch policy, prepare a simulated launch transaction that
 * carries a Kelvo provenance salt, and verify a mined launch receipt. Framework-free; every failure is a
 * LaunchError carrying { status, code, message }. Nothing here signs or sends a transaction.
 */

const ZERO_TAG = "0".repeat(40);
const HMAC_LABEL = "Kelvo launch v1";

// ---------- origin allowlist for POST ----------
// The deployment's own URLs come from Vercel's system env; a custom domain is added through KELVO_SITE_ORIGINS
// (comma-separated https origins) once the owner attaches one.
export function allowedOrigins(): string[] {
  const host = (v: string | undefined) =>
    v && /^[a-z\d.-]+$/i.test(v) ? `https://${v}` : null;
  const extra = (process.env.KELVO_SITE_ORIGINS || "")
    .split(",")
    .map((v) => v.trim().replace(/\/$/, ""))
    .filter((v) => /^https:\/\/[a-z\d.-]+$/i.test(v));
  return [
    ...new Set(
      [
        host(process.env.VERCEL_URL),
        host(process.env.VERCEL_BRANCH_URL),
        host(process.env.VERCEL_PROJECT_PRODUCTION_URL),
        ...extra,
        "http://localhost:5596",
        "http://localhost:5597",
        "http://127.0.0.1:5596",
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  ];
}
export const isAllowedOrigin = (origin: unknown): boolean =>
  typeof origin === "string" && allowedOrigins().includes(origin);

// ---------- provenance secret and salt ----------
function intentSecret(): string {
  const value = process.env.KELVO_INTENT_SECRET;
  if (!value || !/^(?:[a-f\d]{64}|[a-f\d]{128})$/i.test(value))
    throw new LaunchError(
      "Verified launch registration is not configured yet.",
      503,
      "INTENT_NOT_CONFIGURED",
    );
  return value;
}
export function intentReady(): boolean {
  try {
    intentSecret();
    return true;
  } catch {
    return false;
  }
}
function intentTag(account: Address, call: DecodedLaunch, seed: Hex): Buffer {
  return createHmac("sha256", Buffer.from(intentSecret(), "hex"))
    .update(
      `${HMAC_LABEL}\n${PONS_CHAIN_ID}\n${account.toLowerCase()}\n${call.to.toLowerCase()}\n`,
    )
    .update(encodeDecodedLaunch(call, { ...call.params, salt: seed }))
    .digest()
    .subarray(0, 20);
}
/** salt = "KELV" + 8 random bytes + first 20 bytes of HMAC(secret, label, chain, account, target, calldata with a seed salt). */
export function issueIntentSalt(account: Address, call: DecodedLaunch): Hex {
  const nonce = SALT_PREFIX + randomBytes(8).toString("hex");
  const tag = intentTag(account, call, `0x${nonce}${ZERO_TAG}`);
  return `0x${nonce}${tag.toString("hex")}`;
}
export function verifyIntentSalt(
  account: Address,
  call: DecodedLaunch,
): boolean {
  const salt = call.params.salt;
  if (!SALT_PATTERN.test(salt)) return false;
  const seed = `${salt.slice(0, 26)}${ZERO_TAG}` as Hex;
  const actual = Buffer.from(salt.slice(26), "hex");
  const expected = intentTag(account, call, seed);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- policy ----------
type Config = {
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
};
type FeePolicy = {
  protocolFeeRecipient: Address;
  protocolFeeShareBps: number;
  buybackBurnBps: number;
  hookFeeBps: number;
  maxInternalPriceImpactBps: number;
};
type PolicyInput = { account: Address | null; pairToken: Address; configId: number };

function policyInput(params: {
  pairToken?: unknown;
  account?: unknown;
  configId?: unknown;
}): PolicyInput {
  const invalid = () =>
    new LaunchError(
      "Provide a valid account, pair and configuration.",
      400,
      "INVALID_INPUT",
    );
  const pair =
    params.pairToken === undefined || params.pairToken === ""
      ? NATIVE_QUOTE
      : address(params.pairToken, true);
  const account =
    params.account === undefined ||
    params.account === null ||
    params.account === ""
      ? null
      : address(params.account);
  const configId =
    params.configId === undefined || params.configId === ""
      ? 0
      : typeof params.configId === "string" && /^\d{1,2}$/.test(params.configId)
        ? Number(params.configId)
        : params.configId;
  if (
    !pair ||
    (params.account !== undefined &&
      params.account !== null &&
      params.account !== "" &&
      !account) ||
    typeof configId !== "number" ||
    !Number.isInteger(configId) ||
    configId < 0 ||
    configId > LAUNCH_LIMITS.configId
  )
    throw invalid();
  return { account, pairToken: pair, configId };
}

async function policy(reader: Reader, input: PolicyInput): Promise<LaunchPolicy> {
  const { account: caller, pairToken: pair, configId } = input;
  const native = pair === NATIVE_QUOTE;
  const { block, forwarderReady } = await reader.verifiedBlock();
  const read = <T>(name: string, args: readonly unknown[] = []) =>
    reader.read<T>(PONS_FACTORY, ponsFactoryAbi, name, args, block);
  const count = await read<bigint>("launchConfigCount");
  if (count < 1n || count > 32n || BigInt(configId) >= count)
    throw new LaunchError(
      "The selected launch configuration is unavailable.",
      422,
      "CONFIG_UNAVAILABLE",
    );
  const [config, fees, launchFee, maxTax, canLaunch, pairApproved, pairTerms] =
    await Promise.all([
      read<Config>("getLaunchConfig", [BigInt(configId)]),
      reader.read<FeePolicy>(
        PONS_MEME_HOOK,
        ponsReadAbi,
        "currentFeePolicy",
        [],
        block,
      ),
      read<bigint>("launchFee"),
      read<bigint>("maxCreatorTaxBps"),
      caller ? read<boolean>("canLaunch", [caller]) : Promise.resolve(null),
      native
        ? Promise.resolve(true)
        : read<boolean>("approvedPairTokens", [pair]),
      native
        ? Promise.resolve(null)
        : read<readonly [bigint, bigint, number]>("pairTokenEconomics", [pair]),
    ]);
  if (
    config.supply <= 0n ||
    config.curveFeeBps > 1000n ||
    config.poolFee !== 0 ||
    config.tickSpacing <= 0 ||
    maxTax > 1000n ||
    fees.hookFeeBps > 1000 ||
    !isContractAddress(fees.protocolFeeRecipient) ||
    sameAddress(fees.protocolFeeRecipient, NATIVE_QUOTE) ||
    fees.protocolFeeShareBps > 10000 ||
    fees.buybackBurnBps > 10000 ||
    fees.maxInternalPriceImpactBps === 0 ||
    fees.maxInternalPriceImpactBps >= 10000
  )
    throw new LaunchError(
      "The current fee policy requires a new protocol review.",
      503,
      "PROTOCOL_CHANGED",
    );
  const approved = config.enabled && pairApproved === true;
  let phantom = config.phantomQuote,
    threshold = config.graduationThreshold,
    decimals = 18;
  if (!native && pairTerms) {
    [phantom, threshold, decimals] = pairTerms;
    if (approved) {
      const current = await reader.read<number>(
        pair,
        ponsReadAbi,
        "decimals",
        [],
        block,
      );
      if (current !== decimals)
        throw new LaunchError(
          "The quote token decimals changed. Launching with it is unavailable.",
          422,
          "PAIR_CHANGED",
        );
    }
  }
  if (
    decimals < 0 ||
    decimals > LAUNCH_LIMITS.pairDecimals ||
    (approved && (phantom <= 0n || threshold <= 0n))
  )
    throw new LaunchError(
      "The quote asset has unusable economics.",
      422,
      "PAIR_UNAVAILABLE",
    );
  const [economics, nativeBalance, quoteBalance, allowance] = await Promise.all([
    read<Hex>("previewLaunchEconomics", [BigInt(configId), pair]).catch(
      (error: unknown) => {
        if (
          !approved &&
          error instanceof LaunchError &&
          error.code === "SIMULATION_REJECTED"
        )
          throw new LaunchError(
            "The selected quote asset is not enabled for launches.",
            422,
            "PAIR_UNAVAILABLE",
          );
        throw error;
      },
    ),
    caller
      ? reader.rpc("eth_getBalance", [caller, block]).then(amount)
      : Promise.resolve(null),
    caller && !native
      ? reader.read<bigint>(pair, ponsReadAbi, "balanceOf", [caller], block)
      : Promise.resolve(null),
    caller && !native
      ? reader.read<bigint>(
          pair,
          ponsReadAbi,
          "allowance",
          [caller, PONS_ROUTER],
          block,
        )
      : Promise.resolve(null),
  ]);
  if (!/^0x[\da-f]{64}$/i.test(economics) || /^0x0{64}$/.test(economics))
    throw new LaunchError(
      "The protocol returned an invalid economics pin.",
      503,
      "PROTOCOL_CHANGED",
    );
  return {
    status: "live",
    chainId: PONS_CHAIN_ID,
    account: caller,
    pairToken: pair,
    configId,
    checkedAt: new Date().toISOString(),
    blockNumber: BigInt(block).toString(),
    canLaunch,
    enabled: config.enabled,
    approved,
    decimals,
    launchFee: launchFee.toString(),
    maxCreatorTaxBps: Number(maxTax),
    curveFeeBps: Number(config.curveFeeBps),
    hookFeeBps: fees.hookFeeBps,
    supply: config.supply.toString(),
    phantomQuote: phantom.toString(),
    graduationThreshold: threshold.toString(),
    expectedEconomics: economics,
    nativeBalance: nativeBalance === null ? null : nativeBalance.toString(),
    quoteBalance: !caller
      ? null
      : native
        ? (nativeBalance?.toString() ?? null)
        : (quoteBalance?.toString() ?? null),
    allowance: allowance === null ? null : allowance.toString(),
    forwarderReady,
    intentReady: intentReady(),
  };
}

/** GET policy: live protocol terms at one verified block, plus balances and allowance when an account is given. */
export async function getPolicy(
  params: { pairToken?: unknown; account?: unknown; configId?: unknown } = {},
): Promise<LaunchPolicy> {
  const input = policyInput(params);
  budget("launch");
  return policy(new Reader(), input);
}

// ---------- prepare ----------
async function checkExactApproval(
  reader: Reader,
  account: Address,
  pair: Address,
  quoteIn: bigint,
  terms: LaunchPolicy,
): Promise<void> {
  const request = {
    from: account,
    to: pair,
    data: encodeFunctionData({
      abi: ponsReadAbi,
      functionName: "approve",
      args: [PONS_ROUTER, quoteIn],
    }),
    value: "0x0",
  };
  const block = toHex(BigInt(terms.blockNumber));
  const rejected = () =>
    new LaunchError(
      "The quote token rejected the exact router allowance. Tokens requiring an allowance reset are not supported.",
      422,
      "APPROVAL_REJECTED",
    );
  let result: unknown, estimated: bigint;
  try {
    result = await reader.rpc("eth_call", [request, block]);
    // Legacy ERC20 tokens may return no data, but an address without code must never pass.
    if (result === "0x") {
      const code = await reader.rpc("eth_getCode", [pair, block]);
      if (typeof code !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(code))
        throw rejected();
    } else if (
      typeof result !== "string" ||
      !/^0x0{63}1$/i.test(result) ||
      decodeFunctionResult({
        abi: ponsReadAbi,
        functionName: "approve",
        data: result as Hex,
      }) !== true
    )
      throw rejected();
    estimated = amount(await reader.rpc("eth_estimateGas", [request, block]));
  } catch (error) {
    if (error instanceof LaunchError && error.code === "SIMULATION_REJECTED")
      throw rejected();
    throw error;
  }
  const gas = (estimated * 120n + 99n) / 100n;
  if (estimated === 0n || gas > 1_000_000n)
    throw new LaunchError(
      "The gas estimate is outside the supported approval range.",
      422,
      "GAS_UNAVAILABLE",
    );
  const gasPrice = amount(await reader.rpc("eth_gasPrice", []));
  if (
    BigInt(terms.nativeBalance ?? "0") <
    BigInt(terms.launchFee) + gas * gasPrice
  )
    throw new LaunchError(
      "The account needs more ETH for the approval network fee while reserving the launch fee.",
      422,
      "INSUFFICIENT_GAS",
    );
}

/**
 * POST prepare: validate, re-read the policy, quote the opening buy, issue the provenance salt, simulate with
 * eth_call and eth_estimateGas from the account, and return the exact transaction (or the exact approval it
 * needs first). The origin must be on the allowlist.
 */
export async function prepareLaunch(
  raw: unknown,
  origin: string | null | undefined,
): Promise<PreparedLaunch> {
  if (!isAllowedOrigin(origin))
    throw new LaunchError(
      "Launch preparation is only available from the Kelvo site.",
      403,
      "ORIGIN_REJECTED",
    );
  let input: PrepareInput;
  try {
    input = validateLaunchRequest(raw);
  } catch (error) {
    throw new LaunchError(
      error instanceof Error ? error.message : "Invalid launch parameters.",
      400,
      "INVALID_INPUT",
    );
  }
  intentSecret();
  budget("launch");
  const { account, launch } = input;
  const reader = new Reader();
  const terms = await policy(reader, {
    account,
    pairToken: launch.pairToken,
    configId: launch.configId,
  });
  if (!terms.canLaunch)
    throw new LaunchError(
      "The launch factory does not currently permit this account to launch.",
      403,
      "LAUNCH_NOT_ALLOWED",
    );
  if (!terms.enabled || !terms.approved)
    throw new LaunchError(
      "The selected quote or configuration is not enabled for launches.",
      422,
      "PAIR_UNAVAILABLE",
    );
  if (
    launch.creatorTaxBps > terms.maxCreatorTaxBps ||
    terms.curveFeeBps + launch.creatorTaxBps > 2000 ||
    terms.hookFeeBps + launch.creatorTaxBps > 2000
  )
    throw new LaunchError(
      "Creator tax exceeds the current protocol limit.",
      422,
      "TAX_TOO_HIGH",
    );
  let quoteIn: bigint;
  try {
    quoteIn = initialBuyUnits(launch.initialBuy, terms.decimals);
  } catch (error) {
    throw new LaunchError((error as Error).message, 400, "INVALID_INPUT");
  }
  if (quoteIn > 0n && !terms.forwarderReady)
    throw new LaunchError(
      "Launching with an opening buy is not enabled by the factory right now. Launch without one.",
      503,
      "ROUTER_UNAVAILABLE",
    );
  const quote = quoteInitialBuy(
    quoteIn,
    BigInt(terms.supply),
    BigInt(terms.phantomQuote),
    BigInt(terms.graduationThreshold),
    BigInt(terms.curveFeeBps),
    BigInt(launch.creatorTaxBps),
    launch.slippageBps,
    terms.decimals,
  );
  if (quoteIn > 0n && BigInt(quote.tokensOut) === 0n)
    throw new LaunchError(
      "The initial buy is too small to receive tokens.",
      422,
      "BUY_TOO_SMALL",
    );
  const value =
    BigInt(terms.launchFee) +
    (launch.pairToken === NATIVE_QUOTE ? quoteIn : 0n);
  if (BigInt(terms.nativeBalance ?? "0") < value)
    throw new LaunchError(
      "The account needs more ETH for the launch fee and initial buy.",
      422,
      "INSUFFICIENT_ETH",
    );
  if (
    launch.pairToken !== NATIVE_QUOTE &&
    BigInt(terms.quoteBalance ?? "0") < quoteIn
  )
    throw new LaunchError(
      "The account does not hold enough of the selected quote token.",
      422,
      "INSUFFICIENT_QUOTE",
    );
  const fingerprint = launchFingerprint(input),
    expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();
  if (
    launch.pairToken !== NATIVE_QUOTE &&
    quoteIn > BigInt(terms.allowance ?? "0")
  ) {
    await checkExactApproval(reader, account, launch.pairToken, quoteIn, terms);
    return {
      fingerprint,
      expiresAt,
      policy: terms,
      quote,
      simulation: "approval-required",
      transaction: null,
      approval: {
        token: launch.pairToken,
        spender: PONS_ROUTER,
        amount: quoteIn.toString(),
        allowance: terms.allowance ?? "0",
      },
    };
  }
  const params = tokenParams(
    launch,
    terms.expectedEconomics,
    `0x${"0".repeat(64)}`,
  );
  let call = encodeLaunchCall(account, launch, params, quote);
  const decoded = decodeLaunchCall(call.to, call.data, account);
  params.salt = issueIntentSalt(account, decoded);
  call = encodeLaunchCall(account, launch, params, quote);
  const request = {
    from: account,
    to: call.to,
    data: call.data,
    value: toHex(value),
  };
  const block = toHex(BigInt(terms.blockNumber));
  const simulated = uintHex(await reader.rpc("eth_call", [request, block]));
  let returned: readonly unknown[];
  try {
    returned = decodeFunctionResult({
      abi: quoteIn === 0n ? ponsFactoryAbi : ponsRouterAbi,
      functionName: quoteIn === 0n ? "launchToken" : "launchAndBuy",
      data: simulated,
    }) as readonly unknown[];
  } catch {
    returned = [];
  }
  if (
    !isContractAddress(returned[0]) ||
    !isContractAddress(returned[1]) ||
    sameAddress(returned[0], NATIVE_QUOTE) ||
    sameAddress(returned[1], NATIVE_QUOTE) ||
    (quoteIn > 0n && returned[2] !== BigInt(quote.tokensOut))
  )
    throw new LaunchError(
      "Simulation did not match the prepared launch and quote.",
      422,
      "QUOTE_MISMATCH",
    );
  const estimated = amount(
    await reader.rpc("eth_estimateGas", [request, block]),
  );
  const gas = (estimated * 120n + 99n) / 100n;
  if (estimated === 0n || gas > MAX_LAUNCH_GAS)
    throw new LaunchError(
      "The gas estimate is outside the supported launch range.",
      422,
      "GAS_UNAVAILABLE",
    );
  const gasPrice = amount(await reader.rpc("eth_gasPrice", []));
  if (BigInt(terms.nativeBalance ?? "0") < value + gas * gasPrice)
    throw new LaunchError(
      "The account needs more ETH to cover the estimated network fee.",
      422,
      "INSUFFICIENT_GAS",
    );
  return {
    fingerprint,
    expiresAt,
    policy: terms,
    quote,
    simulation: "passed",
    approval: null,
    transaction: {
      chainId: PONS_CHAIN_ID,
      account,
      ...call,
      value: value.toString(),
      gas: gas.toString(),
    },
  };
}

// ---------- receipt ----------
type LaunchRecord = {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  exists: boolean;
};

/** GET receipt: a launch is registered only when every receipt check and the provenance salt pass. */
export async function getReceipt(hash: unknown): Promise<VerifiedLaunch> {
  if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash))
    throw new LaunchError(
      "Provide a valid transaction hash.",
      400,
      "INVALID_INPUT",
    );
  intentSecret();
  budget("receipt", "Receipt checks are cooling down. Try again shortly.");
  return verifyReceipt(hash, new Reader());
}

export async function verifyReceipt(
  inputHash: string,
  reader: Reader,
  knownCurrent?: Hex,
): Promise<VerifiedLaunch> {
  if (typeof inputHash !== "string" || !/^0x[\da-f]{64}$/i.test(inputHash))
    throw new LaunchError(
      "Provide a valid transaction hash.",
      400,
      "INVALID_INPUT",
    );
  intentSecret();
  const current = knownCurrent ?? (await reader.verifiedBlock()).block;
  const hash = inputHash.toLowerCase() as Hex;
  const [rawTransaction, rawReceipt] = await Promise.all([
    reader.rpc("eth_getTransactionByHash", [hash]),
    reader.rpc("eth_getTransactionReceipt", [hash]),
  ]);
  const transaction = object(rawTransaction),
    receipt = object(rawReceipt);
  if (!receipt.blockNumber)
    throw new LaunchError(
      "The launch transaction is still pending or unavailable.",
      409,
      "PENDING",
    );
  if (receipt.status !== "0x1")
    throw new LaunchError(
      "The launch transaction reverted. It cannot be registered.",
      422,
      "REVERTED",
    );
  if (
    transaction.hash !== hash ||
    receipt.transactionHash !== hash ||
    !isContractAddress(transaction.from) ||
    !isContractAddress(transaction.to) ||
    receipt.from !== transaction.from ||
    receipt.to !== transaction.to ||
    transaction.blockHash !== receipt.blockHash ||
    transaction.blockNumber !== receipt.blockNumber ||
    typeof receipt.blockHash !== "string" ||
    !/^0x[\da-f]{64}$/i.test(receipt.blockHash) ||
    !Array.isArray(receipt.logs) ||
    (transaction.chainId !== undefined &&
      transaction.chainId !== null &&
      amount(transaction.chainId) !== BigInt(PONS_CHAIN_ID))
  )
    throw new LaunchError(
      "The transaction and receipt do not agree.",
      422,
      "INVALID_RECEIPT",
    );
  const logs = receipt.logs as unknown[];
  if (
    logs.some((raw) => {
      const log = object(raw);
      return (
        log.removed === true ||
        log.transactionHash !== hash ||
        log.blockHash !== receipt.blockHash ||
        log.blockNumber !== receipt.blockNumber
      );
    })
  )
    throw new LaunchError(
      "The receipt contains mismatched or removed logs.",
      422,
      "INVALID_RECEIPT",
    );
  const account = transaction.from as Address,
    data = uintHex(transaction.input);
  let call: DecodedLaunch;
  try {
    call = decodeLaunchCall(transaction.to as Address, data, account);
  } catch {
    throw new LaunchError(
      "Only direct launch transactions to the verified factory or router can be checked.",
      422,
      "UNSUPPORTED_TRANSACTION",
    );
  }
  if (
    encodeDecodedLaunch(call, call.params).toLowerCase() !==
      data.toLowerCase() ||
    !verifyIntentSalt(account, call)
  )
    throw new LaunchError(
      "This transaction was not prepared by Kelvo.",
      422,
      "PROVENANCE_NOT_VERIFIED",
    );
  const blockNumber = amount(receipt.blockNumber);
  if (BigInt(current) < blockNumber + 1n)
    throw new LaunchError(
      "Waiting for an additional block before registration.",
      409,
      "CONFIRMING",
    );
  const block = object(
    await reader.rpc("eth_getBlockByNumber", [receipt.blockNumber, false]),
  );
  if (block.hash !== receipt.blockHash)
    throw new LaunchError(
      "The receipt block is no longer canonical. Wait and retry.",
      409,
      "REORG",
    );
  const events = logs
    .filter((raw) => sameAddress(object(raw).address, PONS_FACTORY))
    .flatMap((raw) => {
      const log = object(raw);
      try {
        const decoded: any = decodeEventLog({
          abi: ponsFactoryAbi,
          data: uintHex(log.data),
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        return decoded.eventName === "TokenLaunched" ? [decoded.args] : [];
      } catch {
        return [];
      }
    });
  if (events.length !== 1)
    throw new LaunchError(
      "The receipt must contain exactly one verified factory launch.",
      422,
      "INVALID_RECEIPT",
    );
  const event = events[0];
  if (
    !sameAddress(event.deployer, account) ||
    !sameAddress(event.pairToken, call.pairToken) ||
    event.launchConfigId !== call.configId
  )
    throw new LaunchError(
      "The factory event does not match the signed launch.",
      422,
      "INVALID_RECEIPT",
    );
  const at = receipt.blockNumber as Hex;
  const [launch, info, name, symbol] = await Promise.all([
    reader.read<LaunchRecord>(
      PONS_FACTORY,
      ponsFactoryAbi,
      "getLaunchedToken",
      [event.token],
      at,
    ),
    reader.read<readonly [Address, string, string, LaunchSocials]>(
      event.token,
      ponsReadAbi,
      "getTokenInfo",
      [],
      at,
    ),
    reader.read<string>(event.token, ponsReadAbi, "name", [], at),
    reader.read<string>(event.token, ponsReadAbi, "symbol", [], at),
  ]);
  if (
    !launch.exists ||
    !sameAddress(launch.token, event.token) ||
    !sameAddress(launch.curve, event.curve) ||
    !sameAddress(launch.deployer, account) ||
    !sameAddress(launch.creatorFeeRecipient, call.params.creatorFeeRecipient) ||
    !sameAddress(launch.pairToken, call.pairToken) ||
    launch.graduationThreshold !== event.graduationThreshold ||
    launch.creatorTaxBps !== call.params.creatorTaxBps ||
    launch.buybackEnabled !== call.params.buybackEnabled
  )
    throw new LaunchError(
      "The factory record does not match the launch intent.",
      422,
      "INVALID_RECEIPT",
    );
  const socialKeys = [
    "twitter",
    "telegram",
    "discord",
    "website",
    "farcaster",
  ] as const;
  if (
    !sameAddress(info[0], account) ||
    info[1] !== call.params.logo ||
    info[2] !== call.params.description ||
    name !== call.params.name ||
    symbol !== call.params.symbol ||
    socialKeys.some((key) => info[3][key] !== call.params.socials[key])
  )
    throw new LaunchError(
      "Token metadata does not match the registered launch.",
      422,
      "INVALID_RECEIPT",
    );
  let spent = 0n,
    tokensReceived = 0n;
  const buys = logs
    .filter((raw) => sameAddress(object(raw).address, event.curve))
    .flatMap((raw) => {
      const log = object(raw);
      try {
        const decoded: any = decodeEventLog({
          abi: ponsReadAbi,
          data: uintHex(log.data),
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        return decoded.eventName === "CurveBuy" ? [decoded.args] : [];
      } catch {
        return [];
      }
    });
  if (call.quoteIn > 0n) {
    if (
      buys.length !== 1 ||
      !sameAddress(buys[0].buyer, PONS_ROUTER) ||
      !sameAddress(buys[0].recipient, account) ||
      buys[0].quoteIn > call.quoteIn ||
      buys[0].tokensOut === 0n ||
      buys[0].quoteIn * call.minTokensOut > call.quoteIn * buys[0].tokensOut
    )
      throw new LaunchError(
        "The opening buy is not verified by the curve receipt.",
        422,
        "INVALID_RECEIPT",
      );
    spent = buys[0].quoteIn;
    tokensReceived = buys[0].tokensOut;
  } else if (buys.length)
    throw new LaunchError(
      "Unexpected initial buy in the launch receipt.",
      422,
      "INVALID_RECEIPT",
    );
  const blockSeconds = amount(block.timestamp);
  if (blockSeconds > BigInt(Math.floor(Date.now() / 1000) + 300))
    throw new LaunchError(
      "The block timestamp is invalid.",
      422,
      "INVALID_RECEIPT",
    );
  return {
    chainId: PONS_CHAIN_ID,
    hash,
    token: event.token.toLowerCase() as Address,
    curve: event.curve.toLowerCase() as Address,
    account: account.toLowerCase() as Address,
    creator: call.params.creatorFeeRecipient.toLowerCase() as Address,
    name,
    symbol,
    logo: info[1],
    description: info[2],
    socials: {
      twitter: call.params.socials.twitter,
      telegram: call.params.socials.telegram,
      discord: call.params.socials.discord,
      website: call.params.socials.website,
      farcaster: call.params.socials.farcaster,
    },
    pair: call.pairToken.toLowerCase() as Address,
    creatorTaxBps: call.params.creatorTaxBps,
    buybackEnabled: call.params.buybackEnabled,
    configId: Number(call.configId),
    blockNumber: blockNumber.toString(),
    blockHash: receipt.blockHash as Hex,
    blockTime: new Date(Number(blockSeconds) * 1000).toISOString(),
    checkedAt: new Date().toISOString(),
    confirmations: (BigInt(current) - blockNumber + 1n).toString(),
    provenanceVerified: true,
    quoteSpent: spent.toString(),
    tokensReceived: tokensReceived.toString(),
  };
}
