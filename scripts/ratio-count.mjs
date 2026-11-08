#!/usr/bin/env node
/**
 * scripts/ratio-count.mjs
 *
 * 按章内 `<!-- track: app|principle|synthesis|meta -->` 标记汇总中文正文字数，
 * 计算实际双线比例，并与大纲/双线编排中的目标比例比对。
 *
 * 用法：
 *   node scripts/ratio-count.mjs                      # 只检查，写 metadata/ratio-report.txt
 *   node scripts/ratio-count.mjs --write              # 同时把实测比例写回各章 frontmatter 的 ratio
 *   node scripts/ratio-count.mjs --strict             # 有 ERROR 时退出码 1
 *   node scripts/ratio-count.mjs --threshold=8        # 自定义偏差阈值（百分点，默认 10）
 *
 * 约定（与方法论文档 6.6 一致）：
 *   - 标记必须单独成行，放在 H2 标题的上一行（允许中间有空行）。
 *   - 只有 H2 需要标记；H3 及以下继承所属 H2 的轨道。
 *   - 第一个 H2 之前的内容（标题、本章怎么读）自动归入 meta，不参与比例。
 *   - 代码块、HTML 注释不计入字数；只统计中日韩统一表意文字（CJK）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./lib/mdx-utils.mjs";

const TRACKS = new Set(["app", "principle", "synthesis", "meta"]);
const MARKER_RE = /^\s*<!--\s*track\s*:\s*([A-Za-z]+)\s*-->\s*$/;
const H2_RE = /^##\s+\S/;

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const ROOT = path.resolve(opt("root", process.cwd()));
const MDX_DIR = path.resolve(ROOT, opt("mdx", "mdx"));
const TARGETS_FILE = path.resolve(ROOT, opt("targets", "metadata/analysis/04-dual-track.md"));
const OUTLINE_FILE = path.resolve(ROOT, opt("outline", "metadata/outline.md"));
const OUT_FILE = path.resolve(ROOT, opt("out", "metadata/ratio-report.txt"));
const THRESHOLD = Number(opt("threshold", "10"));
const SYNTH_MIN = Number(opt("synth-min", "10"));
const SYNTH_MAX = Number(opt("synth-max", "15"));
const WRITE = flag("write");
const STRICT = flag("strict");

// ---------- 工具 ----------
const cjkCount = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

/** 把围栏代码块与 HTML 注释换成等量空行，保持行号结构不变。
 *  例外：轨道标记本身要保留，后续按它切分。 */
