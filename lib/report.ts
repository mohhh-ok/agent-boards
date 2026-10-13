// Markdown → HTML for reportboard. The look is fixed by the tool (reportboard.html); this file decides the structure.
//
// Rules beyond plain GFM (docs/reportboard.md "How the report is laid out"):
// - Ledger: a list where every item starts with "<name> — <number> <unit>" (two items or more, one unit) is shown as rows
//   of value, bar, name and details. The bar is the value against the largest value in the list. Blocks under an item
//   (a nested list of the work, `>` notes) are part of its details; a list inside the details is a plain list
// - Tables: a column whose cells are all numbers is right-aligned and gets the same bars
// - Quantities with a unit (人日, %, 円 …) in running text are emphasized
// - Raw HTML in the Markdown is shown as text, not run
import { Lexer, Marked, type Token, type Tokens } from "marked";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Heading = { id: string; text: string };
// The places a conversation with the AI can be started (lib/threads.ts): h2 and h3, and the rows of a ledger. A row
// carries the heading it is under (level 0 and "" before the first one) and its own name
export type ReportSection = { id: string; level: number; text: string; occurrence: number; row?: { name: string; occurrence: number } };
export type RenderedReport = { title: string | null; html: string; headings: Heading[]; sections: ReportSection[] };

// "A. カメラ本人認証 (`identity-verification.md`) — 4.5 人日 (…)。AWS の用意 …"
const LEDGER_ITEM = /^(?<name>[^\n]{1,120}?)\s+[—–]\s+(?<num>\d+(?:[.,]\d+)*)\s*(?<unit>[^\s\d。、．，,.()（）:：]{0,6})(?<rest>[\s\S]*)$/;
const NUMERIC_CELL = /^[-+]?\d+(?:[.,]\d+)*\s*(?<unit>%|人日|人月|日|時間|h|分|秒|s|ms|円|万円|件|MB|GB|KB|倍|x)?$/;
// A body row whose first cell is one of these is a total: it is set apart and left out of the bars
const TOTAL_ROW = /^(合計|小計|総計|計|total|subtotal|sum)$/i;
const QUANTITY = /\d+(?:[.,]\d+)*\s?(?:人日|人月|時間|週間|件|万円|円|%)/g;

