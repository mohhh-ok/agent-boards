import { describe, expect, test } from "bun:test";
import { renderReport } from "../lib/report.ts";

const render = (md: string) => renderReport(md, { baseDir: "/base/dir" });

describe("renderReport", () => {
  test("the first h1 is the title and h2s make the contents", () => {
    const r = render("# Report\n\n## One\n\ntext\n\n## Two `x`\n");
    expect(r.title).toBe("Report");
    expect(r.headings).toEqual([
      { id: "section-1", text: "One" },
      { id: "section-2", text: "Two x" },
    ]);
    expect(r.html).toContain('<h2 id="section-2" class="section-heading">Two <code>x</code></h2>');
  });

  test("a list of '<name> — <number> <unit>' items becomes a ledger with bars against the largest value", () => {
    const r = render("- A. Camera — 4.5 人日 (revised)。Setup 0.5, tests 1\n- B. Selfie — 9 人日。Recording 1.5\n- C. Short — 2 人日\n");
    expect(r.html).toContain('<ol class="ledger">');
    expect(r.html).toContain('<span class="ledger-num">4.5</span><span class="ledger-unit">人日</span>');
    expect(r.html).toContain('style="width:50.0%"');
    expect(r.html).toContain('style="width:100.0%"');
    expect(r.html).toContain('<div class="ledger-name">A. Camera</div><div class="ledger-body">(revised)。Setup 0.5, tests 1</div>');
    expect(r.html).toContain('<div class="ledger-name">B. Selfie</div><div class="ledger-body">Recording 1.5</div>');
    expect(r.html).toContain('<li class="ledger-row is-short">');
  });

  test("a list stays a list when an item does not fit or units differ", () => {
    expect(render("- A — 1 人日\n- B is plain\n").html).not.toContain("ledger");
    expect(render("- A — 1 人日\n- B — 2 時間\n").html).not.toContain("ledger");
    expect(render("- A — 1 人日\n").html).not.toContain("ledger");
  });

  test("numeric table columns are right-aligned with bars; text columns are not", () => {
    const r = render("| model | time | note |\n| --- | --- | --- |\n| a | 100 秒 | ok |\n| b | 50 秒 | 2 |\n");
    expect(r.html).toContain('<th class="num">time</th>');
    expect(r.html).toContain('<td class="num"><span class="num-value">50 秒</span><span class="bar" aria-hidden="true"><span style="width:50.0%"></span></span></td>');
    expect(r.html).toContain("<td>ok</td>");
  });

  test("quantities in text are emphasized, but not inside code", () => {
    const r = render("Total 50.5 人日 and 30% done. `12 件`\n");
    expect(r.html).toContain('<span class="qty">50.5 人日</span>');
    expect(r.html).toContain('<span class="qty">30%</span>');
    expect(r.html).toContain("<code>12 件</code>");
  });

  test("raw HTML is shown as text", () => {
    const r = render('<script>alert(1)</script>\n\ntext <b onclick="x">b</b>\n');
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b ");
    expect(r.html).toContain("&lt;script&gt;");
  });

  test("relative images point at files next to the report", () => {
    expect(render("![chart](<img/a b.png>)\n").html).toContain('src="file:///base/dir/img/a%20b.png"');
    expect(render("![x](https://example.com/a.png)\n").html).toContain('src="https://example.com/a.png"');
  });

  test("blockquotes are notes", () => {
    expect(render("> note\n").html).toContain('<blockquote class="note">');
  });
});

describe("links", () => {
  test("only web, mail, anchors and relative paths become links", () => {
    expect(render("[a](https://x.test/) [b](mailto:a@x.test) [c](#s) [d](other.md)\n").html.match(/<a /g)?.length).toBe(4);
    const r = render("[bad](javascript:alert(1)) [app](file:///Applications/Calculator.app)\n");
    expect(r.html).not.toContain("<a ");
    expect(r.html).toContain("bad");
  });
});
