#!/usr/bin/env node
// typst-check.mjs
//
// Typst 工程质量检查 CLI：静态 lint + 固化规则自动修复 + 确定性优化 + 每章独立 probe 并行编译。
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
//         --config <path>（配置解析顺序：--config > typst/.typst-project.json 内嵌配置
//                          > ./typst.config.json > assets/typst-default.config.json）
//
// --fix 的三个 pass（全部幂等）：
//   1. 数学块固化规则（typst-lint.mjs fixText，只动数学块）；
//   2. 确定性优化器（typst-optimize.mjs）：标题手动编号剥离（P0-1）、figure label 注入
//      <fig-C-S>/<tab-C-S> 与 caption 前缀剥离、正文「图 C-S」引用转 @fig-C-S（P0-2）、
//      长表格注入 breakable: true（P0 表格质量，阈值 tables.splitThreshold）、
//      callout 类型名映射颜色键 + 缺失标题补全（P0 callout 健壮性）；
//      label/引用是全局语义，pass 覆盖 chapters/ 下全部章节（不受 --only 影响）；
//   3. 图片路径修正 figures/ -> ../figures/（存在时）。
//   4. 主模板闸门：main.typ 必须使用 @preview/ilm；--fix 时自动重新组装。
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
import { fileURLToPath } from "node:url";
import { lintText, fixText, computeRawMask, errorSuggestion } from "./lib/typst-lint.mjs";
import {
  resolveTypstConfig,
  collectFigureLabels,
  convertFigureRefs,
  convertChapterRefs,
  optimizeChapter,
} from "./lib/typst-optimize.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");

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
const CONFIG_EXPLICIT = getArg("config", null);

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

// ---------- ilm 模板闸门与重新补充 ----------

function hasIlmTemplate(mainTyp) {
  return /(^|\n)\s*#import\s+"@preview\/ilm:[^"]+"\s*:\s*\*/m.test(mainTyp)
    && /(^|\n)\s*#show:\s*ilm\.with\s*\(/m.test(mainTyp);
}

function extractMainString(mainTyp, key, fallback) {
  const m = mainTyp.match(new RegExp(`${key}:\\s*"([^"]*)"`));
  return m?.[1] || fallback;
}

/**
 * 重新运行唯一的组装入口，恢复 main.typ/callout.typ，并保留已有章节内容。
 * 不在这里复制 ilm 模板生成逻辑，避免修复路径与转换路径发生漂移。
 */
async function restoreIlmTemplate(mainTyp, manifest) {
  const mdxDir = path.dirname(PROJECT) === process.cwd()
    ? path.join(process.cwd(), "mdx")
    : path.join(path.dirname(PROJECT), "mdx");
  if (!existsSync(mdxDir)) {
    throw new Error(`无法自动恢复 ilm 模板：未找到 ${mdxDir}`);
  }

  const title = manifest?.bookTitle || extractMainString(mainTyp, "title", "CookBook");
  const author = extractMainString(mainTyp, "authors", "Cookbook Generator");
  const converter = path.join(SKILL_ROOT, "scripts", "lmdx2typst.mjs");
  const cwd = path.dirname(PROJECT);
  await execFileAsync(process.execPath, [converter, "--title", title, "--author", author], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  const repaired = await fs.readFile(path.join(PROJECT, "main.typ"), "utf8");
  if (!hasIlmTemplate(repaired)) {
    throw new Error("lmdx2typst.mjs 已执行，但生成的 main.typ 仍未使用 ilm 模板");
  }
  return repaired;
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
      suggestion: errorSuggestion(msg),
    });
  }
  return errs;
}

function run(cmd, cmdArgs, opts) {
  return execFileAsync(cmd, cmdArgs, { timeout: 600000, maxBuffer: 32 * 1024 * 1024, ...opts });
}

// ---------- 全量 label 收集（跨章引用误报过滤用） ----------

