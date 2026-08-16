// scripts/lib/epub-lint.mjs
//
// EPUB3 XHTML 章节静态检查（lint）、XML 良构校验与安全修复（fix）共享库。
// 适配 lbuild-epub.mjs 产出的目录结构（epub/build/OEBPS/{Text/*.xhtml, Images/, css/}）。
//
// 设计纪律：
//   - XML 良构校验为纯 JS 实现（零依赖）：标签配对 / 属性引号 / 实体合法 / 裸 <；
//     这是 EPUB 阅读器能否打开的硬闸门，等价于 typst/latex 的编译检查；
//   - Markdown/JSX 残留检查跳过 <pre>/<code> 内容（代码示例原样保留）；
//   - fix 只做确定性安全转换（className -> class、裸 & -> &amp;、**x** -> <strong>）。

import { existsSync } from "node:fs";
import path from "node:path";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// ---------- XML 良构校验（零依赖） ----------

/**
 * 校验 XHTML 字符串的 XML 良构性。
 * @param {string} text
 * @returns {{ ok: boolean, errors: { line: number, message: string }[] }}
 */
export function checkXmlWellFormed(text) {
  const errors = [];
  const push = (line, message) => errors.push({ line, message });

  const normalized = text.replace(/\r\n/g, "\n");
  // 逐字符扫描（同时记录行号），跳过：声明/注释/CDATA
  const stack = [];
  let i = 0;
  let line = 1;
  const n = normalized.length;

  while (i < n) {
    const ch = normalized[i];
    if (ch === "\n") { line++; i++; continue; }

    if (ch !== "<") {
      if (ch === "&") {
        // 实体必须是 &name; / &#123; / &#x1F;
        const m = /^&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(normalized.slice(i, i + 34));
        if (!m) push(line, "未转义的 &（必须写作 &amp;）");
        i += m ? m[0].length : 1;
        continue;
      }
      i++;
      continue;
    }

    // ch === "<"
    if (normalized.startsWith("<?", i)) {
      const end = normalized.indexOf("?>", i);
      if (end === -1) { push(line, "未闭合的处理指令 <?"); break; }
      i = end + 2;
      continue;
    }
    if (normalized.startsWith("<!--", i)) {
      const end = normalized.indexOf("-->", i);
      if (end === -1) { push(line, "未闭合的注释 <!--"); break; }
      for (let k = i; k < end; k++) if (normalized[k] === "\n") line++;
      i = end + 3;
      continue;
    }
    if (normalized.startsWith("<![CDATA[", i)) {
      const end = normalized.indexOf("]]>", i);
      if (end === -1) { push(line, "未闭合的 CDATA 节"); break; }
      i = end + 3;
      continue;
    }
    if (normalized.startsWith("<!DOCTYPE", i) || normalized.startsWith("<!doctype", i)) {
      const end = normalized.indexOf(">", i);
      if (end === -1) { push(line, "未闭合的 DOCTYPE"); break; }
      i = end + 1;
      continue;
    }

    // 普通标签
    const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(normalized.slice(i));
    if (!tagMatch) {
      push(line, "裸 < 或格式错误的标签（文本中的 < 必须写作 &lt;）");
      // 跳过这个 < 继续扫描，避免死循环
      i++;
      continue;
    }
    const [full, tagName, attrText, selfClose] = tagMatch;
    const isClose = full.startsWith("</");

    // 属性引号检查：name="value" / name='value' 合法；裸值不合法
    const attrBody = attrText.trim();
    if (attrBody && !/^(?:[a-zA-Z_:][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*')\s*)+$/.test(attrBody)) {
      push(line, `<${tagName}> 属性未加引号或含非法字符：${attrBody.slice(0, 40)}`);
    }

    if (!isClose && !selfClose) {
      stack.push({ tagName, line });
    } else if (isClose) {
      const top = stack.pop();
      if (!top) {
        push(line, `多余的闭合标签 </${tagName}>（无对应开始标签）`);
      } else if (top.tagName !== tagName) {
        push(line, `标签交叉嵌套：第 ${top.line} 行 <${top.tagName}> 未闭合就遇到 </${tagName}>`);
        // 尝试恢复：回退栈直到匹配
        while (stack.length) {
          const t = stack.pop();
          if (t.tagName === tagName) break;
        }
      }
    }
    // 自闭合 <br/> 不入栈
    const newlines = (full.match(/\n/g) || []).length;
    line += newlines;
    i += full.length;
  }

  for (const t of stack) {
    push(t.line, `标签 <${t.tagName}> 未闭合（XHTML 要求所有标签闭合）`);
  }

  return { ok: errors.length === 0, errors };
}

// ---------- <pre>/<code> span 掩码（Markdown 残留检查跳过，含行内 code） ----------

/**
 * 把 <pre>...</pre> 与 <code>...</code> 整段替换为空格（保留换行符），
 * 长度与行号完全对齐，供 Markdown 残留检查使用（代码示例内容原样保留不算残留）。
 * @param {string} text
 * @returns {string}
 */
export function maskCodeSpans(text) {
  return text.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m) =>
    m.replace(/[^\n]/g, " ")
  );
}

// ---------- lint ----------

/**
 * 静态检查 XHTML 章节文本，返回问题列表。
 * @param {string} text
 * @param {{ fileName?: string, oebpsDir?: string|null }} opts
 *     oebpsDir 提供时启用 <img src> 存在性检查（epub/build/OEBPS/）
 * @returns {{ line: number, severity: "error"|"warn", rule: string, message: string, fixable: boolean }[]}
 */
