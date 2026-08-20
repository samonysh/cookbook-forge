#!/usr/bin/env node
// typst-fonts-check.mjs
//
// P1-4 字体可用性预检：读取 Typst 流水线配置里的 `fonts` 栈（正文 + 代码），
// 运行 `typst fonts` 列出本机已安装/可用的字体族，逐项比对并报告缺失。
// 在艰难调试环境（字体缺失导致中文豆腐块 / 编译警告）装书前先跑一次，成本极低。
//
// 用法：
//   node scripts/typst-fonts-check.mjs                 # 用 assets/typst-default.config.json
//   node scripts/typst-fonts-check.mjs --config my.json
//   node scripts/typst-fonts-check.mjs --config my.json --typst C:\path\to\typst.exe
//   node scripts/typst-fonts-check.mjs --json          # 结构化输出（供脚本消费）
//
// 退出码：0 = 栈无缺失；1 = 存在缺失（正文/代码任一）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

// ---------- 配置解析（--config > 工作目录 typst.config.json > assets 默认） ----------
function loadConfig() {
  const explicit = getArg("config", null);
  const cwd = process.cwd();
  const candidates = [explicit, path.join(cwd, "typst.config.json"), path.join(SKILL_ROOT, "assets", "typst-default.config.json")];
  for (const c of candidates) {
    if (c && existsSync(c)) return JSON.parse(readFileSync(c, "utf8"));
  }
  return { fonts: {} };
}

// ---------- typst 二进制探测（与 typst-check.mjs 相同策略的轻量版） ----------
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
    candidates.push("/usr/local/bin/typst", "/opt/homebrew/bin/typst", path.join(os.homedir(), ".cargo", "bin", "typst"));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["typst"], { encoding: "utf8" });
    const first = out.split(/\r?\n/)[0].trim();
    if (first && existsSync(first)) return first;
  } catch {}
  return null;
}

/** 从 `typst fonts` 输出解析可用字体族名（每行去括号路径后的部分）。 */
function parseFontFamilies(raw) {
  const fam = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("Language") && line.includes(":")) continue;
    // fam 名在行首，可选跟 (路径)；也可能整行就是 fam 名
    const name = line.split("(")[0].trim();
    if (name && !/^[a-z]+:/i.test(name)) fam.add(name);
  }
  return fam;
}

/** 宽松匹配：配置字体 c 是否命中已装字体（容忍空格差异 / 子族名 _SC/_Mono 变体）。 */
function isAvailable(c, families) {
  const compact = c.replace(/\s+/g, "").toLowerCase();
  if (!compact) return true; // 空忽略
  for (const f of families) {
    if (f === c) return true;
    if (compact === f.replace(/\s+/g, "").toLowerCase()) return true;
  }
  // 宽松包含：已装字体名包含配置名（覆盖 "LXGW WenKai SC" -> "LXGW WenKai"）
  for (const f of families) {
    if (f.replace(/\s+/g, "").toLowerCase().includes(compact) || compact.includes(f.replace(/\s+/g, "").toLowerCase())) return true;
  }
  return false;
}

function main() {
  const config = loadConfig();
  const fonts = config.fonts || {};
  const textStack = fonts.text || [];
  const codeStack = fonts.code || [];

  const typst = findTypst(getArg("typst", null));
  if (!typst) {
    console.error("未找到 typst 二进制：请安装或 --typst <path>");
    process.exit(2);
  }

  const out = execFileSync(typst, ["fonts"], { encoding: "utf8" });
  const families = parseFontFamilies(out);

  const report = { text: [], code: [] };
  for (const c of textStack) {
    if (c === "serif" || c === "monospace" || c === "sans") continue; // 通用回退名
    report.text.push({ font: c, available: isAvailable(c, families) });
  }
  for (const c of codeStack) {
    if (c === "serif" || c === "monospace" || c === "sans") continue;
    report.code.push({ font: c, available: isAvailable(c, families) });
  }

  const missing =
    [...report.text, ...report.code].filter((r) => !r.available).length;

  if (hasFlag("json")) {
    console.log(JSON.stringify({ typst, families: [...families], report, missing }, null, 2));
  } else {
    console.log(`typst: ${typst}\n`);
    console.log("正文字体栈：");
    for (const r of report.text) console.log(`  ${r.available ? "✓" : "✗"} ${r.font}`);
    console.log("代码字体栈：");
    for (const r of report.code) console.log(`  ${r.available ? "✓" : "✗"} ${r.font}`);
    if (missing === 0) {
      console.log("\n✓ 字体栈全部可用");
    } else {
      console.log(`\n✗ ${missing} 个配置字体未安装：编译时走 fallback（可能中文豆腐块 / 样式不符）。`);
      console.log('  安装建议：引用回退栈中已打 ✓ 的字体，或在系统安装缺失字体。');
      process.exitCode = 1;
    }
  }
}

main();