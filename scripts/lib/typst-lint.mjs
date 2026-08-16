// scripts/lib/typst-lint.mjs
//
// Typst 章节静态检查（lint）与数学规则自动修复（fix）共享库。
// 规则来源：pdf-to-typst-notes/scripts/fix_common.py（typst 0.15.1 实测验证的规则集），
// 移植为 Node 并针对本流水线增强：
//   - 跳过 raw 代码块（``` 围栏）与 // 注释行，不误伤代码示例；
//   - 行号定位，报告可直接跳转修复；
//   - `\$` 转义掩码，避免货币符号误判为数学定界符；
//   - lint / fix 共用同一套 span 提取，保证"报的问题"与"修的问题"一致。
//
// 设计纪律（与 fix_common.py 一致，顺序是承重的）：
//   1. 修复只作用于数学块（$...$），绝不碰正文；
//   2. 数学块内已加引号的字符串先保护（占位符替换），规则跑完再还原；
//   3. 长模式先于短前缀（cdots 先于 cdot；delim 元组先于裸词规则）；
//   4. 反斜杠命令先剥离（\diff -> diff -> dif），再跑裸词规则；
//   5. 数学调用命名参数的布尔/数字/元组值补 # 前缀（字符串例外，官方文档规定）；
//   6. 裸中文 / >=3 位大写缩写最后统一加引号（裸词是 unknown variable 的根因）。

import { existsSync } from "node:fs";
import path from "node:path";

// ---------- 公共正则（fix 使用时以字面量重新创建，避免 lastIndex 复用问题） ----------

