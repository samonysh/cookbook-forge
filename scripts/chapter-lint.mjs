#!/usr/bin/env node
/**
 * scripts/chapter-lint.mjs
 *
 * 章节结构 lint：验证等级标记、图位标注、frontmatter figures 一致性、逐块实测记录。
 * 与方法论文档 6.7.1 / 8.5.1 / 8.8 配套。
 *
 * 用法：
 *   node scripts/chapter-lint.mjs                 # 报告写 metadata/chapter-lint.txt
 *   node scripts/chapter-lint.mjs --strict        # 有 ERROR 时退出码 1
 *   node scripts/chapter-lint.mjs --root=<book>   # 指定书目录（默认 cwd）
 *
 * 检查项：
 *   V1 每个 ```python 代码块前 3 行内必须有 `<!-- verify: L1|L2|L3 -->`
 *   V2 每个图位注释必须符合 `<!-- FIGURE: fig-NN-M | type | 内容 | 依据 ... -->`
 *      - id 形如 fig-09-2；type 在词表内；紧接 4 行内出现 `**图 N-M**` 图题
 *   V3 frontmatter `figures` 与正文图位 id 集合一致，且无重复
 *   V4 `metadata/verify/chNN.txt` 存在，块数与 python 块数一致，等级逐一匹配
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./lib/mdx-utils.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROOT = path.resolve(opt("root", process.cwd()));
const MDX_DIR = path.resolve(ROOT, opt("mdx", "mdx"));
const VERIFY_DIR = path.resolve(ROOT, opt("verify-dir", "metadata/verify"));
const FIGURE_DIR = path.resolve(ROOT, "mdx", "public", "figures");
const OUT_FILE = path.resolve(ROOT, opt("out", "metadata/chapter-lint.txt"));
const STRICT = argv.includes("--strict");

const FIGURE_TYPES = new Set([
  "architecture",
  "flowchart",
  "sequence",
  "state-machine",
  "decision-tree",
  "timeline",
  "matrix",
  "layered",
]);
const FIGURE_ID_RE = /^fig-(\d{2})-(\d+)$/;
const VERIFY_MARK_RE = /^\s*<!--\s*verify\s*:\s*(L[1-3])\s*(?:\|[^>]*)?-->\s*$/;
const VERIFY_ANY_RE = /<!--\s*verify\s*:\s*([^|>\s]+)/;
const FIGURE_RE = /^\s*<!--\s*FIGURE\s*:\s*(.*?)\s*-->\s*$/;
const CAPTION_RE = /^\s*\*\*图\s*(\d+)\s*[-–]\s*(\d+)\*\*/;
// 源码证据块：原理线摘录的源代码，不是可运行示例，不要求 verify 等级
const SOURCE_MARK_RE = /^\s*<!--\s*source\s*:\s*(.+?)\s*-->\s*$/;

function splitFrontmatter(raw) {
  const { body, fm } = parseFrontmatter(raw, "chapter.mdx");
  return { body, fm };
}

