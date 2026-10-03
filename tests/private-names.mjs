// Names Kelvo must never show (other projects, a model host). The list stays out of the public repository in
// .private/banned-names.json; without it the checks that use it have nothing extra to look for.
import { existsSync, readFileSync } from "node:fs";

const file = new URL("../.private/banned-names.json", import.meta.url);
export const PRIVATE_NAMES = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One case-insensitive pattern for every private name, or null when there is no list. */
export const privatePattern = PRIVATE_NAMES.length ? new RegExp(PRIVATE_NAMES.map(escape).join("|"), "i") : null;