function blankOutNoise(text) {
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

/** 找出正文中所有 Markdown 表格，返回 [{ headers, rows }]。 */
function findTables(text) {
  const lines = text.split("\n");
  const tables = [];
  const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
  let i = 0;
  while (i < lines.length) {
    const isHeader = /^\s*\|.*\|\s*$/.test(lines[i]);
    if (isHeader && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
      const headers = lines[i]
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((s) => s.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((s) => s.trim());
        rows.push(cells);
        i++;
      }
      tables.push({ headers, rows });
      continue;
    }
    i++;
  }
  return tables;
}

/** 从「章」单元格里取章号：ch03 / 第 3 章 / 3 → 3 */
function chapterNumber(cell) {
  const m = String(cell).match(/\d+/);
  return m ? Number(m[0]) : null;
}

function parseRatioCell(cell) {
  const m = String(cell).match(/(\d+)\s*[:：]\s*(\d+)/);
  if (!m) return null;
  const a = Number(m[1]);
  const p = Number(m[2]);
  if (a + p === 0) return null;
  return { app: (a / (a + p)) * 100 };
}

/** 读取目标比例：04-dual-track.md 优先（章级 > 书级），其次 outline.md 的「比例」列。 */
async function loadTargets() {
  const perChapter = new Map();
  let bookDefault = null;
  let source = [];

  try {
    const raw = await fs.readFile(TARGETS_FILE, "utf8");
    const body = parseFrontmatter(raw, "04-dual-track.md").body;
    const m = body.match(/应用\s*[:：]\s*原理\s*[=＝]\s*(\d+)\s*[:：]\s*(\d+)/);
    if (m) {
      const a = Number(m[1]);
      const p = Number(m[2]);
      if (a + p > 0) bookDefault = (a / (a + p)) * 100;
    }
    for (const t of findTables(body)) {
      const ci = t.headers.findIndex((h) => h.includes("目标比例"));
      if (ci < 0) continue;
      for (const row of t.rows) {
        const n = chapterNumber(row[0]);
        const r = parseRatioCell(row[ci]);
        if (n != null && r) perChapter.set(n, r.app);
      }
    }
    source.push(path.relative(ROOT, TARGETS_FILE));
  } catch {
    /* 允许缺失 */
  }

  try {
    const raw = await fs.readFile(OUTLINE_FILE, "utf8");
    const body = parseFrontmatter(raw, "outline.md").body;
    for (const t of findTables(body)) {
      const ci = t.headers.findIndex((h) => /比例|应用\s*[:：]\s*原理/.test(h));
      const chIdx = t.headers.findIndex((h) => h.includes("章"));
      if (ci < 0 || chIdx < 0) continue;
      for (const row of t.rows) {
        const n = chapterNumber(row[chIdx]);
        const r = parseRatioCell(row[ci]);
        if (n != null && r && !perChapter.has(n)) perChapter.set(n, r.app);
      }
    }
    source.push(path.relative(ROOT, OUTLINE_FILE));
  } catch {
    /* 允许缺失 */
  }

  return { perChapter, bookDefault, source };
}

// ---------- 解析单章 ----------
function analyzeChapter(raw, fileName) {
  const { body, fm } = parseFrontmatter(raw, fileName);
  const clean = blankOutNoise(body);

  const lines = clean.split("\n");
  const sections = [];
  let preHeading = { track: "meta", title: "(章首)", lines: [], auto: true };
  let pending = null;
  let current = preHeading;
  const issues = [];

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
      if (!pending && current !== preHeading) {
        // 留待汇总时报告
      }
      pending = null;
      continue;
    }
    current.lines.push(line);
  }
  if (current && current !== preHeading) sections.push(current);

  if (preHeading.title && preHeading.lines.length) {
    preHeading.cjk = cjkCount(preHeading.lines.join("\n"));
    if (preHeading.cjk > 0) sections.unshift(preHeading);
  }

  const sums = { app: 0, principle: 0, synthesis: 0, meta: 0 };
  const unmarked = [];
  for (const s of sections) {
    const cjk = cjkCount(s.lines.join("\n"));
    s.cjk = cjk;
    if (!s.track) {
      unmarked.push({ title: s.title, cjk });
      continue;
    }
    sums[s.track] += cjk;
  }

  const twoLine = sums.app + sums.principle;
  const body3 = twoLine + sums.synthesis;
  const measuredApp = twoLine > 0 ? (sums.app / twoLine) * 100 : NaN;
  const synthShare = body3 > 0 ? (sums.synthesis / body3) * 100 : NaN;

  return {
    file: fileName,
    chapter: Number(fm.chapter) || chapterNumber(fileName),
    moduleId: fm.moduleId || "",
    sections,
    sums,
    unmarked,
    twoLine,
    body3,
    measuredApp,
    synthShare,
    issues,
  };
}

// ---------- frontmatter 写回 ----------
function setRatioInFrontmatter(raw, value) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return raw;
  let head = m[1];
  const lineRe = /^ratio:\s*.*$/m;
  if (lineRe.test(head)) {
    head = head.replace(lineRe, `ratio: "${value}"`);
  } else {
    head = `${head}\nratio: "${value}"`;
  }
  return raw.slice(0, m.index) + `---\n${head}\n---\n` + raw.slice(m.index + m[0].length);
}

// ---------- 主流程 ----------
const files = (await fs.readdir(MDX_DIR)).filter((f) => f.endsWith(".mdx")).sort();
if (files.length === 0) {
  console.error(`没有找到 .mdx：${MDX_DIR}`);
  process.exit(2);
}

const targets = await loadTargets();
const results = [];

for (const f of files) {
  const rawPath = path.join(MDX_DIR, f);
  const raw = await fs.readFile(rawPath, "utf8");
  const r = analyzeChapter(raw, f);

  let target = targets.perChapter.get(r.chapter);
  let targetFrom = "章级目标";
  if (target == null && targets.bookDefault != null) {
    target = targets.bookDefault;
    targetFrom = "书级默认";
  }
  if (target == null) {
    targetFrom = "无目标";
  }
  r.target = target;
  r.targetFrom = targetFrom;

  r.dev = target != null && !Number.isNaN(r.measuredApp) ? r.measuredApp - target : NaN;

  if (r.unmarked.length) {
    r.issues.push({
      level: "ERROR",
      msg: `${r.unmarked.length} 个 H2 缺少 track 标记（合计 ${r.unmarked.reduce((a, b) => a + b.cjk, 0)} 字）：` +
        r.unmarked.map((u) => u.title).join(" / "),
    });
  }
  if (target != null && Math.abs(r.dev) > THRESHOLD) {
    r.issues.push({
      level: "WARN",
      msg: `应用线占比 ${r.measuredApp.toFixed(1)}% 相对目标 ${target.toFixed(0)}% 偏差 ${r.dev.toFixed(1)}pp，超过阈值 ${THRESHOLD}pp`,
    });
  }
  if (!Number.isNaN(r.synthShare) && (r.synthShare < SYNTH_MIN || r.synthShare > SYNTH_MAX)) {
    r.issues.push({
      level: "WARN",
      msg: `综合段占 ${r.synthShare.toFixed(1)}%，超出 ${SYNTH_MIN}%–${SYNTH_MAX}%`,
    });
  }
  if (r.twoLine === 0) {
    r.issues.push({ level: "ERROR", msg: "应用线与原理线均为 0 字，无法计算比例" });
  }

  r.ratioText = Number.isNaN(r.measuredApp)
    ? "—"
    : `${Math.round(r.measuredApp)}:${100 - Math.round(r.measuredApp)}`;

  if (WRITE && r.twoLine > 0) {
    const updated = setRatioInFrontmatter(raw, r.ratioText);
    if (updated !== raw) await fs.writeFile(rawPath, updated, "utf8");
  }

  results.push(r);
}

