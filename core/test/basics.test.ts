/**
 * PRNG, hash, time and formatting vectors. The PRNG and FNV vectors are the ones in
 * contracts/tests/test_rules.py (produced by Node/V8), so both languages are pinned to one sequence.
 */
import { describe, expect, it } from "vitest";
import {
  allLooksText,
  days,
  derive,
  fmtDt,
  fnv1a32,
  inGap,
  looksText,
  mulberry32,
  parseMs,
  passesText,
  pct,
  pctDown,
  sha256Hex,
  stageOf,
  timesText,
} from "../src/index.ts";

const NODE_MULBERRY32: Record<number, number[]> = {
  0: [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086, 0.5450490827206522],
  1: [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849, 0.281103502959013],
  42: [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423, 0.5265925421845168],
  20261114: [0.12950722174718976, 0.38213343149982393, 0.757204532623291, 0.19665818405337632, 0.23901733267121017, 0.2118300348520279],
  4294967295: [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489, 0.5391399988438934],
};
const NODE_FNV: Record<string, number> = {
  "": 2166136261,
  a: 3826002220,
  "20261114|awd": 2843749852,
  "20261114|cf": 736015121,
  mudskipper: 4238351173,
};
const STAGES = { mid_start: "2026-07-15", late_start: "2026-09-10" };

describe("mulberry32 / fnv1a32 / derive", () => {
  it("matches the V8 vectors", () => {
    for (const [seed, expected] of Object.entries(NODE_MULBERRY32)) {
      const rng = mulberry32(Number(seed));
      expect(expected.map(() => rng())).toEqual(expected);
    }
  });

  it("reduces seeds mod 2^32 like Python's seed & 0xFFFFFFFF", () => {
    const a = mulberry32(2 ** 32 + 42);
    const b = mulberry32(42);
    const c = mulberry32(-1);
    const d = mulberry32(4294967295);
    for (let i = 0; i < 5; i++) {
      expect(a()).toBe(b());
      expect(c()).toBe(d());
    }
    expect(() => mulberry32(1.5)).toThrow(RangeError);
  });

  it("returns values in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 10000; i++) {
      const u = rng();
      expect(u >= 0 && u < 1).toBe(true);
    }
  });

  it("fnv1a32 matches the V8 vectors and hashes UTF-8 bytes", () => {
    for (const [text, expected] of Object.entries(NODE_FNV)) expect(fnv1a32(text)).toBe(expected);
    expect(derive(20261114, "awd")).toBe(NODE_FNV["20261114|awd"]);
    expect(derive(20261114, "cf")).toBe(NODE_FNV["20261114|cf"]);
    // "é" is two UTF-8 bytes (0xC3 0xA9): FNV over bytes, not UTF-16 code units
    let h = 0x811c9dc5;
    for (const b of [0xc3, 0xa9]) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    expect(fnv1a32("é")).toBe(h);
  });
});

describe("time", () => {
  it("days() matches V8's Date.parse / 86400000", () => {
    expect(days("2026-06-23T13:47:34Z")).toBe(20627.574699074074);
    expect(days("2026-06-05")).toBe(20609.0);
    expect(parseMs("2026-06-23T13:47:34Z")).toBe(Date.parse("2026-06-23T13:47:34Z"));
  });

  it("fmtDt round-trips and floors to whole seconds", () => {
    for (const dt of ["2026-06-23T13:47:34Z", "2026-12-31T23:59:59Z", "2026-01-01T00:00:00Z"]) {
      expect(fmtDt(parseMs(dt))).toBe(dt);
    }
    expect(fmtDt(parseMs("2026-06-23T13:47:34Z") + 999)).toBe("2026-06-23T13:47:34Z");
    expect(fmtDt(-1)).toBe("1969-12-31T23:59:59Z"); // floored, as Python's ms - ms % 1000
    expect(() => fmtDt(1.5)).toThrow(RangeError);
  });

  it("parses fractional seconds by flooring to ms and rejects everything outside C0", () => {
    expect(parseMs("2026-06-23T13:47:34.1239Z")).toBe(parseMs("2026-06-23T13:47:34Z") + 123);
    for (const bad of ["2026-06-23T13:47:34", "2026-06-23 13:47:34Z", "2026-06-23T13:47Z", "2026-02-30", "2026-13-01", "2026-06-23T24:00:00Z", "2026-6-1", "2026-06-23T13:47:34+00:00"]) {
      expect(() => parseMs(bad), bad).toThrow(RangeError);
    }
    expect(parseMs("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
  });

  it("stages and closed gap intervals", () => {
    expect(stageOf("2026-07-14T23:59:59Z", STAGES)).toBe("early");
    expect(stageOf("2026-07-15T00:00:00Z", STAGES)).toBe("mid");
    expect(stageOf("2026-09-10T00:00:00Z", STAGES)).toBe("late");
    const gap = [{ start: "2026-07-27T22:03:25Z", end: "2026-08-10T00:55:27Z" }];
    expect(inGap("2026-07-27T22:03:25Z", gap)).toBe(true);
    expect(inGap("2026-08-10T00:55:27Z", gap)).toBe(true);
    expect(inGap("2026-08-10T13:47:34Z", gap)).toBe(false); // real descending pass just after the gap
    expect(inGap("2026-07-27T22:03:24Z", gap)).toBe(false);
  });
});

describe("formatting", () => {
  it("pct rounds half up", () => {
    expect([0, 0.004, 0.005, 0.125, 0.5, 0.995, 1].map(pct)).toEqual([0, 0, 1, 13, 50, 100, 100]);
  });

  it("pctDown never rounds a value just under a bar up to it", () => {
    expect(pctDown(0.8999)).toBe(89);
    expect(pctDown(0.9)).toBe(90);
    expect(pctDown(0.29)).toBe(29); // 100 * 0.29 = 28.999999999999996
    expect(pct(0.29)).toBe(29);
  });

  it("words", () => {
    expect([looksText(1), looksText(0), looksText(6)]).toEqual(["1 clear look", "0 clear looks", "6 clear looks"]);
    expect([allLooksText(1), allLooksText(4)]).toEqual(["the only clear look", "all 4 clear looks"]);
    expect([passesText(1), passesText(10)]).toEqual(["1 pass", "10 passes"]);
    expect([timesText(1), timesText(2), timesText(3), timesText(4)]).toEqual(["once", "twice", "3 times", "4 times"]);
  });
});

describe("sha256Hex", () => {
  it("hashes strings as UTF-8 and bytes as given", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(await sha256Hex("abc"));
    expect(await sha256Hex(new TextEncoder().encode("abc").buffer)).toBe(await sha256Hex("abc"));
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
