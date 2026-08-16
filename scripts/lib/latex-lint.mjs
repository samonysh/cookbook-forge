// scripts/lib/latex-lint.mjs
//
// LaTeX（ElegantBook）章节静态检查（lint）与少量安全修复（fix）共享库。
// 与 typst-lint.mjs 同一设计纪律，适配 lmdx2tex.mjs 产出的目录结构
// （latex/{main.tex, chapters/*.tex, figures/}）：
//   - 检查跳过注释行（%）与 verbatim 类环境（lstlisting/verbatim/minted）内部；
//   - lint 与 fix 共用同一套行掩码，保证"报的问题"与"修的问题"一致；
//   - fix 只做语义安全的确定性转换（Markdown 粗体/链接残留 -> LaTeX 命令），
//     其余错误交给 agent 对照 MDX 原文修（check <--> fix 循环由 latex-check.mjs 编排）。

import { existsSync } from "node:fs";
import path from "node:path";

const VERB_ENV_RE = /\\(begin|end)\{(lstlisting|verbatim|Verbatim|minted|alltt)\}/;
const COMMENT_RE = /^\s*%/;

// ---------- verbatim 环境掩码 ----------

/**
 * 计算 verbatim 掩码：mask[i] === true 表示第 i 行在 verbatim 类环境内部
 * （\begin{lstlisting} 与 \end{lstlisting} 行本身不掩码，以便环境配对检查）。
 * @param {string[]} lines
 * @returns {boolean[]}
 */
export function computeVerbatimMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inVerb = false;
  let openEnv = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(VERB_ENV_RE);
    if (m) {
      if (m[1] === "begin") {
        inVerb = true;
        openEnv = m[2];
        mask[i] = false; // begin 行本身是真实 LaTeX
        continue;
      }
      if (m[1] === "end" && (!openEnv || m[2] === openEnv)) {
        inVerb = false;
        openEnv = null;
        mask[i] = false; // end 行本身是真实 LaTeX
        continue;
      }
    }
    mask[i] = inVerb;
  }
  return mask;
}

// ---------- lint ----------

/**
 * 静态检查 LaTeX 章节文本，返回问题列表。
 * @param {string} text 章节 .tex 原文
 * @param {{ fileName?: string, projectDir?: string|null }} opts
 *     projectDir 提供时启用 \includegraphics 图片存在性检查（latex/ 根目录）
 * @returns {{ line: number, severity: "error"|"warn", rule: string, message: string, fixable: boolean }[]}
 */
