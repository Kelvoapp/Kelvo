import type { Address, Hex } from "viem";

// Shapes shared by the launch server, the /api/launch handler and the browser client.
// Every amount is a decimal string in base units; null means unknown, never zero.

export type LaunchSocials = {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
};
export type LaunchRequest = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: LaunchSocials;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  pairToken: Address;
  initialBuy: string;
  slippageBps: number;
  configId: number;
};
export type PrepareInput = { account: Address; launch: LaunchRequest };
export type TokenParams = Pick<
  LaunchRequest,
  | "name"
  | "symbol"
  | "logo"
  | "description"
  | "socials"
  | "creatorFeeRecipient"
  | "creatorTaxBps"
  | "buybackEnabled"
> & { expectedEconomics: Hex; salt: Hex };
export type LaunchPolicy = {
  status: "live";
  chainId: 4663;
  account: Address | null;
  pairToken: Address;
  configId: number;
  checkedAt: string;
  blockNumber: string;
  canLaunch: boolean | null;
  enabled: boolean;
  approved: boolean;
  decimals: number;
  launchFee: string;
  maxCreatorTaxBps: number;
  curveFeeBps: number;
  hookFeeBps: number;
  supply: string;
  phantomQuote: string;
  graduationThreshold: string;
  expectedEconomics: Hex;
  nativeBalance: string | null;
  quoteBalance: string | null;
  allowance: string | null;
  forwarderReady: boolean;
  intentReady: boolean;
};
export type InitialBuyQuote = {
  quoteIn: string;
  spent: string;
  refund: string;
  tokensOut: string;
  minTokensOut: string;
  fee: string;
  creatorTax: string;
  decimals: number;
};
export type LaunchTransaction = {
  chainId: 4663;
  account: Address;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
};
export type LaunchApproval = {
  token: Address;
  spender: Address;
  amount: string;
  allowance: string;
};
export type PreparedLaunch = {
  fingerprint: Hex;
  expiresAt: string;
  policy: LaunchPolicy;
  quote: InitialBuyQuote;
  simulation: "passed" | "approval-required";
  transaction: LaunchTransaction | null;
  approval: LaunchApproval | null;
};
export type VerifiedLaunch = {
  chainId: 4663;
  hash: Hex;
  token: Address;
  curve: Address;
  account: Address;
  creator: Address;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: LaunchSocials;
  pair: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  configId: number;
  blockNumber: string;
  blockHash: Hex;
  blockTime: string;
  checkedAt: string;
  confirmations: string;
  provenanceVerified: true;
  quoteSpent: string;
  tokensReceived: string;
};
export type LaunchCoverage = {
  fromBlock: string | null;
  toBlock: string | null;
  nextBefore: string | null;
  partial: boolean;
  scannedTransactions: number;
};
export type LaunchIndex = {
  items: VerifiedLaunch[];
  capturedAt: string | null;
  status: "live" | "cached" | "unavailable";
  error: string | null;
  coverage: LaunchCoverage;
};
export type PairCheck = {
  address: Address;
  approval: "approved" | "rejected";
  status: "live" | "cached";
  checkedAt: string;
  blockNumber: string;
  economics: {
    phantomQuote: string;
    graduationThreshold: string;
    decimals: number;
  } | null;
  error: string | null;
};
export type DecodedLaunch = {
  params: TokenParams;
  configId: bigint;
  pairToken: Address;
  quoteIn: bigint;
  minTokensOut: bigint;
  recipient: Address;
  to: Address;
};
export type LaunchErrorCode =
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "PROTOCOL_CHANGED"
  | "CONFIG_UNAVAILABLE"
  | "PAIR_UNAVAILABLE"
  | "PAIR_CHANGED"
  | "LAUNCH_NOT_ALLOWED"
  | "TAX_TOO_HIGH"
  | "BUY_TOO_SMALL"
  | "INSUFFICIENT_ETH"
  | "INSUFFICIENT_QUOTE"
  | "INSUFFICIENT_GAS"
  | "GAS_UNAVAILABLE"
  | "APPROVAL_REJECTED"
  | "ROUTER_UNAVAILABLE"
  | "QUOTE_MISMATCH"
  | "SIMULATION_REJECTED"
  | "PENDING"
  | "CONFIRMING"
  | "REORG"
  | "REVERTED"
  | "INVALID_RECEIPT"
  | "PROVENANCE_NOT_VERIFIED"
  | "UNSUPPORTED_TRANSACTION"
  | "INTENT_NOT_CONFIGURED"
  | "LAUNCH_UNAVAILABLE"
  | "ORIGIN_REJECTED"
  | "METHOD_NOT_ALLOWED"
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE";