/** 收集围栏代码块信息：语言、起始行下标。 */
function collectFences(lines) {
  const fences = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^\s*```([A-Za-z0-9_-]*)/);
    if (open) {
      const lang = open[1].toLowerCase();
      const start = i;
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
      fences.push({ lang, start, end: i });
    }
    i++;
  }
  return fences;
}

function precedingNonEmpty(lines, idx, span = 3) {
  const found = [];
  for (let j = idx - 1; j >= 0 && j >= idx - span; j--) {
    if (lines[j].trim() === "") continue;
    found.push({ idx: j, text: lines[j] });
  }
  return found;
}

function chapterLabel(fm, fileName) {
  const n = Number(fm.chapter) || Number((fileName.match(/\d+/) || [0])[0]);
  return String(n).padStart(2, "0");
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readVerifyRecord(label) {
  const p = path.join(VERIFY_DIR, `ch${label}.txt`);
  try {
    const raw = await fs.readFile(p, "utf8");
    const blocks = [];
    const re = /^##\s*块\s*(\d+)\s*$/gm;
    const marks = [...raw.matchAll(re)];
    for (let k = 0; k < marks.length; k++) {
      const start = marks[k].index;
      const end = k + 1 < marks.length ? marks[k + 1].index : raw.length;
      const chunk = raw.slice(start, end);
      const level = chunk.match(/^verify:\s*(L[1-3])\s*$/m);
      const status = chunk.match(/^status:\s*(.+)$/m);
      blocks.push({
        index: Number(marks[k][1]),
        level: level ? level[1] : null,
        status: status ? status[1].trim() : null,
      });
    }
    return { exists: true, path: p, blocks };
  } catch {
    return { exists: false, path: p, blocks: [] };
  }
}

const files = (await fs.readdir(MDX_DIR)).filter((f) => f.endsWith(".mdx")).sort();
const report = [];
const issues = [];
let errorCount = 0;
let warnCount = 0;

function add(chapter, level, code, msg) {
  issues.push({ chapter, level, code, msg });
  if (level === "ERROR") errorCount++;
  else warnCount++;
}

const summary = [];

for (const f of files) {
  const raw = await fs.readFile(path.join(MDX_DIR, f), "utf8");
  const { body, fm } = splitFrontmatter(raw);
  const lines = body.split("\n");
  const label = chapterLabel(fm, f);

  // ---- 代码块分类：源码证据块 vs 可运行示例 ----
  const fences = collectFences(lines);
  const isSourceBlock = (fence) =>
    precedingNonEmpty(lines, fence.start, 3).some((l) => SOURCE_MARK_RE.test(l.text));
  const allPyFences = fences.filter((x) => x.lang === "python" || x.lang === "py");
  const pyFences = allPyFences.filter((x) => !isSourceBlock(x));
  const sourceBlocks = allPyFences.filter((x) => isSourceBlock(x));

  // ---- V1 验证等级标记（只检查可运行示例）----
  const levels = [];
  pyFences.forEach((fence, idx) => {
    const near = precedingNonEmpty(lines, fence.start, 3);
    const hit = near.map((l) => l.text.match(VERIFY_MARK_RE)).find(Boolean);
    if (!hit) {
      const anyBad = near.map((l) => l.text.match(VERIFY_ANY_RE)).find(Boolean);
      if (anyBad) {
        add(label, "ERROR", "V1", `第 ${idx + 1} 个 python 块（行 ${fence.start + 1}）验证等级 "${anyBad[1]}" 非法，只允许 L1/L2/L3`);
      } else {
        add(label, "ERROR", "V1", `第 ${idx + 1} 个 python 块（行 ${fence.start + 1}）缺少 \`<!-- verify: Lx -->\` 标记`);
      }
      levels.push(null);
    } else {
      levels.push(hit[1]);
    }
  });

  // ---- V2 图位标注 ----
  const bodyIds = [];
  lines.forEach((line, i) => {
    const m = line.match(FIGURE_RE);
    if (!m) return;
    const parts = m[1].split("|").map((s) => s.trim());
    const [id, type] = parts;
    if (!id || !type) {
      add(label, "ERROR", "V2", `第 ${i + 1} 行图位缺少 id 或 type：${line.trim()}`);
      return;
    }
    const idm = id.match(FIGURE_ID_RE);
    if (!idm) {
      add(label, "ERROR", "V2", `图位 id "${id}" 不符合 fig-NN-M 格式`);
    } else if (idm[1] !== label) {
      add(label, "ERROR", "V2", `图位 id "${id}" 的章号与本章 ch${label} 不一致`);
    }
    if (!FIGURE_TYPES.has(type)) {
      add(label, "ERROR", "V2", `图位 "${id}" 的 type "${type}" 不在词表内：${[...FIGURE_TYPES].join(" / ")}`);
    }
    const caption = lines.slice(i + 1, i + 5).some((l) => CAPTION_RE.test(l));
    if (!caption) {
      add(label, "WARN", "V2", `图位 "${id}" 后 4 行内没有 \`**图 N-M**\` 图题行`);
    }
    bodyIds.push(id);
  });

  const dupIds = bodyIds.filter((id, i) => bodyIds.indexOf(id) !== i);
  for (const id of new Set(dupIds)) {
    add(label, "ERROR", "V2", `图位 id "${id}" 在正文中重复出现`);
  }

  // ---- V3 frontmatter figures 一致性 ----
  const rawFigures = fm.figures;
  const fmFigures = Array.isArray(rawFigures) ? rawFigures : rawFigures ? [rawFigures] : [];
  const bodySet = new Set(bodyIds);
  const fmSet = new Set(fmFigures);
  for (const id of bodySet) {
    if (!fmSet.has(id)) add(label, "ERROR", "V3", `正文图位 "${id}" 未列入 frontmatter \`figures\``);
  }
  for (const id of fmSet) {
    if (!bodySet.has(id)) add(label, "ERROR", "V3", `frontmatter \`figures\` 中的 "${id}" 在正文没有对应图位`);
  }
  if (fmFigures.length !== fmSet.size) {
    add(label, "ERROR", "V3", "frontmatter `figures` 存在重复项");
  }

  // ---- V5 图号顺序与正文出现顺序一致（插图/挪图后最易漏改）----
  const figNums = bodyIds.map((id) => Number(id.split("-")[2]));
  for (let i = 1; i < figNums.length; i++) {
    if (Number.isFinite(figNums[i]) && Number.isFinite(figNums[i - 1]) && figNums[i] < figNums[i - 1]) {
      add(label, "WARN", "V5", `图号顺序与正文出现顺序不一致（${bodyIds[i - 1]} → ${bodyIds[i]}），插图后需重编号`);
      break;
    }
  }

  // ---- V4 实测记录 ----
  const rec = await readVerifyRecord(label);
  if (!rec.exists) {
    add(label, "WARN", "V4", `缺少逐块实测记录 metadata/verify/ch${label}.txt`);
  } else {
    if (rec.blocks.length !== pyFences.length) {
      add(label, "WARN", "V4", `实测记录有 ${rec.blocks.length} 块，正文有 ${pyFences.length} 个 python 块`);
    }
    const n = Math.min(rec.blocks.length, levels.length);
    for (let k = 0; k < n; k++) {
      if (rec.blocks[k].level && levels[k] && rec.blocks[k].level !== levels[k]) {
        add(label, "WARN", "V4", `第 ${k + 1} 块等级不一致：正文 ${levels[k]}，记录 ${rec.blocks[k].level}`);
      }
    }
  }

  // ---- F1 图必须有可渲染产物 + 每章下限 ----
  for (const id of bodyIds) {
    const svg = path.join(FIGURE_DIR, `${id}.svg`);
    const png = path.join(FIGURE_DIR, `${id}.png`);
    if (!(await fileExists(svg)) && !(await fileExists(png))) {
      add(label, "ERROR", "F1", `图位 "${id}" 没有可渲染产物（缺 ${id}.svg / ${id}.png）`);
    }
    if (!new RegExp(`!\\[[^\\]]*\\]\\([^)]*${id}\\.(?:svg|png)\\)`).test(body)) {
      add(label, "ERROR", "F1", `图位 "${id}" 后正文没有引用对应图片`);
    }
  }
  if (bodyIds.length < 2) {
    add(label, "ERROR", "F1", `本章只有 ${bodyIds.length} 张图，低于每章下限 2 张`);
  }

  // ---- C1 python 块中文注释 ----
  pyFences.forEach((fence, idx) => {
    const bodyLines = lines.slice(fence.start + 1, fence.end);
    const hasChineseComment = bodyLines.some((l) => /^\s*#.*[\u4e00-\u9fff]/.test(l));
    if (!hasChineseComment) {
      add(label, "WARN", "C1", `第 ${idx + 1} 个 python 块（行 ${fence.start + 1}）没有中文注释`);
    }
  });

  // ---- M1 公式后的中文说明 ----
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "$$") continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "$$") j++;
    if (j >= lines.length) break;
    const after = lines.slice(j + 1, j + 6).join("\n");
    if (!/[\u4e00-\u9fff]/.test(after)) {
      add(label, "WARN", "M1", `行 ${i + 1} 的公式块后 5 行内没有中文说明`);
    }
    i = j;
  }

  // ---- R1 正文不点材料（WARN，人工复核）----
  const forbidden = [
    /你提供的?(?:文档|材料|资料)/,
    /(?:材料|文档|资料)有偏差/,
    /原文(?:写法)?有误/,
    /原文错误/,
  ];
  for (const re of forbidden) {
    if (re.test(body)) add(label, "WARN", "R1", `正文出现疑似点评材料的表述：${re.source}`);
  }

  // ---- N1 本章参考小节 ----
  if (!/^##\s+.*本章参考/m.test(body)) {
    add(label, "WARN", "N1", "缺少章末「本章参考」小节（N.10）");
  }

  // ---- N2 占位章号 ----
  // 骨架模板里的 N.x / 第 N 章 是占位符，定稿后必须换成真实章号；
  // 漏改会一路带进 LaTeX/Typst/EPUB 的标题与目录。只查标题行，避免误伤正文里的版本号。
  const ph = body.match(/^#{1,6}\s+N\.\d+|第\s*N\s*章/m);
  if (ph) {
    add(label, "ERROR", "N2", `标题残留占位章号「${ph[0].trim()}」，定稿前必须替换为真实章号`);
  }

  summary.push({
    label,
    file: f,
    pyBlocks: pyFences.length,
    sourceBlocks: sourceBlocks.length,
    figures: bodyIds.length,
    levels,
    hasRecord: rec.exists,
  });
}