export function lintXhtml(text, opts = {}) {
  const { fileName = "", oebpsDir = null } = opts;
  const issues = [];
  const push = (line, severity, rule, message, fixable = false) =>
    issues.push({ file: fileName, line, severity, rule, message, fixable });

  const normalized = text.replace(/\r\n/g, "\n");

  // A. XML 良构（硬闸门）
  const wf = checkXmlWellFormed(normalized);
  for (const e of wf.errors) {
    push(e.line, "error", "xml-not-wellformed", e.message, e.message.includes("&"));
  }

  // B. 占位符
  const lines = normalized.split("\n");
  lines.forEach((l, i) => {
    if (l.includes("LLM_CONVERSION_PENDING") || l.includes("此章节需要 LLM 转换")) {
      push(i + 1, "error", "placeholder", "占位符未替换：本章尚未完成 LLM 转换");
    }
    if (/diagram-placeholder/.test(l) && oebpsDir) {
      push(i + 1, "warn", "diagram-placeholder", "存在图表占位 div：图表未被真实渲染产物替换");
    }
  });

  // C. Markdown / JSX 残留（在 code 掩码副本上检查，行号保持对齐）
  const masked = maskCodeSpans(normalized);
  const maskedLines = masked.split("\n");
  maskedLines.forEach((l, i) => {
    if (/^#{1,6}\s+\S/.test(l)) {
      push(i + 1, "error", "md-heading", "Markdown 标题 # 残留：应转为 <h1>~<h6>");
    }
    if (/\*\*[^*\n]+\*\*/.test(l)) {
      push(i + 1, "error", "md-bold", "Markdown 粗体 ** 残留：应转为 <strong>", true);
    }
    if (/^\s*\|[-\s:|]+\|\s*$/.test(l)) {
      push(i + 1, "error", "md-table", "Markdown 表格残留：应转为 <table>");
    }
    if (/!\[[^\]\n]*\]\([^)\n]+\)/.test(l)) {
      push(i + 1, "error", "md-image", "Markdown 图片 ![...](...) 残留：应转为 <figure><img/></figure>");
    }
    if (/\[[^\]\n]*\]\((?:https?:\/\/|\.?\/)[^)\n]+\)/.test(l)) {
      push(i + 1, "error", "md-link", "Markdown 链接 [x](url) 残留：应转为 <a href=...>");
    }
    if (/```/.test(l)) {
      push(i + 1, "error", "md-fence", "Markdown 代码围栏 ``` 残留：应转为 <pre><code>");
    }
    if (/className=/.test(l)) {
      push(i + 1, "error", "jsx-className", "JSX className 残留：XHTML 应使用 class=", true);
    }
  });

  // D. 结构与资源
  if (!/<h1[ >]/.test(normalized)) {
    push(1, "warn", "missing-h1", "body 内缺少 <h1> 章标题（阅读器目录依赖标题层级）");
  }
  if (oebpsDir) {
    for (const m of normalized.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/g)) {
      const line = (normalized.slice(0, m.index).match(/\n/g) || []).length + 1;
      const src = m[1];
      if (/^https?:/.test(src)) {
        push(line, "warn", "img-remote", `远程图片 src="${src}"：EPUB 应内嵌本地资源`);
        continue;
      }
      const resolved = path.resolve(oebpsDir, "Text", src);
      if (!existsSync(resolved)) {
        push(line, "error", "img-missing", `图片文件不存在：${src}（相对 Text/ 解析）`);
      }
    }
    const cssMatch = normalized.match(/<link[^>]*href="([^"]*\.css)"/);
    if (cssMatch && !existsSync(path.resolve(oebpsDir, "Text", cssMatch[1]))) {
      push(1, "error", "css-missing", `样式表不存在：${cssMatch[1]}`);
    }
  }

  return issues;
}

// ---------- fix（仅确定性安全转换） ----------

/**
 * 应用安全修复。处理顺序（承重）：
 *   1. 先保护 pre 与 code 整段（占位符替换）-- 代码示例里的 className 或
 *      Markdown 星号是教学内容，绝不能被改写；
 *   2. 在保护后的文本上做 className -> class 与双星粗体 -> strong；
 *   3. 还原代码段；
 *   4. 最后全局做裸 & -> &amp;（XML 转义在任何位置都必需，含代码段）。
 * @param {string} text
 * @returns {{ text: string, hits: Record<string, number> }}
 */
export function fixXhtml(text) {
  const hits = {};
  let out = text.replace(/\r\n/g, "\n");

  // 1. 保护代码段
  const codeSpans = [];
  out = out.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m) => {
    codeSpans.push(m);
    return `\x00${codeSpans.length - 1}\x00`;
  });

  // 2. 安全转换
  let n = 0;
  out = out.replace(/className=/g, () => { n++; return "class="; });
  if (n) hits["className -> class"] = n;

  n = 0;
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => {
    n++;
    return `<strong>${t}</strong>`;
  });
  if (n) hits["**x** -> <strong>x</strong>"] = n;

  // 3. 还原代码段
  out = out.replace(/\x00(\d+)\x00/g, (m, i) => codeSpans[Number(i)]);

  // 4. 裸 & 转义（全局，含代码段；XML 合法性要求）
  n = 0;
  out = out.replace(/&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, () => {
    n++;
    return "&amp;";
  });
  if (n) hits["bare & -> &amp;"] = n;

  return { text: out, hits };
}
