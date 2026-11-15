/**
 * A tiny document model for the build-time pages (DECISIONS.md K-322): every page is written once as blocks and
 * rendered twice, to HTML (the static page or the block inside the app's mount node) and to Markdown (served
 * for `Accept: text/markdown`). One source, so the two can never say different things.
 *
 * Inline text is a small, fixed subset of Markdown: `[label](href)`, `` `code` ``, `**strong**`, plus the
 * evidence tags `{OBSERVED}`, `{INFERRED}`, `{ASSUMED}` (a chip in HTML, a code span in Markdown).
 */

export type Inline = string;

export type Block =
  | { h: 1 | 2 | 3; text: Inline }
  | { p: Inline }
  | { ul: Inline[] }
  | { ol: Inline[] }
  | { code: string; lang?: string }
  | { table: { head: Inline[]; rows: Inline[][] } }
  | { note: Inline };

export interface Page {
  /** URL path, e.g. "/", "/about". */
  path: string;
  /** <title> and the Markdown front line. */
  title: string;
  /** <meta name="description">. */
  description: string;
  blocks: Block[];
}

export const TAGS = ["OBSERVED", "INFERRED", "ASSUMED"] as const;
const TAG_TITLE: Record<(typeof TAGS)[number], string> = {
  OBSERVED: "A radar measurement",
  INFERRED: "Our model's reading",
  ASSUMED: "A cited parameter or our own study setting",
};

export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\{(OBSERVED|INFERRED|ASSUMED)\}/g;

export function inlineHtml(s: Inline): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += escHtml(s.slice(last, m.index));
    if (m[1] !== undefined) out += `<code>${escHtml(m[1])}</code>`;
    else if (m[2] !== undefined) out += `<a href="${escHtml(m[3]!)}">${escHtml(m[2])}</a>`;
    else if (m[4] !== undefined) out += `<strong>${escHtml(m[4])}</strong>`;
    else {
      const t = m[5] as (typeof TAGS)[number];
      out += `<span class="tag tag-${t.toLowerCase()}" title="${TAG_TITLE[t]}">${t}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + escHtml(s.slice(last));
}

export function inlineMd(s: Inline, base = ""): string {
  const tagged = s.replace(/\{(OBSERVED|INFERRED|ASSUMED)\}/g, "`$1`");
  return base ? tagged.replace(/\]\((\/[^)\s]*)\)/g, (_m, href: string) => `](${base}${href})`) : tagged;
}

/** Visible text of an inline string (for length checks and the scanner's "500 characters" rule). */
export function inlineText(s: Inline): string {
  return s.replace(INLINE, (_m, code, label, _href, strong, tag) => code ?? label ?? strong ?? tag ?? "");
}

/** Throws unless the page has exactly one h1, first, and no heading level skips (h2 → h4). */
export function checkHeadings(page: Page): void {
  const levels = page.blocks.flatMap((b) => ("h" in b ? [b.h] : []));
  if (levels[0] !== 1 || levels.filter((l) => l === 1).length !== 1) throw new Error(`${page.path}: needs exactly one h1, first`);
  levels.reduce((prev, l) => {
    if (l > prev + 1) throw new Error(`${page.path}: heading level jumps from h${prev} to h${l}`);
    return l;
  });
}

/** `base` (the site origin) makes site-relative links absolute, so the Markdown works when read elsewhere. */
export function toMarkdown(page: Page, base = ""): string {
  const out: string[] = [];
  for (const b of page.blocks) {
    if ("h" in b) out.push(`${"#".repeat(b.h)} ${inlineMd(b.text, base)}`);
    else if ("p" in b) out.push(inlineMd(b.p, base));
    else if ("ul" in b) out.push(b.ul.map((i) => `- ${inlineMd(i, base)}`).join("\n"));
    else if ("ol" in b) out.push(b.ol.map((i, n) => `${n + 1}. ${inlineMd(i, base)}`).join("\n"));
    else if ("code" in b) out.push("```" + (b.lang ?? "") + "\n" + b.code + "\n```");
    else if ("note" in b) out.push(`> ${inlineMd(b.note, base)}`);
    else {
      const row = (cells: Inline[]) => `| ${cells.map((c) => inlineMd(c, base).replace(/\|/g, "\\|")).join(" | ")} |`;
      out.push([row(b.table.head), `|${b.table.head.map(() => "---").join("|")}|`, ...b.table.rows.map(row)].join("\n"));
    }
  }
  return out.join("\n\n") + "\n";
}

export function toHtml(page: Page): string {
  const out: string[] = [];
  for (const b of page.blocks) {
    if ("h" in b) out.push(`<h${b.h}>${inlineHtml(b.text)}</h${b.h}>`);
    else if ("p" in b) out.push(`<p>${inlineHtml(b.p)}</p>`);
    else if ("ul" in b) out.push(`<ul>${b.ul.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ul>`);
    else if ("ol" in b) out.push(`<ol>${b.ol.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ol>`);
    else if ("code" in b) out.push(`<pre><code>${escHtml(b.code)}</code></pre>`);
    else if ("note" in b) out.push(`<p class="note">${inlineHtml(b.note)}</p>`);
    else {
      const head = `<thead><tr>${b.table.head.map((c) => `<th scope="col">${inlineHtml(c)}</th>`).join("")}</tr></thead>`;
      const rows = b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="table"><table>${head}<tbody>${rows}</tbody></table></div>`);
    }
  }
  return out.join("\n");
}

/** Characters of visible text a JavaScript-free reader gets from the page body. */
export function textLength(page: Page): number {
  return page.blocks
    .map((b) => {
      if ("h" in b) return inlineText(b.text);
      if ("p" in b) return inlineText(b.p);
      if ("note" in b) return inlineText(b.note);
      if ("ul" in b) return b.ul.map(inlineText).join(" ");
      if ("ol" in b) return b.ol.map(inlineText).join(" ");
      if ("code" in b) return b.code;
      return [...b.table.head, ...b.table.rows.flat()].map(inlineText).join(" ");
    })
    .join(" ").length;
}
