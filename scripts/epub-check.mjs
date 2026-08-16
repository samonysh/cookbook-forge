#!/usr/bin/env node
// epub-check.mjs
//
// EPUB3 工程质量检查 CLI：静态 lint + 每章 XML 良构校验 + 打包结构检查。
// 与 typst-check.mjs / latex-check.mjs 同一模式：以章节为单位并行暴露全部问题。
// 对 EPUB 而言，"编译检查"的等价物是：
//   1) 每章 XHTML 的 XML 良构性（阅读器打不开的硬闸门）；
//   2) content.opf manifest/spine 完整性（资源未登记 / 引用缺失）；
//   3) book.epub 的 zip 合规（mimetype 第一且 STORED）。
//
// 用法：
//   node scripts/epub-check.mjs --project epub        # lint + 章节校验 + 包结构检查
//   node scripts/epub-check.mjs --project epub --fix  # + 安全规则自动修复
//   可选：--only ch01,ch02
//
// 产出：
//   epub/_lint_report.json    lint 问题清单
//   epub/_check_report.json   校验结果 {"passed": [...], "failed": {...}, "package": [...]}
//
// 退出码：0 = 全部通过；1 = 存在 error；2 = 环境错误。

import { promises as fs } from "node:fs";
import path from "node:path";
import { lintXhtml, fixXhtml, checkXmlWellFormed } from "./lib/epub-lint.mjs";

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

const PROJECT = path.resolve(getArg("project", "epub"));
const OPT_FIX = hasFlag("fix");
const ONLY = getArg("only", null);

const BUILD_DIR = path.join(PROJECT, "build");
const OEBPS = path.join(BUILD_DIR, "OEBPS");
const TEXT_DIR = path.join(OEBPS, "Text");

// ---------- 主流程 ----------

async function main() {
  console.log(`=== EPUB 章节检查（lint${OPT_FIX ? " + fix" : ""} + 包结构）===\n`);
  console.log(`project: ${PROJECT}\n`);

  let files;
  try {
    files = (await fs.readdir(TEXT_DIR)).filter((f) => f.endsWith(".xhtml") && !f.startsWith("._prompt_") && !f.startsWith("."));
  } catch {
    console.error(`错误：${TEXT_DIR} 不存在（请先运行 lbuild-epub.mjs）`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error("错误：OEBPS/Text/ 下没有 .xhtml 章节文件");
    process.exit(2);
  }

  const only = ONLY ? new Set(ONLY.split(",").map((s) => s.trim().replace(/\.xhtml$/, ""))) : null;
  const targets = files
    .sort()
    .map((f) => ({ slug: f.replace(/\.xhtml$/, ""), path: path.join(TEXT_DIR, f) }))
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
    const issues = lintXhtml(text, { fileName: t.slug, oebpsDir: OEBPS });
    fileIssues.set(t.slug, issues);
    allIssues = allIssues.concat(issues);
  }

  // ---------- 2. fix ----------
  if (OPT_FIX && allIssues.some((i) => i.fixable)) {
    console.log("━━━ 应用安全规则修复 ━━━\n");
    const hitsTotal = {};
    for (const t of targets) {
      const text = await fs.readFile(t.path, "utf8");
      const { text: fixed, hits } = fixXhtml(text);
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
      const issues = lintXhtml(text, { fileName: t.slug, oebpsDir: OEBPS });
      fileIssues.set(t.slug, issues);
      allIssues = allIssues.concat(issues);
    }
  }

  // ---------- 3. 报告 lint（XML 良构失败即该章 FAIL） ----------
  const lintReport = {};
  for (const t of targets) {
    const issues = fileIssues.get(t.slug) || [];
    if (issues.length) lintReport[t.slug] = issues;
  }
  const nErr = allIssues.filter((i) => i.severity === "error").length;
  const nWarn = allIssues.filter((i) => i.severity === "warn").length;
  console.log("━━━ 静态检查结果（含 XML 良构） ━━━");
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

  // ---------- 4. 包结构检查（manifest / spine / nav / zip） ----------
  const passed = targets.filter((t) => !(fileIssues.get(t.slug) || []).some((i) => i.severity === "error")).map((t) => t.slug);
  const failed = {};
  for (const t of targets) {
    const errs = (fileIssues.get(t.slug) || []).filter((i) => i.severity === "error");
    if (errs.length) failed[t.slug] = errs.map((e) => ({ line: e.line, message: e.message }));
  }
  const pkgIssues = await checkPackage();

  console.log("━━━ 包结构检查 ━━━");
  if (pkgIssues.length === 0) {
    console.log("  [pass] manifest / spine / nav / mimetype 全部合规");
  } else {
    for (const i of pkgIssues) console.log(`  ${i.severity === "error" ? "✗" : "⚠"} [${i.rule}] ${i.message}`);
  }
  const nPkgErr = pkgIssues.filter((i) => i.severity === "error").length;
  console.log("");

  const report = { passed: passed.sort(), failed, package: pkgIssues };
  await fs.writeFile(path.join(PROJECT, "_check_report.json"), JSON.stringify(report, null, 1), "utf8");
  console.log(`检查：${passed.length}/${targets.length} 章通过；包结构 ${nPkgErr} error -> _check_report.json`);

  if (Object.keys(failed).length === 0 && nPkgErr === 0 && nErr === 0) {
    console.log("\n✓ 全部通过");
    process.exit(0);
  } else {
    console.log(`\n✗ 需要修复：${[...Object.keys(failed)].join(", ")}${nPkgErr ? "（含包结构）" : ""}`);
    console.log("\n修复建议：");
    console.log("  1. 可自动修复的已由 --fix 处理（className/class、裸 &、Markdown 粗体）；");
    console.log("  2. 剩余问题读 _lint_report.json，按章对照 MDX 原文交给 agent 修；");
    console.log("  3. 修后复查：node scripts/epub-check.mjs --project epub --only <slug>");
    console.log("  4. check <--> fix 循环不超过 3 轮；全部通过后重跑 node lbuild-epub.mjs 重新打包。");
    process.exit(1);
  }
}

