#!/usr/bin/env node
// lmdx2typst.mjs
//
// LLM-driven MDX -> Typst (ilm template) 转换器。
// 核心思路：逐个读取 mdx/*.mdx 文件，通过 LLM 子 agent 智能转换为 Typst 章节，
// 然后组装 main.typ（使用 ilm 模板）。
//
// 用法（CLI）：node lmdx2typst.mjs [--title "书名"] [--author "作者"]
//   - 输入：工作目录下 mdx/*.mdx
//   - 输出：typst/chapters/*.typ、typst/main.typ、typst/figures/（拷贝图）
//
// 与 lmdx2tex.mjs 的区别：
//   - 输出 Typst 语法（= 标题、$公式$、table() 等）而非 LaTeX
//   - 使用 ilm 模板（@preview/ilm:2.1.1）而非 ElegantBook
//   - 编译器为 typst CLI 而非 xelatex
//   - 样式优化：中文字体 LXGW WenKai、代码块圆角边框、四色 callout 提示框

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { parseFrontmatter } from "./lib/mdx-utils.mjs";
import { extractDiagramBlocks, renderAll, replaceBlocks } from "./lib/diagram-renderer.mjs";
import { lintText } from "./lib/typst-lint.mjs";
import {
  resolveTypstConfig,
  collectFigureLabels,
  convertFigureRefs,
  optimizeChapter,
} from "./lib/typst-optimize.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, "..");

// ---------- CLI 参数解析 ----------
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return def;
}
const BOOK_TITLE = getArg("title", "CookBook");
const BOOK_AUTHOR = getArg("author", "Cookbook Generator");
const BOOK_ABSTRACT = getArg("abstract", "本书由 Cookbook Forge 自动生成。");
const CONFIG_EXPLICIT = getArg("config", null);

// ---------- 配置加载（P1-4：--config > ./typst.config.json > assets/typst-default.config.json） ----------
const { config: TCFG, source: CONFIG_SOURCE } = await resolveTypstConfig(
  CONFIG_EXPLICIT,
  process.cwd(),
  SKILL_ROOT
);

