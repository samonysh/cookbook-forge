// scripts/lib/typst-lint.mjs
//
// Typst 章节静态检查（lint）与数学规则自动修复（fix）共享库。
// 规则来源：pdf-to-typst-notes/scripts/fix_common.py（typst 0.15.1 实测验证的规则集），
// 移植为 Node 并针对本流水线增强：
//   - 跳过 raw 代码块（``` 围栏）与 // 注释行，不误伤代码示例；
//   - 行号定位，报告可直接跳转修复；
//   - `\$` 转义掩码，避免货币符号误判为数学定界符；
//   - lint / fix 共用同一套 span 提取，保证"报的问题"与"修的问题"一致；
//   - 表格质量（P0）：parseTableCalls 估算行列，lint 校验 hline 重复/越界、
//     行列一致性、长表格分页（阈值 config.tables.splitThreshold）；
//   - callout 健壮性（P0）：parseCalloutCalls 校验内容块闭合、颜色键合法
//     （config.callout.palette/types）、参数个数、嵌套警告。
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

// ---------- P1-5 编译错误知识库（与 SKILL.md / stage-5e 失败点速查一致） ----------

const ERROR_KB = [
  { match: /^label `<([^>]+)>` does not exist/, sug: `引用 @<label> 指向不存在的 label。检查该表格/图片是否已注入 <fig-C-S>/<tab-C-S>；跨章引用是单项 probe 固有误报（整书编译可解析），勿手改。` },
  { match: /^cannot place horizontal line/, sug: `table.hline 位置非法：y 重复或超出总行数（合法 0..总行数）。lint 规则 table-hline-duplicate / table-hline-out-of-range 会定位具体行。` },
  { match: /^unexpected closing bracket/, sug: `存在不匹配的 ]。常见于 callout 内容块 [ ] 或表格单元格的多余闭括号；按 lint 行号配平衡括号。` },
  { match: /^missing argument: body/, sug: `callout-box 缺少 body：只传了颜色键/标题、尾部内容块缺失，或内容块被误当 title-text。--fix 会自动补标题参数。` },
  { match: /^unknown variable:/, sug: `裸变量/混用 LaTeX 语法：数学符号、裸中文或缩写未加引号、\\oplus 等 LaTeX 名未映射。--fix 自动处理常见符号与裸词。` },
  { match: /expected closing delimiter/, sug: `配对的括号/定界符缺失，常见于数学块或 table 参数表。检查 $...$ 与 callout 内容块闭合。` },
  { match: /^error: expected/, sug: `语法结构不完整（缺逗号/括号/参数）。对照相邻 table() / callout-box() / figure() 的完整调用检查。` },
  { match: /not found in sources/, sug: `#include / image 指向的文件不存在。图片路径应写 ../figures/<name>（章节在 chapters/ 下）。` },
];

/**
 * 编译错误信息 -> 知识库修复建议（无匹配返回 null）。
 * 供 _check_report.json 附加 suggestion 字段，也便于 agent 直接消费。
 */
export function errorSuggestion(message) {
  for (const kb of ERROR_KB) {
    if (kb.match.test(message)) return kb.sug;
  }
  return null;
}

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

// ---------- 标题 / figure 解析助手（lint 与 typst-optimize.mjs 共享） ----------

/**
 * 解析标题行（= / == / === ...），跳过 raw 块与注释行。
 * @param {string} text
 * @returns {{ lineIndex: number, line: number, level: number, title: string, raw: string }[]}
 *   lineIndex 0 起，line 1 起。
 */
export function parseHeadingLines(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const rawMask = computeRawMask(lines);
  const out = [];
  lines.forEach((l, i) => {
    if (rawMask[i] || COMMENT_RE.test(l)) return;
    const m = /^(={1,6})\s+(.*)$/.exec(l);
    if (m) out.push({ lineIndex: i, line: i + 1, level: m[1].length, title: m[2].trim(), raw: l });
  });
  return out;
}

/** 标题手动编号模式：`第 N 章`（一级，无歧义）与 `N(.M)+`（二级及以上）。 */
export const HEADING_L1_NUM_RE = /^第\s*\d+\s*[章讲部回]\s*[:：、.]?\s*/;
export const HEADING_LN_NUM_RE = /^(\d+)((?:\.\d+)+)\s*[:：、.]?\s*/;