export function renderReport(markdown: string, options: { baseDir: string }): RenderedReport {
  const headings: Heading[] = [];
  const sections: ReportSection[] = [];
  let title: string | null = null;
  let inLedger = false;
  const marked = new Marked({ gfm: true });

  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = plainText(inner);
        if (depth === 1 && title === null) {
          title = text;
          return `<h1 class="report-title">${inner}</h1>\n`;
        }
        if (depth === 2 || depth === 3) {
          const id = `section-${sections.length + 1}`;
          const occurrence = sections.filter((s) => s.row === undefined && s.level === depth && s.text === text).length;
          sections.push({ id, level: depth, text, occurrence });
          if (depth === 2) headings.push({ id, text });
          return `<h${depth} id="${id}" class="section-heading">${inner}</h${depth}>\n`;
        }
        return `<h${depth}>${inner}</h${depth}>\n`;
      },

      list(token) {
        const ledger = inLedger ? null : ledgerOf(token);
        if (ledger === null) return false;
        const max = Math.max(...ledger.map((row) => row.value));
        const under = sections.findLast((s) => s.row === undefined) ?? { level: 0, text: "", occurrence: 0 };
        const rows = ledger
          .map((row) => {
            const ratio = max > 0 ? row.value / max : 0;
            const name = this.parser.parseInline(Lexer.lexInline(row.name));
            const id = `row-${sections.length + 1}`;
            const rowName = plainText(name);
            const rowOccurrence = sections.filter((s) => s.row?.name === rowName && s.level === under.level && s.text === under.text && s.occurrence === under.occurrence).length;
            sections.push({ id, level: under.level, text: under.text, occurrence: under.occurrence, row: { name: rowName, occurrence: rowOccurrence } });
            const rest = row.rest.trim();
            inLedger = true;
            const lead = rest === "" ? "" : this.parser.parseInline(Lexer.lexInline(rest));
            const details = row.blocks.length === 0 ? lead : (lead === "" ? "" : `<p>${lead}</p>`) + this.parser.parse(row.blocks);
            inLedger = false;
            const body = details === "" ? "" : `<div class="ledger-body">${details}</div>`;
            return (
              `<li id="${id}" class="ledger-row${body === "" ? " is-short" : ""}">` +
              `<div class="ledger-value"><span class="ledger-num">${escapeHtml(row.num)}</span>` +
              (row.unit === "" ? "" : `<span class="ledger-unit">${escapeHtml(row.unit)}</span>`) +
              `<span class="bar" aria-hidden="true"><span style="width:${(ratio * 100).toFixed(1)}%"></span></span></div>` +
              `<div class="ledger-name">${name}</div>${body}</li>`
            );
          })
          .join("\n");
        const maxRow = ledger.find((row) => row.value === max);
        const scale = maxRow === undefined ? "" : ` data-max="${escapeHtml(maxRow.num)}" data-unit="${escapeHtml(maxRow.unit)}"`;
        return `<ol class="ledger"${scale}>\n${rows}\n</ol>\n`;
      },

      table(token) {
        const isTotal = (row: Tokens.TableCell[]) => TOTAL_ROW.test(row[0]?.text.trim() ?? "");
        const itemRows = token.rows.filter((row) => !isTotal(row));
        const numeric = token.header.map((_, column) => isNumericColumn(token, column));
        const maxima = numeric.map((isNumeric, column) =>
          isNumeric ? Math.max(...itemRows.map((row) => parseNumber(row[column].text))) : 0,
        );
        const cell = (tag: "th" | "td", content: Tokens.TableCell, column: number, total = false) => {
          const inner = this.parser.parseInline(content.tokens);
          if (!numeric[column]) {
            const align = content.align === null ? "" : ` style="text-align:${content.align}"`;
            return `<${tag}${align}>${inner}</${tag}>`;
          }
          if (tag === "th") return `<th class="num">${inner}</th>`;
          if (total) return `<td class="num"><span class="num-value">${inner}</span></td>`;
          const ratio = maxima[column] > 0 ? parseNumber(content.text) / maxima[column] : 0;
          return `<td class="num"><span class="num-value">${inner}</span><span class="bar" aria-hidden="true"><span style="width:${(Math.max(0, ratio) * 100).toFixed(1)}%"></span></span></td>`;
        };
        const head = `<tr>${token.header.map((c, i) => cell("th", c, i)).join("")}</tr>`;
        const body = token.rows
          .map((row) => (isTotal(row) ? `<tr class="total-row">${row.map((c, i) => cell("td", c, i, true)).join("")}</tr>` : `<tr>${row.map((c, i) => cell("td", c, i)).join("")}</tr>`))
          .join("\n");
        return `<div class="table-wrap"><table>\n<thead>${head}</thead>\n<tbody>\n${body}\n</tbody></table></div>\n`;
      },

      blockquote({ tokens }) {
        return `<blockquote class="note">${this.parser.parse(tokens)}</blockquote>\n`;
      },

      html({ text }) {
        return escapeHtml(text);
      },

      // Only web pages, mail, anchors and relative paths become links; anything else (javascript: etc.) is plain text
      link({ href, title: linkTitle, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (!/^(https?:|mailto:|#)/i.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return inner;
        const titleAttr = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : "";
        return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
      },

      image({ href, title: imageTitle, text }) {
        const src = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : pathToFileURL(isAbsolute(href) ? href : resolve(options.baseDir, href)).href;
        const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : "";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}>`;
      },
    },
  });

  const html = emphasizeQuantities(marked.parse(markdown, { async: false }));
  return { title, html, headings, sections };
}

type LedgerRow = { name: string; num: string; unit: string; value: number; rest: string; blocks: Token[] };

function ledgerOf(list: Tokens.List): LedgerRow[] | null {
  if (list.items.length < 2) return null;
  const rows: LedgerRow[] = [];
  for (const item of list.items) {
    // The item starts with a block of text; what follows it (a nested list, notes) is shown under the details
    const [head, ...blocks] = item.tokens.filter((t) => t.type !== "space");
    if (item.task || head === undefined || (head.type !== "text" && head.type !== "paragraph")) return null;
    const match = LEDGER_ITEM.exec((head as Tokens.Text | Tokens.Paragraph).text);
    if (match?.groups === undefined) return null;
    const { name, num, unit, rest } = match.groups;
    rows.push({ name: name.trim(), num, unit, value: parseNumber(num), rest: rest.replace(/^\s*[。.]/, ""), blocks });
  }
  const units = new Set(rows.map((row) => row.unit));
  return units.size === 1 ? rows : null;
}

function isNumericColumn(table: Tokens.Table, column: number): boolean {
  const cells = table.rows.map((row) => row[column]?.text.trim() ?? "");
  if (cells.length < 2 || cells.some((text) => text === "")) return false;
  const units = new Set<string>();
  for (const text of cells) {
    const match = NUMERIC_CELL.exec(text);
    if (match === null) return false;
    units.add(match.groups?.unit ?? "");
  }
  return units.size === 1;
}

function parseNumber(text: string): number {
  return Number(/[-+]?\d+(?:[.,]\d+)*/.exec(text)?.[0].replaceAll(",", "") ?? "0");
}

// Wraps quantities in running text. Leaves tags, attributes and the inside of code alone
function emphasizeQuantities(html: string): string {
  let codeDepth = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(code|pre)\b/.test(part)) codeDepth += 1;
        else if (/^<\/(code|pre)>/.test(part)) codeDepth = Math.max(0, codeDepth - 1);
        return part;
      }
      return codeDepth > 0 ? part : part.replace(QUANTITY, (quantity) => `<span class="qty">${quantity}</span>`);
    })
    .join("");
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
