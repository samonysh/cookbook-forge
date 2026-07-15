import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEpub } from "./epub-zip.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, "..");

const mdxDir = path.resolve("mdx");
const outDir = path.resolve("epub");
const buildDir = path.join(outDir, "build");

const OEBPS = path.join(buildDir, "OEBPS");
await fs.mkdir(path.join(OEBPS, "Text"), { recursive: true });
await fs.mkdir(path.join(OEBPS, "Images"), { recursive: true });
await fs.mkdir(path.join(OEBPS, "css"), { recursive: true });
await fs.mkdir(path.join(OEBPS, "Fonts"), { recursive: true });
await fs.mkdir(path.join(buildDir, "META-INF"), { recursive: true });

// ---------- HTML 实体转义 ----------
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- 把 MDX body 切分为 code/text 片段，避免正则误伤代码块 ----------
function tokenizeBody(body) {
  const tokens = [];
  const fenceRe = /^```([\w+-]*)\n([\s\S]*?)```$/gm;
  let lastEnd = 0;
  let m;
  while ((m = fenceRe.exec(body)) !== null) {
    if (m.index > lastEnd) tokens.push({ type: "text", content: body.slice(lastEnd, m.index) });
    tokens.push({ type: "code", lang: m[1] || "", content: m[2] });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < body.length) tokens.push({ type: "text", content: body.slice(lastEnd) });
  return tokens;
}

// ---------- 行内转换（对 text 片段使用）----------
function inlineMdToHtml(s) {
  // 顺序很重要：先识别 markdown 行内结构，再对剩余文本做 HTML 实体转义，最后插回 HTML 标签
  const placeholders = [];
  let out = s;

  // 1) 图片 ![alt](src)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const token = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`<img src="../Images/${path.basename(src)}" alt="${escHtml(alt)}" />`);
    return token;
  });
  // 2) 链接 [text](href)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const token = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`<a href="${escHtml(href)}">${text}</a>`);
    return token;
  });
  // 3) 行内代码 `code`（不转义内部内容）
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`<code>${escHtml(code)}</code>`);
    return token;
  });
  // 4) 粗体 **x**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => {
    const token = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`<strong>${t}</strong>`);
    return token;
  });
  // 5) 斜体 *x*
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, pre, t) => {
    const token = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`${pre}<em>${t}</em>`);
    return token;
  });
  // 6) 行内公式 $...$（不转义内部内容）
  out = out.replace(/\$([^$\n]+)\$/g, (_, tex) => {
    const token = `\u0000PH${placeholders.length}\u0000`;
    placeholders.push(`<span class="math-inline">${escHtml(tex)}</span>`);
    return token;
  });

  // 7) 对剩余文本做 HTML 实体转义
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 8) 还原占位符
  out = out.replace(/\u0000PH(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);
  return out;
}

