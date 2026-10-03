import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  LAUNCH_LIMITS,
  NATIVE_QUOTE,
  PONS_CODE_HASHES,
  PONS_DEPLOYER,
  PONS_FACTORY,
  PONS_MEME_HOOK,
  PONS_ROUTER,
  SALT_PREFIX,
  decodeLaunchCall,
  encodeLaunchCall,
  initialBuyUnits,
  launchFingerprint,
  parsePreparedLaunch,
  ponsFactoryAbi,
  ponsReadAbi,
  ponsRouterAbi,
  quoteInitialBuy,
  tokenParams,
  validateLaunchRequest,
  type PreparedLaunch,
  type PrepareInput,
} from "../src/launch/pons.js";
import {
  getPolicy,
  getReceipt,
  issueIntentSalt,
  prepareLaunch,
  verifyIntentSalt,
} from "../server/launch.js";
import { getPair } from "../server/pair.js";
import { listLaunches } from "../server/launches.js";
import { PONS_FACTORY as SITE_PONS_FACTORY } from "../src/chain-addresses.js";
import handler from "../api/launch.js";
import { privatePattern } from "./private-names.mjs";

const ORIGIN = "http://localhost:5596";
const SECRET = randomBytes(32).toString("hex");
const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const token = "0x3333333333333333333333333333333333333333" as Address;
const curve = "0x4444444444444444444444444444444444444444" as Address;
const pin = `0x${"a".repeat(64)}` as Hex;
const blankSalt = `0x${"0".repeat(64)}` as Hex;
const input = (): PrepareInput => ({
  account,
  launch: {
    name: "Kelvo test",
    symbol: "TEST",
    logo: "ipfs://bafytestimage",
    description: "Protocol integration fixture.",
    socials: {
      twitter: "",
      telegram: "",
      discord: "",
      website: "https://example.com",
      farcaster: "",
    },
    creatorFeeRecipient: account,
    creatorTaxBps: 125,
    buybackEnabled: false,
    pairToken: NATIVE_QUOTE,
    initialBuy: "0",
    slippageBps: 100,
    configId: 0,
  },
});
const quote = (amount: bigint, slippage = 100, decimals = 18) =>
  quoteInitialBuy(
    amount,
    1_000_000n * 10n ** 18n,
    168n * 10n ** 16n,
    42n * 10n ** 17n,
    100n,
    125n,
    slippage,
    decimals,
  );
function fixtureCall(value = input()) {
  const q = quote(
    initialBuyUnits(value.launch.initialBuy, 18),
    value.launch.slippageBps,
  );
  const params = tokenParams(value.launch, pin, blankSalt);
  const encoded = encodeLaunchCall(value.account, value.launch, params, q);
  return decodeLaunchCall(encoded.to, encoded.data, value.account);
}
function withSecret<T>(task: () => T): T {
  const previous = process.env.KELVO_INTENT_SECRET;
  process.env.KELVO_INTENT_SECRET = SECRET;
  try {
    return task();
  } finally {
    if (previous === undefined) delete process.env.KELVO_INTENT_SECRET;
    else process.env.KELVO_INTENT_SECRET = previous;
  }
}
// Every fixture gets a fresh one-minute window so production rate budgets stay as they are.
let fixtureClock = Date.now();
async function freshClock<T>(task: () => Promise<T>): Promise<T> {
  const original = Date.now;
  fixtureClock += 61_000;
  Date.now = () => fixtureClock;
  try {
    return await task();
  } finally {
    Date.now = original;
  }
}
const rpcResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

