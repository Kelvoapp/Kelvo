import { FeedError, getHeat } from "../server/heat.js";
import { getTape } from "../server/tape.js";

// Every Robinhood Chain token on the board with its temperature in kelvin, hottest first.
// ?action=tape[&since=<block>]: the board's newest trades as they land on chain.
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") { res.statusCode = 405; res.end(JSON.stringify({ error: "Method not allowed." })); return; }
  const q = new URL(req.url || "/", "http://localhost").searchParams;
  const action = q.get("action");
  try {
    if (action === "tape") {
      const since = q.get("since");
      if (since != null && !/^\d{1,12}$/.test(since)) { res.statusCode = 400; res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify({ error: "since must be a block number." })); return; }
      const data = await getTape({ sinceBlock: since == null ? undefined : Number(since) });
      res.setHeader("Cache-Control", "public, s-maxage=3, stale-while-revalidate=6");
      res.end(JSON.stringify(data));
      return;
    }
    if (action) { res.statusCode = 400; res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify({ error: "Unknown action." })); return; }
    const data = await getHeat();
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=90");
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = e instanceof FeedError ? e.status : 500;
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: e instanceof FeedError ? e.message : "The heat reader could not complete this request." }));
  }
}
