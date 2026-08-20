// scripts/lib/typst-optimize.mjs
//
// Typst 章节确定性优化器（P0-1 标题去重 + P0-2 图片 label 自动化 +
// P0 表格质量 + P0 callout 健壮性）。
//
// 为什么独立于 LLM 转换：模板（ilm）自动生成「第 C 章 / C.S / 图 C-S」编号，
// LLM 输出中的手动编号与纯文本引用属于「LLM 不可靠、规则可固化」的问题，
// 用确定性后处理保证幂等与一致性（与 typst-lint.mjs 的数学规则修复同一纪律）。
//
// 五个变换（全部幂等，重复运行零改动）：
//   1. stripHeadingNumbers —— 剥离标题手动编号（`第 1 章 X` -> `X`，`1.2 X` -> `X`）；
//   2. injectFigureLabels  —— 为 #figure(image(...)) 注入 <fig-C-S>、为 #figure(table(...))
//                             注入 <tab-C-S>，并剥离 caption 里与自身编号一致的前缀；
//   3. injectTableBreakable—— 超过 tables.splitThreshold 行的 table(...) 注入 breakable: true；
//   4. fixCalloutTypes     —— callout 颜色参数写类型名时映射为颜色键，缺失标题时补全；
//   5. convertFigureRefs   —— 正文纯文本引用「图 C-S / 表 C-S」在 label 存在时转为 @fig-C-S。
//
// 章号 C 的约定：取 main.typ 的 include 顺序（第 1 个被 include 的章 = 1），
// 与模板 counter(heading) 渲染出的编号天然一致。
//
// 配置：assets/typst-default.config.json（P1-4），由 lmdx2typst.mjs / typst-check.mjs 加载后传入。

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import {
  computeRawMask,
  extractMathSpans,
  parseHeadingLines,
  parseFigureBlocks,
  parseTableCalls,
  parseCalloutCalls,
  isInsideString,
  HEADING_L1_NUM_RE,
  HEADING_LN_NUM_RE,
  DEFAULT_TABLE_SPLIT_THRESHOLD,
  DEFAULT_CALLOUT_PALETTE,
  DEFAULT_CALLOUT_TYPES,
} from "./typst-lint.mjs";

/**
 * 解析 Typst 流水线配置：--config 显式路径 > 工作目录 typst.config.json > skill 默认配置。
 * @param {string|null} explicitPath --config 传入的路径
 * @param {string} cwd 工作目录
 * @param {string} skillRoot skill 根目录（含 assets/typst-default.config.json）
 * @returns {Promise<{ config: object, source: string|null }>}
 */
export async function resolveTypstConfig(explicitPath, cwd, skillRoot) {
  const candidates = [
    explicitPath,
    path.join(cwd, "typst.config.json"),
    path.join(skillRoot, "assets", "typst-default.config.json"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) {
      return { config: JSON.parse(await fs.readFile(c, "utf8")), source: c };
    }
  }
  return { config: {}, source: null };
}

/** 收集文本中已有的全部 figure label（构建跨章引用索引用）。 */
export function collectFigureLabels(text) {
  return parseFigureBlocks(text.replace(/\r\n/g, "\n"))
    .filter((f) => f.label)
    .map((f) => ({ label: f.label, line: f.endLine, hasImage: f.hasImage, hasTable: f.hasTable }));
}

// ---------- P0-1 标题手动编号剥离 ----------

/**
 * 剥离标题行中的手动编号（模板会自动编号，双重编号是 P0-1 的问题源）。
 * - 一级标题：`第 1 章 X` / `第1章：X` -> `X`（模式无歧义，无条件剥离）；
 * - 二级及以下：`1.2 X` -> `X`（`N(.M)+` 需首段 N 与本章章号一致才剥离，
 *   防止误伤 `3.8 新特性` 这类以版本号开头的标题；章号未知时不剥离）。
 * @param {string} text
 * @param {{ chapterNumber?: number|null }} opts
 * @returns {{ text: string, stripped: { line: number, before: string, after: string }[] }}
 */
