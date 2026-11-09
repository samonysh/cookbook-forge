/**
 * scripts/lib/book-meta.mjs
 *
 * 书名解析与产物文件名清洗的共用实现。
 *
 * 产物命名约定：EPUB / LaTeX PDF / Typst PDF 一律使用书名（主标题）作为文件名，
 * 不再使用 book.epub / main.pdf 这类通用名。书名来源按优先级：
 *   1) 命令行 --title（显式覆盖）
 *   2) metadata/outline.md 的一级标题（如 `# 《书名：副标题》大纲`）
 *   3) latex/main.tex 的 \title{}/\subtitle{}
 *   4) 兜底 CookBook
 *
 * 文件名只取主标题（第一个全角/半角冒号之前），副标题仍保留在元数据里。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 拆分「主标题：副标题」，两个冒号都识别。 */
export function splitTitle(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { title: "", subtitle: "" };
  const idx = text.search(/[：:]/);
  if (idx < 0) return { title: text, subtitle: "" };
  return {
    title: text.slice(0, idx).trim(),
    subtitle: text.slice(idx + 1).trim(),
  };
}

/**
 * 把书名转成跨平台安全的文件名主干（不含扩展名）。
 * - 去书名号《》，NFKC 归一化
 * - Windows 保留字符 <>:"/\|?* 与路径分隔符转 -
 * - 空白折叠为单个 -（中文之间也不留空格）
 * - 去首尾点/横线/空白，规避 Windows 尾随点问题
 * - 避免 CON/PRN/AUX/NUL/COM1-9/LPT1-9 等保留名
 * - 截断到 120 字符，给目录路径留余量
 */
export function sanitizeFileBase(title) {
  let s = String(title ?? "").normalize("NFKC");
  s = s.replace(/[《》]/g, "");
  s = s.replace(/[\u0000-\u001f\u007f]/g, "");
  s = s.replace(/[<>:"/\\|?*]/g, "-");
  s = s.replace(/\s+/g, "-");
  s = s.replace(/-{2,}/g, "-");
  s = s.replace(/^[-.\s]+|[-.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `_${s}`;
  if (s.length > 120) s = s.slice(0, 120).replace(/[-.\s]+$/, "");
  return s || "CookBook";
}

/** 从 metadata/outline.md 的一级标题提取书名。 */
function parseOutlineTitle(raw) {
  const line = raw.split(/\r?\n/).find((l) => /^\s*#\s+/.test(l));
  if (!line) return null;
  let t = line.replace(/^\s*#\s+/, "").trim();
  const book = t.match(/《([^》]+)》/);
  if (book) return book[1].trim() || null;
  t = t.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
  t = t.replace(/\s*(新大纲|大纲|写作大纲)\s*$/, "").trim();
  return t || null;
}

/** 从 latex/main.tex 提取 \title{}/\subtitle{}。 */
function parseTexTitle(raw) {
  const title = raw.match(/\\title\{([^{}]*)\}/)?.[1]?.trim();
  if (!title) return null;
  const subtitle = raw.match(/\\subtitle\{([^{}]*)\}/)?.[1]?.trim() || "";
  return { title, subtitle };
}

/**
 * 解析书的标题元数据。
 * @param {object} opts
 * @param {string} [opts.root] 书根目录
 * @param {string|null} [opts.cliTitle] --title 显式书名
 * @param {string|null} [opts.cliSubtitle] --subtitle 显式副标题
 * @returns {Promise<{title:string, subtitle:string, fullTitle:string, fileBase:string, source:string}>}
 */
export async function resolveBookMeta({
  root = process.cwd(),
  cliTitle = null,
  cliSubtitle = null,
} = {}) {
  let rawTitle = null;
  let subtitle = "";
  let source = "fallback";

  if (cliTitle) {
    rawTitle = cliTitle;
    subtitle = cliSubtitle ?? "";
    source = "--title";
  } else {
    try {
      const outline = await fs.readFile(path.join(root, "metadata", "outline.md"), "utf8");
      const t = parseOutlineTitle(outline);
      if (t) {
        rawTitle = t;
        source = "metadata/outline.md";
      }
    } catch {}

    if (!rawTitle) {
      try {
        const tex = await fs.readFile(path.join(root, "latex", "main.tex"), "utf8");
        const parsed = parseTexTitle(tex);
        if (parsed) {
          rawTitle = parsed.title;
          subtitle = parsed.subtitle;
          source = "latex/main.tex";
        }
      } catch {}
    }

    if (cliSubtitle != null) subtitle = cliSubtitle;
  }

  if (!rawTitle) rawTitle = "CookBook";

  const split = splitTitle(rawTitle);
  const title = split.title || "CookBook";
  const fullSubtitle = subtitle || split.subtitle;
  const fullTitle = fullSubtitle ? `${title}：${fullSubtitle}` : title;

  return {
    title,
    subtitle: fullSubtitle,
    fullTitle,
    fileBase: sanitizeFileBase(title),
    source,
  };
}
