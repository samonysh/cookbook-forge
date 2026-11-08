#!/usr/bin/env node
// mdx2book.mjs
//
// 确定性 MDX → Typst / LaTeX / EPUB-XHTML 章节转换器。
//
// 适用场景：MDX 由 Cookbook Forge 的章节模板产出，结构固定（H2/H3、GFM 表格、
// 围栏代码、引用块、fig-NN-M 图位、图/表交叉引用），用 LLM 逐章改写既慢又不可控。
// 本脚本按块解析后逐块渲染，正文逐字保留，只做语法层转换。
//
// 用法（在书根目录执行）：
//   node <skill>/scripts/mdx2book.mjs --format typst|latex|epub|all [--root .]
//
// 产物（与 lmdx2typst / lmdx2tex / lbuild-epub 的工程目录一致）：
//   typst/chapters/<slug>.typ
//   latex/chapters/<slug>.tex
//   epub/build/OEBPS/Text/<slug>.xhtml
//
// 之后仍由上述三个组装脚本生成 main.typ / main.tex / OPF 与资源拷贝。

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter, stripHtmlComments } from "./lib/mdx-utils.mjs";

// ---------- CLI ----------
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const FORMAT = getArg("format", "all");
const ROOT = path.resolve(getArg("root", "."));

// ---------- 通用解析 ----------
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseList(lines) {
  const items = [];
  for (const raw of lines) {
    const m = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      const indent = m[1].replace(/\t/g, "  ").length;
      const item = { text: m[3].trim(), ordered: /^\d/.test(m[2]), children: [] };
      if (indent >= 2 && items.length) items[items.length - 1].children.push(item);
      else items.push(item);
    } else if (items.length && raw.trim()) {
      items[items.length - 1].text += " " + raw.trim();
    }
  }
  return items;
}

function parseBlocks(body) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "para", text: para.join("\n") });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    // 围栏代码
    let m = t.match(/^(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (m) {
      flush();
      const fence = m[1][0].repeat(m[1].length);
      const lang = m[2] || "text";
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      blocks.push({ type: "code", lang, text: buf.join("\n") });
      continue;
    }
    // 标题
    m = t.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      blocks.push({ type: "heading", level: m[1].length, text: m[2].trim() });
      continue;
    }
    // 图片（图位）
    m = t.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (m) {
      flush();
      blocks.push({ type: "figure", alt: m[1], src: m[2] });
      continue;
    }
    // GFM 表格（当前行 + 下一行分隔线）
    if (t.startsWith("|") && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const header = splitRow(t);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    // 引用块
    if (t.startsWith(">")) {
      flush();
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      i--;
      blocks.push({ type: "quote", lines: q });
      continue;
    }
    // 列表
    if (/^[-*+]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) {
      flush();
      const listLines = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) break;
        if (/^\s*[-*+]\s+/.test(cur) || /^\s*\d+[.)]\s+/.test(cur) || /^\s{2,}\S/.test(cur)) {
          listLines.push(cur);
          i++;
        } else break;
      }
      i--;
      blocks.push({ type: "list", ordered: /^\d/.test(t), items: parseList(listLines) });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks;
}

/** 匹配「图 N-M / 表 N-M」题注行，返回 { num, text }（兼容 **粗体**、*斜体*、纯文本）。 */
function parseCaption(text, kind) {
  const t = String(text).trim();
  const re = new RegExp(`^(\\*\\*|\\*)?\\s*${kind}\\s*(\\d+)\\s*-\\s*(\\d+)\\s*(\\*\\*|\\*)?\\s*[　\\s:：]*(.*)$`, "s");
  const m = t.match(re);
  if (!m) return null;
  let rest = m[5].trim();
  if (m[1] === "*" && rest.endsWith("*")) rest = rest.slice(0, -1).trim();
  return { num: `${m[2]}-${m[3]}`, text: rest };
}

/** 把题注行挂到图/表上，并从正文中移除该行。 */
function attachCaptions(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "figure" && blocks[i + 1]?.type === "para") {
      const cap = parseCaption(blocks[i + 1].text, "图");
      if (cap) {
        b.caption = cap;
        blocks.splice(i + 1, 1);
      }
    }
    if (b.type === "table" && blocks[i - 1]?.type === "para") {
      const cap = parseCaption(blocks[i - 1].text, "表");
      if (cap) {
        b.caption = cap;
        blocks.splice(i - 1, 1);
        i--;
      }
    }
  }
}

