#!/usr/bin/env node
/**
 * scripts/chapter-lint.mjs
 *
 * 章节结构 lint：验证等级标记、图位标注、frontmatter figures 一致性、逐块实测记录。
 * 与方法论文档 6.7.1 / 8.5.1 / 8.8 配套。
 *
 * 用法：
 *   node scripts/chapter-lint.mjs                 # 报告写 metadata/chapter-lint.txt
 *   node scripts/chapter-lint.mjs --strict        # 有 ERROR 时退出码 1
 *   node scripts/chapter-lint.mjs --root=<book>   # 指定书目录（默认 cwd）
 *
 * 检查项：
 *   V1 每个 ```python 代码块前 3 行内必须有 `<!-- verify: L1|L2|L3 -->`
 *   V2 每个图位注释必须符合 `<!-- FIGURE: fig-NN-M | type | 内容 | 依据 ... -->`
 *      - id 形如 fig-09-2；type 在词表内；紧接 4 行内出现 `**图 N-M**` 图题
 *   V3 frontmatter `figures` 与正文图位 id 集合一致，且无重复
 *   V4 `metadata/verify/chNN.txt` 存在，块数与 python 块数一致，等级逐一匹配
 *   V5 图号与正文出现顺序一致
 *   W1 小节首段是否空转开场（本节将介绍 / 众所周知 / 随着……发展）
 *   W2 小节首段是否先给定义/新术语、后给动机（--strict 下为 ERROR）
 *   W3 加粗术语与缩写（MCP / HITL / OTel）首次出现是否带白话解释或全称
 *   W4 段落是否有可识别的主题句（≥100 字段落，首句 ≤70 字且不以衔接词起头）
 *   W5 长句：单句 >120 字 WARN、>180 字 ERROR；≥5 逗号且 ≥100 字判「一逗到底」
 *   W6 小节首段是否以「这/该/此/其/它」开头且标题无先行词
 *
 * 可读性误报控制：
 *   - 只检查正文段落，跳过代码、表格、列表、引用、callout、公式、图题
 *   - 段落 <60 CJK 不查 W4；H3 首段 <60 CJK 不查 W2，其余 H3 不因父 H2 有动机而豁免
 *   - 缩写跳过行内代码、通用缩写白名单与 L1/I3 这类等级编号
 *   - `<!-- lint-ignore: W2 -->` 可豁免下一个小节/段落，多个代码用逗号分隔
 *   - `--no-readability` 整体关闭 W1–W6（历史书稿迁移用）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./lib/mdx-utils.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROOT = path.resolve(opt("root", process.cwd()));
const MDX_DIR = path.resolve(ROOT, opt("mdx", "mdx"));
const VERIFY_DIR = path.resolve(ROOT, opt("verify-dir", "metadata/verify"));
const FIGURE_DIR = path.resolve(ROOT, "mdx", "public", "figures");
const OUT_FILE = path.resolve(ROOT, opt("out", "metadata/chapter-lint.txt"));
const STRICT = argv.includes("--strict");
const NO_READABILITY = argv.includes("--no-readability");

const FIGURE_TYPES = new Set([
  "architecture",
  "flowchart",
  "sequence",
  "state-machine",
  "decision-tree",
  "timeline",
  "matrix",
  "layered",
]);
const FIGURE_ID_RE = /^fig-(\d{2})-(\d+)$/;
const VERIFY_MARK_RE = /^\s*<!--\s*verify\s*:\s*(L[1-3])\s*(?:\|[^>]*)?-->\s*$/;
const VERIFY_ANY_RE = /<!--\s*verify\s*:\s*([^|>\s]+)/;
const FIGURE_RE = /^\s*<!--\s*FIGURE\s*:\s*(.*?)\s*-->\s*$/;
const CAPTION_RE = /^\s*\*\*图\s*(\d+)\s*[-–]\s*(\d+)\*\*/;
// 源码证据块：原理线摘录的源代码，不是可运行示例，不要求 verify 等级
const SOURCE_MARK_RE = /^\s*<!--\s*source\s*:\s*(.+?)\s*-->\s*$/;

function splitFrontmatter(raw) {
  const { body, fm } = parseFrontmatter(raw, "chapter.mdx");
  return { body, fm };
}