export function stripHeadingNumbers(text, opts = {}) {
  const { chapterNumber = null } = opts;
  const normalized = text.replace(/\r\n/g, "\n");
  const headings = parseHeadingLines(normalized);
  const lineEdits = [];
  const stripped = [];

  for (const h of headings) {
    let t = h.title;
    if (h.level === 1) {
      const m1 = HEADING_L1_NUM_RE.exec(t);
      if (m1) t = t.slice(m1[0].length);
    } else {
      const mn = HEADING_LN_NUM_RE.exec(t);
      if (mn && (chapterNumber == null || Number(mn[1]) === chapterNumber)) {
        t = t.slice(mn[0].length);
      }
    }
    if (t !== h.title && t.trim() !== "") {
      lineEdits.push({ lineIndex: h.lineIndex, newLine: `${"=".repeat(h.level)} ${t}` });
      stripped.push({ line: h.line, before: h.title, after: t });
    }
  }
  if (!lineEdits.length) return { text, stripped };

  const lines = normalized.split("\n");
  for (const e of lineEdits) lines[e.lineIndex] = e.newLine;
  return { text: lines.join("\n"), stripped };
}

// ---------- P0-2 figure label 注入 + caption 前缀剥离 ----------

/**
 * 为 #figure(...) 注入 label（无 label 且可编号时），并剥离 caption 中与自身编号一致的
 * 「图 C-S：」前缀（Typst 的 supplement + numbering 已渲染该编号，前缀残留会双重编号）。
 *
 * label 规则：image figure -> <fig-C-S>，table figure -> <tab-C-S>；
 * C = 章号（include 顺序），S = 该类 figure 在本章内按出现顺序的序号（已带 label 的也计数，
 * 保证部分标注后重跑时编号稳定）。已有 label 一律保留不改。
 *
 * @param {string} text
 * @param {{ chapterNumber?: number|null, config?: object|null }} opts
 * @returns {{ text: string, injected: { label: string, line: number }[],
 *             labels: { label: string, kind: string|null, line: number }[], captionsStripped: number }}
 */
export function injectFigureLabels(text, opts = {}) {
  const { chapterNumber = null, config = null } = opts;
  const normalized = text.replace(/\r\n/g, "\n");
  const figs = parseFigureBlocks(normalized);
  if (figs.length === 0) return { text, injected: [], labels: [], captionsStripped: 0 };

  const figPrefix = config?.figures?.labelPrefix || "fig";
  const tabPrefix = config?.tables?.labelPrefix || "tab";
  const autoLabel = !config || !config.figures || config.figures.autoLabel !== false;
  const stripCaption = !config || !config.figures || config.figures.stripCaptionPrefix !== false;
  const seps = (config?.figures?.refSeparators || ["-", "–", "—"]).join("");

  const edits = []; // { start, end, text }；label 注入为 start === end
  const injected = [];
  const labels = [];
  let figSeq = 0;
  let tabSeq = 0;
  let captionsStripped = 0;

  for (const fig of figs) {
    const isImg = fig.hasImage;
    const isTab = !isImg && fig.hasTable;
    if (!isImg && !isTab) {
      if (fig.label) labels.push({ label: fig.label, kind: null, line: fig.endLine });
      continue; // 自定义 kind 的 figure 不在自动化范围
    }
    const kind = isImg ? "fig" : "tab";
    const prefix = isImg ? figPrefix : tabPrefix;
    const word = isImg ? "图" : "表";
    const seq = kind === "fig" ? ++figSeq : ++tabSeq;

    let label = fig.label;
    if (!label) {
      if (!autoLabel || chapterNumber == null) continue;
      label = `${prefix}-${chapterNumber}-${seq}`;
      edits.push({ start: fig.end, end: fig.end, text: ` <${label}>` });
      injected.push({ label, line: fig.endLine });
    }
    labels.push({ label, kind, line: fig.endLine });

    if (!stripCaption) continue;
    // 自身编号：优先从已有 label 解析（fig-C-S 格式），否则用本章计算的 C/S
    let ownC = chapterNumber;
    let ownS = seq;
    const lm = new RegExp(`^${prefix}-(\\d+)-(\\d+)$`).exec(label);
    if (lm) {
      ownC = Number(lm[1]);
      ownS = Number(lm[2]);
    }
    if (ownC == null) continue;
    const cm = /caption:\s*\[/.exec(fig.text);
    if (!cm) continue;
    const contentStart = fig.start + cm.index + cm[0].length;
    // 只剥离与自身编号一致的前缀；caption 若引用别的图（如「图 1-3 展示…」）不会被误删
    const pre = new RegExp(
      `^\\s*${word}\\s*${ownC}\\s*[${seps}]\\s*${ownS}\\s*[:：，,、]?\\s*`
    );
    const pm = pre.exec(normalized.slice(contentStart, contentStart + 200));
    if (pm) {
      edits.push({ start: contentStart, end: contentStart + pm[0].length, text: "" });
      captionsStripped++;
    }
  }

  if (!edits.length) return { text, injected, labels, captionsStripped };
  edits.sort((a, b) => b.start - a.start);
  let out = normalized;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, injected, labels, captionsStripped };
}