/** 图文件名 fig-NN-M.svg → { chapter: "N", index: "M", id: "fig-N-M" }。 */
function figureId(src) {
  const base = path.basename(src).replace(/\.(svg|png|jpg|jpeg)$/i, "");
  const m = base.match(/^fig-(\d+)-(\d+)$/i);
  if (!m) return { id: base, num: null };
  return { id: `fig-${Number(m[1])}-${Number(m[2])}`, num: `${Number(m[1])}-${Number(m[2])}` };
}

// ---------- 行内渲染 ----------
const REF_RE = /([图表])\s*(\d+)\s*-\s*(\d+)/;

function escapeTypst(s) {
  return s.replace(/[\\#$@*_\[\]<>`~]/g, (c) => `\\${c}`);
}
function inlineTypstPlain(s) {
  return s
    .split(/([图表]\s*\d+\s*-\s*\d+)/)
    .map((part, idx) => {
      if (idx % 2 === 1) {
        const m = part.match(REF_RE);
        return `@${m[1] === "图" ? "fig" : "tab"}-${m[2]}-${m[3]}`;
      }
      return escapeTypst(part);
    })
    .join("");
}
function inlineTypst(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i) {
        out += "`" + s.slice(i + 1, j) + "`";
        i = j + 1;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      const j = s.indexOf("**", i + 2);
      if (j > i) {
        out += "*" + inlineTypst(s.slice(i + 2, j)) + "*";
        i = j + 2;
        continue;
      }
    }
    if (s[i] === "*") {
      const j = s.indexOf("*", i + 1);
      if (j > i) {
        out += "_" + inlineTypst(s.slice(i + 1, j)) + "_";
        i = j + 1;
        continue;
      }
    }
    let j = i;
    while (j < s.length && s[j] !== "`" && s[j] !== "*") j++;
    out += inlineTypstPlain(s.slice(i, j));
    i = j;
  }
  return out;
}

const LATEX_MAP = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};
function escapeLatexPlain(s) {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => LATEX_MAP[c]);
}
// 行内代码在 LaTeX 里是等宽盒子，默认不可断行；长标识符会把行撑出页面右边。
// 在标点处插入 \allowbreak{}，让长 token 能在页面内折行（不改变字符内容）。
function breakableCode(s) {
  return escapeLatexPlain(s).replace(/(\\_|[.:/,;\[\]()=])/g, "$1\\allowbreak{}");
}
function inlineLatexPlain(s) {
  return s
    .split(/([图表]\s*\d+\s*-\s*\d+)/)
    .map((part, idx) => {
      if (idx % 2 === 1) {
        const m = part.match(REF_RE);
        const kind = m[1] === "图" ? "fig" : "tab";
        return `\\hyperlink{${kind}:${m[2]}-${m[3]}}{${m[1]} ${m[2]}-${m[3]}}`;
      }
      return escapeLatexPlain(part);
    })
    .join("");
}
function inlineLatex(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i) {
        out += "\\texttt{" + breakableCode(s.slice(i + 1, j)) + "}";
        i = j + 1;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      const j = s.indexOf("**", i + 2);
      if (j > i) {
        out += "\\textbf{" + inlineLatex(s.slice(i + 2, j)) + "}";
        i = j + 2;
        continue;
      }
    }
    if (s[i] === "*") {
      const j = s.indexOf("*", i + 1);
      if (j > i) {
        out += "\\emph{" + inlineLatex(s.slice(i + 1, j)) + "}";
        i = j + 1;
        continue;
      }
    }
    let j = i;
    while (j < s.length && s[j] !== "`" && s[j] !== "*") j++;
    out += inlineLatexPlain(s.slice(i, j));
    i = j;
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function slugId(s) {
  return s
    .replace(/^\d+(?:\.\d+)+\s*/, "")
    .replace(/[「」『』《》（）()[\]{}、，。：；！？,.:;!?"'“”‘’/\\|]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// EPUB 交叉引用需要全局图/表 → 文件映射
let CHAPTER_SLUGS = new Map();
function xrefHref(kind, num, currentSlug) {
  const id = `${kind}-${num}`;
  const m = num.match(/^(\d+)-/);
  const ch = m ? m[1] : null;
  const slug = ch ? CHAPTER_SLUGS.get(Number(ch)) : null;
  if (!slug || slug === currentSlug) return `#${id}`;
  return `${slug}.xhtml#${id}`;
}
function inlineHtmlPlain(s, slug) {
  return s
    .split(/([图表]\s*\d+\s*-\s*\d+)/)
    .map((part, idx) => {
      if (idx % 2 === 1) {
        const m = part.match(REF_RE);
        const kind = m[1] === "图" ? "fig" : "tab";
        return `<a class="xref" href="${xrefHref(kind, `${m[2]}-${m[3]}`, slug)}">${m[1]} ${m[2]}-${m[3]}</a>`;
      }
      return escapeHtml(part);
    })
    .join("");
}
function inlineHtml(s, slug) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i) {
        out += "<code>" + escapeHtml(s.slice(i + 1, j)) + "</code>";
        i = j + 1;
        continue;
      }
    }
    if (s.startsWith("**", i)) {
      const j = s.indexOf("**", i + 2);
      if (j > i) {
        out += "<strong>" + inlineHtml(s.slice(i + 2, j), slug) + "</strong>";
        i = j + 2;
        continue;
      }
    }
    if (s[i] === "*") {
      const j = s.indexOf("*", i + 1);
      if (j > i) {
        out += "<em>" + inlineHtml(s.slice(i + 1, j), slug) + "</em>";
        i = j + 1;
        continue;
      }
    }
    let j = i;
    while (j < s.length && s[j] !== "`" && s[j] !== "*") j++;
    out += inlineHtmlPlain(s.slice(i, j), slug);
    i = j;
  }
  return out;
}

