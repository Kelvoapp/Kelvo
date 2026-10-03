import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getPolicy,
  getReceipt,
  isAllowedOrigin,
  prepareLaunch,
} from "../server/launch.js";
import { getPair } from "../server/pair.js";
import { listLaunches, rememberLaunch } from "../server/launches.js";
import { LaunchError } from "../server/source.js";

// One function for token launches: policy, receipt, pair, launches (GET) and prepare (POST from the site only).
const BODY_LIMIT = 32 * 1024;
type Request = IncomingMessage & { body?: unknown };

const readBody = (req: Request): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const tooLarge = () =>
      new LaunchError("Request too large.", 413, "BODY_TOO_LARGE");
    const invalid = () => new LaunchError("Invalid JSON.", 400, "INVALID_INPUT");
    if (req.body !== undefined && req.body !== null && req.body !== "") {
      const text =
        typeof req.body === "string"
          ? req.body
          : Buffer.isBuffer(req.body)
            ? req.body.toString("utf8")
            : JSON.stringify(req.body);
      if (Buffer.byteLength(text) > BODY_LIMIT) return reject(tooLarge());
      if (typeof req.body === "object" && !Buffer.isBuffer(req.body))
        return resolve(req.body);
      try {
        return resolve(JSON.parse(text));
      } catch {
        return reject(invalid());
      }
    }
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > BODY_LIMIT) return reject(tooLarge());
    const parts: Buffer[] = [];
    let size = 0,
      done = false;
    req.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const part = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += part.length;
      if (size > BODY_LIMIT) {
        done = true;
        reject(tooLarge());
        return;
      }
      parts.push(part);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(parts).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(invalid());
      }
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });

const send = (
  res: ServerResponse,
  status: number,
  data: unknown,
  cache = "no-store",
) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(data));
};
const text = (value: string | null) => (value === null ? undefined : value);

export default async function handler(req: Request, res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const url = new URL(req.url || "/", "http://localhost");
  const q = url.searchParams;
  const action = q.get("action");
  try {
    if (action === "prepare") {
      if (req.method !== "POST")
        throw new LaunchError("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
      const origin = req.headers.origin;
      if (!isAllowedOrigin(origin))
        throw new LaunchError(
          "Launch preparation is only available from the Kelvo site.",
          403,
          "ORIGIN_REJECTED",
        );
      if (!/^application\/json/i.test(req.headers["content-type"] || ""))
        throw new LaunchError("Send JSON.", 415, "UNSUPPORTED_MEDIA_TYPE");
      const body = await readBody(req);
      return send(res, 200, await prepareLaunch(body, origin as string));
    }
    if (req.method !== "GET")
      throw new LaunchError("Method not allowed.", 405, "METHOD_NOT_ALLOWED");
    if (action === "policy")
      return send(
        res,
        200,
        await getPolicy({
          pairToken: text(q.get("pairToken")),
          account: text(q.get("account")),
          configId: text(q.get("configId")),
        }),
      );
    if (action === "receipt") {
      const launch = await getReceipt(q.get("hash"));
      rememberLaunch(launch);
      return send(res, 200, launch);
    }
    if (action === "pair")
      return send(
        res,
        200,
        await getPair(q.get("address")),
        "public, s-maxage=30, stale-while-revalidate=60",
      );
    if (action === "launches") {
      const index = await listLaunches(text(q.get("before")));
      return send(
        res,
        200,
        index,
        index.status === "unavailable"
          ? "no-store"
          : "public, s-maxage=30, stale-while-revalidate=60",
      );
    }
    throw new LaunchError("Unknown action.", 400, "INVALID_INPUT");
  } catch (error) {
    if (res.headersSent) return void res.end();
    if (error instanceof LaunchError)
      return send(res, error.status, { error: error.message, code: error.code });
    console.error("launch api:", error instanceof Error ? error.message : error);
    return send(res, 500, {
      error: "The launch service could not complete this request.",
      code: "LAUNCH_UNAVAILABLE",
    });
  }
}