// ---------- P0-2 纯文本图/表引用 -> @label ----------

/**
 * 把正文中的「图 C-S / 表 C-S」纯文本引用转换为 @fig-C-S / @tab-C-S（仅当 label 存在）。
 * 跳过 raw 块、注释、数学块与双引号字符串；@ref 渲染结果与原文 visually 等价
 * （supplement「图」+ 章-序编号），但成为可跳转的活引用。
 * @param {string} text
 * @param {{ labelIndex?: Set<string>, config?: object|null }} opts
 * @returns {{ text: string, converted: { line: number, from: string, to: string }[],
 *             unresolved: { line: number, ref: string, label: string }[] }}
 */
export function convertFigureRefs(text, opts = {}) {
  const { labelIndex = new Set(), config = null } = opts;
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const mathLines = new Set();
  for (const span of extractMathSpans(normalized)) {
    for (let ln = span.startLine; ln <= span.endLine; ln++) mathLines.add(ln);
  }

  const figPrefix = config?.figures?.labelPrefix || "fig";
  const tabPrefix = config?.tables?.labelPrefix || "tab";
  const seps = (config?.figures?.refSeparators || ["-", "–", "—"]).join("");
  const refRe = new RegExp(`([图表])\\s*(\\d+)\\s*[${seps}]\\s*(\\d+)`, "g");

  const edits = [];
  const converted = [];
  const unresolved = [];
  let m;
  while ((m = refRe.exec(normalized)) !== null) {
    const line = (normalized.slice(0, m.index).match(/\n/g) || []).length + 1;
    if (rawMask[line - 1] || mathLines.has(line) || COMMENT_LINE_RE.test(lines[line - 1])) continue;
    if (isInsideString(normalized, m.index)) continue;
    const prefix = m[1] === "图" ? figPrefix : tabPrefix;
    const label = `${prefix}-${m[2]}-${m[3]}`;
    if (labelIndex.has(label)) {
      edits.push({ start: m.index, end: m.index + m[0].length, text: `@${label}` });
      converted.push({ line, from: m[0].trim(), to: `@${label}` });
    } else {
      unresolved.push({ line, ref: m[0].trim(), label });
    }
  }

  if (!edits.length) return { text, converted, unresolved };
  edits.sort((a, b) => b.start - a.start);
  let out = normalized;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, converted, unresolved };
}

const COMMENT_LINE_RE = /^\s*\/\//;

// ---------- P1-1 章/节标题 label 注入 + 章节引用转换 ----------