const FONT_TEXT = TCFG?.fonts?.text || ["LXGW WenKai", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", "serif"];
const FONT_CODE = TCFG?.fonts?.code || ["LXGW WenKai Mono", "DejaVu Sans Mono", "Source Code Pro", "Consolas", "monospace"];
const FONT_TEXT_SIZE = TCFG?.fonts?.textSize || "12pt";
const FONT_CODE_SIZE = TCFG?.fonts?.codeSize || "11pt";

/** 字体数组 -> Typst 字体栈实参（"a", "b", ...）。 */
const fontArgs = (fonts) => fonts.map((f) => `"${f}"`).join(", ");

/** 生成标题自动编号 set 规则（第 C 章 / C.S）。 */
function genHeadingNumbering(cfg) {
  if (cfg?.headings?.autoNumber === false) {
    return "// 标题自动编号已关闭（headings.autoNumber: false）：章节文件保留手动编号，优化器不剥离";
  }
  let pattern = String(cfg?.headings?.level1Pattern || "第 {n} 章");
  if (!pattern.includes("{n}")) pattern = "第 {n} 章";
  const numbering = cfg?.headings?.numbering || "1.1";
  // "第 {n} 章" -> ["第 ", " 章"] -> `"第 " + numbering("1", ..nums) + " 章"`
  const segs = pattern.split("{n}").map((p, i) => {
    if (i === 0) return p ? [JSON.stringify(p)] : [];
    const seg = [`numbering("1", ..nums)`];
    if (p) seg.push(JSON.stringify(p));
    return seg;
  });
  const l1Expr = segs.flat().join(" + ");
  return [
    "#set heading(numbering: (..nums) => {",
    "  if nums.pos().len() <= 1 {",
    `    ${l1Expr}`,
    "  } else {",
    `    numbering("${numbering}", ..nums)`,
    "  }",
    "})",
  ].join("\n");
}

/** 生成图表编号 set/show 规则（图 C-S / 表 C-S，每章重置）。 */
function genFigureNumbering(cfg) {
  const figs = cfg?.figures || {};
  const tabs = cfg?.tables || {};
  const figOn = figs.autoNumber !== false;
  const tabOn = tabs.autoNumber !== false;
  if (!figOn && !tabOn) {
    return "// 图表自动编号已关闭（figures/tables.autoNumber: false）";
  }
  const figSup = figs.supplement || "图";
  const tabSup = tabs.supplement || "表";
  const codeSup = cfg?.listings?.supplement || "代码";
  const pattern = figs.numbering || "1-1";
  const lines = [
    `#set figure(supplement: [${figSup}])`,
  ];
  if (tabOn) lines.push(`#show figure.where(kind: table): set figure(supplement: [${tabSup}])`);
  lines.push(`#show figure.where(kind: raw): set figure(supplement: [${codeSup}])`);
  if (figOn || tabOn) {
    lines.push(
      "#set figure(numbering: (..nums) => {",
      // 注意：必须用元素类型 counter(heading)（标题实际步进的计数器）；
      // counter("heading") 是同名字符串自定义计数器，永远为 0（典型坑：图号变 图 0-1）
      "  let h = counter(heading).at(here())",
      `  numbering("${pattern}", if h.len() > 0 { h.first() } else { 1 }, ..nums)`,
      "})",
      "#show heading.where(level: 1): it => {",
      "  counter(figure.where(kind: image)).update(0)",
    );
    if (tabOn) lines.push("  counter(figure.where(kind: table)).update(0)");
    lines.push(
      "  counter(figure.where(kind: raw)).update(0)",
      "  it",
      "}"
    );
  }
  return lines.join("\n");
}

/** 生成 callout 调色板（callout.palette -> Typst dictionary 字面量）。 */
function genCalloutPalette(cfg) {
  const palette = cfg?.callout?.palette || {};
  const entries = Object.entries(palette).map(
    ([key, c]) =>
      `  ${key}: (fill: rgb("${c.fill}"), stroke: rgb("${c.stroke}"), icon: ${JSON.stringify(c.icon)}),`
  );
  return (
    entries.join("\n") ||
    '  blue: (fill: rgb("#eff6ff"), stroke: rgb("#3b82f6"), icon: "\u{1f4d8}"),'
  );
}

/** 生成 prompt 中的 callout 类型映射表（callout.types）。 */
function genCalloutTable(cfg) {
  const types = cfg?.callout?.types || {};
  const rows = Object.entries(types).map(
    ([cls, t]) => `| \`${cls}\` | \`#callout-box("${t.color}", "${t.title}")[...内容...]\` |`
  );
  if (rows.length === 0) return "";
  return ["| className | Typst 代码 |", "|---|---|", ...rows].join("\n");
}

// ---------- 目录配置 ----------
const mdxDir = path.resolve("mdx");
const typstDir = path.resolve("typst");
const chaptersDir = path.join(typstDir, "chapters");
const figDir = path.join(typstDir, "figures");

await fs.mkdir(chaptersDir, { recursive: true });
await fs.mkdir(figDir, { recursive: true });

// ---------- 读取 Prompt 模板（callout 映射表由配置生成，P1-4） ----------
const promptTemplatePath = path.join(SKILL_ROOT, "assets", "prompts", "mdx-to-typst.md");
const PROMPT_TEMPLATE = (await fs.readFile(promptTemplatePath, "utf8")).replace(
  "__CALLOUT_TABLE__",
  genCalloutTable(TCFG)
);

// ---------- 主转换流程 ----------
console.log("=== LLM-driven MDX -> Typst (ilm) 转换器 ===\n");
console.log(`config: ${CONFIG_SOURCE || "(assets 默认配置未找到，按内置默认)"}\n`);

const mdxEntries = [];
for (const f of (await fs.readdir(mdxDir)).filter(f => f.endsWith(".mdx")).sort()) {
  const mdxPath = path.join(mdxDir, f);
  const raw = await fs.readFile(mdxPath, "utf8");
  const fm = parseFrontmatter(raw, f);
  const inferred = f.match(/^ch(\d+)/i) || f.match(/^chapter[-_](\d+)/i);
  const appendix = f.match(/^appendix[-_]([a-z])/i);
  const inferredOrder = inferred ? Number(inferred[1])
    : appendix ? 1000 + appendix[1].toLowerCase().charCodeAt(0) - 96
    : /^index\./i.test(f) ? 0
    : Number.MAX_SAFE_INTEGER;
  const chapNum = Number.parseInt(fm.fm.chapter, 10);
  mdxEntries.push({
    file: f,
    mdxPath,
    raw,
    title: fm.title,
    slug: fm.slug,
    fm: fm.fm,
    order: Number.isFinite(chapNum) ? chapNum : inferredOrder,
  });
}
mdxEntries.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));