// ---------- 块渲染：Typst ----------
function renderTypst(blocks, ctx) {
  const out = [];
  const num = (b, fallback) => b.caption?.num || fallback;

  const renderList = (items, indent = "") => {
    const lines = [];
    for (const it of items) {
      const marker = it.ordered ? "+" : "-";
      lines.push(`${indent}${marker} ${inlineTypst(it.text)}`);
      if (it.children.length) lines.push(renderList(it.children, indent + "  "));
    }
    return lines.join("\n");
  };

  for (const b of blocks) {
    if (b.type === "heading") {
      if (b.level === 1) continue;
      const text = inlineTypst(b.text.replace(/^\d+(?:\.\d+)+\s*/, ""));
      out.push(`${"=".repeat(b.level)} ${text}`);
    } else if (b.type === "para") {
      out.push(inlineTypst(b.text));
    } else if (b.type === "quote") {
      const inner = b.lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => inlineTypst(l))
        .join("\n\n");
      out.push(`#quote(block: true)[\n${inner}\n]`);
    } else if (b.type === "list") {
      out.push(renderList(b.items));
    } else if (b.type === "code") {
      out.push("```" + b.lang + "\n" + b.text + "\n```");
    } else if (b.type === "figure") {
      const fid = figureId(b.src);
      const caption = b.caption?.text || b.alt || "";
      const fnum = b.caption?.num || fid.num || "1-1";
      out.push(
        `#figure(\n  image("../figures/${path.basename(b.src)}", width: 70%),\n` +
          `  caption: [${inlineTypst(caption)}],\n` +
          `  numbering: (..nums) => "${fnum}",\n) <${fid.id}>`
      );
    } else if (b.type === "table") {
      const t = ctx.tableIndex++;
      const tnum = num(b, `${ctx.chapter}-${t}`);
      const cols = b.header.length;
      const rows = [];
      rows.push("table.header(" + b.header.map((c) => `[*${inlineTypst(c)}*]`).join(", ") + "),");
      for (const r of b.rows) {
        for (let c = 0; c < cols; c++) rows.push(`[${inlineTypst(r[c] ?? "")}],`);
      }
      const body =
        `table(\n    columns: ${cols},\n    inset: 6pt,\n    align: left,\n` +
        rows.map((r) => "    " + r).join("\n") +
        "\n  )";
      if (b.caption?.text) {
        // 有题注：包成带固定编号的 figure，便于交叉引用
        out.push(
          `#figure(\n  ${body},\n  caption: [${inlineTypst(b.caption.text)}],\n` +
            `  numbering: (..nums) => "${tnum}",\n) <tab-${tnum}>`
        );
      } else {
        // 无题注：保持普通表格，避免在表目录里出现只有编号的空条目
        out.push(`#${body}`);
      }
    }
  }
  return out.join("\n\n");
}

