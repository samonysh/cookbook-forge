#!/usr/bin/env node
// typst-check.mjs
//
// Typst 工程质量检查 CLI：静态 lint + 固化规则自动修复 + 每章独立 probe 并行编译。
// 流程借鉴 pdf-to-typst-notes 的 compile_check.py / fix_common.py（check <--> fix 循环 <= 3 轮），
// 移植为 Node 并与 lmdx2typst.mjs 产出的目录结构（typst/{main.typ, chapters/, figures/}）对齐。
//
// 为什么不直接编译 main.typ：整书编译一次只报第一个错，串行低效；
// 每章包一层 probe（复用 main.typ 导言 + include 单章）并行编译，N 章错误一次全部暴露。
//
// 用法：
//   node scripts/typst-check.mjs --project typst                  # 1) 静态 lint
//   node scripts/typst-check.mjs --project typst --fix            # 2) + 固化规则自动修复
//   node scripts/typst-check.mjs --project typst --fix --compile  # 3) + 每章并行编译检查
//   可选：--only ch01-overview,ch02-xxx  --jobs 6  --typst <path>  --keep（保留 _probe/）
//
// 产出：
//   typst/_lint_report.json   lint 问题清单（供 agent 消费）
//   typst/_check_report.json  编译错误清单 {"passed": [...], "failed": {slug: [{line, col, message}]}}
//
// 退出码：0 = 全部通过；1 = 存在 error 或编译失败。

import { promises as fs, existsSync, accessSync, readdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { lintText, fixText } from "./lib/typst-lint.mjs";

const execFileAsync = promisify(execFile);

// ---------- CLI 参数 ----------

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return def;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const PROJECT = path.resolve(getArg("project", "typst"));
const OPT_FIX = hasFlag("fix");
const OPT_COMPILE = hasFlag("compile");
const OPT_KEEP = hasFlag("keep");
const JOBS = Number.parseInt(getArg("jobs", "6"), 10);
const ONLY = getArg("only", null);
const TYPST_EXPLICIT = getArg("typst", null);

// ---------- typst 二进制探测（Windows 多版本共存时选可用的） ----------

function findTypst(explicit) {
  if (explicit) return explicit;
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      path.join(os.homedir(), ".cargo", "bin", "typst.exe"),
      path.join(os.homedir(), "AppData", "Local", "Programs", "typst", "typst.exe"),
      path.join(os.homedir(), "scoop", "shims", "typst.exe"),
      "C:\\Program Files\\typst\\typst.exe",
    );
  } else {
    candidates.push(
      "/usr/local/bin/typst",
      "/opt/homebrew/bin/typst",
      path.join(os.homedir(), ".cargo", "bin", "typst"),
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // PATH 上找（同步 where/which）
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["typst"], {
      encoding: "utf8",
    });
    const first = out.split(/\r?\n/)[0].trim();
    if (first && existsSync(first)) return first;
  } catch {}
  // TRAE 工作区常见位置
  try {
    const workDir = path.join(os.homedir(), ".trae-cn", "work");
    for (const d of readdirSyncSafe(workDir)) {
      const binDir = path.join(workDir, d, "typst_bin");
      for (const v of readdirSyncSafe(binDir)) {
        const exe = path.join(binDir, v, process.platform === "win32" ? "typst.exe" : "typst");
        if (existsSync(exe)) return exe;
      }
    }
  } catch {}
  return null;
}

function readdirSyncSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// ---------- main.typ 导言提取（模板 import + set/show，止于第一个 #include） ----------

function extractPreamble(mainTyp) {
  const lines = mainTyp.split("\n");
  const out = [];
  for (const ln of lines) {
    if (ln.trim().startsWith("#include")) break;
    if (ln.includes("__CHAPTER_INCLUDES__")) break; // 尚未组装的模板占位符
    if (ln.includes("LLM_CONVERSION_PENDING")) continue;
    out.push(ln);
  }
  return out.join("\n");
}

// ---------- typst 错误输出解析 ----------

const ERR_RE = /error: ([^\n]+)\n\s*\u250c[\u2500\s]*(.+?):(\d+):(\d+)/g;

function parseErrors(raw, typPath) {
  const base = path.basename(typPath);
  const errs = [];
  let m;
  ERR_RE.lastIndex = 0;
  while ((m = ERR_RE.exec(raw)) !== null) {
    const msg = m[1].trim();
    const src = m[2].trim().replace(/^\\\\\?\\/, "");
    // 只保留指向章节文件或 probe 文件的错误，模板包内部错误丢弃
    if (src.endsWith(".typ") && !(src.endsWith(base) || src.replace(/\\/g, "/").includes("/_probe/"))) {
      continue;
    }
    errs.push({
      line: Number.parseInt(m[3], 10) || 0,
      col: Number.parseInt(m[4], 10) || 0,
      message: msg,
    });
  }
  return errs;
}

