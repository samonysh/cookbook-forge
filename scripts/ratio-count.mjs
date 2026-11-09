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
 *   node scripts/ratio-count.mjs --min-body=40000     # 自定义 body3 下限（默认 50000）
 *   node scripts/ratio-count.mjs --synth-max-closure=18  # 含章末回收段的章节综合段上限（默认 18，下限恒为 10）
 *
 * 口径实现统一放在 scripts/lib/word-caliber.mjs（与 word-count.mjs 共用）。
 * 表格替代论述的 WARN 阈值：成段论述 <120 字，或表格折算占比 >60% 且成段论述 <300 字。
 *
 * 约定（与方法论文档 6.6 一致）：
 *   - 标记必须单独成行，放在 H2 标题的上一行（允许中间有空行）。
 *   - 只有 H2 需要标记；H3 及以下继承所属 H2 的轨道。
 *   - 第一个 H2 之前的内容（标题、本章怎么读）自动归入 meta，不参与比例。
 *   - 只统计正文：剔除代码块、HTML 注释、meta；只统计中日韩统一表意文字（CJK）。
 *   - Markdown 表格按 1/2 计数：表内 CJK 字符数 × 0.5；表格以外的成段文字按 1:1 计数。
 *   - 5 万字是全书正文（body3，不含 meta）的最低下限，不是目标值。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./lib/mdx-utils.mjs";
import { splitTrackedSections, applySectionStats } from "./lib/word-caliber.mjs";

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
// 章末回收段属于综合层，会结构性推高综合段占比；含回收段的章节上限放宽一档。
const SYNTH_MAX_CLOSURE = Number(opt("synth-max-closure", "18"));
const MIN_BODY = Number(opt("min-body", "50000"));
const WRITE = flag("write");
const STRICT = flag("strict");

// ---------- 工具 ----------
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

// ---------- 章末回收段 ----------
// 与 chapter-lint 的 G2 同口径：章末两节内、双线索引之前的独立段落，
// 同段内同时出现「问题复述」与「认识变化」两类线索。
const PROBLEM_RECALL_RE = /回到\s*\d+\.0|回到第?\s*\d+\s*章|(?:第?\s*\d+\.0|章首|本章开头|开头|最初)的?(?:那个|三个)?问题/;
const CHANGE_RE =
  /原来(?:以为|觉得|认为|想)|此前(?:以为|认为)|最初(?:以为|认为)|现在(?:才)?(?:知道|明白|清楚)|现在可以(?:给出)?(?:完整)?回答|不再是[^。]{0,40}而是/;
const INDEX_LINE_RE = /^\s*(?:[-*]\s+\*\*(?:应用线|原理线|综合段)|[^\n]{0,16}双线索引[：:])/;