// ---------- 块渲染：LaTeX ----------
function renderLatex(blocks, ctx) {
  const out = [];
  const renderList = (items, ordered) => {
    const env = ordered ? "enumerate" : "itemize";
    const lines = [`\\begin{${env}}`];
    for (const it of items) {
      lines.push(`\\item ${inlineLatex(it.text)}`);
      if (it.children.length) lines.push(renderList(it.children, it.children[0]?.ordered));
    }
    lines.push(`\\end{${env}}`);
    return lines.join("\n");
  };

  for (const b of blocks) {
    if (b.type === "heading") {
      if (b.level === 1) continue;
      const text = inlineLatex(b.text.replace(/^\d+(?:\.\d+)+\s*/, ""));
      if (b.level === 2) out.push(`\\section{${text}}`);
      else if (b.level === 3) out.push(`\\subsection{${text}}`);
      else out.push(`\\subsubsection{${text}}`);
    } else if (b.type === "para") {
      out.push(inlineLatex(b.text) + "\n");
    } else if (b.type === "quote") {
      const inner = b.lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => inlineLatex(l))
        .join("\n\n");
      out.push(`\\begin{quote}\n${inner}\n\\end{quote}`);
    } else if (b.type === "list") {
      out.push(renderList(b.items, b.ordered));
    } else if (b.type === "code") {
      const title = (b.text.match(/^#\s*(?:file|文件)\s*[:：]\s*(\S+)/i) || [])[1];
      const opt = title ? `[title={${escapeLatexPlain(title)}}]` : "";
      out.push(`\\begin{codeblock}${opt}{${b.lang}}\n${b.text}\n\\end{codeblock}`);
    } else if (b.type === "figure") {
      const fid = figureId(b.src);
      const fnum = b.caption?.num || fid.num || "1-1";
      const caption = b.caption?.text || b.alt || "";
      out.push(
        `\\begin{center}\n` +
          `\\hypertarget{fig:${fnum}}{}\\includegraphics[width=0.85\\textwidth]{figures/${path.basename(b.src).replace(/\.svg$/i, ".pdf")}}\\\\[0.3em]\n` +
          `{\\small\\textbf{图 ${fnum}}\\quad ${inlineLatex(caption)}}\n` +
          `\\end{center}`
      );
    } else if (b.type === "table") {
      const t = ctx.tableIndex++;
      const tnum = b.caption?.num || `${ctx.chapter}-${t}`;
      const cols = b.header.length;
      const spec = `@{}*{${cols}}{>{\\raggedright\\arraybackslash}X}@{}`;
      const cap = b.caption?.text
        ? `{\\small\\textbf{表 ${tnum}}\\quad ${inlineLatex(b.caption.text)}}\\par\\smallskip\n`
        : "";
      const rows = b.rows.map((r) => r.map((c) => inlineLatex(c ?? "")).join(" & ") + " \\\\");
      out.push(
        `\\hypertarget{tab:${tnum}}{}\n${cap}` +
          `\\begin{xltabular}{\\textwidth}{${spec}}\n\\toprule\n` +
          b.header.map((c) => inlineLatex(c)).join(" & ") +
          " \\\\\n\\midrule\n\\endhead\n" +
          rows.join("\n") +
          "\n\\bottomrule\n\\end{xltabular}"
      );
    }
  }
  return out.join("\n\n");
}

// ---------- 块渲染：XHTML ----------
function renderXhtml(blocks, ctx) {
  const out = [];
  const renderList = (items, ordered) => {
    const tag = ordered ? "ol" : "ul";
    const parts = [`<${tag}>`];
    for (const it of items) {
      let li = `<li>${inlineHtml(it.text, ctx.slug)}`;
      if (it.children.length) li += "\n" + renderList(it.children, it.children[0]?.ordered);
      parts.push(li + "</li>");
    }
    parts.push(`</${tag}>`);
    return parts.join("\n");
  };

  for (const b of blocks) {
    if (b.type === "heading") {
      if (b.level === 1) continue;
      const level = Math.min(b.level, 6);
      const id = level === 2 ? ` id="${escapeHtml(slugId(b.text))}"` : "";
      out.push(`<h${level}${id}>${inlineHtml(b.text, ctx.slug)}</h${level}>`);
    } else if (b.type === "para") {
      out.push(`<p>${inlineHtml(b.text, ctx.slug)}</p>`);
    } else if (b.type === "quote") {
      const inner = b.lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => `<p>${inlineHtml(l, ctx.slug)}</p>`)
        .join("\n");
      out.push(`<blockquote>\n${inner}\n</blockquote>`);
    } else if (b.type === "list") {
      out.push(renderList(b.items, b.ordered));
    } else if (b.type === "code") {
      out.push(
        `<pre class="code-block"><code class="language-${escapeHtml(b.lang)}">${escapeHtml(b.text)}\n</code></pre>`
      );
    } else if (b.type === "figure") {
      const fid = figureId(b.src);
      const fnum = b.caption?.num || fid.num || "1-1";
      const caption = b.caption?.text || b.alt || "";
      out.push(
        `<figure id="${fid.id}">\n` +
          `<img src="../Images/${escapeHtml(path.basename(b.src))}" alt="${escapeHtml(b.alt)}"/>\n` +
          `<figcaption>图 ${fnum}　${inlineHtml(caption, ctx.slug)}</figcaption>\n</figure>`
      );
    } else if (b.type === "table") {
      const t = ctx.tableIndex++;
      const tnum = b.caption?.num || `${ctx.chapter}-${t}`;
      const head = `<thead>\n<tr>${b.header.map((c) => `<th>${inlineHtml(c, ctx.slug)}</th>`).join("")}</tr>\n</thead>`;
      const body = b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c ?? "", ctx.slug)}</td>`).join("")}</tr>`)
        .join("\n");
      const cap = b.caption?.text ? `<caption>表 ${tnum}　${inlineHtml(b.caption.text, ctx.slug)}</caption>\n` : "";
      out.push(`<table class="gfm-table" id="tab-${tnum}">\n${cap}${head}\n<tbody>\n${body}\n</tbody>\n</table>`);
    }
  }
  return out.join("\n\n");
}