const FENCE_RE = /^\s*(```|~~~)/;
const COMMENT_RE = /^\s*\/\//;

// ---------- 数学块提取（行级状态机） ----------

/**
 * 计算 raw 围栏块掩码：mask[i] === true 表示第 i 行在 raw 块内（含围栏行本身）。
 * @param {string[]} lines
 * @returns {boolean[]}
 */
export function computeRawMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inRaw = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      mask[i] = true;
      inRaw = !inRaw;
      continue;
    }
    mask[i] = inRaw;
  }
  return mask;
}

/**
 * 提取数学块 span（跳过 raw 块与注释行）。
 * 行内：单行 `$...$`（内容不含 $、至少 1 字符）；
 * 块级：某行（去缩进后）以 `$ ` 开头且不以 `$` 结尾 -> 收集到以 `$` 结尾的行。
 * @param {string} text
 * @returns {{ text: string, startLine: number, endLine: number, kind: "inline"|"block", unterminated: boolean }[]}
 *   行号从 1 开始。
 */
export function extractMathSpans(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rawMask = computeRawMask(lines);
  const spans = [];
  let buf = null;
  let bufStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf) {
      buf.push(line);
      if (line.replace(/\s+$/, "").endsWith("$")) {
        spans.push({
          text: buf.join("\n"),
          startLine: bufStart,
          endLine: i + 1,
          kind: "block",
          unterminated: false,
        });
        buf = null;
      }
      continue;
    }
    if (rawMask[i] || COMMENT_RE.test(line)) continue;

    // 掩码 \$（转义美元），保持长度一致以对齐行内偏移
    const masked = line.replace(/\\\$/g, "\u0000\u0000");
    if (!masked.includes("$")) continue;

    const stripped = line.replace(/^[ \t]+/, "");
    if (stripped.startsWith("$ ") && !line.replace(/\s+$/, "").endsWith("$")) {
      buf = [line];
      bufStart = i + 1;
      continue;
    }
    // 行内 $...$（也覆盖单行块级 $ x $）
    const inlineRe = /\$([^$\n]+)\$/g;
    let m;
    while ((m = inlineRe.exec(line)) !== null) {
      spans.push({
        text: m[0],
        startLine: i + 1,
        endLine: i + 1,
        kind: "inline",
        unterminated: false,
      });
    }
  }
  if (buf) {
    spans.push({
      text: buf.join("\n"),
      startLine: bufStart,
      endLine: lines.length,
      kind: "block",
      unterminated: true,
    });
  }
  return spans;
}

/**
 * 对每个数学 span 应用转换函数，返回新的完整文本。
 * @param {string} text
 * @param {(span: {text: string, kind: string}) => string} fn 返回替换后的 span 文本
 */
export function transformMathSpans(text, fn) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const out = [];
  let buf = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf) {
      buf.push(line);
      if (line.replace(/\s+$/, "").endsWith("$")) {
        out.push(fn({ text: buf.join("\n"), kind: "block" }));
        buf = null;
      }
      continue;
    }
    if (FENCE_RE.test(line) || rawMask[i] || COMMENT_RE.test(line)) {
      out.push(line);
      continue;
    }
    const masked = line.replace(/\\\$/g, "\u0000\u0000");
    if (!masked.includes("$")) {
      out.push(line);
      continue;
    }
    out.push(line.replace(/\$([^$\n]+)\$/g, (m) => fn({ text: m, kind: "inline" })));
  }
  if (buf) out.push(fn({ text: buf.join("\n"), kind: "block" }));
  return out.join("\n");
}

// ---------- 数学规则修复（fix_common.py 移植 + 增强） ----------

const WORD_RULES = [
  [/\bddot\b/g, "dot.double", "ddot -> dot.double"],
  [/\bdiff\b/g, "dif", "diff -> dif"],
  [/\bcdots\b/g, "dots.c", "cdots -> dots.c"],
  [/\bcdot\b/g, "dot.c", "cdot -> dot.c"],
  [/\bring\b/g, "\u2218", "ring -> ∘"],
  [/\bmatrix\(/g, "mat(", "matrix -> mat"],
  [/\bxx\b/g, "times", "xx -> times"],
  [/\bll\b/g, "<<", "ll -> <<"],
  [/\bgg\b/g, ">>", "gg -> >>"],
];

/**
 * 对单个数学块字符串应用全部固化修复规则。
 * @param {string} s 数学块原文（含定界 $）
 * @param {Record<string, number>} hits 规则命中计数（累加）
 * @returns {string} 修复后的数学块
 */
export function fixMath(s, hits = {}) {
  const bump = (note, n) => {
    hits[note] = (hits[note] || 0) + n;
  };

  // 1. 定界符/结构修复（在引号保护之前）
  s = s.replace(/delim:\s*\(\s*("[^"]*")\s*,\s*("[^"]*")\s*\)/g, (m, a, b) => {
    bump('delim: ("(",")") -> delim: #("(",")")', 1);
    return `delim: #(${a}, ${b})`;
  });
  s = s.replace(/delim:\s*none\b/g, () => {
    bump("delim: none -> delim: #none", 1);
    return "delim: #none";
  });

  // 2. 角括号转 Unicode（langle/rangle/angle.l/angle.r 在 0.14+ 不可靠）
  for (const [old, nw] of [["angle.l", "\u27e8"], ["angle.r", "\u27e9"], ["langle", "\u27e8"], ["rangle", "\u27e9"]]) {
    if (s.includes(old)) {
      bump(`${old} -> ${nw}`, s.split(old).length - 1);
      s = s.split(old).join(nw);
    }
  }

  // 3. 引号字符串保护（已加引号的文本不再参与后续规则）
  const quoted = [];
  s = s.replace(/"[^"\n]*"/g, (q) => {
    quoted.push(q);
    return `\x00${quoted.length - 1}\x00`;
  });

  // 4. LaTeX 残留 -> Typst
  s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (m, a, b) => {
    bump("\\frac{a}{b} -> frac(a, b)", 1);
    return `frac(${a}, ${b})`;
  });
  // 已知黑板体/花体/文本命令（须在通用 \cmd 剥离之前处理）
  const MATHBB = { R: "RR", E: "EE", P: "PP", N: "NN", Z: "ZZ", Q: "QQ", C: "CC" };
  s = s.replace(/\\mathbb\{([A-Za-z])\}/g, (m, x) => {
    const t = MATHBB[x] || (x + x);
    bump(`\\mathbb{${x}} -> ${t}`, 1);
    return t;
  });
  s = s.replace(/\\mathcal\{([^{}]*)\}/g, (m, x) => {
    bump("\\mathcal{X} -> cal(X)", 1);
    return `cal(${x})`;
  });
  s = s.replace(/\\(?:text|mathrm|operatorname)\{([^{}]*)\}/g, (m, x) => {
    bump("\\text{...} -> \"...\"", 1);
    return `"${x.trim()}"`;
  });
  if (/\\(?:left|right)\b/.test(s)) {
    bump("\\left|\\right stripped", 1);
    s = s.replace(/\\(?:left|right)\b/g, "");
  }
  s = s.replace(/\\([a-zA-Z]+)/g, (m, cmd) => {
    bump("\\cmd -> cmd", 1);
    return cmd;
  });
  s = s.replace(/norm\(([^()]*), *(\d+)\)/g, (m, x, p) => {
    bump("norm(x,2) -> norm(x)_2", 1);
    return `norm(${x})_${p}`;
  });
  // 4b. LaTeX 花括号上下标 -> Typst 圆括号（内层优先，迭代到稳定）
  let prev;
  do {
    prev = s;
    s = s.replace(/([_^])\{([^{}]*)\}/g, (m, op, body) => {
      bump(`${op}{...} -> ${op}(...)`, 1);
      return `${op}(${body})`;
    });
  } while (s !== prev);

  // 5. 数学调用命名参数的布尔/数字/元组值补 #（官方规定仅字符串可裸写）
  s = s.replace(/\b((?:limits|inline):\s*)(true|false)\b/g, (m, a, b) => {
    bump(`${a.trim()} -> 补 # 前缀`, 1);
    return `${a}#${b}`;
  });
  s = s.replace(/\b(augment:\s*)\(/g, (m, a) => {
    bump("augment: ( -> augment: #(", 1);
    return `${a}#(`;
  });
  s = s.replace(/\b(augment:\s*)(-?\d+)\b/g, (m, a, n) => {
    bump("augment: N -> augment: #N", 1);
    return `${a}#${n}`;
  });

  // 6. 裸词规则（长模式在前，见 WORD_RULES 顺序）
  for (const [rx, rep, note] of WORD_RULES) {
    rx.lastIndex = 0;
    const found = s.match(rx);
    if (found) {
      bump(note, found.length);
      s = s.replace(rx, rep);
    }
  }

  // 7. 裸缩写 / 裸中文加引号（已引号包裹的被步骤 3 保护）
  s = s.replace(/(?<![\w"])([A-Z]{3,})(?![\w"])/g, (m, a) => {
    bump("acronym quoted", 1);
    return `"${a}"`;
  });
  s = s.replace(/[\u4e00-\u9fff]+/g, (m) => {
    bump("CJK text quoted", 1);
    return `"${m}"`;
  });

  // 8. 还原被保护的引号字符串
  return s.replace(/\x00(\d+)\x00/g, (m, i) => quoted[Number(i)]);
}

