/**
 * scripts/lib/word-caliber.mjs
 *
 * 全书字数口径的唯一实现，供 ratio-count.mjs / word-count.mjs 共用。
 *
 * 口径（与方法论文档 6.6、SKILL 阶段 4 一致）：
 *   - 只统计正文 CJK：剔除围栏代码块、HTML 注释、meta（章首 / N.0 / N.10）。
 *   - Markdown 表格按 1/2 计数：表内 CJK × 0.5；表格以外的成段文字按 1:1 计数。
 *   - 表格行与成段文字分开累计，便于检查「表格替代论述」。
 */

export const TRACKS = new Set(["app", "principle", "synthesis", "meta"]);
export const MARKER_RE = /^\s*<!--\s*track\s*:\s*([A-Za-z]+)\s*-->\s*$/;
export const H2_RE = /^##\s+\S/;

export const cjkCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/** 把围栏代码块与 HTML 注释换成空行，保持行号结构不变。
 *  例外：轨道标记本身要保留，后续按它切分。 */
export function blankOutNoise(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let inComment = false;
  for (const line of lines) {
    if (MARKER_RE.test(line)) {
      out.push(line);
      continue;
    }
    if (!inFence && !inComment && /^\s*```/.test(line)) {
      inFence = true;
      out.push("");
      continue;
    }
    if (inFence) {
      if (/^\s*```/.test(line)) inFence = false;
      out.push("");
      continue;
    }
    if (!inComment && /^\s*<!--/.test(line) && !/-->\s*$/.test(line)) {
      inComment = true;
      out.push("");
      continue;
    }
    if (inComment) {
      if (/-->\s*$/.test(line)) inComment = false;
      out.push("");
      continue;
    }
    if (/^\s*<!--[\s\S]*-->\s*$/.test(line)) {
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** 标记 Markdown 表格所占的行（表头、分隔行、数据行），返回等长布尔数组。 */
export function markTableLines(lines) {
  const mask = new Array(lines.length).fill(false);
  const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
  const rowRe = /^\s*\|.*\|\s*$/;
  let i = 0;
  while (i < lines.length) {
    if (rowRe.test(lines[i]) && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
      mask[i] = true;
      mask[i + 1] = true;
      i += 2;
      while (i < lines.length && rowRe.test(lines[i])) {
        mask[i] = true;
        i++;
      }
      continue;
    }
    i++;
  }
  return mask;
}

/** 按布尔掩码统计表格块数（连续 true 段算一张表）。 */
export function countTableBlocks(mask) {
  let n = 0;
  let inTable = false;
  for (const v of mask) {
    if (v && !inTable) {
      n++;
      inTable = true;
    } else if (!v) {
      inTable = false;
    }
  }
  return n;
}

/** 按 track 标记与 H2 切分正文。
 *  - 标记必须单独成行，位于 H2 上一行；只标 H2，H3 继承。
 *  - 第一个 H2 之前的内容归入 meta（auto: true）。
 *  @returns {{ sections: Array<{track: string|null, title: string, lines: string[], auto: boolean}>, issues: Array<{level: string, msg: string}> }}
 */
export function splitTrackedSections(body) {
  const clean = blankOutNoise(body);
  const lines = clean.split("\n");
  const sections = [];
  const preHeading = { track: "meta", title: "(章首)", lines: [], auto: true };
  const issues = [];
  let pending = null;
  let current = preHeading;

  for (const line of lines) {
    const mk = line.match(MARKER_RE);
    if (mk) {
      const track = mk[1].toLowerCase();
      if (!TRACKS.has(track)) {
        issues.push({ level: "ERROR", msg: `未知轨道标记 "${mk[1]}"，只允许 app/principle/synthesis/meta` });
        pending = null;
      } else {
        pending = track;
      }
      continue;
    }
    if (H2_RE.test(line)) {
      if (current && current !== preHeading) sections.push(current);
      const title = line.replace(/^##\s+/, "").trim();
      current = { track: pending, title, lines: [], auto: false };
      pending = null;
      continue;
    }
    current.lines.push(line);
  }
  if (current && current !== preHeading) sections.push(current);
  if (preHeading.title && preHeading.lines.length) sections.unshift(preHeading);

  return { sections, issues };
}

/** 为单个 section 计算字数口径（就地写入）：
 *  proseCJK（成段文字）、tableCJK（表内原始 CJK）、tableCount（表数）、cjk（折算后 = prose + table×0.5）。 */
export function applySectionStats(section) {
  const mask = markTableLines(section.lines);
  const proseLines = [];
  const tableLines = [];
  section.lines.forEach((line, i) => (mask[i] ? tableLines : proseLines).push(line));
  section.proseCJK = cjkCount(proseLines.join("\n"));
  section.tableCJK = cjkCount(tableLines.join("\n"));
  section.tableCount = countTableBlocks(mask);
  section.cjk = section.proseCJK + section.tableCJK * 0.5;
  return section;
}