export function lintText(text, opts = {}) {
  const { fileName = "", projectDir = null } = opts;
  const issues = [];
  const push = (line, severity, rule, message, fixable = false) =>
    issues.push({ file: fileName, line, severity, rule, message, fixable });

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const mask = computeVerbatimMask(lines);

  // A. 占位符 / 章首命令
  lines.forEach((l, i) => {
    if (l.includes("LLM_CONVERSION_PENDING")) {
      push(i + 1, "error", "placeholder", "占位符未替换：本章尚未完成 LLM 转换");
    }
  });
  const firstMeaningful = lines.findIndex((l) => l.trim() !== "" && !COMMENT_RE.test(l));
  if (firstMeaningful === -1 || !/^\\chapter\*?\s*\{/.test(lines[firstMeaningful].trim())) {
    push(Math.max(firstMeaningful, 0) + 1, "error", "chapter-command",
      "章节首行必须是 \\chapter{...} 或 \\chapter*{...}");
  }

  // B. Markdown / JSX / HTML 残留（跳过注释与 verbatim）
  lines.forEach((l, i) => {
    if (mask[i] || COMMENT_RE.test(l)) return;

    if (/^#{1,6}\s+\S/.test(l)) {
      push(i + 1, "error", "md-heading", "Markdown 标题 # 残留：应转为 \\chapter/\\section/\\subsection");
    }
    if (/\*\*[^*\n]+\*\*/.test(l)) {
      push(i + 1, "error", "md-bold", "Markdown 粗体 ** 残留：应转为 \\textbf{...}", true);
    }
    if (/^\s*\|[-\s:|]+\|\s*$/.test(l)) {
      push(i + 1, "error", "md-table", "Markdown 表格残留：应转为 booktabs 表格环境");
    }
    const mdImg = l.match(/!\[([^\]\n]*)\]\(([^)\n]+)\)/);
    if (mdImg) {
      push(i + 1, "error", "md-image",
        `Markdown 图片 ![...](${mdImg[2]}) 残留：应转为 \\begin{figure}\\includegraphics{...}`);
    }
    const mdLink = l.match(/\[([^\]\n]*)\]\((https?:\/\/[^)\n]+)\)/);
    if (mdLink) {
      push(i + 1, "error", "md-link",
        `Markdown 链接残留：应转为 \\href{${mdLink[2]}}{${mdLink[1]}}`, true);
    }
    if (/className=/.test(l)) {
      push(i + 1, "error", "jsx-residue", "JSX className 残留：LaTeX 中不存在 HTML/JSX 语法");
    }
    if (/<br\s*\/?>/i.test(l)) {
      push(i + 1, "error", "html-residue", "HTML <br> 残留：换行应使用 \\\\");
    }
  });

  // C. 环境配对（\begin{X} 与 \end{X} 数量一致）
  const envCount = new Map();
  lines.forEach((l) => {
    for (const m of l.matchAll(/\\(begin|end)\{([A-Za-z*]+)\}/g)) {
      const key = m[2];
      const delta = m[1] === "begin" ? 1 : -1;
      envCount.set(key, (envCount.get(key) || 0) + delta);
    }
  });
  for (const [env, n] of envCount) {
    if (n !== 0) {
      push(0, "error", "env-unbalanced",
        `环境 \\begin{${env}} 与 \\end{${env}} 数量不匹配（差 ${n}）`);
    }
  }

  // D. 花括号配对启发式（剔除注释与 verbatim、忽略 \{ \} 转义）
  let braces = 0;
  lines.forEach((l, i) => {
    if (mask[i]) return;
    const noComment = l.replace(/(^|[^\\])%.*/, "$1").replace(/\\[{}]/g, "");
    braces += (noComment.match(/\{/g) || []).length - (noComment.match(/\}/g) || []).length;
  });
  if (braces !== 0) {
    push(0, "warn", "brace-unbalanced",
      `花括号不配对（差 ${braces}）：可能是 LLM 输出被截断`);
  }

  // E. \includegraphics 图片存在性（相对 latex/ 根目录 + graphicspath figures/）
  if (projectDir) {
    const EXTS = ["", ".pdf", ".png", ".jpg", ".jpeg"];
    for (const m of normalized.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      const line = (normalized.slice(0, m.index).match(/\n/g) || []).length + 1;
      const name = m[1].trim();
      const candidates = [];
      for (const base of [projectDir, path.join(projectDir, "figures"), path.join(projectDir, "chapters")]) {
        for (const ext of EXTS) candidates.push(path.join(base, name + ext));
      }
      if (!candidates.some((c) => existsSync(c))) {
        const isSvg = /\.svg$/i.test(name);
        push(line, "error", "figure-missing",
          `图片不存在：${name}` + (isSvg ? "（xelatex 不支持 SVG，需先转为 PDF/PNG）" : ""));
      }
    }
  }

  return issues;
}

// ---------- fix（仅确定性安全转换） ----------

/**
 * 应用安全修复：Markdown 粗体/链接残留 -> LaTeX 命令（跳过注释与 verbatim）。
 * @param {string} text
 * @returns {{ text: string, hits: Record<string, number> }}
 */
export function fixText(text) {
  const hits = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const mask = computeVerbatimMask(lines);
  const out = lines.map((l, i) => {
    if (mask[i] || COMMENT_RE.test(l)) return l;
    let n = 0;
    l = l.replace(/\*\*([^*\n]+)\*\*/g, (m, t) => {
      n++;
      return `\\textbf{${t}}`;
    });
    if (n) hits["**x** -> \\textbf{x}"] = (hits["**x** -> \\textbf{x}"] || 0) + n;
    n = 0;
    l = l.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\n]+)\)/g, (m, t, url) => {
      n++;
      return `\\href{${url}}{${t}}`;
    });
    if (n) hits["[x](url) -> \\href{url}{x}"] = (hits["[x](url) -> \\href{url}{x}"] || 0) + n;
    return l;
  });
  return { text: out.join("\n"), hits };
}