type RpcRequest = { method: string; params: any[] };
type Chain = {
  transactions: Map<string, Record<string, unknown>>;
  receipts: Map<string, Record<string, unknown>>;
  blocks: Map<string, Record<string, unknown>>;
  logs: Record<string, unknown>[];
  launched?: { name: string; symbol: string; info: readonly unknown[]; record: Record<string, unknown> };
};
async function withProtocol(
  task: (calls: string[], requests: RpcRequest[]) => Promise<void>,
  options: {
    allowance?: bigint;
    rejectSimulation?: boolean;
    permit?: boolean;
    approvalResult?: Hex;
    rejectApproval?: boolean;
    rejectApprovalEstimate?: boolean;
    approvalCode?: Hex;
    gasEstimate?: bigint;
    nativeBalance?: bigint;
    forwarder?: Address;
    hook?: Address;
    maxTax?: bigint;
    chain?: Chain;
  } = {},
) {
  const originalFetch = globalThis.fetch,
    previous = process.env.KELVO_INTENT_SECRET,
    previousStart = process.env.KELVO_LAUNCH_START_BLOCK;
  process.env.KELVO_LAUNCH_START_BLOCK = "0";
  const hashes = { ...PONS_CODE_HASHES },
    mutableHashes = PONS_CODE_HASHES as Record<string, string>;
  const code = "0x6001" as Hex,
    calls: string[] = [],
    requests: RpcRequest[] = [];
  for (const key of Object.keys(hashes)) mutableHashes[key] = keccak256(code);
  process.env.KELVO_INTENT_SECRET = SECRET;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.method);
    requests.push(body);
    const rejected = () =>
      rpcResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 3, message: "execution reverted" },
      });
    const chain = options.chain;
    let result: unknown;
    if (body.method === "eth_chainId") result = "0x1237";
    else if (body.method === "eth_blockNumber") result = "0x100";
    else if (body.method === "eth_getCode")
      result = body.params[0] === other ? (options.approvalCode ?? code) : code;
    else if (body.method === "eth_getBalance")
      result = "0x" + (options.nativeBalance ?? 100n * 10n ** 18n).toString(16);
    else if (body.method === "eth_estimateGas") {
      const approval = body.params[0].data.startsWith("0x095ea7b3");
      if (approval && options.rejectApprovalEstimate) return rejected();
      result =
        "0x" +
        (options.gasEstimate ?? (approval ? 50_000n : 1_048_576n)).toString(16);
    } else if (body.method === "eth_gasPrice") result = "0x1";
    else if (body.method === "eth_getTransactionByHash")
      result = chain?.transactions.get(body.params[0]) ?? null;
    else if (body.method === "eth_getTransactionReceipt")
      result = chain?.receipts.get(body.params[0]) ?? null;
    else if (body.method === "eth_getBlockByNumber")
      result = chain?.blocks.get(body.params[0]) ?? null;
    else if (body.method === "eth_getLogs") result = chain?.logs ?? [];
    else if (body.method === "eth_call") {
      let decoded:
          { functionName: string; args?: readonly unknown[] } | undefined,
        abi: Abi | undefined;
      for (const candidate of [ponsFactoryAbi, ponsRouterAbi, ponsReadAbi]) {
        try {
          decoded = decodeFunctionData({
            abi: candidate,
            data: body.params[0].data,
          });
          abi = candidate;
          break;
        } catch {
          /* Try the next verified interface. */
        }
      }
      if (!decoded || !abi) throw new Error("Unexpected contract call");
      const name = decoded.functionName;
      let value: unknown;
      if (name === "launchDeployer") value = PONS_DEPLOYER;
      else if (name === "launchForwarder") value = options.forwarder ?? PONS_ROUTER;
      else if (name === "factory") value = PONS_FACTORY;
      else if (name === "memeHook") value = options.hook ?? PONS_MEME_HOOK;
      else if (name === "launchConfigCount") value = 1n;
      else if (name === "getLaunchConfig")
        value = {
          supply: 10n ** 24n,
          curveFeeBps: 100n,
          phantomQuote: 168n * 10n ** 16n,
          graduationThreshold: 42n * 10n ** 17n,
          poolFee: 0,
          tickSpacing: 60,
          enabled: true,
        };
      else if (name === "currentFeePolicy")
        value = {
          protocolFeeRecipient: other,
          protocolFeeShareBps: 5000,
          buybackBurnBps: 2000,
          hookFeeBps: 100,
          maxInternalPriceImpactBps: 100,
        };
      else if (name === "launchFee") value = 10n ** 15n;
      else if (name === "maxCreatorTaxBps") value = options.maxTax ?? 1000n;
      else if (name === "canLaunch") value = options.permit ?? true;
      else if (name === "approvedPairTokens") value = true;
      else if (name === "pairTokenEconomics")
        value = [168n * 10n ** 16n, 42n * 10n ** 17n, 18];
      else if (name === "previewLaunchEconomics") value = pin;
      else if (name === "balanceOf") value = 100n * 10n ** 18n;
      else if (name === "allowance") value = options.allowance ?? 0n;
      else if (name === "decimals") value = 18;
      else if (name === "getLaunchedToken" && chain?.launched)
        value = chain.launched.record;
      else if (name === "getTokenInfo" && chain?.launched)
        value = chain.launched.info;
      else if (name === "name" && chain?.launched) value = chain.launched.name;
      else if (name === "symbol" && chain?.launched)
        value = chain.launched.symbol;
      else if (name === "approve") {
        if (options.rejectApproval) return rejected();
        if (options.approvalResult !== undefined)
          return rpcResponse({
            jsonrpc: "2.0",
            id: 1,
            result: options.approvalResult,
          });
        value = true;
      } else if (name === "launchToken" || name === "launchAndBuy") {
        if (options.rejectSimulation) return rejected();
        value =
          name === "launchToken"
            ? [token, curve]
            : [
                token,
                curve,
                BigInt(quote(decoded.args![3] as bigint).tokensOut),
              ];
      } else throw new Error("Unhandled read " + name);
      result = encodeFunctionResult({ abi, functionName: name, result: value });
    } else throw new Error("Unexpected RPC method " + body.method);
    return rpcResponse({ jsonrpc: "2.0", id: 1, result });
  };
  const original = Date.now;
  fixtureClock += 61_000;
  Date.now = () => fixtureClock;
  try {
    await task(calls, requests);
  } finally {
    Date.now = original;
    globalThis.fetch = originalFetch;
    Object.assign(mutableHashes, hashes);
    if (previous === undefined) delete process.env.KELVO_INTENT_SECRET;
    else process.env.KELVO_INTENT_SECRET = previous;
    if (previousStart === undefined) delete process.env.KELVO_LAUNCH_START_BLOCK;
    else process.env.KELVO_LAUNCH_START_BLOCK = previousStart;
  }
}

// ---------- identity ----------
test("provenance salt prefix is ASCII KELV", () => {
  assert.equal(SALT_PREFIX, "4b454c56");
  assert.equal(Buffer.from(SALT_PREFIX, "hex").toString("ascii"), "KELV");
  withSecret(() => {
    assert.match(issueIntentSalt(account, fixtureCall()), /^0x4b454c56[\da-f]{56}$/);
  });
});
test("pinned factory matches the site's verified address list", () => {
  assert.equal(PONS_FACTORY.toLowerCase(), SITE_PONS_FACTORY);
});