/** 收集围栏代码块信息：语言、起始行下标。 */
function collectFences(lines) {
  const fences = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^\s*```([A-Za-z0-9_-]*)/);
    if (open) {
      const lang = open[1].toLowerCase();
      const start = i;
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
      fences.push({ lang, start, end: i });
    }
    i++;
  }
  return fences;
}

function precedingNonEmpty(lines, idx, span = 3) {
  const found = [];
  for (let j = idx - 1; j >= 0 && j >= idx - span; j--) {
    if (lines[j].trim() === "") continue;
    found.push({ idx: j, text: lines[j] });
  }
  return found;
}

function chapterLabel(fm, fileName) {
  const n = Number(fm.chapter) || Number((fileName.match(/\d+/) || [0])[0]);
  return String(n).padStart(2, "0");
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readVerifyRecord(label) {
  const p = path.join(VERIFY_DIR, `ch${label}.txt`);
  try {
    const raw = await fs.readFile(p, "utf8");
    const blocks = [];
    const re = /^##\s*块\s*(\d+)\s*$/gm;
    const marks = [...raw.matchAll(re)];
    for (let k = 0; k < marks.length; k++) {
      const start = marks[k].index;
      const end = k + 1 < marks.length ? marks[k + 1].index : raw.length;
      const chunk = raw.slice(start, end);
      const level = chunk.match(/^verify:\s*(L[1-3])\s*$/m);
      const status = chunk.match(/^status:\s*(.+)$/m);
      blocks.push({
        index: Number(marks[k][1]),
        level: level ? level[1] : null,
        status: status ? status[1].trim() : null,
      });
    }
    return { exists: true, path: p, blocks };
  } catch {
    return { exists: false, path: p, blocks: [] };
  }
}

// ---------------- 可读性检查（W1–W6） ----------------

const MOTIVE_RE =
  /(问题|症状|失败|报错|错误|异常|超时|延迟|慢|贵|成本|风险|不一致|冲突|一旦|如果|当你|当.{0,14}时|否则|代价|误判|坑|陷阱|为了|需要|不能|必须|约束|边界|规则|为什么|怎样|如何|困扰|麻烦|痛点)/;
const DEFINITION_RE = /(是指|指的是|定义为|是一种|即为|被称为|称作)/;
const CONNECTIVE_RE = /^(因此|所以|但是|然而|此外|同时|另外|而且|并且|于是|这就|这意味着|这表明|这说明)/;
const GLOSS_RE =
  /(就是|即|指的是|是指|定义为|可以理解为|相当于|好比|通俗|简单说|也就是说|换句话说|（[^）]{1,30}）|\([^)]{1,40}\))/;
const GLOSS_AFTER_RE =
  /^\s*(?:（[^）]{1,30}）|\([^)]{1,40}\))?\s*(?:是|指|即|就是|指的是|定义为|可以理解为|相当于|好比)/;
// 功能式解释同样算白话锚点：「**模型抽象层**把统一的消息翻译成具体 Provider 的形状」。
const GLOSS_FUNC_RE = /^(?:[^。；]{0,8})?(?:负责|用于|用来|把[^。；]{0,40}(?:翻译|转换|封装|适配|映射|合并|拆|变成))/;
// 缩写检查：全大写（MCP、HITL）与「两个大写字母 + 小写」的驼峰缩写（OTel）。
const ABBREV_RES = [/\b[A-Z][A-Z0-9]{1,5}\b/g, /\b[A-Z]{2}[a-z][A-Za-z0-9]{0,6}\b/g];
// 通用缩写与 HTTP 方法不要求解释：读者默认已知，解释反而占篇幅。
const ABBREV_ALLOW = new Set([
  "API", "CLI", "JSON", "JSONL", "HTTP", "HTTPS", "URL", "URI", "ID", "SDK", "AI", "LLM",
  "SQL", "YAML", "XML", "HTML", "CSS", "MDX", "PDF", "EPUB", "PNG", "SVG", "CSV", "TLS",
  "SSH", "CPU", "GPU", "RAM", "OS", "UI", "UX", "CI", "CD", "PR", "OK", "UTC", "ISO", "DB",
  "MQ", "TTL", "JWT", "ASGI", "WSGI", "ANSI", "SLA", "SLO", "GET", "POST", "PUT", "DELETE",
  "PATCH", "HEAD", "OPTIONS", "TODO", "FIXME", "UUID", "ASCII", "UTF", "NOTE", "WARNING",
  "IMPORTANT", "CAUTION",
]);

const EMPTY_OPENER_RES = [
  /^本节(?:将|主要|会|拟|先|只|中)/,
  /^本小节(?:将|主要|会|中)?/,
  /^接下来(?:我们)?(?:将|会|来|看)/,
  /^下面(?:我们)?(?:将|来|先)?(?:介绍|讨论|讲解|看看|来看|分析)/,
  /^众所周知/,
  /^随着.{0,30}(?:的)?(?:发展|普及|兴起|演进)/,
  /^在(?:本节|本章|本文)中/,
];

function cjkCount(s) {
  return (s.match(/[\u4e00-\u9fff]/g) || []).length;
}

function splitSentences(text) {
  return text
    .split(/(?<=[。！？；])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去掉 Markdown 链接/图片目标，保留可见文本，避免 URL 干扰长度统计。 */
function normalizeProse(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** 把章节正文切成「小节 → 段落」结构；代码、表格、列表、引用、callout、公式一律跳过。 */
function buildDocSections(lines) {
  const sections = [];
  let currentSection = null;
  let currentH2 = null;
  let currentTrack = null;
  let pendingTrack = null;
  let ignoreNext = new Set();
  let para = null;
  let inFence = false;
  let inMath = false;
  let divDepth = 0;

  const flush = () => {
    if (para && currentSection) currentSection.paragraphs.push(para);
    para = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (inFence) {
      if (/^```/.test(t)) inFence = false;
      continue;
    }
    if (/^```/.test(t)) {
      flush();
      inFence = true;
      continue;
    }
    if (t === "$$") {
      flush();
      inMath = !inMath;
      continue;
    }
    if (inMath) continue;

    if (divDepth > 0 || /^<div\b/i.test(t)) {
      flush();
      divDepth += (t.match(/<div\b/gi) || []).length;
      divDepth -= (t.match(/<\/div>/gi) || []).length;
      if (divDepth < 0) divDepth = 0;
      continue;
    }

    if (/^<!--/.test(t)) {
      flush();
      let j = i;
      let text = t;
      while (!text.includes("-->") && j + 1 < lines.length) {
        j++;
        text += " " + lines[j].trim();
      }
      const tr = text.match(/track\s*:\s*(app|principle|synthesis|meta)/i);
      if (tr) pendingTrack = tr[1].toLowerCase();
      const ig = text.match(/lint-ignore\s*:\s*([A-Za-z0-9,\s]+)/i);
      if (ig) {
        for (const c of ig[1].split(/[,\s]+/)) if (/^W[1-6]$/.test(c)) ignoreNext.add(c);
      }
      i = j;
      continue;
    }

    if (/^#{2,3}\s+/.test(t)) {
      flush();
      const level = t.startsWith("### ") ? 3 : 2;
      const title = t.replace(/^#{2,3}\s+/, "").trim();
      if (level === 2) {
        currentTrack = pendingTrack || currentTrack;
        currentH2 = null;
      }
      const section = {
        level,
        title,
        track: pendingTrack || currentTrack || "unknown",
        lineNo: i + 1,
        paragraphs: [],
        ignore: new Set(ignoreNext),
        parent: level === 3 ? currentH2 : null,
        listFirst: false,
        tableFirst: false,
      };
      sections.push(section);
      currentSection = section;
      if (level === 2) currentH2 = section;
      pendingTrack = null;
      ignoreNext = new Set();
      continue;
    }

    if (t === "") {
      flush();
      continue;
    }

    if (
      /^\|/.test(t) ||
      /^!\[/.test(t) ||
      /^>/.test(t) ||
      /^<[a-zA-Z]/.test(t) ||
      /^(\s*)(?:[-*+]|\d+\.)\s+/.test(raw) ||
      /^\*\*图\s*\d/.test(t) ||
      /^\*[表图]\s*\d/.test(t)
    ) {
      if (/^(\s*)(?:[-*+]|\d+\.)\s+/.test(raw) && currentSection && currentSection.paragraphs.length === 0) {
        currentSection.listFirst = true;
      }
      if (/^\|/.test(t) && currentSection && currentSection.paragraphs.length === 0) {
        currentSection.tableFirst = true;
      }
      flush();
      continue;
    }

    if (!currentSection) continue;
    if (!para) para = { text: "", lineNo: i + 1, ignore: new Set(ignoreNext) };
    para.text += (para.text ? " " : "") + t;
    ignoreNext = new Set();
  }
  flush();

  for (const s of sections) {
    s.firstPara = s.paragraphs[0] || null;
    s.firstParaMotive = s.firstPara ? MOTIVE_RE.test(s.firstPara.text.slice(0, 240)) : false;
  }
  return sections;
}

function extractBacktickIdents(sentence) {
  return [...sentence.matchAll(/`([^`]{2,48})`/g)]
    .map((m) => m[1])
    .filter((x) => /[A-Za-z]/.test(x) && !/[/\\]/.test(x) && x.length >= 3);
}

