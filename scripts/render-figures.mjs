#!/usr/bin/env node
/**
 * scripts/render-figures.mjs
 *
 * 把 MDX 里的图位注解（<!-- FIGURE: fig-NN-M | ... -->）与可渲染源对齐：
 *   1. 图源优先 mdx/public/diagrams-src/<id>.html，调用 assets/diagram-style/export_svg.py 导出；
 *   2. 已有 mdx/public/figures/<id>.svg|png 时直接复用；
 *   3. 校验正文确实引用了该图片；
 *   4. 每章至少 2 张图（条件触发的下限）。
 *
 * 用法：
 *   node scripts/render-figures.mjs                 # 报告写 metadata/figure-report.txt
 *   node scripts/render-figures.mjs --root=<book>   # 指定书目录（只认等号写法）
 *   node scripts/render-figures.mjs --strict        # 有 ERROR 时退出码 1
 *   node scripts/render-figures.mjs --no-render     # 只检查，不调用 Python
 */

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoot } from "./lib/cli-args.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");
const EXPORT_SVG = path.join(SKILL_ROOT, "assets", "diagram-style", "export_svg.py");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const ROOT = path.resolve(resolveRoot(argv, "render-figures.mjs") ?? process.cwd());
const MDX_DIR = path.resolve(ROOT, opt("mdx", "mdx"));
const FIG_DIR = path.resolve(ROOT, "mdx", "public", "figures");
const SRC_DIR = path.resolve(ROOT, "mdx", "public", "diagrams-src");
const OUT_FILE = path.resolve(ROOT, opt("out", "metadata/figure-report.txt"));
const STRICT = flag("strict");
const NO_RENDER = flag("no-render");
const MIN_PER_CHAPTER = 2;

const FIGURE_RE = /^\s*<!--\s*FIGURE\s*:\s*(fig-\d{2}-\d+)\s*\|/;
const IMG_REF_RE = (id) => new RegExp(`!\\[[^\\]]*\\]\\([^)]*${id}\\.(?:svg|png)\\)`);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function pythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

const files = (await fs.readdir(MDX_DIR).catch(() => [])).filter((f) => f.endsWith(".mdx")).sort();
if (files.length === 0) {
  console.error(`没有找到 .mdx：${MDX_DIR}`);
  process.exit(2);
}

const issues = [];
const rows = [];
let renderedCount = 0;

for (const file of files) {
  const raw = await fs.readFile(path.join(MDX_DIR, file), "utf8");
  const lines = raw.split("\n");
  const ids = [];

  lines.forEach((line, idx) => {
    const m = line.match(FIGURE_RE);
    if (!m) return;
    const id = m[1];
    ids.push(id);

    if (!IMG_REF_RE(id).test(raw)) {
      issues.push({ level: "ERROR", file, id, msg: `正文没有引用 /figures/${id}.svg（注解后应紧跟图片）` });
    }
  });

  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of new Set(dup)) {
    issues.push({ level: "ERROR", file, id, msg: `图位 ${id} 重复` });
  }

  if (ids.length < MIN_PER_CHAPTER) {
    issues.push({
      level: "ERROR",
      file,
      id: "-",
      msg: `图数 ${ids.length} 少于每章下限 ${MIN_PER_CHAPTER}`,
    });
  }

  let rendered = 0;
  for (const id of ids) {
    const svg = path.join(FIG_DIR, `${id}.svg`);
    const png = path.join(FIG_DIR, `${id}.png`);
    const html = path.join(SRC_DIR, `${id}.html`);

    let ok = (await exists(svg)) || (await exists(png));
    if (!ok && !NO_RENDER && (await exists(html))) {
      if (!(await exists(EXPORT_SVG))) {
        issues.push({ level: "ERROR", file, id, msg: `缺少导出脚本 ${EXPORT_SVG}` });
      } else {
        try {
          execFileSync(pythonCommand(), [EXPORT_SVG, html, svg, "--system-fonts"], {
            stdio: "pipe",
          });
          renderedCount++;
          rendered++;
          ok = await exists(svg);
        } catch (e) {
          issues.push({
            level: "ERROR",
            file,
            id,
            msg: `导出失败：${String(e.stderr || e.message).trim().slice(0, 200)}`,
          });
        }
      }
    }
    if (!ok) {
      const hint = (await exists(html)) ? "存在 HTML 源但导出未成功" : "缺少 HTML 源与 SVG/PNG";
      issues.push({ level: "ERROR", file, id, msg: `图文件缺失：${hint}` });
    }
  }

  rows.push({ file, count: ids.length, rendered, ids });
}

const out = [];
out.push("# 图位与图源检查");
out.push("");
out.push(`生成时间: ${new Date().toISOString()}`);
out.push(`图源目录: ${path.relative(ROOT, SRC_DIR)}`);
out.push(`产物目录: ${path.relative(ROOT, FIG_DIR)}`);
out.push("");
out.push("| 章文件 | 图数 | 本次导出 | 图位 |");
out.push("|---|---|---|---|");
for (const r of rows) {
  out.push(`| ${r.file} | ${r.count} | ${r.rendered} | ${r.ids.join(" / ") || "-"} |`);
}
out.push("");
out.push(`本次导出 ${renderedCount} 张；问题 ${issues.length} 条。`);
out.push("");

if (issues.length) {
  out.push("## 问题");
  out.push("");
  for (const i of issues) out.push(`- [${i.level}] ${i.file} ${i.id}：${i.msg}`);
  out.push("");
} else {
  out.push("## 问题");
  out.push("");
  out.push("无。");
  out.push("");
}

await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, out.join("\n"), "utf8");
console.log(out.join("\n"));
console.log(`\n报告已写入 ${OUT_FILE}`);

const errorCount = issues.filter((i) => i.level === "ERROR").length;
if (STRICT && errorCount > 0) process.exit(1);