// ---------- validation ----------
test("metadata applies verified byte caps rather than JavaScript character counts", () => {
  const value = input();
  value.launch.name = "é".repeat(32);
  assert.doesNotThrow(() => validateLaunchRequest(value));
  value.launch.name += "é";
  assert.throws(() => validateLaunchRequest(value), /metadata limit/);
  value.launch.name = "Valid";
  value.launch.logo = "https://example.com/" + "a".repeat(500);
  assert.throws(() => validateLaunchRequest(value), /logo/);
  value.launch.logo = "ipfs://bafytest";
  value.launch.socials.website = "https://example.com/" + "a".repeat(250);
  assert.throws(() => validateLaunchRequest(value), /website/);
});
test("description and symbol support exact protocol limits", () => {
  const value = input();
  value.launch.symbol = "A".repeat(LAUNCH_LIMITS.symbolBytes);
  value.launch.description = "a".repeat(LAUNCH_LIMITS.descriptionBytes);
  assert.doesNotThrow(() => validateLaunchRequest(value));
  value.launch.description += "a";
  assert.throws(() => validateLaunchRequest(value), /description/);
  value.launch.description = "";
  value.launch.symbol += "B";
  assert.throws(() => validateLaunchRequest(value), /symbol/);
});
test("description keeps line breaks for an agent persona; name and symbol take no control characters", () => {
  const value = input();
  value.launch.description = "Persona: cold reader\nTone:\tdry\r\nRules: none";
  assert.doesNotThrow(() => validateLaunchRequest(value));
  value.launch.description = "bell\u0007";
  assert.throws(() => validateLaunchRequest(value), /description/);
  value.launch.description = "ok";
  value.launch.name = "two\nlines";
  assert.throws(() => validateLaunchRequest(value), /name/);
  value.launch.name = "ok";
  value.launch.symbol = "T\tX";
  assert.throws(() => validateLaunchRequest(value), /symbol/);
});
test("metadata rejects active URLs and credentials while allowing persistent IPFS images", () => {
  for (const logo of [
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "blob:https://example.com/id",
    "https://user:password@example.com/image",
    "http://example.com/plain.png",
  ]) {
    const value = input();
    value.launch.logo = logo;
    assert.throws(() => validateLaunchRequest(value), /image URL/);
  }
  const value = input();
  value.launch.logo = "https://example.com/logo.png";
  assert.doesNotThrow(() => validateLaunchRequest(value));
  value.launch.socials.twitter = "ipfs://bafy";
  assert.throws(() => validateLaunchRequest(value), /twitter/);
});
test("creator and initiating accounts must be explicit nonzero contracts", () => {
  const value = input();
  value.launch.creatorFeeRecipient = NATIVE_QUOTE;
  assert.throws(() => validateLaunchRequest(value), /nonzero creator/);
  value.launch.creatorFeeRecipient = account;
  value.account = NATIVE_QUOTE;
  assert.throws(() => validateLaunchRequest(value), /initiating account/);
});
test("tax and slippage are bounded integer basis points", () => {
  for (const tax of [-1, 1001, 0.5, NaN]) {
    const value = input();
    value.launch.creatorTaxBps = tax;
    assert.throws(() => validateLaunchRequest(value), /Creator tax/);
  }
  for (const slippage of [-1, 501, 1.5]) {
    const value = input();
    value.launch.slippageBps = slippage;
    assert.throws(() => validateLaunchRequest(value), /Slippage/);
  }
});
test("initial buys preserve quote precision and never silently round", () => {
  assert.equal(initialBuyUnits("1.234567", 6), 1234567n);
  assert.throws(() => initialBuyUnits("1.2345678", 6), /6 decimal places/);
  for (const value of ["1e2", "-1", ".5", "01", "1."])
    assert.throws(() => initialBuyUnits(value, 18));
});

// ---------- curve math ----------
test("zero initial buy quotes no spend, tax or minimum output", () => {
  const result = quote(0n);
  assert.deepEqual(
    [
      result.spent,
      result.refund,
      result.tokensOut,
      result.minTokensOut,
      result.fee,
      result.creatorTax,
    ],
    ["0", "0", "0", "0", "0", "0"],
  );
});
test("opening buy subtracts separately floored standard and creator fees", () => {
  const result = quote(10n ** 17n);
  const net = 10n ** 17n - 10n ** 15n - 125n * 10n ** 13n;
  const expected =
    (net * (1_000_000n * 10n ** 18n)) / (168n * 10n ** 16n + net);
  assert.equal(BigInt(result.tokensOut), expected);
  assert.equal(BigInt(result.minTokensOut), (expected * 9900n) / 10000n);
  assert.equal(result.refund, "0");
});
test("clamped opening buy refunds input and scales minimum as a rate", () => {
  const result = quote(100n * 10n ** 18n);
  const supply = 1_000_000n * 10n ** 18n;
  const reserved =
    (supply * (168n * 10n ** 16n)) / (168n * 10n ** 16n + 42n * 10n ** 17n);
  assert.equal(BigInt(result.tokensOut), supply - reserved);
  assert.ok(BigInt(result.refund) > 0n);
  assert.equal(
    BigInt(result.spent) + BigInt(result.refund),
    BigInt(result.quoteIn),
  );
  assert.ok(BigInt(result.minTokensOut) > BigInt(result.tokensOut));
  assert.ok(
    BigInt(result.spent) * BigInt(result.minTokensOut) <=
      BigInt(result.quoteIn) * BigInt(result.tokensOut),
  );
});
test("six decimal quote asset uses the same integer curve semantics", () => {
  const result = quoteInitialBuy(
    1_000_000n,
    10n ** 24n,
    10_000_000n,
    25_000_000n,
    100n,
    100n,
    0,
    6,
  );
  assert.equal(result.fee, "10000");
  assert.equal(result.creatorTax, "10000");
  assert.equal(result.decimals, 6);
  assert.equal(result.tokensOut, result.minTokensOut);
});
test("unusable curve economics fail closed", () => {
  assert.throws(
    () => quoteInitialBuy(1n, 1n, 1n, 2n, 100n, 0n, 100, 18),
    /reserved allocation/,
  );
  assert.throws(
    () => quoteInitialBuy(1n, 100n, 1n, 2n, 1000n, 1001n, 100, 18),
    /Invalid quote/,
  );
});