/** 去掉行内代码，避免把 `output_type` 这类标识符当成缩写。 */
function stripInlineCode(text) {
  return text.replace(/`[^`]*`/g, " ");
}

/** 缩写是否已解释：全称括注、反向写法「全称（缩写）」、或紧跟白话锚点。 */
function abbrevGlossed(text, index, token) {
  const after = text.slice(index + token.length);
  if (/^\s*[（(][^）)]{2,80}[）)]/.test(after) && /[A-Za-z]{2,}/.test(after.slice(0, 82))) return true;
  if (GLOSS_RE.test(after.slice(0, 60))) return true;
  const before = text.slice(0, index);
  if (/[（(]\s*$/.test(before)) return true;
  if (/(全称|简称|即|也就是|又称)[^。；]{0,30}$/.test(before)) return true;
  return false;
}

function checkReadability(lines, label, add) {
  const sections = buildDocSections(lines);
  const seenTerms = new Set();
  const seenAbbrev = new Set();
  const headingText = sections.map((s) => s.title).join(" ");
  const bodyText = sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(" ");
  const occurrenceCount = (term) => bodyText.split(term).length - 1;

  for (const s of sections) {
    const isMeta = s.track === "meta" || /本章参考|本章地图|阅读路线/.test(s.title);
    const ignored = (code, para) =>
      s.ignore.has(code) || (para && para.ignore.has(code));

    // ---- W1 空转开场 ----
    const first = s.firstPara;
    if (!isMeta && first && !s.listFirst && !s.tableFirst && !ignored("W1", first)) {
      const head = first.text.slice(0, 40);
      if (EMPTY_OPENER_RES.some((re) => re.test(head))) {
        add(label, "WARN", "W1", `第 ${first.lineNo} 行小节「${s.title}」以空转开场开头（「${head.slice(0, 18)}…」），先写具体问题或场景`);
      }
    }

    // ---- W2 概念先行（--strict 下升为 ERROR） ----
    if (!isMeta && first && !s.listFirst && !s.tableFirst && !ignored("W2", first)) {
      const sentences = splitSentences(first.text);
      const firstSentence = sentences[0] || "";
      const hasMotive = s.firstParaMotive;
      // H3 首段过短（<60 CJK）视为过渡句，不判概念先行；其余 H3 不因父 H2 有动机而豁免。
      const shortH3 = s.level === 3 && cjkCount(first.text) < 60;
      const startsWithExample = /^(下面的?(?:脚本|例子|示例|代码|清单)|例如|比如)/.test(firstSentence);
      const w2Level = STRICT ? "ERROR" : "WARN";
      if (!hasMotive && !shortH3 && !startsWithExample) {
        const hasDef = DEFINITION_RE.test(firstSentence);
        // 只看首句第一个分句里的标识符；「A 有四种写法：`x`、`y`」属于导览，不算概念先行。
        const firstClause = firstSentence.split(/[，：]/)[0];
        const idents = extractBacktickIdents(firstClause);
        const newIdent = idents.find((id) => !s.title.includes(id));
        if (hasDef) {
          add(label, w2Level, "W2", `第 ${first.lineNo} 行小节「${s.title}」先给定义后给动机，请在定义前补 2–3 句「什么时候会遇到/不处理会怎样」`);
        } else if (newIdent && cjkCount(firstSentence) >= 25) {
          add(label, w2Level, "W2", `第 ${first.lineNo} 行小节「${s.title}」首句直接引入 \`${newIdent}\`，未说明它解决什么问题`);
        }
      }
    }

    // ---- W3 术语首次出现无白话锚点 ----
    if (!isMeta) {
      for (const p of s.paragraphs) {
        const text = p.text;
        for (const m of text.matchAll(/\*\*([^*\n]{2,20})\*\*/g)) {
          const term = m[1].trim();
          if (seenTerms.has(term)) continue;
          if (/\s/.test(term)) continue;
          if (/[，。；：、！？,.!?;:()（）「」【】[\]{}|/]/.test(term)) continue;
          if (/^[0-9]+$/.test(term)) continue;
          if (/^(图|表)\s*\d/.test(term)) continue;
          const cjk = cjkCount(term);
          const isAscii = /^[A-Za-z0-9_.-]+$/.test(term);
          if (isAscii ? term.length < 3 || term.length > 30 : cjk < 3 || cjk > 10) continue;
          if (!isAscii && /[的与和或]/.test(term)) continue;
          const spanEnd = m.index + m[0].length;
          if (text.slice(spanEnd).startsWith("：")) continue;

          // 只把「标题里出现」或「全章重复出现」的加粗词当术语；
          // 一次性加粗多半是强调短语（如「**组合爆炸**」），不是需要定义的概念。
          const isTerm = headingText.includes(term) || occurrenceCount(term) >= 2;
          if (!isTerm) continue;

          seenTerms.add(term);
          const after = text.slice(spanEnd);
          const window = after.slice(0, 120);
          if (GLOSS_AFTER_RE.test(after) || GLOSS_FUNC_RE.test(after) || GLOSS_RE.test(window)) continue;
          if (ignored("W3", p)) continue;
          add(label, "WARN", "W3", `第 ${p.lineNo} 行术语「${term}」首次出现没有白话解释，补一句「就是/即/指的是……」`);
        }
      }
    }

    // ---- W3b 缩写首次出现（MCP / HITL / OTel） ----
    if (!isMeta) {
      for (const p of s.paragraphs) {
        if (ignored("W3", p)) continue;
        const text = stripInlineCode(p.text);
        for (const re of ABBREV_RES) {
          for (const m of text.matchAll(re)) {
            const token = m[0];
            if (/^[A-Z]\d{1,2}$/.test(token)) continue; // L1 / L2 / I3 这类等级编号不是缩写
            if (ABBREV_ALLOW.has(token) || seenAbbrev.has(token)) continue;
            seenAbbrev.add(token);
            if (abbrevGlossed(text, m.index, token)) continue;
            add(label, "WARN", "W3", `第 ${p.lineNo} 行缩写「${token}」首次出现没有白话解释或全称，补「（<全称>，即……）」`);
          }
        }
      }
    }

    // ---- W4 段落主题句 ----
    if (!isMeta) {
      for (const p of s.paragraphs) {
        if (ignored("W4", p)) continue;
        const prose = normalizeProse(p.text);
        if (cjkCount(prose) < 100) continue;
        const firstSentence = splitSentences(prose)[0] || "";
        const firstLen = cjkCount(firstSentence);
        if (firstLen > 70) {
          add(label, "WARN", "W4", `第 ${p.lineNo} 行段落首句 ${firstLen} 字，超过主题句 70 字上限，先给判断再展开`);
        } else if (CONNECTIVE_RE.test(firstSentence) && firstLen >= 40) {
          add(label, "WARN", "W4", `第 ${p.lineNo} 行段落以「${firstSentence.slice(0, 8)}…」开头，主题句被衔接词占用，先写本段结论`);
        }
      }
    }

    // ---- W5 长句 / 一逗到底 / 连续长句 ----
    if (!isMeta) {
      let run = 0;
      for (const p of s.paragraphs) {
        if (ignored("W5", p)) continue;
        const prose = normalizeProse(p.text);
        for (const sentence of splitSentences(prose)) {
          const len = cjkCount(sentence);
          if (len < 40) {
            run = 0;
            continue;
          }
          const commas = (sentence.match(/[，,]/g) || []).length;
          if (len > 180) {
            add(label, "ERROR", "W5", `第 ${p.lineNo} 行出现 ${len} 字长句（上限 180），必须拆分`);
          } else if (len > 120) {
            add(label, "WARN", "W5", `第 ${p.lineNo} 行出现 ${len} 字长句（建议 ≤120），建议拆分`);
          } else if (commas >= 5 && len >= 100) {
            add(label, "WARN", "W5", `第 ${p.lineNo} 行出现「一逗到底」（${len} 字、${commas} 个逗号），在逻辑断点处断句`);
          }
          run = len >= 90 ? run + 1 : 0;
          if (run === 3) {
            add(label, "WARN", "W5", `第 ${p.lineNo} 行起连续 3 个 ≥90 字长句，插入短句或列表降低密度`);
            run = 0;
          }
        }
      }
    }

    // ---- W6 段首指代悬空 ----
    if (!isMeta && first && !s.listFirst && !s.tableFirst && !ignored("W6", first)) {
      const titleHasIdent = /[A-Za-z`]/.test(s.title);
      const startsPronoun = /^(这|该|此|其|它)/.test(first.text.trim());
      if (startsPronoun && !titleHasIdent && cjkCount(first.text) >= 40) {
        add(label, "WARN", "W6", `第 ${first.lineNo} 行小节「${s.title}」首段以指代词开头，标题未给出先行词，请改成具体名词`);
      }
    }
  }
}


const files = (await fs.readdir(MDX_DIR)).filter((f) => f.endsWith(".mdx")).sort();
const report = [];
const issues = [];
let errorCount = 0;
let warnCount = 0;

function add(chapter, level, code, msg) {
  issues.push({ chapter, level, code, msg });
  if (level === "ERROR") errorCount++;
  else warnCount++;
}

const summary = [];

for (const f of files) {
  const raw = await fs.readFile(path.join(MDX_DIR, f), "utf8");
  const { body, fm } = splitFrontmatter(raw);
  // body 去掉了 frontmatter，直接按 body 行号报错会整体偏移；补回空行让行号对齐源文件。
  const bodyLines = body.split("\n");
  const fmOffset = Math.max(0, raw.split("\n").length - bodyLines.length);
  const lines = [...Array(fmOffset).fill(""), ...bodyLines];
  const label = chapterLabel(fm, f);

  // ---- 代码块分类：源码证据块 vs 可运行示例 ----
  const fences = collectFences(lines);
  const isSourceBlock = (fence) =>
    precedingNonEmpty(lines, fence.start, 3).some((l) => SOURCE_MARK_RE.test(l.text));
  const allPyFences = fences.filter((x) => x.lang === "python" || x.lang === "py");
  const pyFences = allPyFences.filter((x) => !isSourceBlock(x));
  const sourceBlocks = allPyFences.filter((x) => isSourceBlock(x));

  // ---- V1 验证等级标记（只检查可运行示例）----
  const levels = [];
  pyFences.forEach((fence, idx) => {
    const near = precedingNonEmpty(lines, fence.start, 3);
    const hit = near.map((l) => l.text.match(VERIFY_MARK_RE)).find(Boolean);
    if (!hit) {
      const anyBad = near.map((l) => l.text.match(VERIFY_ANY_RE)).find(Boolean);
      if (anyBad) {
        add(label, "ERROR", "V1", `第 ${idx + 1} 个 python 块（行 ${fence.start + 1}）验证等级 "${anyBad[1]}" 非法，只允许 L1/L2/L3`);
      } else {
        add(label, "ERROR", "V1", `第 ${idx + 1} 个 python 块（行 ${fence.start + 1}）缺少 \`<!-- verify: Lx -->\` 标记`);
      }
      levels.push(null);
    } else {
      levels.push(hit[1]);
    }
  });

  // ---- V2 图位标注 ----
  const bodyIds = [];
  lines.forEach((line, i) => {
    const m = line.match(FIGURE_RE);
    if (!m) return;
    const parts = m[1].split("|").map((s) => s.trim());
    const [id, type] = parts;
    if (!id || !type) {
      add(label, "ERROR", "V2", `第 ${i + 1} 行图位缺少 id 或 type：${line.trim()}`);
      return;
    }
    const idm = id.match(FIGURE_ID_RE);
    if (!idm) {
      add(label, "ERROR", "V2", `图位 id "${id}" 不符合 fig-NN-M 格式`);
    } else if (idm[1] !== label) {
      add(label, "ERROR", "V2", `图位 id "${id}" 的章号与本章 ch${label} 不一致`);
    }
    if (!FIGURE_TYPES.has(type)) {
      add(label, "ERROR", "V2", `图位 "${id}" 的 type "${type}" 不在词表内：${[...FIGURE_TYPES].join(" / ")}`);
    }
    const caption = lines.slice(i + 1, i + 5).some((l) => CAPTION_RE.test(l));
    if (!caption) {
      add(label, "WARN", "V2", `图位 "${id}" 后 4 行内没有 \`**图 N-M**\` 图题行`);
    }
    bodyIds.push(id);
  });

  const dupIds = bodyIds.filter((id, i) => bodyIds.indexOf(id) !== i);
  for (const id of new Set(dupIds)) {
    add(label, "ERROR", "V2", `图位 id "${id}" 在正文中重复出现`);
  }

  // ---- V3 frontmatter figures 一致性 ----
  const rawFigures = fm.figures;
  const fmFigures = Array.isArray(rawFigures) ? rawFigures : rawFigures ? [rawFigures] : [];
  const bodySet = new Set(bodyIds);
  const fmSet = new Set(fmFigures);
  for (const id of bodySet) {
    if (!fmSet.has(id)) add(label, "ERROR", "V3", `正文图位 "${id}" 未列入 frontmatter \`figures\``);
  }
  for (const id of fmSet) {
    if (!bodySet.has(id)) add(label, "ERROR", "V3", `frontmatter \`figures\` 中的 "${id}" 在正文没有对应图位`);
  }
  if (fmFigures.length !== fmSet.size) {
    add(label, "ERROR", "V3", "frontmatter `figures` 存在重复项");
  }

  // ---- V5 图号顺序与正文出现顺序一致（插图/挪图后最易漏改）----
  const figNums = bodyIds.map((id) => Number(id.split("-")[2]));
  for (let i = 1; i < figNums.length; i++) {
    if (Number.isFinite(figNums[i]) && Number.isFinite(figNums[i - 1]) && figNums[i] < figNums[i - 1]) {
      add(label, "WARN", "V5", `图号顺序与正文出现顺序不一致（${bodyIds[i - 1]} → ${bodyIds[i]}），插图后需重编号`);
      break;
    }
  }

  // ---- V4 实测记录 ----
  const rec = await readVerifyRecord(label);
  if (!rec.exists) {
    add(label, "WARN", "V4", `缺少逐块实测记录 metadata/verify/ch${label}.txt`);
  } else {
    if (rec.blocks.length !== pyFences.length) {
      add(label, "WARN", "V4", `实测记录有 ${rec.blocks.length} 块，正文有 ${pyFences.length} 个 python 块`);
    }
    const n = Math.min(rec.blocks.length, levels.length);
    for (let k = 0; k < n; k++) {
      if (rec.blocks[k].level && levels[k] && rec.blocks[k].level !== levels[k]) {
        add(label, "WARN", "V4", `第 ${k + 1} 块等级不一致：正文 ${levels[k]}，记录 ${rec.blocks[k].level}`);
      }
    }
  }

  // ---- F1 图必须有可渲染产物 + 每章下限 ----
  for (const id of bodyIds) {
    const svg = path.join(FIGURE_DIR, `${id}.svg`);
    const png = path.join(FIGURE_DIR, `${id}.png`);
    if (!(await fileExists(svg)) && !(await fileExists(png))) {
      add(label, "ERROR", "F1", `图位 "${id}" 没有可渲染产物（缺 ${id}.svg / ${id}.png）`);
    }
    if (!new RegExp(`!\\[[^\\]]*\\]\\([^)]*${id}\\.(?:svg|png)\\)`).test(body)) {
      add(label, "ERROR", "F1", `图位 "${id}" 后正文没有引用对应图片`);
    }
  }
  if (bodyIds.length < 2) {
    add(label, "ERROR", "F1", `本章只有 ${bodyIds.length} 张图，低于每章下限 2 张`);
  }

  // ---- C1 python 块中文注释 ----
  pyFences.forEach((fence, idx) => {
    const bodyLines = lines.slice(fence.start + 1, fence.end);
    const hasChineseComment = bodyLines.some((l) => /^\s*#.*[\u4e00-\u9fff]/.test(l));
    if (!hasChineseComment) {
      add(label, "WARN", "C1", `第 ${idx + 1} 个 python 块（行 ${fence.start + 1}）没有中文注释`);
    }
  });

  // ---- M1 公式后的中文说明 ----
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "$$") continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "$$") j++;
    if (j >= lines.length) break;
    const after = lines.slice(j + 1, j + 6).join("\n");
    if (!/[\u4e00-\u9fff]/.test(after)) {
      add(label, "WARN", "M1", `行 ${i + 1} 的公式块后 5 行内没有中文说明`);
    }
    i = j;
  }

  // ---- R1 正文不点材料（WARN，人工复核）----
  const forbidden = [
    /你提供的?(?:文档|材料|资料)/,
    /(?:材料|文档|资料)有偏差/,
    /原文(?:写法)?有误/,
    /原文错误/,
  ];
  for (const re of forbidden) {
    if (re.test(body)) add(label, "WARN", "R1", `正文出现疑似点评材料的表述：${re.source}`);
  }

  // ---- N1 本章参考小节 ----
  if (!/^##\s+.*本章参考/m.test(body)) {
    add(label, "WARN", "N1", "缺少章末「本章参考」小节（N.10）");
  }

  // ---- N2 占位章号 ----
  // 骨架模板里的 N.x / 第 N 章 是占位符，定稿后必须换成真实章号；
  // 漏改会一路带进 LaTeX/Typst/EPUB 的标题与目录。只查标题行，避免误伤正文里的版本号。
  const ph = body.match(/^#{1,6}\s+N\.\d+|第\s*N\s*章/m);
  if (ph) {
    add(label, "ERROR", "N2", `标题残留占位章号「${ph[0].trim()}」，定稿前必须替换为真实章号`);
  }

  // ---- W1–W6 可读性（详见 references/readability-style-guide.md）----
  if (!NO_READABILITY) checkReadability(lines, label, add);

  summary.push({
    label,
    file: f,
    pyBlocks: pyFences.length,
    sourceBlocks: sourceBlocks.length,
    figures: bodyIds.length,
    levels,
    hasRecord: rec.exists,
  });
}

