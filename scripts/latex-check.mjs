#!/usr/bin/env node
// latex-check.mjs
//
// ElegantBook LaTeX 工程质量检查 CLI：静态 lint + 每章独立 probe 并行编译。
// 与 typst-check.mjs 同一模式（借鉴 pdf-to-typst-notes 的 compile_check.py）：
// 不反复编译整本 main.tex（一次只报第一个错、串行低效），而是每章包一层
// probe（复用 main.tex 导言 + \input 单章）并行 xelatex 编译，N 章错误一次全部暴露。
//
// 用法：
//   node scripts/latex-check.mjs --project latex                 # 1) 静态 lint
//   node scripts/latex-check.mjs --project latex --fix           # 2) + 安全规则自动修复
//   node scripts/latex-check.mjs --project latex --fix --compile # 3) + 每章并行 xelatex 编译
//   可选：--only ch01,ch02  --jobs 4  --xelatex <path>  --keep（保留 _probe/）
//
// 产出：
//   latex/_lint_report.json    lint 问题清单
//   latex/_check_report.json   编译错误清单 {"passed": [...], "failed": {slug: [{line, message}]}}
//
// 退出码：0 = 全部通过；1 = 存在 error 或编译失败；2 = 环境错误。

import { promises as fs, existsSync, readdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { lintText, fixText } from "./lib/latex-lint.mjs";

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

const PROJECT = path.resolve(getArg("project", "latex"));
const OPT_FIX = hasFlag("fix");
const OPT_COMPILE = hasFlag("compile");
const OPT_KEEP = hasFlag("keep");
const JOBS = Math.min(Number.parseInt(getArg("jobs", "4"), 10), 4); // xelatex 重，默认并发更低
const ONLY = getArg("only", null);
const XELATEX_EXPLICIT = getArg("xelatex", null);

// ---------- xelatex 二进制探测 ----------

function findXelatex(explicit) {
  if (explicit) return explicit;
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\xelatex.exe",
      path.join(os.homedir(), "AppData", "Local", "Programs", "MiKTeX", "miktex", "bin", "x64", "xelatex.exe"),
    );
    // texlive 年份动态扫描（新版本优先）
    const years = readdirSyncSafe("C:\\texlive").sort().reverse();
    for (const y of years) candidates.push(`C:\\texlive\\${y}\\bin\\windows\\xelatex.exe`);
  } else {
    candidates.push(
      "/usr/local/bin/xelatex",
      "/Library/TeX/texbin/xelatex",
      "/opt/homebrew/bin/xelatex",
    );
    for (const d of readdirSyncSafe("/usr/local/texlive").sort().reverse()) {
      candidates.push(`/usr/local/texlive/${d}/bin/x86_64-linux/xelatex`);
      candidates.push(`/usr/local/texlive/${d}/bin/aarch64-linux/xelatex`);
      candidates.push(`/usr/local/texlive/${d}/bin/universal-darwin/xelatex`);
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["xelatex"], {
      encoding: "utf8",
    });
    const first = out.split(/\r?\n/)[0].trim();
    if (first && existsSync(first)) return first;
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

// ---------- main.tex 导言提取（至 \begin{document}，含该行） ----------

function extractPreamble(mainTex) {
  const lines = mainTex.split("\n");
  const out = [];
  for (const ln of lines) {
    out.push(ln);
    if (/\\begin\{document\}/.test(ln)) return out.join("\n");
  }
  return null; // 无 \begin{document}，main.tex 异常
}

// ---------- xelatex 日志解析 ----------

function parseLogErrors(logText, chapterPath) {
  const base = path.basename(chapterPath);
  const errs = [];
  const seen = new Set();
  // -file-line-error 模式：./chapters/ch01.tex:15: message
  for (const m of logText.matchAll(/^([^\s:][^:]*?\.tex):(\d+): (.+)$/gm)) {
    const src = m[1].replace(/^\.\//, "").replace(/\\/g, "/");
    const msg = m[3].trim();
    const isChapter = src.endsWith(base);
    const key = `${src}:${m[2]}:${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errs.push({
      line: isChapter ? Number.parseInt(m[2], 10) : 0,
      message: isChapter ? msg : `${src}:${m[2]} ${msg}`,
    });
  }
  // 经典模式：! message ... l.NNN
  if (errs.length === 0) {
    for (const m of logText.matchAll(/^! (?:LaTeX|Package|Class)? ?Error: (.+)$/gm)) {
      const msg = m[1].trim();
      if (seen.has(msg)) continue;
      seen.add(msg);
      errs.push({ line: 0, message: msg });
    }
  }
  return errs;
}

function run(cmd, cmdArgs, opts) {
  return execFileAsync(cmd, cmdArgs, { timeout: 300000, maxBuffer: 32 * 1024 * 1024, ...opts });
}

// ---------- 每章 probe 并行编译 ----------

async function compileCheck(xelatex, targets) {
  const probeDir = path.join(PROJECT, "_probe");
  await fs.mkdir(probeDir, { recursive: true });
  const mainTex = await fs.readFile(path.join(PROJECT, "main.tex"), "utf8");
  const preamble = extractPreamble(mainTex);
  if (!preamble) {
    console.error("错误：main.tex 中未找到 \\begin{document}");
    process.exit(2);
  }
  const results = new Map();

  const queue = [...targets];
  const workers = Array.from({ length: Math.min(JOBS, Math.max(queue.length, 1)) }, async () => {
    while (queue.length > 0) {
      const t = queue.shift();
      if (!t) break;
      const probe = path.join("_probe", `p-${t.slug}.tex`).replace(/\\/g, "/");
      await fs.writeFile(
        path.join(PROJECT, probe),
        `${preamble}\n\\input{chapters/${t.slug}.tex}\n\\end{document}\n`,
        "utf8"
      );
      let failed = false;
      try {
        // cwd = PROJECT：\input{chapters/...} 与 graphicspath figures/ 均相对 latex/ 根解析
        await run(xelatex, [
          "-interaction=nonstopmode",
          "-file-line-error",
          `-output-directory=${path.join("_probe").replace(/\\/g, "/")}`,
          probe,
        ], { cwd: PROJECT });
      } catch {
        failed = true; // nonstopmode 下出错退出码非 0
      }
      let errs = [];
      try {
        const log = await fs.readFile(path.join(PROJECT, "_probe", `p-${t.slug}.log`), "utf8");
        errs = parseLogErrors(log, t.path);
      } catch {}
      if (failed && errs.length === 0) {
        errs = [{ line: 0, message: "xelatex 编译失败（详见 _probe/p-" + t.slug + ".log）" }];
      }
      results.set(t.slug, { ok: !failed && errs.length === 0, errs });
    }
  });
  await Promise.all(workers);
  if (!OPT_KEEP) await fs.rm(probeDir, { recursive: true, force: true });
  return results;
}

// ---------- 主流程 ----------

async function main() {
  console.log(`=== LaTeX 章节检查（lint${OPT_FIX ? " + fix" : ""}${OPT_COMPILE ? " + compile" : ""}）===\n`);
  console.log(`project: ${PROJECT}\n`);

  const chaptersDir = path.join(PROJECT, "chapters");
  let files;
  try {
    files = (await fs.readdir(chaptersDir)).filter((f) => f.endsWith(".tex") && !f.startsWith("._prompt_") && !f.startsWith("."));
  } catch {
    console.error(`错误：${chaptersDir} 不存在（请先运行 lmdx2tex.mjs）`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error("错误：chapters/ 下没有 .tex 章节文件");
    process.exit(2);
  }

  const only = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null;
  const targets = files
    .sort()
    .map((f) => ({ slug: f.replace(/\.tex$/, ""), path: path.join(chaptersDir, f) }))
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
    const issues = lintText(text, { fileName: t.slug, projectDir: PROJECT });
    fileIssues.set(t.slug, issues);
    allIssues = allIssues.concat(issues);
  }

  // ---------- 2. fix ----------
  if (OPT_FIX && allIssues.some((i) => i.fixable)) {
    console.log("━━━ 应用安全规则修复（跳过注释与 verbatim） ━━━\n");
    const hitsTotal = {};
    for (const t of targets) {
      const text = await fs.readFile(t.path, "utf8");
      const { text: fixed, hits } = fixText(text);
      if (fixed !== text) {
        await fs.writeFile(t.path, fixed, "utf8");
        console.log(`  [fixed] ${t.slug}`);
      }
      for (const [k, v] of Object.entries(hits)) hitsTotal[k] = (hitsTotal[k] || 0) + v;
    }
    for (const [note, n] of Object.entries(hitsTotal).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${note}`);
    }
    console.log("");
    allIssues = [];
    for (const t of targets) {
      const text = await fs.readFile(t.path, "utf8");
      const issues = lintText(text, { fileName: t.slug, projectDir: PROJECT });
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
    const xelatex = findXelatex(XELATEX_EXPLICIT);
    if (!xelatex) {
      console.error("未找到 xelatex：请安装 TeX Live / MiKTeX，或用 --xelatex <path> 指定");
      process.exit(2);
    }
    console.log(`━━━ 每章独立 probe 并行编译（${xelatex}，jobs=${JOBS}）━━━\n`);
    if (!existsSync(path.join(PROJECT, "elegantbook.cls"))) {
      console.log("  提示：latex/ 下没有 elegantbook.cls（TeXLive 自带则忽略此提示）\n");
    }
    const results = await compileCheck(xelatex, targets);
    for (const t of targets) {
      const r = results.get(t.slug);
      if (!r) continue;
      if (r.ok) {
        compilePassed.push(t.slug);
        console.log(`  [pass] ${t.slug}`);
      } else {
        compileFailed[t.slug] = r.errs;
        console.log(`  [FAIL] ${t.slug}: ${r.errs.length} 个编译错误`);
        for (const e of r.errs.slice(0, 3)) console.log(`         ${e.line}  ${e.message}`);
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
    console.log("  1. 可自动修复的已由 --fix 处理；");
    console.log("  2. 剩余问题读 _lint_report.json / _check_report.json，按章对照 MDX 原文交给 agent 修；");
    console.log("  3. 修后复查：node scripts/latex-check.mjs --project latex --compile --only <slug>");
    console.log("  4. check <--> fix 循环不超过 3 轮；整书编译两遍（目录/交叉引用）：cd latex && xelatex main.tex && xelatex main.tex");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
