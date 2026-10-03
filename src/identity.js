// Kelvo's identity. Null until the owner gives it: never invent a contract, socials or a domain.
export const IDENTITY = Object.freeze({ name: 'Kelvo', ticker: '$KELVO', contract: '0x911fc0efa2219152e42faa8282697edbd4d28830', repo: 'https://github.com/Kelvoapp/Kelvo', site: 'https://kelvo.lat', x: null, telegram: null });
// The holding that opens the agent and the cold side, in US dollars. Null until the owner sets it and the contract exists.
export const HOLDER_MIN_USD = null;