function hasClosureParagraph(body) {
  const lines = body.split(/\r?\n/);
  const h2 = [];
  lines.forEach((l, i) => {
    const m = l.match(/^##\s+(\d+)\.(\d+)\s+/);
    if (m) h2.push({ i, n: Number(m[2]) });
  });
  const contentH2 = h2.filter((h) => h.n !== 0 && h.n !== 10);
  if (!contentH2.length) return false;
  const tail = contentH2.slice(-2);
  const last = tail[tail.length - 1];
  const next = h2.find((h) => h.i > last.i);
  const tailLines = lines.slice(tail[0].i, next ? next.i : lines.length);
  const indexAt = tailLines.findIndex((l) => INDEX_LINE_RE.test(l));
  const limit = indexAt >= 0 ? indexAt : tailLines.length;
  const blocks = [];
  let cur = null;
  for (let i = 0; i < limit; i++) {
    const l = tailLines[i];
    if (!l.trim()) {
      cur = null;
      continue;
    }
    if (cur) cur.text += "\n" + l;
    else {
      cur = { text: l };
      blocks.push(cur);
    }
  }
  return blocks.some((b) => {
    const t = b.text.trim();
    if (/^(?:[-*|>#<!`]|<div|<\/div)/.test(t)) return false;
    return PROBLEM_RECALL_RE.test(t) && CHANGE_RE.test(t);
  });
}

// ---------- 解析单章 ----------
function analyzeChapter(raw, fileName) {
  const { body, fm } = parseFrontmatter(raw, fileName);
  const { sections, issues } = splitTrackedSections(body);

  const sums = { app: 0, principle: 0, synthesis: 0, meta: 0 };
  const unmarked = [];
  const tableIssues = [];
  for (const s of sections) {
    applySectionStats(s);

    if (!s.track) {
      unmarked.push({ title: s.title, cjk: s.cjk });
      continue;
    }
    sums[s.track] += s.cjk;

    // 表格不能替代论述：只查正文 H2 小节，meta（章首）跳过。
    // 阈值：成段论述 <120 字即 WARN；或表格折算占比 >60% 且成段论述 <300 字。
    if (!s.auto && s.tableCount > 0) {
      const tableShared = s.tableCJK * 0.5;
      const denom = s.proseCJK + tableShared;
      const share = denom > 0 ? tableShared / denom : 0;
      if (s.proseCJK < 120) {
        tableIssues.push({
          level: "WARN",
          msg: `小节「${s.title}」含 ${s.tableCount} 张表，但成段论述仅 ${s.proseCJK} 字（<120），表格不能替代论述`,
        });
      } else if (share > 0.6 && s.proseCJK < 300) {
        tableIssues.push({
          level: "WARN",
          msg: `小节「${s.title}」表格折算字数占 ${(share * 100).toFixed(0)}%（>60%），成段论述仅 ${s.proseCJK} 字（<300），需补因果与取舍段落`,
        });
      }
    }
  }
  issues.push(...tableIssues);

  const tableCJK = sections.reduce((a, s) => a + s.tableCJK, 0);

  const twoLine = sums.app + sums.principle;
  const body3 = twoLine + sums.synthesis;
  const measuredApp = twoLine > 0 ? (sums.app / twoLine) * 100 : NaN;
  const synthShare = body3 > 0 ? (sums.synthesis / body3) * 100 : NaN;
  const hasClosure = hasClosureParagraph(body);
  const synthMax = hasClosure ? SYNTH_MAX_CLOSURE : SYNTH_MAX;

  return {
    file: fileName,
    chapter: Number(fm.chapter) || chapterNumber(fileName),
    moduleId: fm.moduleId || "",
    sections,
    sums,
    tableCJK,
    unmarked,
    twoLine,
    body3,
    measuredApp,
    synthShare,
    hasClosure,
    synthMax,
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
      msg: `${r.unmarked.length} 个 H2 缺少 track 标记（合计 ${Math.round(r.unmarked.reduce((a, b) => a + b.cjk, 0))} 字）：` +
        r.unmarked.map((u) => u.title).join(" / "),
    });
  }
  if (target != null && Math.abs(r.dev) > THRESHOLD) {
    r.issues.push({
      level: "WARN",
      msg: `应用线占比 ${r.measuredApp.toFixed(1)}% 相对目标 ${target.toFixed(0)}% 偏差 ${r.dev.toFixed(1)}pp，超过阈值 ${THRESHOLD}pp`,
    });
  }
  if (!Number.isNaN(r.synthShare) && (r.synthShare < SYNTH_MIN || r.synthShare > r.synthMax)) {
    const scope = r.hasClosure ? `含回收段章节按 ${SYNTH_MIN}%–${r.synthMax}% 判定` : `${SYNTH_MIN}%–${r.synthMax}%`;
    r.issues.push({
      level: "WARN",
      msg: `综合段占 ${r.synthShare.toFixed(1)}%，超出 ${scope}`,
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
out.push(`统计口径: 仅正文；已剔除代码块、HTML 注释与 meta（章首），只统计 CJK`);
out.push(`表格口径: Markdown 表格内 CJK 按 1/2 计数（×0.5）；表格以外的成段文字按 1:1 计数`);
out.push(`三分口径: tApp = 应用线 + 原理线；body3 = tApp + 综合段（全书正文）；含 meta = body3 + 章首等`);
out.push(`正文下限: body3 ≥ ${MIN_BODY} 字（最低下限，不是目标值）`);
out.push(`目标来源: ${targets.source.length ? targets.source.join(" + ") : "未找到目标文件"}`);
out.push(`偏差阈值: ${THRESHOLD}pp；综合段区间: ${SYNTH_MIN}%–${SYNTH_MAX}%（含章末回收段的章节上限放宽到 ${SYNTH_MAX_CLOSURE}%，下限 ${SYNTH_MIN}% 不变）`);
out.push("");
out.push("| 章 | 模块 | 应用 | 原理 | 综合 | meta | 表格折算 | 实测比例 | 目标 | 偏差(pp) | 状态 |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|");

const total = { app: 0, principle: 0, synthesis: 0, meta: 0, tableCJK: 0 };
let errorCount = 0;
let warnCount = 0;

for (const r of results) {
  total.app += r.sums.app;
  total.principle += r.sums.principle;
  total.synthesis += r.sums.synthesis;
  total.meta += r.sums.meta;
  total.tableCJK += r.tableCJK;
  const errs = r.issues.filter((i) => i.level === "ERROR").length;
  const warns = r.issues.filter((i) => i.level === "WARN").length;
  errorCount += errs;
  warnCount += warns;
  const status = errs ? `ERROR×${errs}` : warns ? `WARN×${warns}` : "OK";
  out.push(
    `| ch${String(r.chapter).padStart(2, "0")} | ${r.moduleId} | ${Math.round(r.sums.app)} | ${Math.round(r.sums.principle)} | ${Math.round(r.sums.synthesis)} | ${Math.round(r.sums.meta)} | ${Math.round(r.tableCJK * 0.5)} | ` +
      `${Number.isNaN(r.measuredApp) ? "—" : r.measuredApp.toFixed(1) + "%"} | ` +
      `${r.target == null ? "—" : r.target.toFixed(0) + "%"} | ` +
      `${Number.isNaN(r.dev) ? "—" : (r.dev > 0 ? "+" : "") + r.dev.toFixed(1)} | ${status} |`,
  );
}

out.push("");
out.push("> 应用/原理/综合/meta 各列均已含表内 CJK 的 1/2 折算；「表格折算」列是其中来自表格的部分，仅供核对，不要与前三列重复相加。逐章与全书各自四舍五入，纵向相加可能有 ±1 误差。");
out.push("> 章末回收段属于综合层，会结构性推高综合段占比，不是内容失衡。因此含回收段的章节上限按 " + SYNTH_MAX_CLOSURE + "% 判定，下限 " + SYNTH_MIN + "% 不变；**禁止为压回 " + SYNTH_MAX + "% 而删减回收段内容或挪走机制解释**。");

const closureList = results.filter((r) => r.hasClosure).map((r) => `ch${String(r.chapter).padStart(2, "0")}`);
const plainList = results.filter((r) => !r.hasClosure).map((r) => `ch${String(r.chapter).padStart(2, "0")}`);
out.push("");
out.push(`- **回收段判定**：含回收段的章节按 ${SYNTH_MIN}%–${SYNTH_MAX_CLOSURE}% 判定（${closureList.join("、") || "无"}）；未检出回收段的章节按 ${SYNTH_MIN}%–${SYNTH_MAX}% 判定（${plainList.join("、") || "无"}）。`);

const tApp = total.app + total.principle;
const tBody = tApp + total.synthesis;
const tAll = tBody + total.meta;
out.push("");
out.push("## 全书（三分口径，引用时必须带标签）");
out.push("");
if (tApp > 0) {
  out.push(`- **双线合计 tApp**（应用线 + 原理线）：${Math.round(tApp)} 字 → ${Math.round(total.app)} : ${Math.round(total.principle)} = **${((total.app / tApp) * 100).toFixed(1)} : ${((total.principle / tApp) * 100).toFixed(1)}**`);
}
if (tBody > 0) {
  out.push(`- **全书正文 body3**（tApp + 综合段）：${Math.round(tBody)} 字；综合段 ${Math.round(total.synthesis)} 字，占正文 ${((total.synthesis / tBody) * 100).toFixed(1)}%`);
}
out.push(`- **全书含 meta**（body3 + 章首等）：${Math.round(tAll)} 字；meta ${Math.round(total.meta)} 字，不参与比例`);
out.push(`- **表格折算**：表格原始 CJK ${Math.round(total.tableCJK)} 字，按 1/2 计 ${Math.round(total.tableCJK * 0.5)} 字（已包含在上面三个口径中，不另加）`);
out.push(`- **正文下限校验**：body3 ${Math.round(tBody)} 字 ${tBody >= MIN_BODY ? "≥" : "<"} 下限 ${MIN_BODY} 字 → **${tBody >= MIN_BODY ? "达标" : `不达标，差 ${Math.round(MIN_BODY - tBody)} 字`}**`);
out.push("");
out.push("> 对外汇报必须同时写明三个口径的名字（tApp / body3 / 含 meta），并注明「表格按 1/2 计数」。只写「全书正文」会让跨轮次数字不可比。");
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