/**
 * 为标题生成 ASCII slug label 后缀（基于章节文件名 slug + 章内小节序号）。
 * 一级标题 -> `<ch-<fileSlug>>`（全章唯一，供跨章引用）；二级及以上 -> `<sec-<fileSlug>-<seq>>`。
 * label 名只用 ASCII 与连字符，避开中文（Typst label 支持 Unicode 但 @ 引用易写错）。
 * @param {string} text
 * @param {{ fileSlug?: string|null }} opts
 * @returns {{ text: string, injected: { label: string, line: number, level: number }[] }}
 */
export function injectHeadingLabels(text, opts = {}) {
  const { fileSlug = "ch" } = opts;
  const normalized = text.replace(/\r\n/g, "\n");
  const headings = parseHeadingLines(normalized);
  if (headings.length === 0) return { text, injected: [] };

  const edits = []; // { lineIndex, append }
  const injected = [];
  let sec = 0;
  for (const h of headings) {
    // 幂等：标题行已带 ` <label>` 结尾时跳过，避免重复追加
    if (/<\s*[a-zA-Z][\w-]*>\s*$/.test(h.raw)) continue;
    if (h.level === 1) {
      edits.push({ lineIndex: h.lineIndex, append: ` <ch-${fileSlug}>` });
      injected.push({ label: `ch-${fileSlug}`, line: h.line, level: 1 });
    } else {
      sec++;
      edits.push({ lineIndex: h.lineIndex, append: ` <sec-${fileSlug}-${sec}>` });
      injected.push({ label: `sec-${fileSlug}-${sec}`, line: h.line, level: h.level });
    }
  }
  const lines = normalized.split("\n");
  for (const e of edits) lines[e.lineIndex] += e.append;
  return { text: lines.join("\n"), injected };
}

/**
 * 正文「第 N 章」纯文本引用 -> @ch-<slug>（当 numToLabel[N] 存在，即该章已注入 <ch-<slug>>）。
 * @ref 到一等标题默认渲染为编号「第 N 章」，与原文 visually 等价，同时变为可跳转活引用。
 * 跳过 raw 块、注释、数学块与双引号字符串；引用不存在的章号由 lint 的 chapter-ref 兜底。
 * @param {string} text
 * @param {{ numToLabel?: Map<number,string>|Record<number,string> }} opts
 * @returns {{ text: string, converted: { line: number, from: string, to: string }[] }}
 */
export function convertChapterRefs(text, opts = {}) {
  const map = opts.numToLabel instanceof Map ? opts.numToLabel
    : new Map(Object.entries(opts.numToLabel || {}).map(([k, v]) => [Number(k), v]));
  if (map.size === 0) return { text, converted: [] };
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const mathLines = new Set();
  for (const span of extractMathSpans(normalized)) {
    for (let ln = span.startLine; ln <= span.endLine; ln++) mathLines.add(ln);
  }
  // 标题行（“第 N 章”格式的章标题）不能被误当成正文引用转换
  const headingLines = new Set(parseHeadingLines(normalized).map((h) => h.line));

  // 修复历史版本已生成但没有 token 分隔符的引用，例如
  // `@ch-ch03-dsh给出`。已知 label 才做替换，避免改写普通 @ 文本。
  const knownLabels = [...map.values()];
  const labelEdits = [];
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    if (rawMask[lineNo] || mathLines.has(lineNo + 1) || COMMENT_LINE_RE.test(lines[lineNo])) continue;
    for (const label of knownLabels) {
      const re = new RegExp(`@${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!#h\\(0pt\\))`, "g");
      let hit;
      while ((hit = re.exec(lines[lineNo])) !== null) {
        // 下面的行级替换不依赖绝对偏移，避免同文本行时定位不稳定。
        labelEdits.push({ lineNo, start: hit.index, end: hit.index + (`@${label}`).length, replacement: `@${label}#h(0pt)` });
      }
    }
  }
  if (labelEdits.length) {
    const fixedLines = [...lines];
    for (const e of labelEdits.sort((a, b) => b.lineNo - a.lineNo || b.start - a.start)) {
      fixedLines[e.lineNo] = fixedLines[e.lineNo].slice(0, e.start) + e.replacement + fixedLines[e.lineNo].slice(e.end);
    }
    return convertChapterRefs(fixedLines.join("\n"), opts);
  }

  const refRe = /第\s*(\d+)\s*章/g;
  const edits = [];
  const converted = [];
  let m;
  while ((m = refRe.exec(normalized)) !== null) {
    const line = (normalized.slice(0, m.index).match(/\n/g) || []).length + 1;
    if (rawMask[line - 1] || mathLines.has(line) || COMMENT_LINE_RE.test(lines[line - 1]) || headingLines.has(line)) continue;
    if (isInsideString(normalized, m.index)) continue;
    const label = map.get(Number(m[1]));
    if (!label) continue;
    // Typst 的 @label 会继续吞并紧随其后的中文/字母，直到遇到分隔符。
    // 用零宽 h(0pt) 终止 label token，避免「@ch-x建立术语」被解析成一个新 label。
    const replacement = `@${label}#h(0pt)`;
    edits.push({ start: m.index, end: m.index + m[0].length, text: replacement });
    converted.push({ line, from: m[0].trim(), to: replacement });
  }
  if (!edits.length) return { text, converted };
  edits.sort((a, b) => b.start - a.start);
  let out = normalized;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, converted };
}