/**
 * 收集一章内全部 `<label>`（跳过 raw 块与注释行）。
 * probe 单章编译时，其他章定义的 label 在本文档中不存在，
 * "label does not exist" 属固有误报；真悬空引用由 lint 的 dangling-ref 规则兜底。
 */
function collectAllLabels(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const rawMask = computeRawMask(lines);
  const labels = new Set();
  const re = /<([a-zA-Z][a-zA-Z0-9_-]*)>/g;
  for (let i = 0; i < lines.length; i++) {
    if (rawMask[i] || /^\s*\/\//.test(lines[i])) continue;
    let m;
    while ((m = re.exec(lines[i])) !== null) labels.add(m[1]);
  }
  return labels;
}

// ---------- 每章 probe 并行编译 ----------

async function compileCheck(typst, chaptersDir, preamble, targets, labelSets) {
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
      // probe 单章编译的固有误报：跨章 @ref 指向其他章的 label（本章文档中不存在）。
      // 整书编译（main.typ 顺序 include 全部章）可正常解析；本章 label 报错、
      // 或 label 全局不存在（真悬空，lint dangling-ref 兜底）不过滤。
      let crossRefFP = 0;
      if (errs.length > 0 && labelSets) {
        const own = labelSets.get(t.slug) || new Set();
        errs = errs.filter((e) => {
          const lm = /^label `<([^>]+)>` does not exist/.exec(e.message);
          if (!lm || own.has(lm[1])) return true;
          const inOther = [...labelSets.values()].some((s) => s !== own && s.has(lm[1]));
          if (inOther) { crossRefFP++; return false; }
          return true;
        });
        if (crossRefFP > 0) {
          console.log(`  [probe ] ${t.slug}: 跳过 ${crossRefFP} 处跨章引用误报（单章 probe 无法解析他章 label，整书编译可解析）`);
        }
      }
      // raw 输出中的全部 error 都被判定为跨章误报时视为通过（exit code 由这些 error 引起）；
      // 否则编译非零退出但解析不出错误时，保留原始首行作通用回退。
      const rawErrTotal = (raw.match(/^error: /gm) || []).length;
      const allFalsePositive = crossRefFP > 0 && errs.length === 0 && crossRefFP >= rawErrTotal;
      if (code !== 0 && errs.length === 0 && !allFalsePositive) {
        const first = raw.split("\n").find((l) => l.trim()) || "unknown error";
        errs = [{ line: 0, col: 0, message: first }];
      }
      await fs.rm(pdfOut, { force: true });
      results.set(t.slug, { ok: errs.length === 0 && (code === 0 || allFalsePositive), errs });
    }
  });
  await Promise.all(workers);
  if (!OPT_KEEP) await fs.rm(probeDir, { recursive: true, force: true });
  return results;
}

// ---------- 配置与章号映射加载 ----------

/**
 * 配置解析：--config > typst/.typst-project.json 内嵌配置 > ./typst.config.json > assets 默认。
 * .typst-project.json 由 lmdx2typst.mjs 写出（含生效配置与章节 ordinal 清单），
 * 优先于 cwd 配置以保证与转换期使用的配置一致。
 */
async function loadProjectContext() {
  const manifestPath = path.join(PROJECT, ".typst-project.json");
  if (CONFIG_EXPLICIT) {
    const r = await resolveTypstConfig(CONFIG_EXPLICIT, process.cwd(), SKILL_ROOT);
    return { config: r.config, configSource: r.source, manifest: null };
  }
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (manifest?.config && typeof manifest.config === "object") {
        return { config: manifest.config, configSource: `${manifestPath}#config`, manifest };
      }
      return { config: null, configSource: null, manifest };
    } catch {
      // manifest 损坏时走常规解析
    }
  }
  const r = await resolveTypstConfig(null, process.cwd(), SKILL_ROOT);
  return { config: r.config, configSource: r.source, manifest: null };
}

