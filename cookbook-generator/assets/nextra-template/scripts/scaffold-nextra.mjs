#!/usr/bin/env node
// scaffold-nextra.mjs
//
// 在 nextra-site/ 目录下把模板里的 {{XXX}} 占位符替换为真实值，并拷贝 MDX 章节。
//
// 用法：
//   node scripts/scaffold-nextra.mjs --slug python-decorators --title "Python 装饰器 CookBook" [--github URL] [--year 2026] [--mdx ../mdx]
//
// 运行后还需：
//   npm install && npm run build

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      opts[key] = val;
    }
  }
  return opts;
}

const args = parseArgs(process.argv);
const slug = args.slug || "cookbook";
const title = args.title || "CookBook";
const github = args.github || `https://example.com/${slug}`;
const year = args.year || new Date().getFullYear().toString();
const siteDir = path.resolve(".");
const mdxDir = path.resolve(args.mdx || "../mdx");

console.log(`Scaffolding Nextra site at ${siteDir}`);
console.log(`  slug=${slug}, title=${title}, github=${github}, year=${year}`);
console.log(`  mdx source=${mdxDir}`);

// ---------- 1. 拷贝 MDX 章节到 pages/zh ----------
const zhDir = path.join(siteDir, "pages", "zh");
const enDir = path.join(siteDir, "pages", "en");
await fs.mkdir(zhDir, { recursive: true });
await fs.mkdir(enDir, { recursive: true });

if (await fs.stat(mdxDir).catch(() => null)) {
  const mdxFiles = (await fs.readdir(mdxDir)).filter(f => f.endsWith(".mdx"));
  for (const f of mdxFiles) {
    let content = await fs.readFile(path.join(mdxDir, f), "utf8");
    // Nextra 站点里图片引用走 /figures/
    content = content.replace(/public\/figures\//g, "/figures/");
    await fs.writeFile(path.join(zhDir, f), content, "utf8");
    // 英文占位骨架
    const enF = path.join(enDir, f);
    if (!(await fs.stat(enF).catch(() => null))) {
      const titleM = content.match(/title:\s*"?([^"\n]+)"?/);
      const enTitle = titleM ? titleM[1] : f;
      await fs.writeFile(enF,
`---
title: "${enTitle}"
---

> 🚧 English translation is in progress. Contributions welcome.
`, "utf8");
    }
  }
  console.log(`Copied ${mdxFiles.length} MDX files to pages/zh/ and generated en skeletons.`);
} else {
  console.warn("mdx dir not found at", mdxDir, "— skipping MDX copy.");
}

// ---------- 2. 拷贝 figures ----------
const srcFig = path.join(mdxDir, "public", "figures");
const dstFig = path.join(siteDir, "public", "figures");
await fs.mkdir(dstFig, { recursive: true });
if (await fs.stat(srcFig).catch(() => null)) {
  const figs = await fs.readdir(srcFig);
  for (const fn of figs) {
    const s = path.join(srcFig, fn);
    if ((await fs.stat(s)).isFile()) await fs.copyFile(s, path.join(dstFig, fn));
  }
  console.log(`Copied ${figs.length} figures to public/figures/`);
}

// ---------- 3. 替换模板占位符 ----------
async function replaceInFile(file, replacements) {
  if (!(await fs.stat(file).catch(() => null))) return;
  let text = await fs.readFile(file, "utf8");
  for (const [k, v] of Object.entries(replacements)) {
    text = text.split(`{{${k}}}`).join(v);
  }
  await fs.writeFile(file, text, "utf8");
}

const reps = {
  BOOK_SLUG: slug,
  BOOK_TITLE: title,
  GITHUB_REPO_URL: github,
  YEAR: year,
};

const targets = [
  "package.json",
  "theme.config.tsx",
  "docker-compose.yml",
];
for (const t of targets) await replaceInFile(path.join(siteDir, t), reps);

console.log("Substituted placeholders in:", targets.join(", "));

// ---------- 4. 运行 build-meta.mjs 生成 _meta.ts（如存在）--------
console.log("\nDone. Next steps:");
console.log("  npm install");
console.log("  npm run prepare:meta       # generates pages/zh/_meta.ts");
console.log("  npm run prepare:diagrams   # renders PlantUML via Docker (if any)");
console.log("  npm run build");