// ---------- P0 表格质量：长表格自动注入 breakable: true ----------

/**
 * 为超过 splitThreshold 行的 table(...) 注入 `breakable: true`（幂等：已显式写
 * breakable 的表格跳过）。注：Typst table 没有文档设想的 `split` 参数，分页开关是
 * `breakable`（0.14+，默认 auto）；figure 内的表格还依赖 main.typ 模板的
 * `#show figure.where(kind: table): set block(breakable: true)` 才能跨页。
 * @param {string} text
 * @param {{ config?: object|null }} opts
 * @returns {{ text: string, injected: { line: number, rows: number }[] }}
 */
export function injectTableBreakable(text, opts = {}) {
  const { config = null } = opts;
  const threshold = config?.tables?.splitThreshold ?? DEFAULT_TABLE_SPLIT_THRESHOLD;
  const normalized = text.replace(/\r\n/g, "\n");
  const edits = [];
  const injected = [];
  for (const t of parseTableCalls(normalized)) {
    if (t.rows == null || t.rows <= threshold || t.hasBreakable) continue;
    // 首参数前有换行则独立成行插入，否则同行插入（保持原有排版风格）
    let j = t.parenEnd;
    while (j < normalized.length && /\s/.test(normalized[j])) j++;
    const onOwnLine = normalized.slice(t.parenEnd, j).includes("\n");
    edits.push({
      start: t.parenEnd,
      end: t.parenEnd,
      text: onOwnLine ? "breakable: true,\n" : "breakable: true, ",
    });
    injected.push({ line: t.startLine, rows: t.rows });
  }
  if (!edits.length) return { text, injected };
  edits.sort((a, b) => b.start - a.start);
  let out = normalized;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, injected };
}

// ---------- P0 callout 健壮性：类型名 -> 颜色键 + 缺失标题补全 ----------

/**
 * 修复 callout-box 调用的两类确定性错误（幂等）：
 *   1. 第一个参数写成类型名（如 "pitfall"）而非颜色键：按 config.callout.types
 *      映射替换为颜色键（"red"）；未知值不动（lint 报错，不做猜测性替换）；
 *   2. 只有颜色键一个位置参数、缺标题（内容块会被误当成 title-text，编译报
 *      missing argument: body）：补标题——类型名场景补 types 默认标题，
 *      已是颜色键场景补 ""（callout.typ 对空标题渲染为仅图标）。
 * @param {string} text
 * @param {{ config?: object|null }} opts
 * @returns {{ text: string, colorsFixed: { line: number, from: string, to: string }[],
 *             titlesInserted: { line: number, title: string }[] }}
 */