function run(cmd, cmdArgs, opts) {
  return execFileAsync(cmd, cmdArgs, { timeout: 600000, maxBuffer: 32 * 1024 * 1024, ...opts });
}

// ---------- 每章 probe 并行编译 ----------

async function compileCheck(typst, chaptersDir, preamble, targets) {
  const probeDir = path.join(PROJECT, "_probe");
  await fs.mkdir(probeDir, { recursive: true });
  const results = new Map();

  const queue = [...targets];
  const workers = Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    while (queue.length > 0) {
      const t = queue.shift();
      if (!t) break;
      const probe = path.join(probeDir, `p-${t.slug}.typ`);
      const includeRel = path.relative(probeDir, t.path).replace(/\\/g, "/");
      await fs.writeFile(
        probe,
        `${preamble}\n#include "${includeRel}"\n`,
        "utf8"
      );
      const pdfOut = probe.slice(0, -4) + ".pdf";
      let raw = "";
      let code = 0;
      try {
        await run(typst, ["compile", "--root", PROJECT, probe, pdfOut], { cwd: PROJECT });
      } catch (e) {
        code = e.code ?? 1;
        raw = `${e.stderr || ""}${e.stdout || ""}`;
      }
      let errs = parseErrors(raw, t.path);
      if (code !== 0 && errs.length === 0) {
        const first = raw.split("\n").find((l) => l.trim()) || "unknown error";
        errs = [{ line: 0, col: 0, message: first }];
      }
      await fs.rm(pdfOut, { force: true });
      results.set(t.slug, { ok: code === 0 && errs.length === 0, errs });
    }
  });
  await Promise.all(workers);
  if (!OPT_KEEP) await fs.rm(probeDir, { recursive: true, force: true });
  return results;
}

// ---------- 主流程 ----------