// ---------- 包结构检查 ----------

async function checkPackage() {
  const issues = [];
  const push = (severity, rule, message) => issues.push({ severity, rule, message });

  // content.opf
  let opf = null;
  try {
    opf = await fs.readFile(path.join(OEBPS, "content.opf"), "utf8");
  } catch {
    push("error", "opf-missing", "content.opf 不存在（请运行 lbuild-epub.mjs 生成）");
    return issues;
  }
  const opfWf = checkXmlWellFormed(opf);
  for (const e of opfWf.errors) push("error", "opf-xml", `content.opf 第 ${e.line} 行：${e.message}`);

  // manifest 完整性
  const manifestIds = new Map(); // id -> href
  for (const m of opf.matchAll(/<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/g)) {
    manifestIds.set(m[1], m[2]);
  }
  if (manifestIds.size === 0) push("error", "opf-manifest-empty", "content.opf manifest 为空或格式异常");
  for (const [id, href] of manifestIds) {
    const local = path.join(OEBPS, href);
    try {
      await fs.access(local);
    } catch {
      push("error", "manifest-broken", "manifest 项 " + id + " -> " + href + " 在 OEBPS/ 下不存在");
    }
  }

  // OEBPS 下的实际文件是否都登记（nav.xhtml / css / 图片 / 章节）
  const skipDirs = new Set(["META-INF"]);
  async function walk(dir, relPrefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("._prompt_")) continue;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), rel);
      } else {
        if (skipDirs.has(relPrefix)) continue;
        if (rel === "content.opf") continue;
        const registered = [...manifestIds.values()].some((h) => h === rel);
        if (!registered) push("error", "file-not-in-manifest", `文件未登记进 manifest：${rel}（阅读器可能不显示）`);
      }
    }
  }
  await walk(OEBPS, "");

  // spine 完整性
  const spineRefs = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((m) => m[1]);
  if (spineRefs.length === 0) push("error", "spine-empty", "spine 为空：阅读器无法翻页");
  for (const idref of spineRefs) {
    if (!manifestIds.has(idref)) push("error", "spine-broken", `spine 引用 ${idref} 不在 manifest 中`);
  }

  // nav.xhtml
  try {
    const nav = await fs.readFile(path.join(OEBPS, "nav.xhtml"), "utf8");
    if (!/epub:type="toc"/.test(nav)) push("warn", "nav-toc", "nav.xhtml 缺少 epub:type=\"toc\" 导航元素");
  } catch {
    push("error", "nav-missing", "nav.xhtml 不存在（EPUB3 必需）");
  }

  // container.xml
  try {
    await fs.access(path.join(BUILD_DIR, "META-INF", "container.xml"));
  } catch {
    push("error", "container-missing", "META-INF/container.xml 不存在");
  }

  // book.epub zip 合规（mimetype 第一且 STORED）—— 读原始字节，不依赖解压库
  const epubPath = path.join(PROJECT, "book.epub");
  try {
    await fs.access(epubPath);
    const fh = await fs.open(epubPath, "r");
    try {
      const buf = Buffer.alloc(64);
      await fh.read(buf, 0, 64, 0);
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
        push("error", "zip-magic", "book.epub 不是有效 zip（PK 头缺失）");
      } else {
        const nameLen = buf.readUInt16LE(26);
        const method = buf.readUInt16LE(8);
        const name = buf.subarray(30, 30 + Math.min(nameLen, 34)).toString("latin1");
        if (name !== "mimetype") {
          push("error", "zip-mimetype-first", `zip 第一项是 "${name}"，必须是 mimetype（EPUB 规范）`);
        }
        if (method !== 0) {
          push("error", "zip-mimetype-stored", "mimetype 必须以 STORED（未压缩）方式存储");
        }
        const contentBuf = Buffer.alloc(20);
        await fh.read(contentBuf, 0, 20, 30 + nameLen);
        if (contentBuf.toString("latin1") !== "application/epub+zip") {
          push("error", "zip-mimetype-content", "mimetype 内容不是 application/epub+zip");
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    push("warn", "epub-missing", "book.epub 尚未打包（先完成全部章节转换后运行 lbuild-epub.mjs）");
  }

  return issues;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