// ---- 输出 ----
report.push("# 章节结构 lint");
report.push("");
report.push(`生成时间: ${new Date().toISOString()}`);
report.push("");
report.push("| 章 | 文件 | 可运行块 | 已标级 | 源码证据块 | 图位 | 实测记录 |");
report.push("|---|---|---|---|---|---|---|");
for (const s of summary) {
  const marked = s.levels.filter(Boolean).length;
  report.push(
    `| ch${s.label} | ${s.file} | ${s.pyBlocks} | ${marked}/${s.pyBlocks} | ${s.sourceBlocks} | ${s.figures} | ${s.hasRecord ? "有" : "缺"} |`,
  );
}
report.push("");
report.push(`合计: ERROR ${errorCount}，WARN ${warnCount}`);
report.push("");

const wIssues = issues.filter((i) => /^W[1-6]$/.test(i.code));
if (wIssues.length) {
  report.push("## 可读性告警分布（W1–W6）");
  report.push("");
  report.push("| 代码 | ERROR | WARN | 含义 |");
  report.push("|---|---|---|---|");
  const meanings = {
    W1: "空转开场",
    W2: "概念先行",
    W3: "术语无白话锚点",
    W4: "段落主题句弱",
    W5: "长句 / 一逗到底",
    W6: "段首指代悬空",
  };
  for (const code of ["W1", "W2", "W3", "W4", "W5", "W6"]) {
    const list = wIssues.filter((i) => i.code === code);
    if (!list.length) continue;
    const e = list.filter((i) => i.level === "ERROR").length;
    report.push(`| ${code} | ${e} | ${list.length - e} | ${meanings[code]} |`);
  }
  report.push("");
}

if (issues.length) {
  report.push("## 问题");
  report.push("");
  const byChapter = new Map();
  for (const i of issues) {
    if (!byChapter.has(i.chapter)) byChapter.set(i.chapter, []);
    byChapter.get(i.chapter).push(i);
  }
  for (const [ch, list] of byChapter) {
    report.push(`### ch${ch}`);
    for (const i of list) report.push(`- [${i.level}][${i.code}] ${i.msg}`);
    report.push("");
  }
} else {
  report.push("## 问题");
  report.push("");
  report.push("无。");
  report.push("");
}

await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
await fs.writeFile(OUT_FILE, report.join("\n"), "utf8");
console.log(report.join("\n"));
console.log(`\n报告已写入 ${OUT_FILE}`);
if (STRICT && errorCount > 0) process.exit(1);