export function fixCalloutTypes(text, opts = {}) {
  const { config = null } = opts;
  const palette = new Set(Object.keys(config?.callout?.palette || DEFAULT_CALLOUT_PALETTE));
  const types = config?.callout?.types || DEFAULT_CALLOUT_TYPES;
  const normalized = text.replace(/\r\n/g, "\n");
  const edits = [];
  const colorsFixed = [];
  const titlesInserted = [];

  for (const c of parseCalloutCalls(normalized)) {
    if (c.colorArg == null) continue;
    let color = c.colorArg;
    let title = null;
    if (!palette.has(c.colorArg)) {
      const t = types[c.colorArg];
      if (!t || !palette.has(t.color)) continue;
      color = t.color;
      title = t.title ?? "";
    }
    if (color !== c.colorArg) {
      edits.push({ start: c.colorArgStart, end: c.colorArgEnd, text: `"${color}"` });
      colorsFixed.push({ line: c.colorLine, from: c.colorArg, to: color });
    }
    const needTitle = c.hasContent && c.positionalCount < 2 && !c.namedTitle;
    if (needTitle) {
      const t = JSON.stringify(title ?? "");
      edits.push({ start: c.colorArgEnd, end: c.colorArgEnd, text: `, ${t}` });
      titlesInserted.push({ line: c.startLine, title: t.slice(1, -1) });
    }
  }
  if (!edits.length) return { text, colorsFixed, titlesInserted };
  edits.sort((a, b) => b.start - a.start);
  let out = normalized;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, colorsFixed, titlesInserted };
}

// ---------- 单章编排（strip -> inject -> convert） ----------

/**
 * 对单章依次执行五个确定性变换（标题编号 / figure label / 长表格 breakable / callout 修复，
 * 引用转换需跨章索引，由调用方在收集完全部 label 后单独执行 convertFigureRefs）。
 * @param {string} text
 * @param {{ chapterNumber?: number|null, config?: object|null, labelIndex?: Set<string>|null }} opts
 *     labelIndex 为跨章全量索引（含他章 label）；本函数会并入本章 label 后再做引用转换。
 * @returns {{ text: string, changes: Record<string, number>, labels: { label: string }[] }}
 */
export function optimizeChapter(text, opts = {}) {
  const { chapterNumber = null, config = null, labelIndex = null, fileSlug = "ch" } = opts;
  const changes = {
    headingsStripped: 0,
    labelsInjected: 0,
    captionsStripped: 0,
    refsConverted: 0,
    refsUnresolved: 0,
    tablesBreakable: 0,
    calloutColorsFixed: 0,
    calloutTitlesInserted: 0,
    headingsLabelled: 0,
  };

  let out = text;
  const r1 = stripHeadingNumbers(out, { chapterNumber });
  out = r1.text;
  changes.headingsStripped = r1.stripped.length;

  const r2 = injectFigureLabels(out, { chapterNumber, config });
  out = r2.text;
  changes.labelsInjected = r2.injected.length;
  changes.captionsStripped = r2.captionsStripped;

  const r2b = injectHeadingLabels(out, { fileSlug });
  out = r2b.text;
  changes.headingsLabelled = r2b.injected.length;

  const r4 = injectTableBreakable(out, { config });
  out = r4.text;
  changes.tablesBreakable = r4.injected.length;

  const r5 = fixCalloutTypes(out, { config });
  out = r5.text;
  changes.calloutColorsFixed = r5.colorsFixed.length;
  changes.calloutTitlesInserted = r5.titlesInserted.length;

  if (labelIndex) {
    const merged = new Set(labelIndex);
    for (const l of r2.labels) merged.add(l.label);
    const r3 = convertFigureRefs(out, { labelIndex: merged, config });
    out = r3.text;
    changes.refsConverted = r3.converted.length;
    changes.refsUnresolved = r3.unresolved.length;
  }
  return { text: out, changes, labels: r2.labels };
}
