// The agent's sign-in message, built the same way in the browser and on the server. It opens the agent for one wallet;
// it is not a transaction and is not the privacy protocol's own sign-in message.
export const AGENT_SIGN_IN = 'Kelvo agent sign in';
export const AGENT_SESSION_HOURS = 6;
export const AGENT_MAX_INPUT = 1200;

export function agentSignInMessage(account, issued, nonce) {
  return `${AGENT_SIGN_IN}\nWallet: ${account}\nIssued: ${issued}\nNonce: ${nonce}\n\nThis signature opens the Kelvo agent for this wallet. It is not a transaction and cannot move funds.`;
}

export const SUGGESTIONS = [
  'What are the five hottest tokens right now?',
  'Which tokens went cold today?',
  'Why is the hottest token that hot?',
  'Check my plan: deposit 0.137 ETH, withdraw it in an hour to my own wallet',
];
