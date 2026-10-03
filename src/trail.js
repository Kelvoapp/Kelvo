// The trail ΔT: how far a planned private withdrawal stands out from its pool. Shared by the agent and the cold side.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, d = 6) => (v == null ? null : Number(v.toPrecision(d)));

// Like a thermal camera, what matches the background disappears: each check that stands out warms the trail.
export const TRAIL_K = Object.freeze({ pass: 0, warn: 15, risk: 40, unknown: 5 });
/**
 * Rules of thumb for a planned private withdrawal, with the live fee and the trail ΔT. Pure: the config and activity are passed in.
 * Levels: pass, warn, risk, block, unknown. A block has no ΔT: the withdrawal would not go through.
 */
export function withdrawCheck(input, config, activity) {
  const token = input?.token === "usdg" ? "usdg" : "eth", sym = token.toUpperCase();
  const raw = String(input?.amount ?? "").trim();
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(raw) || !(Number(raw) > 0)) throw Object.assign(new Error("Give the amount as a plain number, like 0.1."), { status: 400 });
  const amount = Number(raw), rate = num(config?.fee_rate), flat = num(config?.rent_fees?.[token]), min = num(config?.minimum_withdrawal?.[token]);
  const fee = rate != null && flat != null ? flat + (amount * rate) / 10000 : null;
  const checks = [];
  checks.push(min == null ? { id: "minimum", level: "unknown", title: "Minimum unknown", detail: "The pool minimum could not be read." }
    : amount >= min ? { id: "minimum", level: "pass", title: `Above the ${min} ${sym} minimum`, detail: "The relay accepts this amount." }
    : { id: "minimum", level: "block", title: `Below the ${min} ${sym} minimum`, detail: `The relay takes withdrawals from ${min} ${sym}.` });
  if (fee != null && amount <= fee) checks.push({ id: "fee", level: "block", title: "The fee is larger than the amount", detail: "Nothing would arrive." });
  const places = (raw.split(".")[1] || "").replace(/0+$/, "").length, roundPlaces = token === "eth" ? 2 : 0;
  checks.push(places <= roundPlaces ? { id: "shape", level: "pass", title: "A common amount", detail: "Round amounts are shared by many notes, so they blend in." }
    : { id: "shape", level: "warn", title: "An unusual amount", detail: `${raw} ${sym} stands out. A round amount like ${token === "eth" ? Number(raw).toFixed(roundPlaces) : Math.round(amount)} ${sym} blends in better.` });
  const dep = input?.deposit_amount != null && /^\d{1,9}(\.\d{1,18})?$/.test(String(input.deposit_amount).trim()) ? Number(input.deposit_amount) : null;
  checks.push(dep == null ? { id: "match", level: "unknown", title: "Deposit amount not given", detail: "Withdrawing exactly what was deposited links the two." }
    : Math.abs(dep - amount) <= Math.max(dep, amount) * 0.005 ? { id: "match", level: "risk", title: "Same amount as the deposit", detail: `A ${dep} ${sym} deposit followed by a ${raw} ${sym} withdrawal is easy to pair. Withdraw a different amount or split it.` }
    : { id: "match", level: "pass", title: "Different from the deposit", detail: "The withdrawal does not mirror the deposit amount." });
  const hours = num(input?.hours_since_deposit);
  checks.push(hours == null ? { id: "timing", level: "unknown", title: "Timing not given", detail: "A withdrawal soon after its deposit is easy to pair." }
    : hours < 1 ? { id: "timing", level: "risk", title: "Within the hour of the deposit", detail: "Few other notes arrive in between, so timing alone can pair them. Wait longer." }
    : hours < 24 ? { id: "timing", level: "warn", title: `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"} after the deposit`, detail: "More time lets more notes pass through the pool. A day or more is safer." }
    : { id: "timing", level: "pass", title: `${Math.round(hours)} hours after the deposit`, detail: "Plenty of pool activity in between." });
  const fresh = typeof input?.to_new_address === "boolean" ? input.to_new_address : null;
  checks.push(fresh == null ? { id: "recipient", level: "unknown", title: "Recipient not given", detail: "Sending to the wallet that deposited links them directly." }
    : fresh ? { id: "recipient", level: "pass", title: "A fresh recipient", detail: "The address has no history with the depositing wallet." }
    : { id: "recipient", level: "risk", title: "Back to a linked wallet", detail: "Withdrawing to the wallet that deposited, or one it funded, undoes the privacy. Use a fresh address." });
  const a = activity?.[token];
  checks.push(a?.notes24h == null ? { id: "crowd", level: "unknown", title: "Pool activity unknown", detail: "The pool counter could not be read." }
    : a.notes24h < 20 ? { id: "crowd", level: "warn", title: `${a.notes24h} new notes in 24 hours`, detail: `A quiet pool gives fewer notes to blend with. ${a.notes} notes in total.` }
    : { id: "crowd", level: "pass", title: `${a.notes24h} new notes in 24 hours`, detail: `${a.notes.toLocaleString("en-US")} notes in the ${sym} pool in total.` });
  const counted = checks.filter((c) => c.level !== "unknown");
  const deltaK = checks.some((c) => c.level === "block") ? null : checks.reduce((k, c) => k + (TRAIL_K[c.level] ?? 0), 0);
  return {
    token, symbol: sym, amount: raw, feeRateBps: rate, flatFee: flat, fee: fee == null ? null : round(fee), receive: fee == null ? null : round(Math.max(0, amount - fee)),
    minimum: min, checks, passed: counted.filter((c) => c.level === "pass").length, of: counted.length,
    deltaK, deltaRule: "trail ΔT = 40 K per risk + 15 K per warning + 5 K per unknown; 0 K blends in with the pool",
    note: "Rules of thumb from public patterns. Privacy is not anonymity, and these checks are not a guarantee.",
  };
}
