/**
 * Runtime boundaries: the main entry and `@mudskipper/core/client` must load in browsers and workerd, so
 * nothing they import (transitively) may touch `node:` modules, Vite's `import.meta.glob`, or any package
 * (zero runtime dependencies). The fixture loaders are separate entry points.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url);
// Source without block comments and whole-line `//` comments (doc examples mention other entry points).
const read = (file: string): string =>
  readFileSync(new URL(file, SRC), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const specifiers = (code: string): string[] =>
  [...code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g), ...code.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);

function closure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const code = read(file);
    seen.set(file, code);
    for (const spec of specifiers(code)) {
      expect(spec.startsWith("./"), `${file} imports ${spec}: core has no runtime dependencies`).toBe(true);
      expect(spec.endsWith(".ts"), `${file} imports ${spec} without .ts (Node type stripping needs it)`).toBe(true);
      stack.push(spec.slice(2));
    }
  }
  return seen;
}

describe("entry points", () => {
  for (const entry of ["index.ts", "client.ts"]) {
    it(`${entry} reaches no Node or Vite APIs`, () => {
      const files = closure(entry);
      expect(files.size).toBeGreaterThan(1);
      for (const [file, code] of files) {
        expect(file).not.toMatch(/^fixtures-/);
        expect(code, file).not.toMatch(/from\s+"node:/);
        expect(code, file).not.toContain("import.meta.glob");
        expect(code, file).not.toMatch(/\bprocess\.|\bBuffer\b|\brequire\(/);
      }
    });
  }

  it("fixtures-vite.ts uses no Node APIs; fixtures-node.ts no Vite APIs", () => {
    const vite = closure("fixtures-vite.ts");
    for (const [file, code] of vite) expect(code, file).not.toMatch(/from\s+"node:/);
    expect(read("fixtures-node.ts")).not.toContain("import.meta.glob");
  });

  it("package.json declares no runtime dependencies and exports every entry", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(Object.keys(pkg.exports).sort()).toEqual(
      [".", "./client", "./contracts", "./fixtures-node", "./fixtures-vite", "./package.json"].sort(),
    );
  });
});