/**
 * 对整份章节文本应用数学规则修复（只动数学块，raw/注释/正文不动）。
 * @param {string} text
 * @returns {{ text: string, hits: Record<string, number> }}
 */
export function fixText(text) {
  const hits = {};
  const out = transformMathSpans(text, (span) => fixMath(span.text, hits));
  return { text: out, hits };
}

// ---------- 静态 lint ----------

/**
 * 静态检查章节文本，返回问题列表。
 * @param {string} text 章节原文
 * @param {{ fileName?: string, projectDir?: string }} opts
 *     projectDir 提供时启用图片路径存在性检查
 * @returns {{ line: number, severity: "error"|"warn", rule: string, message: string, fixable: boolean }[]}
 */
export async function lintText(text, opts = {}) {
  const { fileName = "", projectDir = null } = opts;
  const issues = [];
  const push = (line, severity, rule, message, fixable = false) =>
    issues.push({ file: fileName, line, severity, rule, message, fixable });

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);

  // A. 占位符 / 首行章标题（允许首部若干 #import 行，之后必须是 `= 章标题`）
  lines.forEach((l, i) => {
    if (l.includes("LLM_CONVERSION_PENDING")) {
      push(i + 1, "error", "placeholder", "占位符未替换：本章尚未完成 LLM 转换");
    }
  });
  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || COMMENT_RE.test(l)) continue;
    if (l.trim().startsWith("#import") && l.includes("callout.typ")) continue; // 首部 callout import
    headingLine = i;
    break;
  }
  if (headingLine === -1 || !/^=\s+\S/.test(lines[headingLine])) {
    push(Math.max(headingLine, 0) + 1, "error", "chapter-heading",
      "章节在首部 `#import \"../callout.typ\": callout-box` 之后必须是 `= 章标题`（Typst 一级标题）");
  }

  // B. 逐行 Markdown / LaTeX 残留（跳过 raw 块；注释行也跳过避免误报）
  const latexCmdRe = /\\[a-zA-Z]+/g;
  lines.forEach((l, i) => {
    if (rawMask[i]) return;
    if (l.includes("LLM_CONVERSION_PENDING")) return; // 已报
    if (COMMENT_RE.test(l)) return;

    if (l.includes("$$")) {
      push(i + 1, "error", "md-block-math",
        "Markdown 块级公式 $$ 残留：应转为 Typst 块级公式 `$ ... $`（两侧留空格）");
    }
    latexCmdRe.lastIndex = 0;
    const cmds = l.match(latexCmdRe);
    if (cmds) {
      push(i + 1, "error", "latex-cmd",
        `LaTeX 命令残留：${[...new Set(cmds)].slice(0, 3).join(" ")}${cmds.length > 3 ? " …" : ""}（应转为 Typst 原生语法）`);
    }
    if (/^#{1,6}\s+\S/.test(l)) {
      push(i + 1, "error", "md-heading",
        "Markdown 标题 # 残留：Typst 中 # 是 code 入口，标题应使用 = / == / ===");
    }
    if (/\*\*[^*\n]+\*\*/.test(l)) {
      push(i + 1, "error", "md-bold", "Markdown 粗体 ** 残留：Typst 粗体是 *...*（单星）");
    }
    if (/^\s*\|[-\s:|]+\|\s*$/.test(l)) {
      push(i + 1, "error", "md-table",
        "Markdown 表格残留：应转为 Typst table() + table.hline() booktabs 风格");
    }
    const mdImg = l.match(/!\[([^\]\n]*)\]\(([^)\n]+)\)/);
    if (mdImg) {
      push(i + 1, "warn", "md-image",
        `Markdown 图片 ![...](${mdImg[2]}) 残留：应转为 #figure(image(...), caption: [...])`);
    } else {
      const mdLink = l.match(/\[([^\]\n]*)\]\((https?:\/\/[^)\n]+)\)/);
      if (mdLink) {
        push(i + 1, "warn", "md-link",
          `Markdown 链接残留：应转为 #link("${mdLink[2]}")[${mdLink[1]}]`);
      }
    }
  });

  // C. 数学块内部规则（与 fixMath 同源，标记 fixable）
  for (const span of extractMathSpans(normalized)) {
    const lineOf = (idx) => span.startLine + (span.text.slice(0, idx).match(/\n/g) || []).length;
    if (span.unterminated) {
      push(span.startLine, "error", "math-unterminated", "数学块未闭合（缺少结束 $）");
    }
    const s = span.text;

    for (const [rx, note] of [
      [/\bdiff\b/g, "diff 应为 dif（Typst 微分算子）"],
      [/\bcdots\b/g, "cdots 应为 dots.c"],
      [/\bcdot\b/g, "cdot 应为 dot.c"],
      [/\bddot\b/g, "ddot 应为 dot.double"],
      [/\bmatrix\(/g, "matrix( 应为 mat(（0.14+ 改名）"],
      [/\b(?:langle|rangle)\b/g, "langle/rangle 应为 Unicode ⟨ ⟩"],
    ]) {
      rx.lastIndex = 0;
      const m = rx.exec(s);
      if (m) push(lineOf(m.index), "error", "math-word", `${note}：${s.slice(Math.max(0, m.index - 15), m.index + 20).trim()}`, true);
    }

    const boolArg = /\b((?:limits|inline):\s*)(true|false)\b/.exec(s);
    if (boolArg) push(lineOf(boolArg.index), "error", "math-hash-arg",
      "数学调用布尔参数缺 # 前缀（如 limits: #true）", true);
    const augArg = /\baugment:\s*[-\d(]/.exec(s);
    if (augArg) push(lineOf(augArg.index), "error", "math-hash-arg",
      "数学调用 augment 参数缺 # 前缀（如 augment: #2）", true);
    const delimArg = /\bdelim:\s*\(/.exec(s);
    if (delimArg) push(lineOf(delimArg.index), "error", "math-hash-arg",
      '数学调用 delim 元组缺 # 前缀（如 delim: #("(", ")")）', true);

    const labelArg = /\b(?:under|over)(?:brace|bracket|paren|shell)\([^)]*,\s*label:/.exec(s);
    if (labelArg) push(lineOf(labelArg.index), "warn", "math-label-arg",
      "underbrace/overbrace 注释是第二个位置参数：underbrace(a, b) 而非 label: b");

    const braceSub = /[_^]\{/.exec(s);
    if (braceSub) push(lineOf(braceSub.index), "error", "math-brace-sub",
      "LaTeX 花括号上下标残留：`_{...}`/`^{...}` 应转为 Typst 圆括号 `_(...)`/`^(...)`", true);

    const mlSub = /_\(([a-zA-Z]{2,})\)/.exec(s);
    if (mlSub) push(lineOf(mlSub.index), "warn", "math-multiletter-sub",
      `多字母下标 _(${mlSub[1]}) 会被当成名为 ${mlSub[1]} 的变量：多变量应空格分隔 _(i j)，文本应加引号 _("max")`);

    // 引号内容先掩码（已加引号的中文/缩写不算裸词）
    const masked = s.replace(/"[^"\n]*"/g, (q) => " ".repeat(q.length));
    const cjk = /[\u4e00-\u9fff]+/.exec(masked);
    if (cjk) push(lineOf(cjk.index), "error", "math-bare-cjk",
      `数学块内裸中文 "${cjk[0]}"：必须加双引号（裸词编译报 unknown variable）`, true);

    const acrRe = /(?<![\w"])([A-Z]{3,})(?![\w"])/g;
    let am;
    while ((am = acrRe.exec(masked)) !== null) {
      push(lineOf(am.index), "error", "math-bare-acronym",
        `数学块内裸缩写 ${am[1]}：必须加双引号（如 "${am[1]}"）`, true);
    }
  }

  // D. 图片引用存在性与路径规范（章节在 chapters/ 子目录，相对路径需 ../figures/）
  if (projectDir) {
    const imgRe = /image\("([^"]+)"/g;
    let im;
    while ((im = imgRe.exec(normalized)) !== null) {
      const line = (normalized.slice(0, im.index).match(/\n/g) || []).length + 1;
      if (rawMask[line - 1]) continue;
      const p = im[1];
      if (/^https?:/.test(p)) continue;
      const fromProject = p.startsWith("/")
        ? path.join(projectDir, p)
        : path.resolve(projectDir, p);
      const fromChapterOk = !p.startsWith("/") && existsSync(path.resolve(projectDir, "chapters", p));
      if (existsSync(fromProject)) {
        if (!p.startsWith("/") && !p.startsWith("../") && !fromChapterOk) {
          push(line, "error", "figure-path",
            `图片路径 "${p}" 相对章节文件解析会失败：章节在 chapters/ 下，应写 "../figures/<name>" 或 "/figures/<name>"`, true);
        }
      } else if (!fromChapterOk) {
        push(line, "error", "figure-missing", `图片文件不存在：${p}`);
      }
    }
  }

  return issues;
}