/**
 * 解析 `#figure(...)` 调用块（平衡括号扫描，跳过字符串与注释），并探测尾部 `<label>`。
 * @param {string} text
 * @returns {{ start: number, end: number, text: string, label: string|null,
 *             labelEnd: number, hasImage: boolean, hasTable: boolean,
 *             startLine: number, endLine: number }[]}
 *   start/end 为 `#` 与闭合 `)` 之后一位的字符偏移（基于 \n 归一化文本）；行号 1 起。
 */
export function parseFigureBlocks(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const lineStarts = [];
  let off = 0;
  for (const l of lines) {
    lineStarts.push(off);
    off += l.length + 1;
  }
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  const results = [];
  const figRe = /(^|[^\w.#@])#figure\s*\(/g;
  let m;
  while ((m = figRe.exec(normalized)) !== null) {
    const callStart = m.index + m[1].length;
    const li = lineOf(callStart);
    if (rawMask[li] || COMMENT_RE.test(lines[li])) continue;

    // 平衡括号扫描（跳过字符串与 // /* */ 注释；[] 只作为嵌套上下文不参与配对终止条件）
    let i = m.index + m[0].length - 1; // '(' 的位置
    let depth = 0;
    let end = -1;
    while (i < normalized.length) {
      const ch = normalized[i];
      if (ch === '"') {
        i++;
        while (i < normalized.length && normalized[i] !== '"') {
          if (normalized[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "/" && normalized[i + 1] === "/") {
        while (i < normalized.length && normalized[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && normalized[i + 1] === "*") {
        i += 2;
        while (i < normalized.length && !(normalized[i] === "*" && normalized[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === "(") { depth++; i++; continue; }
      if (ch === ")") {
        depth--;
        i++;
        if (depth === 0) { end = i; break; }
        continue;
      }
      i++;
    }
    if (end === -1) continue; // 括号不闭合：交由编译检查暴露

    // 尾部 label 探测（跨行空白之后）
    let k = end;
    while (k < normalized.length && /\s/.test(normalized[k])) k++;
    let label = null;
    let labelEnd = end;
    if (normalized[k] === "<") {
      const close = normalized.indexOf(">", k);
      const cand = close === -1 ? "" : normalized.slice(k + 1, close);
      if (close !== -1 && /^[a-zA-Z][\w-]*$/.test(cand)) {
        label = cand;
        labelEnd = close + 1;
      }
    }
    const body = normalized.slice(callStart, end);
    results.push({
      start: callStart,
      end,
      text: body,
      label,
      labelEnd,
      hasImage: /(^|[^\w.])image\s*\(/.test(body),
      hasTable: /(^|[^\w.])table\s*\(/.test(body),
      startLine: lineOf(callStart) + 1,
      endLine: lineOf(end - 1) + 1,
    });
    figRe.lastIndex = end;
  }
  return results;
}

/**
 * 判断字符偏移 idx 是否位于双引号字符串内（按所在行的引号奇偶性，含转义处理）。
 * 用于避免把字符串里的 "图 1-2" / @xxx 当作正文引用处理。
 */
export function isInsideString(text, idx) {
  const lineStart = text.lastIndexOf("\n", Math.max(idx - 1, 0)) + 1;
  let inStr = false;
  for (let i = lineStart; i < idx; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === '"') inStr = !inStr;
  }
  return inStr;
}

// ---------- 表格 / callout 解析助手（P0 表格质量 + callout 健壮性） ----------

/** 长表格行数阈值（可被 config.tables.splitThreshold 覆盖）。 */
export const DEFAULT_TABLE_SPLIT_THRESHOLD = 12;

/** callout 颜色键 / 类型映射的内置缺省（与 assets/typst-default.config.json 保持一致）。 */
export const DEFAULT_CALLOUT_PALETTE = { blue: {}, orange: {}, red: {}, green: {} };
export const DEFAULT_CALLOUT_TYPES = {
  chapteroutline: { color: "blue", title: "本章地图" },
  recipe: { color: "orange", title: "Recipe" },
  pitfall: { color: "red", title: "陷阱" },
  keypoints: { color: "green", title: "核心要点" },
};

/** 构建行号索引（字符偏移 -> 行号，1 起）。 */
function buildLineIndex(normalized) {
  const lineStarts = [];
  let off = 0;
  for (const l of normalized.split("\n")) {
    lineStarts.push(off);
    off += l.length + 1;
  }
  return {
    lineOf(idx) {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

/**
 * 从开括号位置做平衡扫描，返回配对闭括号之后一位的偏移；不可配对返回 -1。
 * 跳过字符串与注释；( ) [ ] { } 均计入深度。
 */
function scanBalanced(text, openIdx) {
  const CLOSER = { "(": ")", "[": "]", "{": "}" };
  const stack = [CLOSER[text[openIdx]]];
  if (!stack[0]) return -1;
  let i = openIdx + 1;
  while (i < text.length && stack.length > 0) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (CLOSER[ch]) stack.push(CLOSER[ch]);
    else if (ch === ")" || ch === "]" || ch === "}") stack.pop();
    i++;
  }
  return stack.length === 0 ? i : -1;
}

/**
 * 扫描标记模式内容块 [...]：只跟踪方括号深度（圆/花括号在标记里是普通文本，
 * 如 `:)`），跳过字符串、行注释与块注释、`\[` 转义。返回闭合 ] 之后一位；未闭合返回 -1。
 */
function scanContentBlock(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * 顶层逗号切分（代码模式参数表）：text[from, to) 内深度 0 的逗号切段，
 * 跳过字符串与注释；闭括号与栈顶不匹配时容错跳过（单元格文本里的裸括号）。
 * @returns {{ start: number, end: number, text: string }[]} 非空参数段
 */
export function splitTopLevelArgs(text, from, to) {
  const segs = [];
  let depth = 0;
  let segStart = from;
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < to && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && i + 1 < to && text[i + 1] === "/") {
      while (i < to && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && i + 1 < to && text[i + 1] === "*") {
      i += 2;
      while (i < to && !(text[i] === "*" && i + 1 < to && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; i++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      segs.push({ start: segStart, end: i, text: text.slice(segStart, i) });
      segStart = i + 1;
    }
    i++;
  }
  if (segStart < to) segs.push({ start: segStart, end: to, text: text.slice(segStart, to) });
  return segs.filter((s) => s.text.trim() !== "");
}

/**
 * 解析 table(...) 调用（跳过 raw 块与注释行；不匹配 table.hline/vline/cell/header）。
 * 列数取 columns: N 或 columns: (..) 的顶层元素数；行数优先显式 rows: N，
 * 否则按 (header + footer + 数据单元格) / 列数 向上取整。
 * colspan/rowspan 会降低估算精度（hasSpans = true 时调用方应跳过行列一致性检查）。
 * @returns {{ start, end, parenEnd, startLine, columns, rows, totalCells,
 *             hlines: { y: number, line: number }[], hasBreakable, breakableFalse, hasSpans }[]}
 */
export function parseTableCalls(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const { lineOf } = buildLineIndex(normalized);
  const results = [];
  const tableRe = /(^|[^.\w])#?table\s*\(/g;
  let m;
  while ((m = tableRe.exec(normalized)) !== null) {
    const parenIdx = m.index + m[0].length - 1;
    const ln = lineOf(parenIdx);
    if (rawMask[ln - 1] || COMMENT_RE.test(lines[ln - 1])) continue;
    const end = scanBalanced(normalized, parenIdx);
    if (end === -1) continue;

    let columns = null;
    let rows = null;
    let hasBreakable = false;
    let breakableFalse = false;
    let hasSpans = false;
    let dataCells = 0;
    let headerCells = 0;
    let footerCells = 0;
    const hlines = [];

    for (const seg of splitTopLevelArgs(normalized, parenIdx + 1, end - 1)) {
      const s = seg.text.trim();
      // seg.start 指向上一个逗号后的换行符（上一行行尾），跳过前导空白才是实际内容行
      const segLine = lineOf(seg.start + (seg.text.length - seg.text.trimStart().length));
      if (/^table\.hline\s*\(/.test(s)) {
        const inner = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
        let y = 0;
        const ym = /\by:\s*(\d+)/.exec(inner);
        if (ym) y = Number(ym[1]);
        else {
          const pm = /^\s*(\d+)\s*[,)]/.exec(inner) || /^\s*(\d+)\s*$/.exec(inner);
          if (pm) y = Number(pm[1]);
        }
        hlines.push({ y, line: segLine });
      } else if (/^table\.(header|footer)\s*\(/.test(s)) {
        const pIdx = normalized.indexOf("(", seg.start);
        const pEnd = scanBalanced(normalized, pIdx);
        if (pEnd !== -1) {
          const cells = splitTopLevelArgs(normalized, pIdx + 1, pEnd - 1)
            .filter((x) => !/^[A-Za-z_][\w-]*\s*:/.test(x.text.trim()));
          if (s.startsWith("table.header")) headerCells += cells.length;
          else footerCells += cells.length;
        }
      } else if (/^table\.cell\s*\(/.test(s)) {
        dataCells++;
        if (/(col|row)span\s*:/.test(s)) hasSpans = true;
      } else if (/^table\.vline\s*\(/.test(s)) {
        // vline 不参与行列估算
      } else {
        const nm = /^([A-Za-z_][\w-]*)\s*:/.exec(s);
        if (nm) {
          const rest = s.slice(nm[0].length).trim();
          if (nm[1] === "columns") {
            const cm = /^(\d+)\b/.exec(rest);
            if (cm) columns = Number(cm[1]);
            else if (rest.startsWith("(")) {
              const pIdx = normalized.indexOf("(", seg.start);
              const pEnd = scanBalanced(normalized, pIdx);
              if (pEnd !== -1) columns = splitTopLevelArgs(normalized, pIdx + 1, pEnd - 1).length;
            }
          } else if (nm[1] === "rows") {
            const rm = /^(\d+)\b/.exec(rest);
            if (rm) rows = Number(rm[1]);
          } else if (nm[1] === "breakable") {
            hasBreakable = true;
            if (/^false\b/.test(rest)) breakableFalse = true;
          }
        } else {
          dataCells++;
          if (/(col|row)span\s*:/.test(s)) hasSpans = true;
        }
      }
    }

    const totalCells = dataCells + headerCells + footerCells;
    const estRows = rows ?? (columns ? Math.ceil(totalCells / columns) : null);
    results.push({
      start: m.index + m[1].length,
      end,
      parenEnd: parenIdx + 1,
      startLine: ln,
      columns,
      rows: estRows,
      totalCells,
      hlines,
      hasBreakable,
      breakableFalse,
      hasSpans,
    });
    tableRe.lastIndex = end;
  }
  return results;
}

/**
 * 解析 #callout-box(...) 调用：位置参数计数、首参数颜色键（带引号字符串）、
 * 尾部内容块 [...] 闭合状态、内容块内嵌套 callout 计数。
 * @returns {{ start, end, startLine, positionalCount, namedTitle, namedBody,
 *             colorArg, colorArgStart, colorArgEnd, colorArgRaw, colorLine,
 *             hasContent, closed, contentStart, contentEnd, nested }[]}
 */
export function parseCalloutCalls(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const { lineOf } = buildLineIndex(normalized);
  const results = [];
  const re = /(^|[^\w.#@])#callout-box\s*\(/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const callStart = m.index + m[1].length;
    const parenIdx = m.index + m[0].length - 1;
    const ln = lineOf(parenIdx);
    if (rawMask[ln - 1] || COMMENT_RE.test(lines[ln - 1])) continue;
    const end = scanBalanced(normalized, parenIdx);
    if (end === -1) continue;

    let positionalCount = 0;
    let namedTitle = false;
    let namedBody = false;
    let firstPositional = null;
    for (const seg of splitTopLevelArgs(normalized, parenIdx + 1, end - 1)) {
      const s = seg.text.trim();
      const nm = /^([A-Za-z_][\w-]*)\s*:/.exec(s);
      if (nm) {
        if (nm[1] === "title-text" || nm[1] === "title") namedTitle = true;
        if (nm[1] === "body") namedBody = true;
      } else {
        positionalCount++;
        if (!firstPositional) firstPositional = seg;
      }
    }

    let colorArg = null;
    let colorArgStart = -1;
    let colorArgEnd = -1;
    if (firstPositional) {
      const cm = /^(\s*)"(.*?)"/.exec(firstPositional.text);
      if (cm) {
        colorArg = cm[2];
        colorArgStart = firstPositional.start + cm[1].length;
        colorArgEnd = colorArgStart + cm[0].length - cm[1].length;
      }
    }

    let k = end;
    while (k < normalized.length && /\s/.test(normalized[k])) k++;
    let hasContent = false;
    let closed = false;
    let contentStart = -1;
    let contentEnd = -1;
    if (normalized[k] === "[") {
      hasContent = true;
      contentStart = k;
      const close = scanContentBlock(normalized, k);
      if (close !== -1) {
        closed = true;
        contentEnd = close;
      }
    }

    let nested = 0;
    if (closed) {
      const nRe = /#callout-box\s*\(/g;
      while (nRe.exec(normalized.slice(contentStart, contentEnd)) !== null) nested++;
    }

    results.push({
      start: callStart,
      end: closed ? contentEnd : end,
      startLine: ln,
      positionalCount,
      namedTitle,
      namedBody,
      colorArg,
      colorArgStart,
      colorArgEnd,
      colorArgRaw: firstPositional ? firstPositional.text.trim() : null,
      colorLine: firstPositional
        ? lineOf(firstPositional.start + (firstPositional.text.length - firstPositional.text.trimStart().length))
        : ln,
      hasContent,
      closed,
      contentStart,
      contentEnd,
      nested,
    });
    re.lastIndex = closed ? contentEnd : end;
  }
  return results;
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
  // P1-3 数学符号映射扩展：优先替换为 Typst 原生符号/Unicode 字符（0.14+ 对 LaTeX 名支持不稳）
  [/\boplus\b/g, "\u2295", "oplus -> ⊕"],
  [/\botimes\b/g, "\u2297", "otimes -> ⊗"],
  [/\bodot\b/g, "\u2299", "odot -> ⊙"],
  [/\brightarrow\b/g, "\u2192", "rightarrow -> →"],
  [/\blongrightarrow\b/g, "\u27f6", "longrightarrow -> ⟶"],
  [/\bleftarrow\b/g, "\u2190", "leftarrow -> ←"],
  [/\buparrow\b/g, "\u2191", "uparrow -> ↑"],
  [/\bdownarrow\b/g, "\u2193", "downarrow -> ↓"],
  [/\bleftrightarrow\b/g, "\u2194", "leftrightarrow -> ↔"],
  [/\bgeq\b/g, "\u2265", "geq -> ≥"],
  [/\bleq\b/g, "\u2264", "leq -> ≤"],
  [/\bneq\b/g, "\u2260", "neq -> ≠"],
  [/\bapprox\b/g, "\u2248", "approx -> ≈"],
  [/\bpropto\b/g, "\u221d", "propto -> ∝"],
  [/\binfty\b/g, "\u221e", "infty -> ∞"],
  [/\bforall\b/g, "\u2200", "forall -> ∀"],
  [/\bexists\b/g, "\u2203", "exists -> ∃"],
  [/\bnabla\b/g, "\u2207", "nabla -> ∇"],
  [/\bpartial\b/g, "dif", "partial -> dif"],
  [/\bimplies\b/g, "\u27f9", "implies -> ⟹"],
  [/\biff\b/g, "\u27fa", "iff -> ⟺"],
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
 * @param {{ fileName?: string, projectDir?: string, config?: object,
 *           labelIndex?: Set<string>, labelIndexComplete?: boolean }} opts
 *     projectDir 提供时启用图片路径存在性检查；
 *     config 提供时按其开关编号类规则（缺省按默认配置：自动编号/自动 label 均开）；
 *     labelIndex 提供时启用引用类规则（fig-ref-unresolved / dangling-ref），
 *     labelIndexComplete = false 时（仍有章节未转换）跳过 dangling-ref 避免误报。
 * @returns {{ line: number, severity: "error"|"warn", rule: string, message: string, fixable: boolean }[]}
 */
export async function lintText(text, opts = {}) {
  const { fileName = "", projectDir = null, config = null, labelIndex = null, labelIndexComplete = true } = opts;
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

  // E. 标题手动编号（P0-1：模板已自动编号，正文标题不得再带手动编号）
  const headingsAuto = !config || !config.headings || config.headings.autoNumber !== false;
  const headingsStrip = !config || !config.headings || config.headings.stripManualNumbers !== false;
  if (headingsAuto && headingsStrip) {
    for (const h of parseHeadingLines(normalized)) {
      if (h.level === 1 && HEADING_L1_NUM_RE.test(h.title)) {
        push(h.line, "error", "heading-manual-number",
          `一级标题含手动编号 "${h.title.slice(0, 24)}"：模板已自动编号「${(config?.headings?.level1Pattern) || "第 {n} 章"}」，--fix 会剥离编号`, true);
      } else if (h.level >= 2 && HEADING_LN_NUM_RE.test(h.title)) {
        push(h.line, "error", "heading-manual-number",
          `标题含手动编号 "${h.title.slice(0, 24)}"：模板已自动编号，--fix 会剥离编号`, true);
      }
    }
  }

  // F. figure 缺 label（P0-2：无 label 的 figure 无法被 @ref 引用）
  const figAutoLabel = !config || !config.figures || config.figures.autoLabel !== false;
  if (figAutoLabel) {
    for (const fig of parseFigureBlocks(normalized)) {
      if (fig.label) continue;
      const kind = fig.hasImage ? "图" : fig.hasTable ? "表" : null;
      if (!kind) continue; // 非 image/table figure（自定义 kind）不在自动化范围
      const prefix = fig.hasImage
        ? (config?.figures?.labelPrefix || "fig")
        : (config?.tables?.labelPrefix || "tab");
      push(fig.startLine, "error", "figure-missing-label",
        `${kind} figure 缺少 label：--fix 会自动注入 <${prefix}-C-S>（C=章号、S=章内序号）`, true);
    }
  }

  // G/H. 引用完整性（P0-2：需要跨章 label 全量索引）
  if (labelIndex) {
    const lines = normalized.split("\n");
    const rawMask2 = computeRawMask(lines);
    const mathLines = new Set();
    for (const span of extractMathSpans(normalized)) {
      for (let ln = span.startLine; ln <= span.endLine; ln++) mathLines.add(ln);
    }

    // G. 正文 "图 N-M" / "表 N-M" 纯文本引用无法解析到已注入的 label
    const figPrefix = config?.figures?.labelPrefix || "fig";
    const tabPrefix = config?.tables?.labelPrefix || "tab";
    const seps = (config?.figures?.refSeparators || ["-", "–", "—"]).join("");
    const refRe = new RegExp(`([图表])\\s*(\\d+)\\s*[${seps}]\\s*(\\d+)`, "g");
    let rm;
    while ((rm = refRe.exec(normalized)) !== null) {
      const line = (normalized.slice(0, rm.index).match(/\n/g) || []).length + 1;
      if (rawMask2[line - 1] || mathLines.has(line) || COMMENT_RE.test(lines[line - 1])) continue;
      if (isInsideString(normalized, rm.index)) continue;
      const prefix = rm[1] === "图" ? figPrefix : tabPrefix;
      const label = `${prefix}-${rm[2]}-${rm[3]}`;
      if (!labelIndex.has(label)) {
        push(line, "warn", "fig-ref-unresolved",
          `正文引用 "${rm[0].trim()}" 找不到对应 label <${label}>：请核对编号或补齐图片`);
      }
    }

    // H. 悬空 @ref（编译必然报 label does not exist）
    if (labelIndexComplete) {
      const atRe = /@([a-zA-Z][\w-]*)/g;
      let am;
      while ((am = atRe.exec(normalized)) !== null) {
        const line = (normalized.slice(0, am.index).match(/\n/g) || []).length + 1;
        if (rawMask2[line - 1] || mathLines.has(line) || COMMENT_RE.test(lines[line - 1])) continue;
        if (isInsideString(normalized, am.index)) continue;
        if (!labelIndex.has(am[1])) {
          push(line, "error", "dangling-ref",
            `悬空引用 @${am[1]}：label 不存在（编译会报 "label does not exist"）`);
        }
      }
    }
  }

  // I. 表格质量（P0：hline 位置 / 行列一致性 / 长表格分页）
  const splitThreshold = config?.tables?.splitThreshold ?? DEFAULT_TABLE_SPLIT_THRESHOLD;
  const figSpans = parseFigureBlocks(normalized);
  for (const t of parseTableCalls(normalized)) {
    const inFigure = figSpans.some((f) => t.start >= f.start && t.end <= f.end);

    const seenY = new Map();
    for (const h of t.hlines) {
      const prev = seenY.get(h.y);
      if (prev !== undefined) {
        push(h.line, "error", "table-hline-duplicate",
          `table.hline 在 y=${h.y} 重复定义（第 ${prev} 行已有一条）：两条线叠加渲染，删除多余 hline 或调整 y`);
      } else {
        seenY.set(h.y, h.line);
      }
    }

    if (t.rows != null && !t.hasSpans) {
      for (const h of t.hlines) {
        if (h.y > t.rows) {
          push(h.line, "error", "table-hline-out-of-range",
            `table.hline 的 y=${h.y} 超出表格总行数 ${t.rows}（合法 0-${t.rows}，${t.rows} 为表底线）——Typst 报 cannot place horizontal line 的根因`);
        }
      }
    }

    if (t.columns != null && !t.hasSpans && t.totalCells > 0 && t.totalCells % t.columns !== 0) {
      push(t.startLine, "warn", "table-row-mismatch",
        `单元格数 ${t.totalCells} 不是列数 ${t.columns} 的整数倍：最后一行不完整，转换可能丢失或多余了单元格`);
    }

    if (t.rows != null && t.rows > splitThreshold) {
      if (!t.hasBreakable) {
        push(t.startLine, "warn", "table-oversize",
          `长表格约 ${t.rows} 行（阈值 ${splitThreshold}）：--fix 会注入 breakable: true` +
            (inFigure
              ? "；figure 内表格跨页还依赖模板的 #show figure.where(kind: table): set block(breakable: true)"
              : "；超长表建议拆分为多个小表提高可读性"),
          true);
      } else if (t.breakableFalse) {
        push(t.startLine, "warn", "table-oversize",
          `长表格约 ${t.rows} 行且显式 breakable: false：表格无法跨页会溢出页面，请移除该限制或拆表`);
      }
    }
  }

  // J. Callout 健壮性（P0：内容块闭合 / 颜色键校验 / 嵌套警告）
  const paletteKeys = new Set(Object.keys(config?.callout?.palette || DEFAULT_CALLOUT_PALETTE));
  const calloutTypes = config?.callout?.types || DEFAULT_CALLOUT_TYPES;
  for (const c of parseCalloutCalls(normalized)) {
    if (!c.hasContent && !(c.positionalCount >= 3 || c.namedBody)) {
      push(c.startLine, "error", "callout-missing-body",
        "callout-box 缺少 body：需要尾部内容块 [...] 或第三个位置参数（编译报 missing argument: body）");
      continue;
    }
    if (c.hasContent && !c.closed) {
      push(c.startLine, "error", "callout-unclosed",
        "callout 内容块 [ ] 未闭合（嵌套括号配对失衡，编译报 expected closing bracket）");
    }
    if (c.hasContent) {
      if (c.positionalCount > 2) {
        push(c.startLine, "error", "callout-extra-args",
          `callout-box 位置参数过多（${c.positionalCount} 个）：签名是 callout-box(color-key, title-text, body)`);
      } else if (c.positionalCount < 2 && !c.namedTitle) {
        push(c.startLine, "error", "callout-missing-title",
          "callout-box 缺少标题参数：尾部内容块会被误当成 title-text、body 缺失（编译报 missing argument: body）", true);
      }
    }
    if (c.colorArg != null && !paletteKeys.has(c.colorArg)) {
      const mapped = calloutTypes[c.colorArg];
      if (mapped) {
        push(c.colorLine, "error", "callout-unknown-color",
          `callout 第一个参数是类型名 "${c.colorArg}"，应为颜色键（${[...paletteKeys].join("/")}）：--fix 会替换为 "${mapped.color}"`, true);
      } else {
        push(c.colorLine, "error", "callout-unknown-color",
          `callout 未知颜色键 "${c.colorArg}"：合法值 ${[...paletteKeys].join("/")}（callout.typ 调色板）`);
      }
    } else if (c.colorArg == null && c.colorArgRaw != null) {
      push(c.colorLine, "error", "callout-color-arg",
        `callout 第一个参数「${c.colorArgRaw.slice(0, 20)}」应为带引号的颜色键字符串（如 "blue"）`);
    }
    if (c.nested > 0) {
      push(c.startLine, "warn", "callout-nested",
        `callout 内容块内嵌套了 ${c.nested} 个 callout-box：嵌套渲染易出错，建议拆为并列的多个 callout`);
    }
  }

  // K/L. 章节引用完整性（P1-1）+ 代码块质量（P1-2）。
  const codeQ = await lintCodeBlocks(normalized, { fileName });
  for (const ci of codeQ) {
    ci.file = fileName;
    issues.push(ci);
  }

  // 正文「第 N 章」引用：已知合法章号来自 opts.chapterNumbers（main.typ include 顺序）。
  // 引用不存在的章号 -> 章号写错；存在时优化器会转 @ch-<slug>（convertChapterRefs）。
  if (opts.chapterNumbers instanceof Set && opts.chapterNumbers.size > 0) {
    const rawRef = /(?:第\s*)(\d+)\s*章/g;
    let rm;
    while ((rm = rawRef.exec(normalized)) !== null) {
      const line = (normalized.slice(0, rm.index).match(/\n/g) || []).length + 1;
      if (rawMask[line - 1] || COMMENT_RE.test(lines[line - 1])) continue;
      if (isInsideString(normalized, rm.index)) continue;
      const num = Number(rm[1]);
      if (!opts.chapterNumbers.has(num)) {
        push(line, "warn", "chapter-ref",
          `正文引用「第 ${num} 章」不在已知章号集合内（共 ${opts.chapterNumbers.size} 章）：章号可能写错`);
      }
    }
  }

  return issues;
}

/**
 * 代码块质量检查（P1-2）：长代码行溢出 + 块外裸 `@` 转义。
 * 独立于 lintText 抽出，便于测试；lintText 内部也调用。不依赖 config。
 * @param {string} text
 * @param {{ fileName?: string, maxLine?: number }} opts
 * @returns {{ line: number, severity: "error"|"warn", rule: string, message: string, fixable: boolean }[]}
 */
export async function lintCodeBlocks(text, opts = {}) {
  const { fileName = "", maxLine = 60 } = opts;
  const issues = [];
  const push = (line, severity, rule, message, fixable = false) =>
    issues.push({ file: fileName, line, severity, rule, message, fixable });

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);

  // 1) raw 块内超长行（会溢出页面）
  let curv = -1;
  for (let i = 0; i < lines.length; i++) {
    if (rawMask[i] && curv === -1) curv = i; // 进入 raw 块
    if (!rawMask[i]) { curv = -1; continue; }
    if (/^\s*(```|~~~)/.test(lines[i])) continue; // 围栏行本身
    if (lines[i].length > maxLine) {
      push(i + 1, "warn", "code-line-long",
        `代码块第 ${i + 1} 行 ${lines[i].length} 字符（> ${maxLine}）：长行会溢出页面，建议手动断行或缩进续行`);
    }
  }

  // 2) 正文（非 raw / 非注释 / 非字符串内）中的裸 `@`：Typst 里 @ 后必须紧跟 label 名，
  // 裸 @ 或 @ 后是空白/标点会是语法错误；需转义成 `\@`。
  for (let i = 0; i < lines.length; i++) {
    if (rawMask[i] || /^\s*\/\//.test(lines[i])) continue;
    const line = lines[i];
    let off = 0;
    const re = /@(?![A-Za-z0-9_-])/g;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const absIdx = m.index;
      if (isInsideString(normalized, absIdx)) continue;
      off = 1;
      break;
    }
    if (off) {
      push(i + 1, "error", "code-bare-at",
        `正文裸 @（@ 后非 label 名）：Typst 中 @ 是引用语法，普通 @ 需转义为 \\@`, true);
    }
  }
  return issues;
}