async function main() {
  console.log("=== Typst 章节检查（lint" + (OPT_FIX ? " + fix" : "") + (OPT_COMPILE ? " + compile" : "") + "）===\n");
  console.log(`project: ${PROJECT}\n`);

  const chaptersDir = path.join(PROJECT, "chapters");
  let files;
  try {
    files = (await fs.readdir(chaptersDir)).filter((f) => f.endsWith(".typ") && !f.startsWith("._prompt_") && !f.startsWith("."));
  } catch {
    console.error(`错误：${chaptersDir} 不存在（请先运行 lmdx2typst.mjs）`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error("错误：chapters/ 下没有 .typ 章节文件");
    process.exit(2);
  }

  const only = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null;
  const targets = files
    .sort()
    .map((f) => ({ slug: f.replace(/\.typ$/, ""), path: path.join(chaptersDir, f) }))
    .filter((t) => !only || only.has(t.slug));
  if (targets.length === 0) {
    console.error("错误：--only 过滤后没有目标章节");
    process.exit(2);
  }

  // ---------- 1. lint ----------
  let allIssues = [];
  const fileIssues = new Map();
  for (const t of targets) {
    const text = await fs.readFile(t.path, "utf8");
    const issues = await lintText(text, { fileName: t.slug, projectDir: PROJECT });
    fileIssues.set(t.slug, issues);
    allIssues = allIssues.concat(issues);
  }

  // ---------- 2. fix（固化规则，只动数学块） ----------
  if (OPT_FIX && allIssues.some((i) => i.fixable)) {
    console.log("━━━ 应用固化规则修复（只作用于数学块） ━━━\n");
    const hitsTotal = {};
    for (const t of targets) {
      const text = await fs.readFile(t.path, "utf8");
      const { text: fixed, hits } = fixText(text);
      // 图片路径自动修正：figures/x -> ../figures/x（当且仅当 ../figures/x 存在）
      const fixed2 = await fixFigurePaths(fixed, t.path);
      if (fixed2 !== text) {
        await fs.writeFile(t.path, fixed2, "utf8");
        console.log(`  [fixed] ${t.slug}`);
      }
      for (const [k, v] of Object.entries(hits)) hitsTotal[k] = (hitsTotal[k] || 0) + v;
    }
    const notes = Object.entries(hitsTotal).sort((a, b) => b[1] - a[1]);
    for (const [note, n] of notes) console.log(`  ${String(n).padStart(5)}  ${note}`);
    if (notes.length) console.log("");
    // 修复后重新 lint，剩余问题进入报告
    allIssues = [];
    for (const t of targets) {
      const text = await fs.readFile(t.path, "utf8");
      const issues = await lintText(text, { fileName: t.slug, projectDir: PROJECT });
      fileIssues.set(t.slug, issues);
      allIssues = allIssues.concat(issues);
    }
  }

  // ---------- 3. 报告 lint ----------
  const lintReport = {};
  for (const t of targets) {
    const issues = fileIssues.get(t.slug) || [];
    if (issues.length) lintReport[t.slug] = issues;
  }
  const nErr = allIssues.filter((i) => i.severity === "error").length;
  const nWarn = allIssues.filter((i) => i.severity === "warn").length;
  console.log("━━━ 静态检查结果 ━━━");
  for (const t of targets) {
    const issues = fileIssues.get(t.slug) || [];
    if (issues.length === 0) {
      console.log(`  [pass] ${t.slug}`);
    } else {
      const e = issues.filter((i) => i.severity === "error").length;
      console.log(`  [${e ? "FAIL" : "warn"}] ${t.slug}: ${issues.length} 个问题`);
      for (const i of issues.slice(0, 5)) {
        console.log(`         ${i.line}  ${i.severity === "warn" ? "⚠" : "✗"} [${i.rule}] ${i.message}`);
      }
      if (issues.length > 5) console.log(`         ... 另有 ${issues.length - 5} 个`);
    }
  }
  await fs.writeFile(path.join(PROJECT, "_lint_report.json"), JSON.stringify(lintReport, null, 1), "utf8");
  console.log(`\n静态检查：${nErr} error / ${nWarn} warn -> _lint_report.json\n`);

  // ---------- 4. 每章 probe 并行编译 ----------
  let compileFailed = {};
  let compilePassed = [];
  if (OPT_COMPILE) {
    const typst = findTypst(TYPST_EXPLICIT);
    if (!typst) {
      console.error("未找到 typst 二进制：请安装 https://github.com/typst/typst/releases 或用 --typst <path> 指定");
      process.exit(2);
    }
    let ver = "unknown";
    try {
      ver = (await run(typst, ["--version"])).stdout.trim();
    } catch {}
    console.log(`━━━ 每章独立 probe 并行编译（${typst}, ${ver}）━━━\n`);
    if (ver.includes("0.13")) {
      console.error("警告：typst 0.13 对 @preview/ilm >= 2.1 过旧（需 0.14+），如机器上有更新版本请用 --typst 指定\n");
    }
    const mainTyp = await fs.readFile(path.join(PROJECT, "main.typ"), "utf8");
    const preamble = extractPreamble(mainTyp);
    const results = await compileCheck(typst, chaptersDir, preamble, targets);
    for (const t of targets) {
      const r = results.get(t.slug);
      if (!r) continue;
      if (r.ok) {
        compilePassed.push(t.slug);
        console.log(`  [pass] ${t.slug}`);
      } else {
        compileFailed[t.slug] = r.errs;
        console.log(`  [FAIL] ${t.slug}: ${r.errs.length} 个编译错误`);
        for (const e of r.errs.slice(0, 3)) console.log(`         ${e.line}:${e.col}  ${e.message}`);
        if (r.errs.length > 3) console.log(`         ... 另有 ${r.errs.length - 3} 个`);
      }
    }
    const report = { passed: compilePassed.sort(), failed: compileFailed };
    await fs.writeFile(path.join(PROJECT, "_check_report.json"), JSON.stringify(report, null, 1), "utf8");
    const nCerr = Object.values(compileFailed).reduce((s, v) => s + v.length, 0);
    console.log(`\n编译检查：${compilePassed.length}/${targets.length} 章通过；${nCerr} 个错误 -> _check_report.json\n`);
  }

  // ---------- 5. 总结 ----------
  const failedSlugs = new Set([
    ...Object.keys(lintReport).filter((s) => (lintReport[s] || []).some((i) => i.severity === "error")),
    ...Object.keys(compileFailed),
  ]);
  if (failedSlugs.size === 0) {
    console.log("✓ 全部通过");
    process.exit(0);
  } else {
    console.log(`✗ ${failedSlugs.size} 个章节需要修复：${[...failedSlugs].join(", ")}`);
    console.log("\n修复建议：");
    console.log("  1. 可自动修复的已尽量由 --fix 处理；");
    console.log("  2. 剩余问题读 _lint_report.json / _check_report.json，按章交给 agent 对照 MDX 原文修（语义级修复）；");
    console.log("  3. 修后复查：node scripts/typst-check.mjs --project typst --compile --only <slug>");
    console.log("  4. check <--> fix 循环不超过 3 轮，超限章节单独人工介入。");
    process.exit(1);
  }
}

async function fixFigurePaths(text, chapterPath) {
  const chapterDir = path.dirname(chapterPath);
  return text.replace(/image\("(figures\/[^"]+)"/g, (m, rel) => {
    const fromChapter = path.resolve(chapterDir, rel);
    const fromParent = path.resolve(chapterDir, "..", rel);
    if (!existsSync(fromChapter) && existsSync(fromParent)) {
      return `image("../${rel}"`;
    }
    return m;
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