/**
 * 章号映射（label 的 C 与模板 include 顺序一致）：
 * manifest.chapters[].ordinal 覆盖全部章节文件时用 manifest；否则按文件名排序推导（1 起）。
 */
function buildOrdinals(allFiles, manifest) {
  const fromManifest = new Map();
  for (const c of manifest?.chapters || []) {
    if (typeof c.ordinal === "number" && c.slug) fromManifest.set(c.slug, c.ordinal);
  }
  const covered = allFiles.every((t) => fromManifest.has(t.slug));
  if (covered) return fromManifest;
  const m = new Map();
  allFiles.forEach((t, i) => m.set(t.slug, i + 1));
  return m;
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
  const allFiles = files
    .sort()
    .map((f) => ({ slug: f.replace(/\.typ$/, ""), path: path.join(chaptersDir, f) }));
  const targets = allFiles.filter((t) => !only || only.has(t.slug));
  if (targets.length === 0) {
    console.error("错误：--only 过滤后没有目标章节");
    process.exit(2);
  }

  // ---------- 0. 配置 + 章号映射 + 跨章 label 索引 ----------
  const { config, configSource, manifest } = await loadProjectContext();
  const ordinals = buildOrdinals(allFiles, manifest);
  console.log(`config: ${configSource || "(assets 默认配置未找到，按内置默认)"}\n`);

  // ---------- 0.1 ilm 模板硬闸门 + 自动重新补充 ----------
  const mainPath = path.join(PROJECT, "main.typ");
  let mainTyp;
  try {
    mainTyp = await fs.readFile(mainPath, "utf8");
  } catch {
    mainTyp = "";
  }
  if (!hasIlmTemplate(mainTyp)) {
    if (!OPT_FIX) {
      console.error(
        "错误：typst/main.typ 未检测到 ilm 模板。必须包含 `@preview/ilm:<version>` 导入和 `#show: ilm.with(...)`。\n" +
        "请运行 `node scripts/typst-check.mjs --project typst --fix` 自动重新补充。"
      );
      process.exit(1);
    }
    console.log("━━━ 重新补充 ilm 模板 ━━━");
    try {
      mainTyp = await restoreIlmTemplate(mainTyp, manifest);
      console.log("  ✓ 已依据 lmdx2typst.mjs 重新生成 main.typ（ilm）\n");
    } catch (err) {
      console.error(`错误：ilm 模板自动恢复失败：${err?.message || err}`);
      process.exit(1);
    }
  } else {
    console.log("ilm template: @preview/ilm + ilm.with ✓\n");
  }

  const buildLabelIndex = async () => {
    const idx = new Set();
    for (const t of allFiles) {
      try {
        const text = await fs.readFile(t.path, "utf8");
        for (const l of collectFigureLabels(text)) idx.add(l.label);
      } catch {}
    }
    return idx;
  };
  const lintTargets = async () => {
    const labelIndex = await buildLabelIndex();
    let all = [];
    const per = new Map();
    for (const t of targets) {
      const text = await fs.readFile(t.path, "utf8");
      const issues = await lintText(text, {
        fileName: t.slug,
        projectDir: PROJECT,
        config,
        labelIndex,
        labelIndexComplete: true,
        chapterNumbers: new Set(ordinals.values()),
      });
      per.set(t.slug, issues);
      all = all.concat(issues);
    }
    return { all, per };
  };

  // ---------- 1. lint ----------
  let { all: allIssues, per: fileIssues } = await lintTargets();

  // ---------- 2. fix（固化规则 + 确定性优化器） ----------
  if (OPT_FIX) {
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

    // 确定性优化器（P0-1 标题编号剥离 / P0-2 figure label 注入 + 引用转换 /
    //              P0 长表格 breakable / P0 callout 颜色与标题修复）。
    // label 与引用是跨章全局语义：sweep 覆盖 chapters/ 全部章节（不受 --only 影响），报告只看 targets。
    console.log("━━━ 确定性优化器（标题编号 / figure label / 引用转换 / 长表格 / callout） ━━━\n");
    const texts = new Map();
    for (const t of allFiles) texts.set(t.slug, await fs.readFile(t.path, "utf8"));
    const totals = {
      headingsStripped: 0, labelsInjected: 0, captionsStripped: 0, refsConverted: 0,
      tablesBreakable: 0, calloutFixes: 0, headingsLabelled: 0, chapterRefsConverted: 0,
    };
    const labelIndex = new Set();
    // sweep 1：剥离标题手动编号 + 注入 figure label + 剥离 caption 自身编号前缀
    //          + 注入标题 label（ch-<slug> / sec-<slug>-<seq>）
    //          + 长表格注入 breakable + callout 颜色/标题修复
    for (const t of allFiles) {
      const r = optimizeChapter(texts.get(t.slug), {
        chapterNumber: ordinals.get(t.slug) ?? null,
        config,
        fileSlug: t.slug,
      });
      texts.set(t.slug, r.text);
      for (const l of r.labels) labelIndex.add(l.label);
      totals.headingsStripped += r.changes.headingsStripped;
      totals.labelsInjected += r.changes.labelsInjected;
      totals.captionsStripped += r.changes.captionsStripped;
      totals.tablesBreakable += r.changes.tablesBreakable;
      totals.calloutFixes += r.changes.calloutColorsFixed + r.changes.calloutTitlesInserted;
      totals.headingsLabelled += r.changes.headingsLabelled;
    }
    // sweep 2：正文「图 C-S / 表 C-S」纯文本引用 -> @label（仅 label 存在时）
    for (const t of allFiles) {
      const r = convertFigureRefs(texts.get(t.slug), { labelIndex, config });
      texts.set(t.slug, r.text);
      totals.refsConverted += r.converted.length;
    }
    // sweep 3：正文「第 N 章」纯文本引用 -> @ch-<slug>（章号 -> 一级标题 label 映射）
    const numToLabel = new Map();
    for (const t of allFiles) {
      const n = ordinals.get(t.slug);
      if (n != null) numToLabel.set(n, `ch-${t.slug}`);
    }
    for (const t of allFiles) {
      const r = convertChapterRefs(texts.get(t.slug), { numToLabel });
      texts.set(t.slug, r.text);
      totals.chapterRefsConverted += r.converted.length;
    }
    // 写回（内容有变化才写，保证幂等）
    for (const t of allFiles) {
      const cur = await fs.readFile(t.path, "utf8");
      if (texts.get(t.slug) !== cur) {
        await fs.writeFile(t.path, texts.get(t.slug), "utf8");
        console.log(`  [optimized] ${t.slug}`);
      }
    }
    console.log(
      `  剥离手动编号标题 ${totals.headingsStripped} 个；注入 figure label ${totals.labelsInjected} 个；` +
        `剥离 caption 前缀 ${totals.captionsStripped} 处；转换纯文本引用 ${totals.refsConverted} 处；` +
        `长表格注入 breakable ${totals.tablesBreakable} 个；callout 修复 ${totals.calloutFixes} 处；` +
        `注入标题 label ${totals.headingsLabelled} 个；章节引用转 @ch ${totals.chapterRefsConverted} 处\n`
    );

    // 修复后重新 lint，剩余问题进入报告
    ({ all: allIssues, per: fileIssues } = await lintTargets());
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
    const preamble = extractPreamble(mainTyp);
    // 各章全量 label 集合：用于过滤 probe 单章编译的跨章引用误报
    const labelSets = new Map();
    for (const t of allFiles) {
      try {
        labelSets.set(t.slug, collectAllLabels(await fs.readFile(t.path, "utf8")));
      } catch {}
    }
    const results = await compileCheck(typst, chaptersDir, preamble, targets, labelSets);
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
