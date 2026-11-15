import { describe, expect, it } from "vitest";
import { JUDGES } from "../src/index.ts";

const ROUTES = ["/lab", "/evidence", "/map", "/?tour=1", "/scarecrow", "/methods"];
const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|once|twice|half|dozen)\b/gi;

describe("JUDGES (/judges and the README table)", () => {
  it("has the five WIN_GUIDE §8 criteria in order, each with one sentence and one app route", () => {
    expect(JUDGES.map((j) => j.criterion)).toEqual(["Impact", "Creativity", "Validity", "Relevance", "Presentation"]);
    for (const j of JUDGES) {
      expect(ROUTES).toContain(j.href);
      expect(j.sentence.trim().split(/[.!?](\s|$)/).filter((s) => s.trim()).length, j.id).toBe(1);
      expect(j.sentence.endsWith(".")).toBe(true);
      expect(j.linkLabel.length).toBeGreaterThan(0);
    }
    expect(new Set(JUDGES.map((j) => j.href)).size).toBe(5);
  });

  it("uses the corrected Impact wording (DECISIONS.md F-001)", () => {
    const impact = JUDGES[0]!;
    expect(impact.shows).toContain("rice methane credits contracted in 2026");
    expect(impact.shows).not.toContain("1.5M");
    expect(impact.shows).not.toContain("committed");
  });

  it("tags every number it shows (T12); years are dates, not quantities", () => {
    for (const j of JUDGES) {
      const text = `${j.shows} ${j.sentence}`;
      for (const n of j.numbers) {
        expect(text, `${j.id}: ${n.text}`).toContain(n.text);
        expect(["OBSERVED", "INFERRED", "ASSUMED"]).toContain(n.tag);
        expect(n.source.citation.length).toBeGreaterThan(0);
      }
      let rest = text;
      for (const n of j.numbers) rest = rest.split(n.text).join(" ");
      rest = rest.replace(/\b20\d\d\b/g, " ").replace(/NASA-ISRO/g, " ");
      expect(rest.match(/\d/g), `${j.id}: untagged digits in "${rest}"`).toBeNull();
      expect(rest.match(NUMBER_WORDS), `${j.id}: untagged number words`).toBeNull();
    }
  });

  it("follows SPEC D5 wording", () => {
    for (const j of JUDGES) {
      for (const banned of ["fraud", "cheat", "proof of"]) expect(`${j.shows} ${j.sentence}`.toLowerCase()).not.toContain(banned);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(JUDGES)).toBe(true);
    expect(Object.isFrozen(JUDGES[0])).toBe(true);
    expect(Object.isFrozen(JUDGES[0]!.numbers[0]!.source)).toBe(true);
  });
});
