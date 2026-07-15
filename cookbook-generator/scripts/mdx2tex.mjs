#!/usr/bin/env node
// mdx2tex.mjs
//
// MDX → ElegantBook LaTeX 转换器。
// 核心策略：先按 code fence 切分 text/code 片段，再对 text 做 inline/block 转换，
// 避免代码块内的 `#`/`{}`/`_` 被 LaTeX 转义误伤。
//
// 用法（CLI）：node mdx2tex.mjs
//   - 输入：工作目录下 mdx/*.mdx
//   - 输出：latex/chapters/*.tex、latex/main.tex、latex/figures/（拷贝图）
//
// 生成的 .tex 依赖 ElegantBook 文档类 + tcolorbox + listings + booktabs + tabularx 等宏包（见 main.tex preamble）。

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mdxDir = path.resolve("mdx");
const texDir = path.resolve("latex/chapters");
const figDir = path.resolve("latex/figures");
const diagramSrcDir = path.resolve("latex/diagrams");
const metaDir = path.resolve("latex/metadata");
await fs.mkdir(texDir, { recursive: true });
await fs.mkdir(figDir, { recursive: true });
await fs.mkdir(diagramSrcDir, { recursive: true });
await fs.mkdir(metaDir, { recursive: true });

// ---------- 工具：解析 frontmatter ----------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { title: "Chapter", fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^(\w+):\s*(.+)$/);
    if (mm) fm[mm[1]] = mm[2].replace(/^["']|["']$/g, "");
  }
  return { title: fm.title || "Chapter", fm, body: raw.slice(m[0].length) };
}

// ---------- 代码 fence 切分 ----------
function tokenize(body) {
  const tokens = [];
  const fenceRe = /^```([\w+-]*)\n([\s\S]*?)```$/gm;
  let lastEnd = 0, m;
  while ((m = fenceRe.exec(body)) !== null) {
    if (m.index > lastEnd) tokens.push({ type: "text", content: body.slice(lastEnd, m.index) });
    tokens.push({ type: "code", lang: m[1] || "", content: m[2].replace(/\n$/, "") });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < body.length) tokens.push({ type: "text", content: body.slice(lastEnd) });
  return tokens;
}

// ---------- LaTeX 转义（仅对**纯文本**使用；已经是 LaTeX 命令的不要再次转义）----------
function ltxEscPlain(s) {
  return String(s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// ---------- 行内转换（text 片段内用）：先识别 markdown 行内结构为 LaTeX 命令，再对剩余纯文本转义 ----------
function inlineMdToTex(s) {
  const placeholders = [];
  let out = s;

  // 行内代码 `code`（原样写入，不转义内部）
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const t = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`\\texttt{${code}}`);
    return t;
  });
  // 粗体 **x**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => {
    const ph = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`\\textbf{${t}}`);
    return ph;
  });
  // 斜体 *x*
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, pre, t) => {
    const ph = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`${pre}\\emph{${t}}`);
    return ph;
  });
  // 图片 ![alt](src)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const ph = `\u0000PH${placeholders.length}\u0000`;
    const base = path.basename(src);
    placeholders.push(`\\begin{figure}[htbp]\\centering\\includegraphics[width=0.85\\textwidth]{figures/${base}}\\caption{${ltxEscPlain(alt)}}\\end{figure}`);
    return ph;
  });
  // 链接 [text](href)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const ph = `\u0000PH${placeholders.length}\u0000`;
    if (href.startsWith("./") || href.startsWith("#")) {
      placeholders.push(ltxEscPlain(text));
    } else {
      placeholders.push(`\\href{${href}}{${ltxEscPlain(text)}}`);
    }
    return ph;
  });
  // 行内公式 $...$ 保留原样
  out = out.replace(/\$([^$\n]+)\$/g, (_, tex) => {
    const ph = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`$${tex}$`);
    return ph;
  });

  // 剩余纯文本转义
  out = ltxEscPlain(out);
  // 还原占位符
  out = out.replace(/\u0000PH(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);
  return out;
}