if (mdxEntries.length === 0) {
  console.error("错误：mdx/ 目录下没有找到 .mdx 文件");
  process.exit(1);
}

console.log(`找到 ${mdxEntries.length} 个 MDX 章节文件（按 chapter: 字段排序）:\n`);
for (const e of mdxEntries) console.log(`  [${e.order === Number.MAX_SAFE_INTEGER ? " -" : String(e.order).padStart(2)}] ${e.file}  ->  ${e.title}`);
console.log("");

const chapterRefs = [];
const pendingTasks = [];

for (const entry of mdxEntries) {
  const f = entry.file;
  const mdxPath = entry.mdxPath;
  const raw = entry.raw;
  const title = entry.title;
  const slug = entry.slug;

  console.log(`\n━━━ 转换章节: ${f} (${title}) ━━━`);

  // ---------- 处理 mermaid/plantuml 代码块：先渲染成 SVG ----------
  const blocks = extractDiagramBlocks(raw);
  let mdxForLlm = raw;
  if (blocks.length > 0) {
    console.log(`  提取到 ${blocks.length} 个 mermaid/plantuml 代码块，渲染中...`);
    const results = await renderAll(path.resolve("."), blocks, {
      onProgress: (m) => console.log("   ", m),
    });
    for (const r of results) {
      try {
        await fs.copyFile(r.svgAbsPath, path.join(figDir, r.svgFileName));
      } catch {}
    }
    mdxForLlm = replaceBlocks(raw, results, (r) => {
      const caption = r.caption;
      const fname = r.svgFileName;
      return `\n\n![${caption}](/figures/${fname})\n\n`;
    });
    console.log(`  ✓ 已替换 ${blocks.length} 个图表代码块为 Markdown 图片引用`);
  }

  // 构造 LLM prompt（写入 prompt 文件供 agent 读取）
  const prompt = `${PROMPT_TEMPLATE}

---

## 待转换的 MDX 文件（${f}）：

\`\`\`mdx
${mdxForLlm}
\`\`\`

---

请立即开始转换。只输出 Typst 代码，不要任何解释。输出文件第一行必须是 #import "../callout.typ": callout-box，第二行必须是 = 开头的章标题。
注意：
1. 标题文本不要带手动编号（如「第 1 章」「1.2」）——模板自动编号，组装脚本也会剥离残留编号；
2. mermaid/plantuml 代码块已被预处理为 ![caption](/figures/diagram-<hash>.svg) 图片语法，请把这些图片转换为 #figure(image("../figures/<svg-file>", width: 70%), caption: [...]) 语法（路径必须是 ../figures/，因为章节文件在 chapters/ 子目录下），不要保留 mermaid 源码；
3. figure 不要手写 <label>（组装脚本自动注入 <fig-C-S>），caption 不要带「图 N-M」编号前缀；
4. 正文中「图 N-M / 表 N-M」交叉引用保持纯文本，组装脚本会自动转换为 @fig-N-M / @tab-N-M 活引用。`;

  const promptFile = path.join(chaptersDir, `._prompt_${slug}.txt`);
  await fs.writeFile(promptFile, prompt, "utf8");

  const typstOutputPath = path.join(chaptersDir, `${slug}.typ`);

  console.log(`  PROMPT_FILE: ${promptFile}`);
  console.log(`  OUTPUT_FILE: ${typstOutputPath}`);

  // 尝试读取已有缓存
  let typstContent = null;
  try {
    typstContent = await fs.readFile(typstOutputPath, "utf8");
    // 章节可能有合法的前置指令（例如 #divider()），不要求第一行必须是标题。
    // 只拒绝本脚本自己的占位符，以及完全不像章节的缓存文件。
    const t = typstContent.trim();
    if (t.includes("LLM_CONVERSION_PENDING")
      || (!t.includes('#import "../callout.typ"') && !/^={1,3}\s+\S/m.test(t))) {
      typstContent = null;
    } else {
      console.log(`  ✓ 使用缓存结果`);
    }
  } catch {
    // 文件不存在
  }

  if (!typstContent) {
    pendingTasks.push({
      format: "typst",
      mdxFile: f,
      mdxPath,
      promptFile,
      outputFile: typstOutputPath,
      slug,
      title,
      validation: { mustStartWith: ["=", "#import"] },
    });

    const placeholder = `// LLM_CONVERSION_PENDING: ${f}
// This chapter needs to be converted by an LLM agent.
// Prompt file: ${promptFile}
// Output file: ${typstOutputPath}
//
// After filling this file, re-run: node lmdx2typst.mjs
#import "../callout.typ": callout-box

= ${title}

// [LLM output will replace this block]
`;
    await fs.writeFile(typstOutputPath, placeholder, "utf8");
    console.log(`  ⚠ 写入占位符 - 待 LLM 转换`);
  }

  chapterRefs.push({ slug, f, title, typstPath: typstOutputPath });
}

