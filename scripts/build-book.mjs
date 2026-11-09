#!/usr/bin/env node
// build-book.mjs
//
// 统一构建入口：按书名命名 EPUB / LaTeX PDF / Typst PDF。
//
// 用法（在书根目录执行）：
//   node scripts/build-book.mjs --format=all|epub|latex|typst [--root=<book>] [--title "书名"]
//
// 说明：
//   - EPUB：调用 scripts/lbuild-epub.mjs（其内部已按书名输出 <书名>.epub）。
//   - LaTeX：xelatex main.tex 两遍后，把 main.pdf 重命名为 <书名>.pdf。
//     不直接用 xelatex -jobname 中文名：部分 TeX 发行版对非 ASCII jobname 支持不稳，
//     先编译成 main.pdf 再重命名，跨平台更可靠。
//   - Typst：typst compile main.typ main.pdf 后重命名为 <书名>.pdf，理由同上。
//
// 文件名来源与清洗规则见 scripts/lib/book-meta.mjs（metadata/outline.md -> latex/main.tex -> 兜底）。
// --root 只认等号写法（--root=<book>），空格形式直接报错，避免静默回退到当前目录。

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "./lib/cli-args.mjs";
import { resolveBookMeta } from "./lib/book-meta.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const optEq = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const ROOT = path.resolve(resolveRoot(argv, "build-book.mjs") ?? process.cwd());
const FORMAT = optEq("format", opt("format", "all"));
const CLI_TITLE = opt("title", null);

function run(cmd, cmdArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: "inherit" });
    child.on("error", (err) => reject(new Error(`无法启动 ${cmd}：${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}`));
    });
  });
}

async function removeQuietly(file) {
  try {
    await fs.unlink(file);
  } catch {}
}

async function buildEpub(meta) {
  const script = path.join(SKILL_ROOT, "scripts", "lbuild-epub.mjs");
  const args = [script];
  if (CLI_TITLE) args.push("--title", CLI_TITLE);
  console.log("\n━━━ 构建 EPUB ━━━");
  await run(process.execPath, args, ROOT);
  const out = path.join(ROOT, "epub", `${meta.fileBase}.epub`);
  await fs.access(out);
  console.log(`  → ${out}`);
  return out;
}

async function buildLatex(meta) {
  const dir = path.join(ROOT, "latex");
  const mainPdf = path.join(dir, "main.pdf");
  console.log("\n━━━ 构建 LaTeX PDF（xelatex 两遍）━━━");
  await removeQuietly(mainPdf);
  for (let i = 0; i < 2; i++) {
    await run("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], dir);
  }
  await fs.access(mainPdf);
  const out = path.join(dir, `${meta.fileBase}.pdf`);
  await removeQuietly(out);
  await fs.rename(mainPdf, out);
  await removeQuietly(path.join(dir, "book.pdf"));
  console.log(`  → ${out}`);
  return out;
}

async function buildTypst(meta) {
  const dir = path.join(ROOT, "typst");
  const mainPdf = path.join(dir, "main.pdf");
  console.log("\n━━━ 构建 Typst PDF ━━━");
  await removeQuietly(mainPdf);
  await run("typst", ["compile", "main.typ", "main.pdf"], dir);
  await fs.access(mainPdf);
  const out = path.join(dir, `${meta.fileBase}.pdf`);
  await removeQuietly(out);
  await fs.rename(mainPdf, out);
  await removeQuietly(path.join(dir, "book.pdf"));
  console.log(`  → ${out}`);
  return out;
}

async function main() {
  const meta = await resolveBookMeta({ root: ROOT, cliTitle: CLI_TITLE });
  console.log(`=== 构建产物（书名：${meta.fullTitle}；来源：${meta.source}）===`);
  console.log(`文件名主干：${meta.fileBase}`);

  const want = new Set(FORMAT === "all" ? ["epub", "latex", "typst"] : [FORMAT]);
  for (const f of want) {
    if (!["epub", "latex", "typst"].includes(f)) {
      console.error(`未知格式：${f}（可选 epub|latex|typst|all）`);
      process.exit(2);
    }
  }

  const outputs = [];
  if (want.has("epub")) outputs.push(await buildEpub(meta));
  if (want.has("latex")) outputs.push(await buildLatex(meta));
  if (want.has("typst")) outputs.push(await buildTypst(meta));

  console.log("\n━━━ 完成 ━━━");
  for (const out of outputs) console.log(`  ${out}`);
}

main().catch((err) => {
  console.error(`\n构建失败：${err.message}`);
  process.exit(1);
});