// ---------- 报告 ----------
const out = [];
out.push("# 双线比例实测报告");
out.push("");
out.push(`生成时间: ${new Date().toISOString()}`);
out.push(`统计口径: 仅正文 CJK 字符，已剔除代码块与 HTML 注释；meta（章首）不参与比例`);
out.push(`目标来源: ${targets.source.length ? targets.source.join(" + ") : "未找到目标文件"}`);
out.push(`偏差阈值: ${THRESHOLD}pp；综合段区间: ${SYNTH_MIN}%–${SYNTH_MAX}%`);
out.push("");
out.push("| 章 | 模块 | 应用 | 原理 | 综合 | meta | 实测比例 | 目标 | 偏差(pp) | 状态 |");
out.push("|---|---|---|---|---|---|---|---|---|---|");

const total = { app: 0, principle: 0, synthesis: 0, meta: 0 };
let errorCount = 0;
let warnCount = 0;

for (const r of results) {
  total.app += r.sums.app;
  total.principle += r.sums.principle;
  total.synthesis += r.sums.synthesis;
  total.meta += r.sums.meta;
  const errs = r.issues.filter((i) => i.level === "ERROR").length;
  const warns = r.issues.filter((i) => i.level === "WARN").length;
  errorCount += errs;
  warnCount += warns;
  const status = errs ? `ERROR×${errs}` : warns ? `WARN×${warns}` : "OK";
  out.push(
    `| ch${String(r.chapter).padStart(2, "0")} | ${r.moduleId} | ${r.sums.app} | ${r.sums.principle} | ${r.sums.synthesis} | ${r.sums.meta} | ` +
      `${Number.isNaN(r.measuredApp) ? "—" : r.measuredApp.toFixed(1) + "%"} | ` +
      `${r.target == null ? "—" : r.target.toFixed(0) + "%"} | ` +
      `${Number.isNaN(r.dev) ? "—" : (r.dev > 0 ? "+" : "") + r.dev.toFixed(1)} | ${status} |`,
  );
}

const tApp = total.app + total.principle;
out.push("");
out.push("## 全书");
out.push("");
if (tApp > 0) {
  out.push(`- 应用线 ${total.app} 字 / 原理线 ${total.principle} 字 → 实测比例 **${((total.app / tApp) * 100).toFixed(1)} : ${((total.principle / tApp) * 100).toFixed(1)}**`);
}
const tBody = tApp + total.synthesis;
if (tBody > 0) {
  out.push(`- 综合段 ${total.synthesis} 字，占正文 ${((total.synthesis / tBody) * 100).toFixed(1)}%`);
}
out.push(`- meta（章首等）${total.meta} 字，不参与比例`);
out.push("");

const allIssues = results.flatMap((r) => r.issues.map((i) => ({ ...i, chapter: r.chapter })));
if (allIssues.length) {
  out.push("## 问题");
  out.push("");
  for (const r of results) {
    if (!r.issues.length) continue;
    out.push(`### ch${String(r.chapter).padStart(2, "0")} ${r.file}`);
    for (const i of r.issues) out.push(`- [${i.level}] ${i.msg}`);
    out.push("");
  }
} else {
  out.push("## 问题");
  out.push("");
  out.push("无。");
  out.push("");
}

if (WRITE) {
  out.push(`> 已把实测比例写回各章 frontmatter 的 \`ratio\`（${results.map((r) => `ch${r.chapter}=${r.ratioText}`).join(", ")}）。`);
  out.push("");
}

await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, out.join("\n"), "utf8");

console.log(out.join("\n"));
console.log(`\n报告已写入 ${OUT_FILE}`);
if (STRICT && errorCount > 0) process.exit(1);
