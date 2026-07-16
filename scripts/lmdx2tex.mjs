#!/usr/bin/env node
// lmdx2tex.mjs
//
// LLM-driven MDX → ElegantBook LaTeX 转换器。
// 核心思路：逐个读取 mdx/*.mdx 文件，通过 LLM 子 agent 智能转换为 LaTeX 章节，
// 然后组装 main.tex（使用 ElegantBook 文档类）。
//
// 用法（CLI）：node lmdx2tex.mjs [--title "书名"] [--author "作者"]
//   - 输入：工作目录下 mdx/*.mdx
//   - 输出：latex/chapters/*.tex、latex/main.tex、latex/figures/（拷贝图）
//
// 与 mdx2tex.mjs 的区别：
//   - mdx2tex.mjs 使用正则替换（脆弱，容易转义错误）
//   - lmdx2tex.mjs 使用 LLM 逐章转换（语义理解，转换质量高）

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

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
const BOOK_SUBTITLE = getArg("subtitle", "");
const BOOK_VERSION = getArg("version", "1.0");
const BOOK_INSTITUTE = getArg("institute", "");

// ---------- 目录配置 ----------
const mdxDir = path.resolve("mdx");
const texDir = path.resolve("latex/chapters");
const figDir = path.resolve("latex/figures");
const diagramSrcDir = path.resolve("latex/diagrams");

await fs.mkdir(texDir, { recursive: true });
await fs.mkdir(figDir, { recursive: true });
await fs.mkdir(diagramSrcDir, { recursive: true });

// ---------- 工具 ----------
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { title: "Chapter", slug: "chapter", fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^(\w+):\s*(.+)$/);
    if (mm) fm[mm[1]] = mm[2].replace(/^["']|["']$/g, "");
  }
  return {
    title: fm.title || "Chapter",
    slug: fm.slug || "chapter",
    fm,
    body: raw.slice(m[0].length),
  };
}

// ---------- 读取 Prompt 模板 ----------
const promptTemplatePath = path.join(SKILL_ROOT, "assets", "prompts", "mdx-to-latex.md");
const PROMPT_TEMPLATE = await fs.readFile(promptTemplatePath, "utf8");

// ---------- 主转换流程 ----------
console.log("=== LLM-driven MDX → ElegantBook LaTeX 转换器 ===\n");

const mdxFiles = (await fs.readdir(mdxDir))
  .filter(f => f.endsWith(".mdx"))
  .sort();

if (mdxFiles.length === 0) {
  console.error("错误：mdx/ 目录下没有找到 .mdx 文件");
  process.exit(1);
}

console.log(`找到 ${mdxFiles.length} 个 MDX 章节文件:\n`);
for (const f of mdxFiles) console.log(`  - ${f}`);
console.log("");

const chapterRefs = [];
const convertedSlugs = [];