// ---------- GFM 表格 → tabularx ----------
function tableToTex(block) {
  const rows = block.split("\n").filter(l => l.trim().startsWith("|"));
  if (rows.length < 2) return null;
  const parsed = rows
    .filter(r => !/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(r))
    .map(r => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
  if (parsed.length < 2) return null;
  const [header, ...body] = parsed;
  const ncol = header.length;
  const colspec = Array(ncol).fill("X").join(" ");
  let out = "\\begin{table}[htbp]\n\\centering\n";
  out += `\\begin{tabularx}{\\textwidth}{${colspec}}\n\\toprule\n`;
  out += header.map(h => inlineMdToTex(h)).join(" & ") + " \\\\\n\\midrule\n";
  for (const row of body) {
    const padded = [...row];
    while (padded.length < ncol) padded.push("");
    out += padded.map(c => inlineMdToTex(c)).join(" & ") + " \\\\\n";
  }
  out += "\\bottomrule\n\\end{tabularx}\n\\end{table}\n";
  return out;
}

// ---------- callout div → tcolorbox ----------
function convertCallouts(text) {
  return text.replace(
    /<div\s+className="callout\s+([\w-]+)"\s*>([\s\S]*?)<\/div>/g,
    (_, klass, inner) => {
      const colorMap = {
        chapteroutline: { bg: "blue!5",   fg: "blue!40",   title: "本章地图" },
        recipe:         { bg: "yellow!5", fg: "orange!40", title: "Recipe" },
        pitfall:        { bg: "red!5",    fg: "red!40",    title: "常见陷阱" },
        keypoints:      { bg: "green!5",  fg: "green!40",  title: "核心要点" },
      };
      const c = colorMap[klass] || colorMap.chapteroutline;
      // 内部的 #### Title 提取
      let body = inner.trim();
      let title = c.title;
      const hm = body.match(/^####\s+(.+)$/m);
      if (hm) {
        title = inlineMdToTex(hm[1].trim());
        body = body.replace(hm[0], "").trim();
      }
      // 内部可能还有空行/列表 → 简单按段处理
      const paras = body.split(/\n{2,}/).map(p => inlineMdToTex(p.replace(/\n/g, " "))).join("\n\n");
      return `\\begin{tcolorbox}[colback=${c.bg},colframe=${c.fg},title={${title}}]\n${paras}\n\\end{tcolorbox}`;
    }
  );
}

// ---------- text 片段 → LaTeX ----------
function textToTex(text) {
  let s = convertCallouts(text);
  // 块级公式 $$...$$
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => `\\[\n${tex.trim()}\n\\]`);

  const lines = s.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // 标题
    let m;
    if ((m = line.match(/^######\s+(.+)$/))) { out.push(`\\subparagraph{${inlineMdToTex(m[1])}}`); i++; continue; }
    if ((m = line.match(/^#####\s+(.+)$/)))  { out.push(`\\paragraph{${inlineMdToTex(m[1])}}`); i++; continue; }
    if ((m = line.match(/^####\s+(.+)$/)))   { out.push(`\\subsubsection{${inlineMdToTex(m[1])}}`); i++; continue; }
    if ((m = line.match(/^###\s+(.+)$/)))    { out.push(`\\subsection{${inlineMdToTex(m[1])}}`); i++; continue; }
    if ((m = line.match(/^##\s+(.+)$/)))     { out.push(`\\section{${inlineMdToTex(m[1])}}`); i++; continue; }
    if ((m = line.match(/^#\s+(.+)$/)))      { out.push(`\\section*{${inlineMdToTex(m[1])}}`); i++; continue; }

    // 表格
    if (/^\s*\|/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { buf.push(lines[i]); i++; }
      const tex = tableToTex(buf.join("\n"));
      if (tex) out.push(tex);
      continue;
    }

    // 列表
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push("\\begin{itemize}");
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        out.push(`\\item ${inlineMdToTex(lines[i].replace(/^\s*[-*+]\s+/, ""))}`);
        i++;
      }
      out.push("\\end{itemize}");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push("\\begin{enumerate}");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        out.push(`\\item ${inlineMdToTex(lines[i].replace(/^\s*\d+\.\s+/, ""))}`);
        i++;
      }
      out.push("\\end{enumerate}");
      continue;
    }

    // 已有的 LaTeX (tcolorbox 等) 原样放行
    if (/^\s*\\(begin|end)\{/.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    // 段落
    const pbuf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^#{1,6}\s/.test(lines[i]) &&
           !/^\s*\|/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^\s*\\(begin|end)\{/.test(lines[i])) {
      pbuf.push(lines[i]);
      i++;
    }
    out.push(inlineMdToTex(pbuf.join(" ")) + "\n");
  }
  return out.join("\n");
}

// ---------- code 片段 → listings/tcolorbox ----------
function codeToTex(lang, code) {
  // mermaid/plantuml/excalidraw → 占位（见 Nextra/PDF 成品）
  if (/^(mermaid|plantuml|excalidraw)$/i.test(lang)) {
    return `\\begin{tcolorbox}[colback=gray!5,colframe=gray!40,title={Diagram: ${lang}}]\n` +
      `Diagram source kept in \\texttt{diagrams/}. Rendered in Nextra/PDF.\\end{tcolorbox}`;
  }
  // listings 对特殊字符敏感，但在 tcolorbox listing only 模式下会按 verbatim 处理，无需手动转义。
  const title = lang || "code";
  return `\\begin{codeblock}{${title}}\n${code}\n\\end{codeblock}`;
}

// ---------- 主转换 ----------
const mdxFiles = (await fs.readdir(mdxDir)).filter(f => f.endsWith(".mdx")).sort();
const chapterRefs = [];
for (const f of mdxFiles) {
  const raw = await fs.readFile(path.join(mdxDir, f), "utf8");
  const { title, fm, body } = parseFrontmatter(raw);
  const slug = f.replace(/\.mdx$/, "");
  const tokens = tokenize(body);
  const bodyTex = tokens.map(tok =>
    tok.type === "code" ? codeToTex(tok.lang, tok.content) : textToTex(tok.content)
  ).join("\n\n");

  const tex = `% Auto-generated from ${f} — edit ${f} then re-run mdx2tex.mjs
\\chapter{${ltxEscPlain(title)}}
\\label{ch:${slug}}

${bodyTex}
`;
  await fs.writeFile(path.join(texDir, `${slug}.tex`), tex, "utf8");
  chapterRefs.push({ slug, f });
}

// ---------- 拷贝 public/figures → latex/figures ----------
const figSrc = path.join(mdxDir, "public", "figures");
try {
  const figs = await fs.readdir(figSrc);
  for (const fn of figs) {
    const s = path.join(figSrc, fn);
    if ((await fs.stat(s)).isFile()) await fs.copyFile(s, path.join(figDir, fn));
  }
  console.log(`Copied ${figs.length} figures into latex/figures/`);
} catch {}

// 拷贝 diagrams-src
const diagSrc = path.join(mdxDir, "public", "diagrams-src");
try {
  const diags = await fs.readdir(diagSrc);
  for (const fn of diags) {
    const s = path.join(diagSrc, fn);
    if ((await fs.stat(s)).isFile()) await fs.copyFile(s, path.join(diagramSrcDir, fn));
  }
} catch {}

// ---------- 生成 main.tex ----------
const inputs = chapterRefs.map(c => `\\input{chapters/${c.slug}}`).join("\n");
const mainTex = `\\documentclass[12pt,a4paper]{elegantbook}
\\title{${ltxEscPlain(chapterRefs[0]?.slug ? "CookBook" : "CookBook")}}
\\subtitle{}
\\author{Cookbook Generator}
\\institute{}
\\date{\\today}
\\version{1.0}

% 数学 / 字体 / 中文
\\usepackage{amsmath,amssymb}
\\usepackage{fontspec}

% 表格
\\usepackage{booktabs}
\\usepackage{tabularx}
\\usepackage{xltabular}
\\usepackage{longtable}
\\usepackage{array}
\\usepackage{makecell}
\\usepackage{multirow}
\\usepackage{threeparttable}
\\usepackage{pdflscape}
\\usepackage{needspace}
\\renewcommand{\\arraystretch}{1.25}
\\setlength{\\tabcolsep}{5pt}

% 代码块
\\usepackage{listings}
\\usepackage[most]{tcolorbox}
\\lstdefinestyle{cookbookcode}{
  basicstyle=\\ttfamily\\small,
  breaklines=true,
  breakatwhitespace=true,
  columns=fullflexible,
  keepspaces=true,
  showstringspaces=false,
  frame=none,
  tabsize=2,
  extendedchars=true,
  literate={-}{{-}}1
}
\\newtcblisting{codeblock}[2][]{
  listing only,
  listing style=cookbookcode,
  title={#2},
  breakable,
  enhanced,
  colback=gray!3,
  colframe=gray!45,
  boxrule=0.4pt,
  arc=2mm,
  left=1.5mm, right=1.5mm, top=1mm, bottom=1mm,
  fonttitle=\\bfseries\\small,
  #1
}

% 超链接
\\usepackage{hyperref}
\\hypersetup{colorlinks=true, linkcolor=blue, urlcolor=blue}

\\begin{document}
\\maketitle
\\tableofcontents

${inputs}

\\end{document}
`;
await fs.writeFile(path.resolve("latex/main.tex"), mainTex, "utf8");

// 提示用户需要 elegantbook.cls
console.log("");
console.log("Wrote latex/main.tex +", chapterRefs.length, "chapter files.");
console.log("To compile: place ElegantBook's elegantbook.cls in latex/ and run:");
console.log("  xelatex main.tex && xelatex main.tex");
console.log("(Or invoke the elegantbook-latex skill to set up and compile.)");