// ---------- calldata ----------
test("zero buy selects factory and nonzero buy selects atomic router", () => {
  assert.equal(fixtureCall().to, PONS_FACTORY);
  const value = input();
  value.launch.initialBuy = "0.1";
  value.launch.pairToken = other;
  const call = fixtureCall(value);
  assert.equal(call.to, PONS_ROUTER);
  assert.equal(call.quoteIn, 10n ** 17n);
  assert.equal(call.recipient.toLowerCase(), account);
  assert.equal(call.pairToken.toLowerCase(), other);
});
test("decoder refuses unrelated destinations and approve calldata", () => {
  const value = input();
  const encoded = encodeLaunchCall(
    account,
    value.launch,
    tokenParams(value.launch, pin, blankSalt),
    quote(0n),
  );
  assert.throws(
    () => decodeLaunchCall(other, encoded.data, account),
    /unverified/,
  );
  const approval = encodeFunctionData({
    abi: parseAbi([
      "function approve(address spender,uint256 value) returns (bool)",
    ]),
    functionName: "approve",
    args: [PONS_ROUTER, 1n],
  });
  assert.throws(() => decodeLaunchCall(PONS_ROUTER, approval, account));
});
test("fingerprints include every form field and ignore social-object insertion order", () => {
  const a = input(),
    b = input();
  b.launch.socials = {
    website: "https://example.com",
    farcaster: "",
    discord: "",
    telegram: "",
    twitter: "",
  };
  assert.equal(launchFingerprint(a), launchFingerprint(b));
  b.launch.creatorTaxBps++;
  assert.notEqual(launchFingerprint(a), launchFingerprint(b));
  b.launch.creatorTaxBps--;
  b.account = other;
  assert.notEqual(launchFingerprint(a), launchFingerprint(b));
  b.account = account;
  b.launch.description = "changed";
  assert.notEqual(launchFingerprint(a), launchFingerprint(b));
});

// ---------- provenance salt ----------
test("server-issued salt is random and authenticates the exact caller and launch", () =>
  withSecret(() => {
    const call = fixtureCall();
    const salt = issueIntentSalt(account, call);
    assert.match(salt, /^0x4b454c56[\da-f]{56}$/);
    assert.notEqual(salt, issueIntentSalt(account, call));
    call.params.salt = salt;
    assert.equal(verifyIntentSalt(account, call), true);
    assert.equal(verifyIntentSalt(other, call), false);
    assert.equal(
      verifyIntentSalt(account, {
        ...call,
        params: { ...call.params, creatorTaxBps: 999 },
      }),
      false,
    );
    assert.equal(
      verifyIntentSalt(account, {
        ...call,
        params: { ...call.params, logo: "https://example.com/changed.png" },
      }),
      false,
    );
    assert.equal(
      verifyIntentSalt(account, {
        ...call,
        params: { ...call.params, description: "another persona" },
      }),
      false,
    );
    assert.equal(
      verifyIntentSalt(account, { ...call, pairToken: other }),
      false,
    );
    assert.equal(verifyIntentSalt(account, { ...call, configId: 1n }), false);
  }));
test("intent authenticates opening buy amount, minimum and economics pin", () =>
  withSecret(() => {
    const value = input();
    value.launch.initialBuy = "0.1";
    const call = fixtureCall(value);
    call.params.salt = issueIntentSalt(account, call);
    assert.equal(verifyIntentSalt(account, call), true);
    assert.equal(
      verifyIntentSalt(account, { ...call, quoteIn: call.quoteIn + 1n }),
      false,
    );
    assert.equal(
      verifyIntentSalt(account, { ...call, minTokensOut: 0n }),
      false,
    );
    assert.equal(
      verifyIntentSalt(account, {
        ...call,
        params: { ...call.params, expectedEconomics: blankSalt },
      }),
      false,
    );
  }));
test("a salt from another secret or another prefix never verifies", () => {
  const call = fixtureCall();
  call.params.salt = withSecret(() => issueIntentSalt(account, call));
  const previous = process.env.KELVO_INTENT_SECRET;
  process.env.KELVO_INTENT_SECRET = randomBytes(64).toString("hex");
  try {
    assert.equal(verifyIntentSalt(account, call), false);
  } finally {
    if (previous === undefined) delete process.env.KELVO_INTENT_SECRET;
    else process.env.KELVO_INTENT_SECRET = previous;
  }
  withSecret(() => {
    const foreign = { ...call, params: { ...call.params, salt: `0x4b495454${call.params.salt.slice(10)}` as Hex } };
    assert.equal(verifyIntentSalt(account, foreign), false);
  });
});

// ---------- server gates ----------
test("unconfigured registration cannot create a transaction", async () => {
  const previous = process.env.KELVO_INTENT_SECRET;
  delete process.env.KELVO_INTENT_SECRET;
  try {
    await assert.rejects(prepareLaunch(input(), ORIGIN), {
      code: "INTENT_NOT_CONFIGURED",
      status: 503,
    });
  } finally {
    if (previous !== undefined) process.env.KELVO_INTENT_SECRET = previous;
  }
});
test("preparation from an unlisted origin is refused before any RPC", async () =>
  withProtocol(async (calls) => {
    for (const origin of [undefined, null, "https://evil.example", "http://localhost:5173"])
      await assert.rejects(prepareLaunch(input(), origin), {
        code: "ORIGIN_REJECTED",
        status: 403,
      });
    assert.equal(calls.length, 0);
  }));
test("wrong RPC chain prevents all contract reads", async () =>
  freshClock(async () => {
    const original = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      return rpcResponse({ jsonrpc: "2.0", id: 1, result: "0x1" });
    };
    try {
      await assert.rejects(
        getPolicy({ account, pairToken: NATIVE_QUOTE }),
        /wrong chain/,
      );
      assert.deepEqual(methods, ["eth_chainId"]);
    } finally {
      globalThis.fetch = original;
    }
  }));
test("replaced factory code stops policy, pair and index reads with PROTOCOL_CHANGED", async () =>
  freshClock(async () => {
    const original = globalThis.fetch,
      previous = process.env.KELVO_INTENT_SECRET;
    process.env.KELVO_INTENT_SECRET = SECRET;
    const methods: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      const result =
        body.method === "eth_chainId"
          ? "0x1237"
          : body.method === "eth_blockNumber"
            ? "0x100"
            : "0x6000";
      return rpcResponse({ jsonrpc: "2.0", id: 1, result });
    };
    try {
      await assert.rejects(getPolicy({ account }), {
        code: "PROTOCOL_CHANGED",
        status: 503,
        message: /contract code requires/,
      });
      await assert.rejects(getPair(NATIVE_QUOTE), { code: "PROTOCOL_CHANGED" });
      await assert.rejects(listLaunches(), { code: "PROTOCOL_CHANGED" });
      assert.equal(methods.includes("eth_call"), false);
    } finally {
      globalThis.fetch = original;
      if (previous === undefined) delete process.env.KELVO_INTENT_SECRET;
      else process.env.KELVO_INTENT_SECRET = previous;
    }
  }));
