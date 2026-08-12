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

// ---------- 目录配置 ----------
const mdxDir = path.resolve("mdx");
const typstDir = path.resolve("typst");
const chaptersDir = path.join(typstDir, "chapters");
const figDir = path.join(typstDir, "figures");

await fs.mkdir(chaptersDir, { recursive: true });
await fs.mkdir(figDir, { recursive: true });

// ---------- 读取 Prompt 模板 ----------
const promptTemplatePath = path.join(SKILL_ROOT, "assets", "prompts", "mdx-to-typst.md");
const PROMPT_TEMPLATE = await fs.readFile(promptTemplatePath, "utf8");

// ---------- 主转换流程 ----------
console.log("=== LLM-driven MDX -> Typst (ilm) 转换器 ===\n");

const mdxEntries = [];
for (const f of (await fs.readdir(mdxDir)).filter(f => f.endsWith(".mdx")).sort()) {
  const mdxPath = path.join(mdxDir, f);
  const raw = await fs.readFile(mdxPath, "utf8");
  const fm = parseFrontmatter(raw);
  const chapNum = Number.parseInt(fm.fm.chapter, 10);
  mdxEntries.push({
    file: f,
    mdxPath,
    raw,
    title: fm.title,
    slug: fm.slug,
    fm: fm.fm,
    order: Number.isFinite(chapNum) ? chapNum : Number.MAX_SAFE_INTEGER,
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

请立即开始转换。只输出 Typst 代码，不要任何解释。输出文件第一行必须是 = 开头的章标题。
注意：mermaid/plantuml 代码块已被预处理为 ![caption](/figures/diagram-<hash>.svg) 图片语法，请把这些图片转换为 #figure(image("figures/<svg-file>", width: 70%), caption: [...]) 语法，不要保留 mermaid 源码。`;

  const promptFile = path.join(chaptersDir, `._prompt_${slug}.txt`);
  await fs.writeFile(promptFile, prompt, "utf8");

  const typstOutputPath = path.join(chaptersDir, `${slug}.typ`);

  console.log(`  PROMPT_FILE: ${promptFile}`);
  console.log(`  OUTPUT_FILE: ${typstOutputPath}`);

  // 尝试读取已有缓存
  let typstContent = null;
  try {
    typstContent = await fs.readFile(typstOutputPath, "utf8");
    // Typst 章节文件以 = 开头（标题）
    if (!typstContent.trim().startsWith("=")) {
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
      validation: { mustStartWith: "=" },
    });

    const placeholder = `// LLM_CONVERSION_PENDING: ${f}
// This chapter needs to be converted by an LLM agent.
// Prompt file: ${promptFile}
// Output file: ${typstOutputPath}
//
// After filling this file, re-run: node lmdx2typst.mjs
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

// ---------- 生成 main.typ ----------
console.log("\n━━━ 生成 main.typ ━━━");

const mainTemplatePath = path.join(SKILL_ROOT, "assets", "ilm-template.typ.txt");
let mainTemplate = await fs.readFile(mainTemplatePath, "utf8");

const includes = chapterRefs.map(c => `#include "chapters/${c.slug}.typ"`).join("\n");

mainTemplate = mainTemplate
  .replace(/__BOOK_TITLE__/g, BOOK_TITLE)
  .replace(/__BOOK_AUTHOR__/g, BOOK_AUTHOR)
  .replace(/__BOOK_ABSTRACT__/g, BOOK_ABSTRACT)
  .replace("__CHAPTER_INCLUDES__", includes);

await fs.writeFile(path.join(typstDir, "main.typ"), mainTemplate, "utf8");

// ---------- 输出结构化任务清单（供 TRAE agent 编排）----------
const planPath = path.join(typstDir, ".conversion-plan.json");
const plan = {
  format: "typst",
  bookTitle: BOOK_TITLE,
  totalChapters: chapterRefs.length,
  pendingCount: pendingTasks.length,
  pending: pendingTasks,
  cached: chapterRefs
    .filter(c => !pendingTasks.some(p => p.slug === c.slug))
    .map(c => ({ slug: c.slug, file: c.f, title: c.title, typstPath: c.typstPath })),
  instructions: pendingTasks.length
    ? [
        "For each task in `pending`, invoke a Task/sub-agent with these instructions:",
        "  1. Read `promptFile` (it contains full conversion rules + the MDX source).",
        "  2. Convert the MDX chapter to Typst per those rules.",
        "  3. Write ONLY raw Typst code to `outputFile` (no markdown fences, no prose).",
        "  4. First line must be `= Chapter Title` (Typst heading).",
        "After all tasks complete, re-run `node lmdx2typst.mjs` to regenerate main.typ with final content.",
      ]
    : ["All chapters already converted; main.typ is ready for typst compile."],
};
await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

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
console.log(`  1. 安装 Typst CLI: https://github.com/typst/typst/releases`);
console.log(`  2. cd typst && typst compile main.typ`);
console.log(`  3. 或使用 Typst Web App: https://typst.app/`);