// ---------- 文档包装 ----------
const stripChapterPrefix = (t) => t.replace(/^第\s*\d+\s*章[　\s：:]*/, "").trim();

function wrapTypst(title, body) {
  return `#import "../callout.typ": callout-box\n\n= ${inlineTypst(stripChapterPrefix(title))}\n\n${body}\n`;
}
function wrapLatex(title, slug, body) {
  return `\\chapter{${escapeLatexPlain(stripChapterPrefix(title))}}\n\\label{ch:${slug}}\n\n${body}\n`;
}
function wrapXhtml(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="../css/stylesheet.css"/>
</head>
<body>
<h1>${escapeHtml(title)}</h1>

${body}
</body>
</html>
`;
}

// ---------- 主流程 ----------
const mdxDir = path.join(ROOT, "mdx");
const files = (await fs.readdir(mdxDir)).filter((f) => f.endsWith(".mdx")).sort();
const chapters = [];
for (const f of files) {
  const raw = await fs.readFile(path.join(mdxDir, f), "utf8");
  const { fm, title, slug } = parseFrontmatter(raw, f);
  const chNum = Number.parseInt(fm.chapter, 10);
  if (!Number.isFinite(chNum)) continue;
  chapters.push({ file: f, raw, title, slug, chapter: chNum });
}
chapters.sort((a, b) => a.chapter - b.chapter);
for (const c of chapters) CHAPTER_SLUGS.set(c.chapter, c.slug);

const doTypst = FORMAT === "all" || FORMAT === "typst";
const doLatex = FORMAT === "all" || FORMAT === "latex";
const doEpub = FORMAT === "all" || FORMAT === "epub";

const typstDir = path.join(ROOT, "typst", "chapters");
const latexDir = path.join(ROOT, "latex", "chapters");
const xhtmlDir = path.join(ROOT, "epub", "build", "OEBPS", "Text");
if (doTypst) await fs.mkdir(typstDir, { recursive: true });
if (doLatex) await fs.mkdir(latexDir, { recursive: true });
if (doEpub) await fs.mkdir(xhtmlDir, { recursive: true });

let figures = 0;
let tables = 0;
for (const c of chapters) {
  const { body } = parseFrontmatter(c.raw, c.file);
  const blocks = parseBlocks(stripHtmlComments(body));
  attachCaptions(blocks);
  const figs = blocks.filter((b) => b.type === "figure").length;
  const tabs = blocks.filter((b) => b.type === "table").length;
  figures += figs;
  tables += tabs;

  if (doTypst) {
    const ctx = { chapter: c.chapter, tableIndex: 1 };
    await fs.writeFile(path.join(typstDir, `${c.slug}.typ`), wrapTypst(c.title, renderTypst(blocks, ctx)), "utf8");
  }
  if (doLatex) {
    const ctx = { chapter: c.chapter, tableIndex: 1 };
    await fs.writeFile(path.join(latexDir, `${c.slug}.tex`), wrapLatex(c.title, c.slug, renderLatex(blocks, ctx)), "utf8");
  }
  if (doEpub) {
    const ctx = { chapter: c.chapter, tableIndex: 1, slug: c.slug };
    await fs.writeFile(path.join(xhtmlDir, `${c.slug}.xhtml`), wrapXhtml(c.title, renderXhtml(blocks, ctx)), "utf8");
  }
  console.log(`  ✓ ch${String(c.chapter).padStart(2)} ${c.slug}  图 ${figs}  表 ${tabs}`);
}
console.log(`\n完成：${chapters.length} 章，图 ${figures} 张，表 ${tables} 个。`);