test("a rewired fee hook is a protocol change", async () =>
  withProtocol(
    async (calls) => {
      await assert.rejects(getPolicy({ account }), { code: "PROTOCOL_CHANGED" });
      await assert.rejects(prepareLaunch(input(), ORIGIN), {
        code: "PROTOCOL_CHANGED",
      });
      assert.equal(calls.includes("eth_estimateGas"), false);
    },
    { hook: other },
  ));
test("a factory forwarder other than the router only disables opening buys", async () =>
  withProtocol(
    async () => {
      const policy = await getPolicy({ account });
      assert.equal(policy.forwarderReady, false);
      assert.equal((await prepareLaunch(input(), ORIGIN)).simulation, "passed");
      const value = input();
      value.launch.initialBuy = "0.1";
      await assert.rejects(prepareLaunch(value, ORIGIN), {
        code: "ROUTER_UNAVAILABLE",
      });
    },
    { forwarder: other },
  ));
test("the RPC list falls back to the next endpoint when one is unreachable", async () =>
  withProtocol(async () => {
    const inner = globalThis.fetch,
      previous = process.env.ROBINHOOD_RPC_URL;
    process.env.ROBINHOOD_RPC_URL = "https://dedicated.example/rpc";
    const urls: string[] = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      if (String(url) === "https://dedicated.example/rpc")
        throw new TypeError("fetch failed");
      return inner(url, init);
    };
    try {
      const policy = await getPolicy({});
      assert.equal(policy.account, null);
      assert.equal(policy.nativeBalance, null);
      assert.equal(policy.launchFee, (10n ** 15n).toString());
      assert.equal(urls[0], "https://dedicated.example/rpc");
      assert.ok(urls.some((url) => url !== "https://dedicated.example/rpc"));
    } finally {
      globalThis.fetch = inner;
      if (previous === undefined) delete process.env.ROBINHOOD_RPC_URL;
      else process.env.ROBINHOOD_RPC_URL = previous;
    }
  }));