// ---------- 拷贝图片资源 ----------
console.log("\n━━━ 拷贝资源文件 ━━━");

const figSrc = path.join(mdxDir, "public", "figures");
try {
  const figs = await fs.readdir(figSrc);
  let count = 0;
  for (const fn of figs) {
    const s = path.join(figSrc, fn);
    if ((await fs.stat(s)).isFile()) {
      await fs.copyFile(s, path.join(figDir, fn));
      count++;
    }
  }
  console.log(`  拷贝了 ${count} 个图片到 typst/figures/`);
} catch {
  console.log("  未找到 public/figures 目录，跳过图片拷贝");
}

// ---------- 生成 main.typ（配置驱动占位符替换，P1-4） ----------
console.log("\n━━━ 生成 main.typ + callout.typ ━━━");

const mainTemplatePath = path.join(SKILL_ROOT, "assets", "ilm-template.typ.txt");
let mainTemplate = await fs.readFile(mainTemplatePath, "utf8");

// Callout 模块独立成文件：Typst 的 #include 不继承 main.typ 的 #let 作用域，
// 章节文件通过 `#import "../callout.typ": callout-box` 自行引入。
const calloutTemplatePath = path.join(SKILL_ROOT, "assets", "ilm-callout.typ.txt");
const calloutTemplate = (await fs.readFile(calloutTemplatePath, "utf8")).replace(
  // 行锚定匹配：只替换独立成行的占位符，避免误命中注释中的占位符字面量
  /^[ \t]*__CALLOUT_PALETTE__[ \t]*$/m,
  () => genCalloutPalette(TCFG)
);
await fs.writeFile(path.join(typstDir, "callout.typ"), calloutTemplate, "utf8");

const includes = chapterRefs.map(c => `#include "chapters/${c.slug}.typ"`).join("\n");

mainTemplate = mainTemplate
  .replace(/__BOOK_TITLE__/g, BOOK_TITLE)
  .replace(/__BOOK_AUTHOR__/g, BOOK_AUTHOR)
  .replace(/__BOOK_ABSTRACT__/g, BOOK_ABSTRACT)
  .replace(/__FONT_TEXT_ARGS__/g, fontArgs(FONT_TEXT))
  .replace(/__FONT_CODE_ARGS__/g, fontArgs(FONT_CODE))
  .replace(/__FONT_TEXT_SIZE__/g, FONT_TEXT_SIZE)
  .replace(/__FONT_CODE_SIZE__/g, FONT_CODE_SIZE)
  .replace(/__HEADING_NUMBERING__/g, () => genHeadingNumbering(TCFG))
  .replace(/__FIGURE_NUMBERING__/g, () => genFigureNumbering(TCFG))
  .replace("__CHAPTER_INCLUDES__", includes);

await fs.writeFile(path.join(typstDir, "main.typ"), mainTemplate, "utf8");

// ---------- 写出工程 manifest（生效配置 + 章号映射，供 typst-check.mjs 消费） ----------
const manifestPath = path.join(typstDir, ".typst-project.json");
await fs.writeFile(
  manifestPath,
  JSON.stringify(
    {
      format: "typst",
      bookTitle: BOOK_TITLE,
      config: TCFG,
      configSource: CONFIG_SOURCE,
      // ordinal = include 顺序（1 起），与模板 counter(heading) 渲染编号一致，
      // 也是 figure label <fig-C-S> 中 C 的取值来源
      chapters: chapterRefs.map((c, i) => ({
        slug: c.slug,
        ordinal: i + 1,
        title: c.title,
        file: `chapters/${c.slug}.typ`,
      })),
    },
    null,
    2
  ),
  "utf8"
);

// ---------- 输出结构化任务清单（供 TRAE agent 编排）----------
const planPath = path.join(typstDir, ".conversion-plan.json");