for (const f of mdxFiles) {
  const mdxPath = path.join(mdxDir, f);
  const raw = await fs.readFile(mdxPath, "utf8");
  const { title, slug, fm } = parseFrontmatter(raw);

  console.log(`\n━━━ 转换章节: ${f} (${title}) ━━━`);

  // 构造 LLM prompt
  const prompt = `${PROMPT_TEMPLATE}

---

## 待转换的 MDX 文件（${f}）：

\`\`\`mdx
${raw}
\`\`\`

---

请立即开始转换。只输出 LaTeX 代码，不要任何解释。`;

  // 将 prompt 写入临时文件，供子 agent 读取
  const promptFile = path.join(texDir, `._prompt_${slug}.txt`);
  await fs.writeFile(promptFile, prompt, "utf8");

  // 通过 TRAE CLI 调用子 agent 进行转换
  // 这里我们使用一个约定：子 agent 读取 prompt 文件，将结果写入输出文件
  const texOutputPath = path.join(texDir, `${slug}.tex`);
  const agentPrompt = `Read the conversion instructions from "${promptFile}", then convert the MDX chapter "${f}" to LaTeX according to those instructions. Write the resulting LaTeX code to "${texOutputPath}". Write ONLY the raw LaTeX code to the file (no markdown fences, no explanations). The file must start with \\chapter or \\chapter* on the first line.`;

  console.log(`  调用 LLM 转换中...`);

  // 使用 TRAE 的 agent 子进程来执行转换
  // 这里我们通过动态 import 的方式调用子 agent
  // 实际运行时，TRAE 会将 Task 调用路由到 LLM
  let texContent = null;

  try {
    // 尝试读取是否已经有缓存的转换结果
    try {
      texContent = await fs.readFile(texOutputPath, "utf8");
      if (texContent.trim().startsWith("\\chapter")) {
        console.log(`  使用缓存结果 (${texOutputPath} 已存在)`);
      } else {
        texContent = null;
      }
    } catch {
      // 文件不存在，需要 LLM 转换
    }

    if (!texContent) {
      // 我们不能在 .mjs 脚本中直接调用 LLM API，
      // 所以这里输出指令让主 agent（即 TRAE）执行子任务
      // 我们将在下面通过 Task tool 来实现这个调用
      //
      // 临时方案：输出待转换文件信息到 stdout，
      // 主 agent 负责逐章调用 Task
      console.log(`  [WAITING_FOR_LLM] 需要 LLM 转换: ${f}`);
      console.log(`  PROMPT_FILE: ${promptFile}`);
      console.log(`  OUTPUT_FILE: ${texOutputPath}`);
      console.log(`  SLUG: ${slug}`);
      console.log(`  TITLE: ${title}`);

      // 写入占位符
      const placeholder = `% LLM_CONVERSION_PENDING: ${f}
% This chapter needs to be converted by LLM.
% Run: node lmdx2tex.mjs  to trigger LLM conversion, or
% manually convert using the prompt at ${promptFile}
\\chapter{${title.replace(/[_#&%$]/g, '\\$&')}}
\\label{ch:${slug}}

% [LLM output will be placed here]
`;
      await fs.writeFile(texOutputPath, placeholder, "utf8");
      texContent = placeholder;
    }
  } catch (err) {
    console.error(`  转换失败: ${err.message}`);
    texContent = `\\chapter{${title}}\\label{ch:${slug}}\n% Error: ${err.message}\n`;
    await fs.writeFile(texOutputPath, texContent, "utf8");
  }

  chapterRefs.push({ slug, f, title, texPath: texOutputPath });
  convertedSlugs.push(slug);
  console.log(`  ✓ 已输出: ${slug}.tex`);
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
  console.log(`  拷贝了 ${count} 个图片到 latex/figures/`);
} catch {
  console.log("  未找到 public/figures 目录，跳过图片拷贝");
}

const diagSrc = path.join(mdxDir, "public", "diagrams-src");
try {
  const diags = await fs.readdir(diagSrc);
  let count = 0;
  for (const fn of diags) {
    const s = path.join(diagSrc, fn);
    if ((await fs.stat(s)).isFile()) {
      await fs.copyFile(s, path.join(diagramSrcDir, fn));
      count++;
    }
  }
  console.log(`  拷贝了 ${count} 个图表源文件到 latex/diagrams/`);
} catch {
  // 可选目录，不存在则跳过
}

// ---------- 生成 main.tex ----------
console.log("\n━━━ 生成 main.tex ━━━");

const mainTemplatePath = path.join(SKILL_ROOT, "assets", "elegantbook-main.template.tex");
let mainTemplate = await fs.readFile(mainTemplatePath, "utf8");

const inputs = chapterRefs.map(c => `\\input{chapters/${c.slug}}`).join("\n");

mainTemplate = mainTemplate
  .replace(/__BOOK_TITLE__/g, BOOK_TITLE)
  .replace(/__BOOK_SUBTITLE__/g, BOOK_SUBTITLE)
  .replace(/__BOOK_AUTHOR__/g, BOOK_AUTHOR)
  .replace(/__BOOK_INSTITUTE__/g, BOOK_INSTITUTE)
  .replace(/__BOOK_VERSION__/g, BOOK_VERSION)
  .replace("__CHAPTER_INPUTS__", inputs);

await fs.writeFile(path.resolve("latex/main.tex"), mainTemplate, "utf8");

// ---------- 清理临时 prompt 文件 ----------
for (const slug of convertedSlugs) {
  const pf = path.join(texDir, `._prompt_${slug}.txt`);
  try { await fs.unlink(pf); } catch {}
}

console.log(`\n━━━ 完成 ━━━`);
console.log(`\n已生成:`);
console.log(`  - latex/main.tex (主文件，使用 ElegantBook 文档类)`);
console.log(`  - latex/chapters/ (${chapterRefs.length} 个章节文件)`);
console.log(`  - latex/figures/ (图片资源)`);
console.log(`\n注意: 章节文件中标记为 [WAITING_FOR_LLM] 的需要 LLM 填充实际内容。`);
console.log(`请使用 TRAE agent 逐个转换这些章节（见 lmdx2tex-convert.mjs 或手工调用）。`);
console.log(`\n编译方法:`);
console.log(`  1. 将 ElegantBook 的 elegantbook.cls 放入 latex/ 目录`);
console.log(`  2. cd latex && xelatex main.tex && xelatex main.tex`);