test("every endpoint throttling surfaces as RATE_LIMITED and the index degrades instead of throwing", async () =>
  freshClock(async () => {
    const original = globalThis.fetch,
      previous = process.env.KELVO_INTENT_SECRET;
    process.env.KELVO_INTENT_SECRET = SECRET;
    globalThis.fetch = async () =>
      new Response("<!doctype html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      });
    try {
      await assert.rejects(getPolicy({}), { code: "RATE_LIMITED", status: 429 });
      const index = await listLaunches("1:0");
      assert.equal(index.status, "unavailable");
      assert.match(index.error ?? "", /rate limiting/);
    } finally {
      globalThis.fetch = original;
      if (previous === undefined) delete process.env.KELVO_INTENT_SECRET;
      else process.env.KELVO_INTENT_SECRET = previous;
    }
  }));
test("policy query parameters are validated", async () =>
  withProtocol(async (calls) => {
    for (const params of [
      { pairToken: "0x123" },
      { account: "nope" },
      { account: NATIVE_QUOTE },
      { configId: "32" },
      { configId: "-1" },
      { configId: 1.5 },
    ])
      await assert.rejects(getPolicy(params), { code: "INVALID_INPUT" });
    assert.equal(calls.length, 0);
  }));
test("pair check reports ETH economics and approved stock decimals", async () =>
  withProtocol(async () => {
    const eth = await getPair(NATIVE_QUOTE);
    assert.equal(eth.approval, "approved");
    assert.equal(eth.status, "live");
    assert.deepEqual(eth.economics, {
      phantomQuote: (168n * 10n ** 16n).toString(),
      graduationThreshold: (42n * 10n ** 17n).toString(),
      decimals: 18,
    });
    assert.equal((await getPair(NATIVE_QUOTE)).status, "cached");
    const stock = await getPair(other);
    assert.equal(stock.approval, "approved");
    assert.equal(stock.economics?.decimals, 18);
    await assert.rejects(getPair("0xabc"), { code: "INVALID_INPUT" });
  }));

// ---------- prepare ----------
test("native zero-buy preparation exposes only a successfully simulated factory transaction", async () =>
  withProtocol(async (calls) => {
    const value = input(),
      prepared = await prepareLaunch(value, ORIGIN);
    assert.equal(prepared.simulation, "passed");
    assert.equal(prepared.transaction?.to, PONS_FACTORY);
    assert.equal(prepared.transaction?.value, (10n ** 15n).toString());
    assert.equal(calls.includes("eth_estimateGas"), true);
    assert.equal(parsePreparedLaunch(prepared, value), prepared);
    const call = decodeLaunchCall(
      prepared.transaction!.to,
      prepared.transaction!.data,
      account,
    );
    assert.match(call.params.salt, /^0x4b454c56/);
    assert.equal(verifyIntentSalt(account, call), true);
  }));
test("native opening buy sends fee plus quote input to atomic router", async () =>
  withProtocol(async () => {
    const value = input();
    value.launch.initialBuy = "0.1";
    const prepared = await prepareLaunch(value, ORIGIN);
    assert.equal(prepared.transaction?.to, PONS_ROUTER);
    assert.equal(
      prepared.transaction?.value,
      (10n ** 15n + 10n ** 17n).toString(),
    );
    assert.doesNotThrow(() => parsePreparedLaunch(prepared, value));
  }));
test("insufficient native ETH stops before simulation", async () =>
  withProtocol(
    async (calls) => {
      await assert.rejects(prepareLaunch(input(), ORIGIN), {
        code: "INSUFFICIENT_ETH",
      });
      assert.equal(calls.includes("eth_estimateGas"), false);
    },
    { nativeBalance: 0n },
  ));
test("creator tax above the live cap is refused", async () => {
  const value = input();
  value.launch.creatorTaxBps = 1000;
  await withProtocol(async () => {
    assert.equal((await prepareLaunch(value, ORIGIN)).simulation, "passed");
  });
  await withProtocol(
    async (calls) => {
      await assert.rejects(prepareLaunch(value, ORIGIN), {
        code: "TAX_TOO_HIGH",
      });
      assert.equal(calls.includes("eth_estimateGas"), false);
    },
    { maxTax: 999n },
  );
});
test("stock approval requirement simulates exact router allowance and never exposes a launch transaction or calls a write", async () =>
  withProtocol(async (calls, requests) => {
    const value = input();
    value.launch.initialBuy = "0.1";
    value.launch.pairToken = other;
    const prepared = await prepareLaunch(value, ORIGIN);
    assert.equal(prepared.simulation, "approval-required");
    assert.equal(prepared.transaction, null);
    assert.deepEqual(prepared.approval, {
      token: other,
      spender: PONS_ROUTER,
      amount: (10n ** 17n).toString(),
      allowance: "0",
    });
    const approvalCalls = requests.filter(
      (request) =>
        request.method === "eth_call" &&
        request.params[0].data.startsWith("0x095ea7b3"),
    );
    assert.equal(approvalCalls.length, 1);
    const exact = {
      from: account,
      to: other,
      data: encodeFunctionData({
        abi: ponsReadAbi,
        functionName: "approve",
        args: [PONS_ROUTER, 10n ** 17n],
      }),
      value: "0x0",
    };
    assert.deepEqual(approvalCalls[0].params, [exact, "0x100"]);
    assert.deepEqual(
      requests.find((request) => request.method === "eth_estimateGas")?.params,
      [exact, "0x100"],
    );
    assert.equal(calls.includes("eth_gasPrice"), true);
    assert.equal(
      calls.some((method) => /send|sign/.test(method)),
      false,
    );
    assert.doesNotThrow(() => parsePreparedLaunch(prepared, value));
    assert.throws(() =>
      parsePreparedLaunch(
        { ...prepared, approval: { ...prepared.approval!, spender: other } },
        value,
      ),
    );
  }));
test("legacy empty approval result requires deployed quote-token code", async () => {
  const value = input();
  value.launch.initialBuy = "0.1";
  value.launch.pairToken = other;
  await withProtocol(
    async () =>
      assert.equal(
        (await prepareLaunch(value, ORIGIN)).simulation,
        "approval-required",
      ),
    { approvalResult: "0x" },
  );
  await withProtocol(
    async (calls) => {
      await assert.rejects(prepareLaunch(value, ORIGIN), {
        code: "APPROVAL_REJECTED",
      });
      assert.equal(calls.includes("eth_estimateGas"), false);
    },
    { approvalResult: "0x", approvalCode: "0x" },
  );
});
test("false or malformed approval responses cannot offer an approval transaction", async () => {
  for (const approvalResult of [
    `0x${"0".repeat(64)}`,
    `0x${"0".repeat(63)}2`,
    "0x01",
    `0x${"0".repeat(63)}1${"0".repeat(64)}`,
  ] as Hex[]) {
    await withProtocol(
      async (calls) => {
        const value = input();
        value.launch.initialBuy = "0.1";
        value.launch.pairToken = other;
        await assert.rejects(prepareLaunch(value, ORIGIN), {
          code: "APPROVAL_REJECTED",
        });
        assert.equal(calls.includes("eth_estimateGas"), false);
        assert.equal(
          calls.some((method) => /send|sign/.test(method)),
          false,
        );
      },
      { approvalResult },
    );
  }
});
test("zero-reset approval and failed approval estimates stop without fallback writes", async () => {
  for (const options of [
    { rejectApproval: true },
    { rejectApprovalEstimate: true },
  ]) {
    await withProtocol(
      async (_calls, requests) => {
        const value = input();
        value.launch.initialBuy = "0.1";
        value.launch.pairToken = other;
        await assert.rejects(prepareLaunch(value, ORIGIN), /allowance reset/);
        const approvals = requests.filter(
          (request) =>
            request.method === "eth_call" &&
            request.params[0].data.startsWith("0x095ea7b3"),
        );
        assert.equal(approvals.length, 1);
        assert.equal(
          decodeFunctionData({
            abi: ponsReadAbi,
            data: approvals[0].params[0].data,
          }).args?.[1],
          10n ** 17n,
        );
      },
      { allowance: 1n, ...options },
    );
  }
});
test("approval gas estimates are nonzero and bounded including the buffer", async () => {
  for (const gasEstimate of [0n, 833_334n]) {
    await withProtocol(
      async () => {
        const value = input();
        value.launch.initialBuy = "0.1";
        value.launch.pairToken = other;
        await assert.rejects(prepareLaunch(value, ORIGIN), {
          code: "GAS_UNAVAILABLE",
        });
      },
      { gasEstimate },
    );
  }
});
test("approval requires enough ETH for buffered gas while retaining the launch fee", async () => {
  const value = input();
  value.launch.initialBuy = "0.1";
  value.launch.pairToken = other;
  await withProtocol(
    async () => {
      await assert.rejects(prepareLaunch(value, ORIGIN), {
        code: "INSUFFICIENT_GAS",
      });
    },
    { nativeBalance: 10n ** 15n + 59_999n },
  );
  await withProtocol(
    async () =>
      assert.equal(
        (await prepareLaunch(value, ORIGIN)).simulation,
        "approval-required",
      ),
    { nativeBalance: 10n ** 15n + 60_000n },
  );
});
test("stock preparation after exact allowance sends only the native launch fee", async () =>
  withProtocol(
    async () => {
      const value = input();
      value.launch.initialBuy = "0.1";
      value.launch.pairToken = other;
      const prepared = await prepareLaunch(value, ORIGIN);
      assert.equal(prepared.simulation, "passed");
      assert.equal(prepared.transaction?.value, (10n ** 15n).toString());
      assert.equal(prepared.transaction?.to, PONS_ROUTER);
      assert.doesNotThrow(() => parsePreparedLaunch(prepared, value));
    },
    { allowance: 10n ** 17n },
  ));
test("rejected simulation cannot return a transaction", async () =>
  withProtocol(
    async (calls) => {
      await assert.rejects(prepareLaunch(input(), ORIGIN), {
        code: "SIMULATION_REJECTED",
        message: /contract rejected/,
      });
      assert.equal(calls.includes("eth_estimateGas"), false);
    },
    { rejectSimulation: true },
  ));
test("closed launcher gate fails before transaction simulation", async () =>
  withProtocol(
    async (calls) => {
      await assert.rejects(prepareLaunch(input(), ORIGIN), {
        code: "LAUNCH_NOT_ALLOWED",
      });
      assert.equal(calls.includes("eth_estimateGas"), false);
    },
    { permit: false },
  ));

// ---------- client re-verification ----------
test("parsePreparedLaunch rejects every tampered or stale preparation", async () =>
  withProtocol(async () => {
    const value = input();
    value.launch.initialBuy = "0.05";
    const prepared = await prepareLaunch(value, ORIGIN);
    const now = Date.now();
    assert.equal(parsePreparedLaunch(prepared, value, now), prepared);
    const tx = prepared.transaction!;
    const reject = (mutated: unknown, against: PrepareInput = value, at = now) =>
      assert.throws(
        () => parsePreparedLaunch(mutated, against, at),
        /invalid or outdated preparation/,
      );
    // expiry: already passed, and further out than the client accepts
    reject({ ...prepared, expiresAt: new Date(0).toISOString() });
    reject(prepared, value, Date.parse(prepared.expiresAt));
    reject({ ...prepared, expiresAt: new Date(now + 181_000).toISOString() });
    // fingerprint and form drift
    reject({ ...prepared, fingerprint: keccak256("0x01") });
    const changed = input();
    changed.launch.initialBuy = "0.05";
    changed.launch.creatorTaxBps++;
    reject(prepared, changed);
    // policy flags and terms
    for (const patch of [
      { canLaunch: false },
      { intentReady: false },
      { approved: false },
      { chainId: 1 },
      { forwarderReady: false },
      { maxCreatorTaxBps: 100 },
      { curveFeeBps: 101 },
      { expectedEconomics: blankSalt },
      { nativeBalance: "1" },
    ])
      reject({ ...prepared, policy: { ...prepared.policy, ...patch } });
    // quote numbers must equal the client's own recomputation
    reject({ ...prepared, quote: { ...prepared.quote, minTokensOut: "1" } });
    // transaction value, gas, target and calldata
    reject({ ...prepared, transaction: { ...tx, value: "999999999999999999999" } });
    reject({ ...prepared, transaction: { ...tx, gas: "0" } });
    reject({ ...prepared, transaction: { ...tx, gas: "30000001" } });
    reject({ ...prepared, transaction: { ...tx, to: PONS_FACTORY } });
    reject({ ...prepared, transaction: { ...tx, account: other } });
    reject({ ...prepared, approval: { token: other, spender: PONS_ROUTER, amount: "1", allowance: "0" } });
    reject({ ...prepared, simulation: "approval-required" });
    // a salt without the KELV prefix, even when re-encoded consistently
    const call = decodeLaunchCall(tx.to, tx.data, account);
    const normalized = validateLaunchRequest(value);
    const foreignSalt = `0x4b495454${call.params.salt.slice(10)}` as Hex;
    const foreign = encodeLaunchCall(
      account,
      normalized.launch,
      tokenParams(normalized.launch, prepared.policy.expectedEconomics, foreignSalt),
      prepared.quote,
    );
    reject({ ...prepared, transaction: { ...tx, data: foreign.data } });
    // calldata that differs from the re-encoded form in any parameter
    const lowered = encodeLaunchCall(
      account,
      normalized.launch,
      tokenParams(normalized.launch, prepared.policy.expectedEconomics, call.params.salt),
      { ...prepared.quote, minTokensOut: "0" },
    );
    reject({ ...prepared, transaction: { ...tx, data: lowered.data } });
    const otherName = encodeLaunchCall(
      account,
      normalized.launch,
      tokenParams({ ...normalized.launch, name: "Swapped" }, prepared.policy.expectedEconomics, call.params.salt),
      prepared.quote,
    );
    reject({ ...prepared, transaction: { ...tx, data: otherName.data } });
    reject(null);
    reject("prepared");
  }));

// ---------- receipt and launch index ----------
async function minedLaunch(
  run: (hash: Hex, prepared: PreparedLaunch) => Promise<void>,
  tweak: (chain: Chain) => void = () => {},
) {
  const value = input();
  value.launch.description = "Agent persona\nSpeaks in kelvin.";
  let prepared!: PreparedLaunch;
  await withProtocol(async () => {
    prepared = await prepareLaunch(value, ORIGIN);
  });
  const tx = prepared.transaction!;
  const hash = keccak256(tx.data);
  const blockHash = `0x${"b".repeat(64)}` as Hex;
  const blockNumber = "0xff";
  const launchLog = {
    address: PONS_FACTORY.toLowerCase(),
    topics: encodeEventTopics({
      abi: ponsFactoryAbi,
      eventName: "TokenLaunched",
      args: { token, curve, deployer: account },
    }),
    data: encodeAbiParameters(parseAbiParameters("address, uint256, uint256"), [
      NATIVE_QUOTE,
      0n,
      42n * 10n ** 17n,
    ]),
    blockHash,
    blockNumber,
    transactionHash: hash,
    logIndex: "0x0",
    removed: false,
  };
  const chain: Chain = {
    transactions: new Map([
      [
        hash,
        {
          hash,
          from: account,
          to: tx.to.toLowerCase(),
          input: tx.data,
          blockHash,
          blockNumber,
          chainId: "0x1237",
        },
      ],
    ]),
    receipts: new Map([
      [
        hash,
        {
          transactionHash: hash,
          from: account,
          to: tx.to.toLowerCase(),
          blockHash,
          blockNumber,
          status: "0x1",
          logs: [launchLog],
        },
      ],
    ]),
    blocks: new Map([
      [blockNumber, { hash: blockHash, timestamp: "0x" + Math.floor(fixtureClock / 1000).toString(16) }],
    ]),
    logs: [launchLog],
    launched: {
      name: value.launch.name,
      symbol: value.launch.symbol,
      info: [account, value.launch.logo, value.launch.description, value.launch.socials],
      record: {
        token,
        curve,
        deployer: account,
        creatorFeeRecipient: account,
        pairToken: NATIVE_QUOTE,
        graduationThreshold: 42n * 10n ** 17n,
        poolFee: 0,
        tickSpacing: 200,
        creatorTaxBps: value.launch.creatorTaxBps,
        buybackEnabled: false,
        phase: 0,
        sweptQuote: 0n,
        sweptTokens: 0n,
        sweptAt: 0n,
        exists: true,
      },
    },
  };
  tweak(chain);
  await withProtocol(async () => run(hash, prepared), { chain });
}
test("a mined Kelvo launch verifies in full and enters the launch index", async () =>
  minedLaunch(async (hash) => {
    const verified = await getReceipt(hash);
    assert.equal(verified.provenanceVerified, true);
    assert.equal(verified.token, token);
    assert.equal(verified.description, "Agent persona\nSpeaks in kelvin.");
    assert.equal(verified.socials.website, "https://example.com");
    assert.equal(verified.confirmations, "2");
    const index = await listLaunches();
    assert.equal(index.status, "live");
    assert.equal(index.items.length, 1);
    assert.equal(index.items[0].hash, hash);
    assert.equal(index.coverage.scannedTransactions, 1);
    await assert.rejects(listLaunches("bad"), { code: "INVALID_INPUT" });
  }));
test("receipt states: pending, reverted, wrong secret and edited metadata", async () => {
  await minedLaunch(
    async (hash) => {
      await assert.rejects(getReceipt(hash), { code: "PENDING", status: 409 });
    },
    (chain) => chain.receipts.clear(),
  );
  await minedLaunch(
    async (hash) => {
      await assert.rejects(getReceipt(hash), { code: "REVERTED", status: 422 });
    },
    (chain) => chain.receipts.forEach((receipt) => (receipt.status = "0x0")),
  );
  await minedLaunch(
    async (hash) => {
      await assert.rejects(getReceipt(hash), { code: "INVALID_RECEIPT" });
    },
    (chain) => (chain.launched!.name = "Renamed"),
  );
  await minedLaunch(async (hash) => {
    process.env.KELVO_INTENT_SECRET = randomBytes(32).toString("hex");
    await assert.rejects(getReceipt(hash), { code: "PROVENANCE_NOT_VERIFIED" });
  });
  await assert.rejects(getReceipt("0x1234"), { code: "INVALID_INPUT" });
});

// ---------- HTTP handler ----------
function call(
  method: string,
  path: string,
  options: { origin?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const req: any = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  req.method = method;
  req.url = path;
  req.headers = {
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...options.headers,
  };
  const headers: Record<string, string> = {};
  let text = "";
  const res: any = {
    statusCode: 200,
    headersSent: false,
    setHeader: (key: string, value: string) => (headers[key.toLowerCase()] = value),
    end: (chunk?: string) => (text += chunk ?? ""),
  };
  return handler(req, res).then(() => ({
    status: res.statusCode as number,
    headers,
    json: text ? JSON.parse(text) : null,
  }));
}
test("handler: origin allowlist, method, body limit and error shape", async () =>
  withProtocol(async (calls) => {
    const body = JSON.stringify(input());
    let r = await call("POST", "/api/launch?action=prepare", { origin: "https://evil.example", body });
    assert.equal(r.status, 403);
    assert.deepEqual(Object.keys(r.json).sort(), ["code", "error"]);
    assert.equal(r.json.code, "ORIGIN_REJECTED");
    r = await call("POST", "/api/launch?action=prepare", { body });
    assert.equal(r.status, 403);
    r = await call("GET", "/api/launch?action=prepare", { origin: ORIGIN });
    assert.equal(r.status, 405);
    r = await call("POST", "/api/launch?action=policy", { origin: ORIGIN, body });
    assert.equal(r.status, 405);
    r = await call("POST", "/api/launch?action=prepare", {
      origin: ORIGIN,
      body: JSON.stringify({ ...input(), padding: "x".repeat(33 * 1024) }),
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "BODY_TOO_LARGE");
    r = await call("POST", "/api/launch?action=prepare", {
      origin: ORIGIN,
      body,
      headers: { "content-type": "text/plain" },
    });
    assert.equal(r.status, 415);
    r = await call("GET", "/api/launch?action=nope");
    assert.equal(r.status, 400);
    assert.equal(calls.length, 0);
    r = await call("POST", "/api/launch?action=prepare", { origin: ORIGIN, body });
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.json.simulation, "passed");
    r = await call("GET", `/api/launch?action=policy&account=${account}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.account, account);
    r = await call("GET", "/api/launch?action=pair&address=0x0000000000000000000000000000000000000000");
    assert.equal(r.json.approval, "approved");
    r = await call("GET", "/api/launch?action=receipt&hash=0x12");
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "INVALID_INPUT");
  }));

// ---------- copy hygiene ----------
test("launch sources name no other project, data vendor or numeric chain id in user-facing text", () => {
  const files = [
    "server/launch.ts",
    "server/pair.ts",
    "server/source.ts",
    "server/launches.ts",
    "api/launch.ts",
    "src/launch/pons.ts",
    "src/launch/types.ts",
    "src/launch/launch-client.ts",
    "src/launch/pending-launch.ts",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /gecko|coingecko|dexscreener/i, file);
    if (privatePattern) assert.doesNotMatch(source, privatePattern, file);
    assert.doesNotMatch(source, /["'`][^"'`\n]*\b4663\b[^"'`\n]*["'`]/, file);
  }
});