// ---------- 对已转换章节做快速静态 lint（零依赖，秒级） ----------
const lintSummary = {};
let lintErrTotal = 0;
for (const c of chapterRefs) {
  if (pendingTasks.some((p) => p.slug === c.slug)) continue;
  let text;
  try {
    text = await fs.readFile(c.typstPath, "utf8");
  } catch {
    continue;
  }
  const issues = await lintText(text, { fileName: c.slug, projectDir: typstDir });
  const errs = issues.filter((i) => i.severity === "error");
  lintErrTotal += errs.length;
  if (issues.length > 0) lintSummary[c.slug] = issues;
}

const plan = {
  format: "typst",
  bookTitle: BOOK_TITLE,
  totalChapters: chapterRefs.length,
  pendingCount: pendingTasks.length,
  pending: pendingTasks,
  cached: chapterRefs
    .filter(c => !pendingTasks.some(p => p.slug === c.slug))
    .map(c => ({ slug: c.slug, file: c.f, title: c.title, typstPath: c.typstPath })),
  lintIssues: lintSummary,
  instructions: pendingTasks.length
    ? [
        "For each task in `pending`, invoke a Task/sub-agent with these instructions:",
        "  1. Read `promptFile` (it contains full conversion rules + the MDX source).",
        "  2. Convert the MDX chapter to Typst per those rules.",
        "  3. Write ONLY raw Typst code to `outputFile` (no markdown fences, no prose).",
        "  4. First line must be `= Chapter Title` (Typst heading).",
        "After all tasks complete:",
        "  5. Re-run `node scripts/lmdx2typst.mjs` to regenerate main.typ with final content.",
        "  6. Run `node scripts/typst-check.mjs --project typst --fix` to auto-fix known Typst math rules (LaTeX residue, bare CJK/acronyms in math, missing # prefixes).",
        "  7. Run `node scripts/typst-check.mjs --project typst --compile` for per-chapter parallel probe compilation; fix remaining errors from `_check_report.json` (check<->fix loop, max 3 rounds).",
      ]
    : ["All chapters already converted; main.typ is ready for typst compile.",
       "Run `node scripts/typst-check.mjs --project typst --fix --compile` to validate."],
};
await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

if (Object.keys(lintSummary).length > 0) {
  console.log(`\n━━━ 静态 lint（已转换章节） ━━━`);
  for (const [slug, issues] of Object.entries(lintSummary)) {
    const e = issues.filter((i) => i.severity === "error").length;
    console.log(`  [${e ? "FAIL" : "warn"}] ${slug}: ${issues.length} 个问题（${e} error）`);
    for (const i of issues.slice(0, 3)) console.log(`         ${i.line}  [${i.rule}] ${i.message}`);
    if (issues.length > 3) console.log(`         ... 另有 ${issues.length - 3} 个`);
  }
  console.log(`  共 ${lintErrTotal} 个 error。修复：node scripts/typst-check.mjs --project typst --fix --compile`);
}

// ---------- 清理临时 prompt 文件（仅对已缓存章节） ----------
for (const c of chapterRefs) {
  if (pendingTasks.some(p => p.slug === c.slug)) continue;
  const pf = path.join(chaptersDir, `._prompt_${c.slug}.txt`);
  try { await fs.unlink(pf); } catch {}
}

console.log(`\n━━━ 完成 ━━━`);
console.log(`\n已生成:`);
console.log(`  - typst/main.typ (主文件，使用 ilm 模板)`);
console.log(`  - typst/chapters/ (${chapterRefs.length} 个章节文件)`);
console.log(`  - typst/figures/ (图片资源)`);
if (pendingTasks.length > 0) {
  console.log(`\n⚠ 有 ${pendingTasks.length} 个章节需要 LLM 转换：`);
  for (const t of pendingTasks) {
    console.log(`    • ${t.slug}  ->  ${t.outputFile}`);
  }
  console.log(`\n任务清单已写入: ${planPath}`);
  console.log(`主 agent（TRAE）读取该 JSON 后可并发调度 Task 逐章转换。`);
  console.log(`全部转换完成后重新运行: node lmdx2typst.mjs`);
} else {
  console.log(`\n✓ 所有章节已转换完成。`);
}
console.log(`\n编译方法:`);
console.log(`  0. 检查与自动修复（推荐）: node scripts/typst-check.mjs --project typst --fix --compile`);
console.log(`  1. 安装 Typst CLI: https://github.com/typst/typst/releases`);
console.log(`  2. cd typst && typst compile main.typ`);
console.log(`  3. 或使用 Typst Web App: https://typst.app/`);
