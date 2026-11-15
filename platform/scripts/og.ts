#!/usr/bin/env node
/**
 * Render the link-preview image and the raster icons from original artwork (SPEC D2/D3/D7; no NASA logos).
 *
 *   node scripts/og.ts    # writes placeholder/og.png (1200×630), apple-touch-icon.png (180), favicon-48.png (48)
 *
 * The preview is an HTML card (written to placeholder/og.html for the render, then removed) that uses the same self-hosted woff2
 * fonts as the site, screenshotted by headless Chrome at exactly 1200×630 and recompressed by sharp. (libvips'
 * own text rendering cannot load custom fonts on macOS, so it would silently fall back to a system font.)
 * Set CHROME_PATH if Chrome is not in a standard place. The decoration is drawn from a seeded PRNG and carries
 * no numbers. Outputs are committed; rerun after changing the artwork.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { PLATFORM_ROOT } from "./lib/run.ts";

const OUT = join(PLATFORM_ROOT, "placeholder");

/** SPEC D2 palette. */
export const PALETTE = {
  night: "#0E1A1F",
  bank: "#16262D",
  silt: "#2C3E46",
  paper: "#EAE6DA",
  reed: "#9FB0A8",
  water: "#3FA7D6",
  mud: "#C98B4E",
  haze: "#8A8F98",
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decorative season strip: one column per 12-day pass, a hatched data-gap column. Not data; no numbers. */
export function mosaicSvg(cols: number, rows: number, cell: number, gap: number): string {
  const rnd = mulberry32(20261114);
  const w = cols * (cell + gap) - gap;
  const h = rows * (cell + gap) - gap;
  const out: string[] = [];
  const gapCol = 4;
  for (let c = 0; c < cols; c++) {
    const x = c * (cell + gap);
    if (c === gapCol) {
      out.push(`<rect x="${x}" y="0" width="${cell}" height="${h}" rx="3" fill="url(#hatch)"/>`);
      continue;
    }
    const pFlood = c < gapCol ? 0.78 : c < 8 ? 0.45 : 0.18;
    for (let r = 0; r < rows; r++) {
      const u = rnd();
      const fill = u < 0.1 ? "url(#hatch)" : u < 0.1 + 0.9 * pFlood ? PALETTE.water : PALETTE.mud;
      const op = (0.55 + 0.45 * rnd()).toFixed(2);
      out.push(`<rect x="${x}" y="${r * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${fill}" fill-opacity="${op}"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="6" height="6" fill="${PALETTE.night}"/><rect width="2" height="6" fill="${PALETTE.haze}" fill-opacity="0.55"/>` +
    `</pattern></defs>${out.join("")}</svg>`
  );
}

function ogHtml(): string {
  const mark = readFileSync(join(OUT, "favicon.svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mudskipper link preview</title>
<style>
@font-face{font-family:Fraunces;src:url(fonts/fraunces-latin.woff2) format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"IBM Plex Sans";src:url(fonts/plex-sans-latin.woff2) format("woff2");font-weight:100 700;font-display:block}
@font-face{font-family:"IBM Plex Mono";src:url(fonts/plex-mono-500-latin.woff2) format("woff2");font-weight:500;font-display:block}
*{margin:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden;background:${PALETTE.night};color:${PALETTE.paper}}
.card{position:relative;width:1200px;height:630px;display:grid;grid-template-columns:740px 460px}
.left{padding:64px 72px 0}
.brand{display:flex;align-items:center;gap:22px}
.brand svg{width:96px;height:96px}
.brand span{font:600 30px/1 "IBM Plex Sans";letter-spacing:.2em}
h1{margin-top:34px;font:600 72px/1.04 Fraunces;font-variation-settings:"opsz" 144;letter-spacing:-.01em;max-width:600px}
p{margin-top:30px;font:400 27px/1.32 "IBM Plex Sans";color:${PALETTE.reed};max-width:600px}
.tag{margin-top:18px;font:600 27px/1 "IBM Plex Sans";color:${PALETTE.water}}
.foot{position:absolute;left:72px;bottom:56px;width:596px;padding-top:26px;border-top:2px solid ${PALETTE.silt};
  font:500 21px/1 "IBM Plex Mono";color:${PALETTE.reed}}
.right{background:${PALETTE.bank};border-left:2px solid ${PALETTE.silt};display:grid;place-items:center}
</style></head>
<body><div class="card">
<div class="left">
  <div class="brand">${mark}<span>MUDSKIPPER</span></div>
  <h1>Was this rice field really drained?</h1>
  <p>NASA-ISRO NISAR radar shows, field by field, what space can prove about rice-field drainage.</p>
  <div class="tag">Proof, not paperwork.</div>
  <div class="foot">NASA Space Apps 2026 · Dancing with the SARs</div>
</div>
<div class="right">${mosaicSvg(11, 15, 26, 7)}</div>
</div></body></html>
`;
}

function chromePath(): string {
  const candidates = [
    process.env["CHROME_PATH"],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found: set CHROME_PATH to a Chrome or Chromium binary.");
  return found;
}

async function renderOg(): Promise<void> {
  const html = join(OUT, "og.html");
  writeFileSync(html, ogHtml());
  const scratch = mkdtempSync(join(tmpdir(), "mudskipper-og-"));
  const shot = join(scratch, "og.png");
  const res = spawnSync(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--font-render-hinting=none",
      "--window-size=1200,630",
      "--virtual-time-budget=3000",
      `--user-data-dir=${join(scratch, "profile")}`,
      `--screenshot=${shot}`,
      pathToFileURL(html).href,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !existsSync(shot)) throw new Error(`Chrome screenshot failed:\n${res.stderr}`);
  const png = await sharp(shot).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(html, { force: true });
  writeFileSync(join(OUT, "og.png"), png);
  const meta = await sharp(png).metadata();
  console.log(`og.png ${meta.width}×${meta.height}, ${(png.byteLength / 1024).toFixed(0)} KiB`);
}

async function renderIcons(): Promise<void> {
  const svg = readFileSync(join(OUT, "favicon.svg"));
  for (const [name, size] of [["apple-touch-icon.png", 180], ["favicon-48.png", 48]] as const) {
    const png = await sharp(svg, { density: 1200 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(join(OUT, name), png);
    console.log(`${name} ${size}×${size}`);
  }
}

await renderOg();
await renderIcons();