// ---------- 处理表格（连续 |...| 行构成一个 GFM 表格）----------
function tableBlockToHtml(lines) {
  // lines 是多行字符串，每行都以 | 开头
  const rows = lines.split("\n").filter(l => l.trim().startsWith("|"));
  if (rows.length < 2) return null;
  // 跳过分隔行 |---|---|
  const parsed = rows
    .filter(r => !/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(r))
    .map(r => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
  if (parsed.length < 2) return null;
  const [header, ...body] = parsed;
  let html = '<table class="gfm-table">\n<thead><tr>';
  for (const h of header) html += `<th>${inlineMdToHtml(h)}</th>`;
  html += "</tr></thead>\n<tbody>";
  for (const row of body) {
    html += "<tr>";
    for (const c of row) html += `<td>${inlineMdToHtml(c)}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

// ---------- 处理 callout <div className="callout X"> ... </div> ----------
function renderCalloutInner(md) {
  // 对 callout 内部做简化的 markdown 处理：标题/列表/段落/行内
  let s = md.trim();
  s = s.replace(/^####\s+(.+)$/gm, (_, t) => `<h4>${inlineMdToHtml(t)}</h4>`);
  s = s.replace(/^###\s+(.+)$/gm, (_, t) => `<h3>${inlineMdToHtml(t)}</h3>`);
  // 列表
  const lines = s.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push("<ul>");
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        out.push(`<li>${inlineMdToHtml(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      out.push("</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push("<ol>");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        out.push(`<li>${inlineMdToHtml(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push("</ol>");
      continue;
    }
    if (/^<h[34]>/.test(line)) { out.push(line); i++; continue; }
    // 段落：累积到空行
    const pbuf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^<h[34]>/.test(lines[i])) { pbuf.push(lines[i]); i++; }
    out.push(`<p>${inlineMdToHtml(pbuf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function convertCalloutDivs(text) {
  return text.replace(
    /<div\s+className="callout\s+([\w-]+)"\s*>([\s\S]*?)<\/div>/g,
    (_, klass, inner) => {
      const colorMap = {
        chapteroutline: "callout-chapteroutline",
        recipe: "callout-recipe",
        pitfall: "callout-pitfall",
        keypoints: "callout-keypoints",
      };
      const cls = colorMap[klass] || "callout-chapteroutline";
      return `<div class="${cls}">\n${renderCalloutInner(inner)}\n</div>`;
    }
  );
}

// ---------- 把 text 片段转成 HTML ----------
function textToHtml(text) {
  // 先处理 JSX div (callout)
  let s = convertCalloutDivs(text);

  // 块级公式 $$...$$（独立段落）
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) =>
    `\n<div class="math-block">${escHtml(tex.trim())}</div>\n`);

  // 逐行/段处理
  const lines = s.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 空行 → 段落分隔
    if (line.trim() === "") { i++; continue; }

    // mermaid / plantuml / excalidraw 代码围栏已在 tokenize 阶段被切走；
    // 这里只处理 text 中可能残留的 "```mermaid" 不该出现；防御性跳过

    // 标题
    const h6 = line.match(/^######\s+(.+)$/);
    const h5 = line.match(/^#####\s+(.+)$/);
    const h4 = line.match(/^####\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);
    if (h6) { out.push(`<h6>${inlineMdToHtml(h6[1])}</h6>`); i++; continue; }
    if (h5) { out.push(`<h5>${inlineMdToHtml(h5[1])}</h5>`); i++; continue; }
    if (h4) { out.push(`<h4>${inlineMdToHtml(h4[1])}</h4>`); i++; continue; }
    if (h3) { out.push(`<h3>${inlineMdToHtml(h3[1])}</h3>`); i++; continue; }
    if (h2) { out.push(`<h2>${inlineMdToHtml(h2[1])}</h2>`); i++; continue; }
    if (h1) { out.push(`<h1>${inlineMdToHtml(h1[1])}</h1>`); i++; continue; }

    // 表格：连续以 | 开头的行
    if (/^\s*\|/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const tbl = tableBlockToHtml(buf.join("\n"));
      if (tbl) out.push(tbl);
      continue;
    }

    // 列表：- 或 1. 开头（简单支持一层）
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push("<ul>");
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*[-*+]\s+/, "");
        out.push(`<li>${inlineMdToHtml(item)}</li>`);
        i++;
      }
      out.push("</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push("<ol>");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*\d+\.\s+/, "");
        out.push(`<li>${inlineMdToHtml(item)}</li>`);
        i++;
      }
      out.push("</ol>");
      continue;
    }

    // 已有的 HTML 块（<div>、<table> 等可能跨多行）：用深度计数找到配对闭合
    const blockOpenRe = /^\s*<(div|table|figure|ul|ol|blockquote)(\s|>)/;
    const mo = line.match(blockOpenRe);
    if (mo) {
      const tag = mo[1];
      const closeRe = new RegExp(`^\\s*</${tag}\\s*>`);
      const openRe = new RegExp(`<${tag}(\\s|>)`, "g");
      const buf = [line];
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const cur = lines[i];
        // 粗略计数：出现 open 标签 +1，出现 close 标签 -1
        const opens = (cur.match(openRe) || []).length;
        if (closeRe.test(cur.trim())) depth -= 1;
        depth += opens;
        buf.push(cur);
        i++;
        if (depth === 0) break;
      }
      out.push(buf.join("\n"));
      continue;
    }

    // 段落：累积到下一个空行/块级元素
    const pbuf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^#{1,6}\s/.test(lines[i]) &&
           !/^\s*\|/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^\s*<(div|h[1-6]|ul|ol|table|figure)/.test(lines[i])) {
      pbuf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMdToHtml(pbuf.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ---------- 单个 MDX → XHTML ----------
async function mdxToXhtml(mdx) {
  const fmMatch = mdx.match(/^---\n([\s\S]*?)\n---\n/);
  const title = fmMatch?.[1].match(/title:\s*"?([^"\n]+)"?/)?.[1] || "Chapter";
  const body = fmMatch ? mdx.slice(fmMatch[0].length) : mdx;

  // 按 code fence 切分
  const tokens = tokenizeBody(body);
  const bodyHtml = tokens.map(tok => {
    if (tok.type === "code") {
      // mermaid/plantuml 等图代码块 → 转成占位提示（EPUB 不支持交互渲染）
      if (/^(mermaid|plantuml|excalidraw)$/i.test(tok.lang)) {
        return `<div class="diagram-placeholder">[Diagram: ${escHtml(tok.lang)} — see Nextra site/PDF version]</div>`;
      }
      const codeHtml = escHtml(tok.content);
      return `<pre class="code-block"><code class="language-${escHtml(tok.lang)}">${codeHtml}</code></pre>`;
    }
    return textToHtml(tok.content);
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<title>${escHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="../css/stylesheet.css"/>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// ---------- 主流程 ----------
const files = (await fs.readdir(mdxDir)).filter(f => f.endsWith(".mdx")).sort();
const chapterFiles = [];
for (const f of files) {
  const raw = await fs.readFile(path.join(mdxDir, f), "utf8");
  const xhtml = await mdxToXhtml(raw);
  const xhtmlName = f.replace(/\.mdx$/, ".xhtml");
  await fs.writeFile(path.join(OEBPS, "Text", xhtmlName), xhtml, "utf8");
  chapterFiles.push({ id: f.replace(/\.mdx$/, ""), href: `Text/${xhtmlName}` });
}

// 登记图片到 manifest
const manifestExtra = [];
const figSrcDir = path.resolve(mdxDir, "public", "figures");
try {
  const figs = await fs.readdir(figSrcDir);
  let idx = 0;
  for (const fn of figs) {
    const src = path.join(figSrcDir, fn);
    if (!(await fs.stat(src)).isFile()) continue;
    await fs.copyFile(src, path.join(OEBPS, "Images", fn));
    const ext = path.extname(fn).slice(1).toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml"
               : ext === "png" ? "image/png"
               : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
               : ext === "gif" ? "image/gif"
               : "application/octet-stream";
    manifestExtra.push(`<item id="img-${idx++}" href="Images/${fn}" media-type="${mime}"/>`);
  }
  console.log(`Copied ${figs.length} figures into OEBPS/Images`);
} catch {
  console.warn("No figures dir found at", figSrcDir);
}

// 登记 CSS 和字体
manifestExtra.push(`<item id="css" href="css/stylesheet.css" media-type="text/css"/>`);

const manifestItems = [
  `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
  ...manifestExtra,
  ...chapterFiles.map(c =>
    `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`),
].join("\n");
const spineItems = chapterFiles.map(c => `<itemref idref="${c.id}"/>`).join("\n");

const bookTitle = process.env.BOOK_TITLE || "CookBook";
const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escHtml(bookTitle)}</dc:title>
<dc:language>zh-CN</dc:language>
<dc:identifier id="uid">urn:cookbook:${Date.now()}</dc:identifier>
</metadata>
<manifest>
${manifestItems}
</manifest>
<spine>
${spineItems}
</spine>
</package>`;
await fs.writeFile(path.join(OEBPS, "content.opf"), opf, "utf8");

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
await fs.writeFile(path.join(buildDir, "META-INF", "container.xml"), container, "utf8");

const navList = chapterFiles.map(c => `<li><a href="${c.href}">${c.id}</a></li>`).join("\n");
const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><title>Navigation</title></head>
<body>
<nav epub:type="toc"><ol>${navList}</ol></nav>
</body></html>`;
await fs.writeFile(path.join(OEBPS, "nav.xhtml"), nav, "utf8");

// 加载 CSS（优先 formula-image，如果存在）
const cssPath = path.resolve(SKILL_ROOT, "assets", "stylesheet.template.css");
let css;
try {
  css = await fs.readFile(cssPath, "utf8");
} catch {
  css = "body { font-family: serif; }";
}
// 在 CSS 尾部追加 callout / math / 表格 / 占位图样式（兼容 mdx 里没覆盖到的类）
css += `
/* === Cookbook Generator 追加样式 === */
.callout-chapteroutline { border-left: 4px solid #3b82f6; background: rgba(59,130,246,0.08); padding: 0.75em 1em; margin: 1em 0; border-radius: 4px; }
.callout-recipe         { border-left: 4px solid #f59e0b; background: rgba(245,158,11,0.08); padding: 0.75em 1em; margin: 1em 0; border-radius: 4px; }
.callout-pitfall        { border-left: 4px solid #ef4444; background: rgba(239,68,68,0.08); padding: 0.75em 1em; margin: 1em 0; border-radius: 4px; }
.callout-keypoints      { border-left: 4px solid #22c55e; background: rgba(34,197,94,0.08);  padding: 0.75em 1em; margin: 1em 0; border-radius: 4px; }
table.gfm-table { border-collapse: collapse; margin: 1em 0; width: 100%; }
table.gfm-table th, table.gfm-table td { border: 1px solid #ccc; padding: 0.4em 0.7em; }
table.gfm-table thead { border-top: 2px solid #000; border-bottom: 1.5px solid #000; }
table.gfm-table tbody { border-bottom: 2px solid #000; }
.math-inline { font-style: italic; font-family: serif; }
.math-block { text-align: center; margin: 1em 0; font-style: italic; font-family: serif; }
.diagram-placeholder { text-align: center; color: #888; font-size: 0.9em; border: 1px dashed #aaa; padding: 1em; margin: 1em 0; }
pre.code-block { border: 1px solid #000; border-left: 4px solid #4a90d9; background: #f8f9fb; padding: 0.8em 1em; margin: 1em 0; border-radius: 4px; white-space: pre-wrap; word-wrap: break-word; font-family: "LXGW WenKai Mono", Consolas, monospace; font-size: 0.88em; }
code { font-family: "LXGW WenKai Mono", Consolas, monospace; }
`;
await fs.writeFile(path.join(OEBPS, "css", "stylesheet.css"), css, "utf8");

await buildEpub(buildDir, path.join(outDir, "book.epub"));
console.log("EPUB built at epub/book.epub");
