import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./lib/mdx-utils.mjs";
import { splitTrackedSections, applySectionStats, blankOutNoise } from "./lib/word-caliber.mjs";

// 计数 GFM 表格数：连续 ≥2 行 `|...|` 且第 2 行是分隔行 `| --- | --- |` 才算一张表。
function countGfmTables(text) {
  const lines = text.split("\n");
  let count = 0;
  let i = 0;
  const sepRe = /^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/;
  const rowRe = /^\s*\|.*\|\s*$/;
  while (i < lines.length) {
    if (rowRe.test(lines[i]) && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
      count++;
      i += 2;
      while (i < lines.length && rowRe.test(lines[i])) i++;
    } else {
      i++;
    }
  }
  return count;
}

const mdxDir = path.resolve("mdx");
const outFile = path.resolve("metadata/word-count.txt");
await fs.mkdir(path.dirname(outFile), { recursive: true });

const files = (await fs.readdir(mdxDir)).filter((f) => f.endsWith(".mdx"));
let totalCjk = 0;
let totalMeta = 0;
let totalEn = 0;
let totalRecipes = 0;
let totalTables = 0;
let totalCodeBlocks = 0;
let totalFigs = 0;
const perChapter = [];

for (const f of files) {
  const raw = await fs.readFile(path.join(mdxDir, f), "utf8");
  const { body } = parseFrontmatter(raw, f);
  // 与 ratio-count 同一口径：剔代码块 / HTML 注释 / meta，表内 CJK × 0.5
  const text = blankOutNoise(body);
  const codeBlocks = (body.match(/```[\s\S]*?```/g) || []).length;
  totalCodeBlocks += codeBlocks;
  const tables = countGfmTables(text);
  totalTables += tables;
  const figs = (text.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
  totalFigs += figs;
  const recipes = (text.match(/🍳 Recipe/g) || []).length;
  totalRecipes += recipes;
  const en = (text.match(/[a-zA-Z]+/g) || []).length;

  const { sections } = splitTrackedSections(body);
  sections.forEach(applySectionStats);
  // meta（章首 / N.0 / N.10）不计入正文；未标 track 的小节仍计入正文，避免无标记书报 0
  const cjk = sections.reduce((a, s) => a + (s.track === "meta" ? 0 : s.cjk), 0);
  const meta = sections.reduce((a, s) => a + (s.track === "meta" ? s.cjk : 0), 0);

  totalCjk += cjk;
  totalMeta += meta;
  totalEn += en;
  perChapter.push({ file: f, cjk, meta, en, est: cjk + en });
}

const totalEst = totalCjk + totalEn;
const lines = [];
lines.push("# Word Count Report");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("CJK caliber: body3 — code blocks, HTML comments and meta excluded; Markdown tables counted at 1/2 (table CJK × 0.5)");
lines.push(`Total CJK characters (body3 caliber): ${Math.round(totalCjk)}`);
lines.push(`Total CJK with meta: ${Math.round(totalCjk + totalMeta)} (meta ${Math.round(totalMeta)})`);
lines.push(`Total English words: ${totalEn}`);
lines.push(`Estimated total word count (CJK + EN, auxiliary): ${Math.round(totalEst)}`);
lines.push(`Chapters: ${files.length}`);
lines.push(`Recipes: ${totalRecipes}`);
lines.push(`Tables: ${totalTables}`);
lines.push(`Code blocks: ${totalCodeBlocks}`);
lines.push(`Figures/images: ${totalFigs}`);
lines.push("");
lines.push("## Per-chapter breakdown");
lines.push("");
lines.push("| File | CJK body3 | meta CJK | EN | Est. words |");
lines.push("|---|---|---|---|---|");
for (const c of perChapter) {
  lines.push(`| ${c.file} | ${Math.round(c.cjk)} | ${Math.round(c.meta)} | ${c.en} | ${Math.round(c.est)} |`);
}

await fs.writeFile(outFile, lines.join("\n"), "utf8");
console.log(`Wrote ${outFile}`);
console.log(`Total CJK (body3 caliber): ${Math.round(totalCjk)}; with meta: ${Math.round(totalCjk + totalMeta)}; EN: ${totalEn}`);
