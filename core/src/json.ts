/**
 * Writing contract JSON (CONTRACTS.md C0): UTF-8, LF, finite numbers only, deterministic layout.
 * Key order is the insertion order of the objects core builds, which follows the schemas.
 */

function assertFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`non-finite number at ${path} (C0: finite numbers only)`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertFinite(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
  }
}

/** Pretty JSON (2-space indent) plus a final LF. Throws on NaN or ±Infinity instead of writing `null`. */
export function dumpJson(value: unknown): string {
  assertFinite(value, "$");
  return JSON.stringify(value, null, 2) + "\n";
}

/** One compact JSON value per line, each ending in LF (`*.jsonl`). */
export function dumpJsonl(rows: Iterable<unknown>): string {
  let out = "";
  for (const row of rows) {
    assertFinite(row, "$");
    out += JSON.stringify(row) + "\n";
  }
  return out;
}

/** `states.json` with the header compact and one field per line, as contracts/make_fixtures.py lays it out. */
export function dumpStates(doc: { readonly states: ReadonlyArray<string> } & Record<string, unknown>): string {
  const { states, ...head } = doc;
  assertFinite(head, "$");
  const h = JSON.stringify(head);
  return h.slice(0, -1) + ',"states":[\n' + states.map((s) => JSON.stringify(s)).join(",\n") + "\n]}\n";
}

/** Parse `*.jsonl` text: one value per non-empty line. A blank line in the middle is an error (as in validate.py). */
export function parseJsonl<T = unknown>(text: string): T[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, i) => {
    if (line.trim() === "") throw new SyntaxError(`blank line ${i + 1} in JSONL`);
    return JSON.parse(line) as T;
  });
}