// ---- 输出 ----
report.push("# 章节结构 lint");
report.push("");
report.push(`生成时间: ${new Date().toISOString()}`);
report.push("");
report.push("| 章 | 文件 | 可运行块 | 已标级 | 源码证据块 | 图位 | 实测记录 |");
report.push("|---|---|---|---|---|---|---|");
for (const s of summary) {
  const marked = s.levels.filter(Boolean).length;
  report.push(
    `| ch${s.label} | ${s.file} | ${s.pyBlocks} | ${marked}/${s.pyBlocks} | ${s.sourceBlocks} | ${s.figures} | ${s.hasRecord ? "有" : "缺"} |`,
  );
}
report.push("");
report.push(`合计: ERROR ${errorCount}，WARN ${warnCount}`);
report.push("");

if (issues.length) {
  report.push("## 问题");
  report.push("");
  const byChapter = new Map();
  for (const i of issues) {
    if (!byChapter.has(i.chapter)) byChapter.set(i.chapter, []);
    byChapter.get(i.chapter).push(i);
  }
  for (const [ch, list] of byChapter) {
    report.push(`### ch${ch}`);
    for (const i of list) report.push(`- [${i.level}][${i.code}] ${i.msg}`);
    report.push("");
  }
} else {
  report.push("## 问题");
  report.push("");
  report.push("无。");
  report.push("");
}

await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, report.join("\n"), "utf8");
console.log(report.join("\n"));
console.log(`\n报告已写入 ${OUT_FILE}`);
if (STRICT && errorCount > 0) process.exit(1);
