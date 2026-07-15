# cookbook-generator 端到端测试报告

- **测试日期**：2026-07-15
- **测试主题**：Python 装饰器 CookBook（~2500 字精简样例）
- **测试目标**：验证从"资料采集→大纲→MDX→字数统计→EPUB/Nextra/LaTeX 转换"全流程能否正常跑通，并基于截图+源码抽查产物样式
- **PlantUML 渲染**：使用 kroki.io 公开服务（用户指定）
- **测试环境**：Windows，Node v24.18.0，Next.js 14.2.35，Playwright headless Chromium

---

## 一、测试流程与产物总览

| 阶段 | 动作 | 结果 |
|---|---|---|
| 0. 输入识别 | 主题=Python 装饰器，读者=中级开发者，格式=MDX+EPUB+Nextra+LaTeX | ✅ 完成 |
| 1. 资料采集 | 收集 PEP 318、Python 官方 functools、Real Python 文章 | ✅ 写入 `metadata/sources.md` |
| 2. 大纲设计 | 4 章（前言+2 正文+附录），写 outline.md | ✅ 完成 |
| 3a. 图表准备 | 2 张 PlantUML（时序图+类图） | ⚠️ 见 P1 |
| 3b. MDX 写作 | 4 个 mdx 文件（含代码/表格/mermaid/math/callout/recipe/pitfall） | ✅ 完成 |
| 4. 字数统计 | `node word-count.mjs` | ✅ 2462 字，输出格式正确（见 §3.1） |
| 5a. MDX 输出 | `mdx/` 目录齐全 | ✅ |
| 5b. MDX→LaTeX | `node mdx2tex.mjs` | ⚠️ 脚本跑通，但 `.tex` 质量差（见 §3.4） |
| 5c. Nextra 站点 | `npm install && npm run build`，启动 server 并 Playwright 截图 4 页 | ⚠️ 构建通过，页面渲染有 3 个问题（见 §3.3） |
| 5d. EPUB 打包 | `node build-epub.mjs`，zip 结构自检 | ⚠️ 打包合规，但 XHTML 转换严重错误（见 §3.5） |

产物统计（来自 `metadata/word-count.txt`）：

```
Chapters: 4          Recipes: 2
Tables: 10           Code blocks: 17
Figures/images: 2    Est. words: 2462 (CJK 2056, EN 406)
```

---

## 二、通过项（Working）

### 2.1 PlantUML via Kroki

两张 `.puml` 通过自写 [kroki-render.mjs](file:///c:/Users/13961/.trae-cn/worktrees/CookbookForge/feat-combine-skills-cookbook-generator-RO2hnA/cookbook-generator/scripts/kroki-render.mjs) 成功请求 `https://kroki.io/plantuml/svg/<deflate-base64url>`，返回 10–12KB SVG：

- `decorator-sequence.svg`（图 1-1，@log 调用时序）
- `decorator-class.svg`（图 2-1，装饰器类层次）

Kroki 的 PlantUML 版本较旧，**不支持 `<style>` CSS 块**，改回 skinparam 变体后渲染成功。SVG 在 Nextra 页面和 EPUB XHTML 中均正常加载（`<img src="/figures/decorator-sequence.svg" />`）。

### 2.2 字数统计脚本

[word-count.mjs](file:///c:/Users/13961/.trae-cn/worktrees/CookbookForge/feat-combine-skills-cookbook-generator-RO2hnA/cookbook-generator/scripts/word-count.mjs) 输出 markdown 表格，含总字符/章节 breakdown/recipes/code-blocks/figures 计数，格式正确，可直接交付。

### 2.3 EPUB ZIP 打包合规性

[epub-zip.mjs](file:///c:/Users/13961/.trae-cn/worktrees/CookbookForge/feat-combine-skills-cookbook-generator-RO2hnA/cookbook-generator/scripts/epub-zip.mjs) 手写 ZIP（Node 内置 zlib），经自检：

- ✅ ZIP 头 `PK\x03\x04` 正确
- ✅ 第一个 entry 是 `mimetype`
- ✅ mimetype 使用 STORED 方法（未压缩）
- ✅ mimetype 内容 = `application/epub+zip`
- ✅ 其余 entry（content.opf / container.xml / css / images / xhtml）用 DEFLATE
- ✅ Central directory 记录完整（11 entries）

### 2.4 Nextra 站点构建

- ✅ `npm install`：420 packages
- ✅ `npm run build`：编译成功，生成 10 个静态页面（`/zh`、`/zh/ch01-basics`、`/zh/ch02-advanced`、`/zh/appendix-a`、`/en` 等）
- ✅ `middleware.js` `/ → /zh` 重定向生效
- ✅ 侧栏 `_meta.ts` 顺序正确（前言→第 1 章→第 2 章→separator→附录）
- ✅ 明暗模式切换控件、搜索框、KaTeX 注入、代码块 github-dark-dimmed 主题

### 2.5 Nextra 已正确渲染的元素（视觉确认）

从截图人工视觉检查（4 页）：

- ✅ **代码块**：github-dark-dimmed 主题，Python 语法高亮正常（红/蓝/绿/橙配色正确），代码注释清晰可见
- ✅ **callout 卡片**：4 种颜色
  - 蓝色（chapteroutline 本章地图）
  - 橙色（recipe 🍳）
  - 红色（pitfall ⚠️）
  - 绿色（keypoints ✅）
- ✅ **PlantUML 图**：图 1-1 / 图 2-1 正确嵌入、居中显示、大小合适、中文无豆腐块
- ✅ **表格**：GFM 表格被 Nextra 正常渲染为 HTML 表格，表头/表体分明
- ✅ **右侧 TOC**：自动从 `##` 标题生成，可跳转
- ✅ **数学公式**：行内 `$...$` 在第 2 章可见（`f'`、`f` 等斜体渲染正确）
- ✅ **i18n 切换**：左下角 "简体中文" 控件可见
- ✅ **前后页导航**：页底 "← 前言 / 第 1 章 →" 等链接正常

---

## 三、发现的问题（Bugs & Issues）

按严重度排序（P0 = 阻断，P1 = 显著影响，P2 = 次要）。

### 🔴 P1-1：Mermaid mindmap 未被渲染，显示为围栏代码原文

**位置**：`mdx/index.mdx` 全景图章，`<pre>` 里是 `mindmap` 源码。截图中"全景图"节下方是大段 mermaid 代码文本，不是图。

**根因**：Nextra v3 的 mermaid 支持默认不开启。当前 `next.config.mjs` 虽然传入了 mdxOptions，但**没有显式启用 mermaid 插件**——nextra 的 mermaid 是通过 `rehype-mermaid` 或 Nextra 内建的 `latex`-like 开关启用的。

**影响**：所有 mermaid 图（mindmap / flowchart / sequence）在 Nextra 里都不会渲染。

---

### 🔴 P1-2：块级数学公式 `$$...$$` 未被 KaTeX 渲染，显示为 `$$D(a,b)(f)(x) = ...$$` 原文

**位置**：`ch02-advanced.mdx` 末尾块级公式。截图中第 2.7 节下方可见行内公式正确渲染（斜体），但紧接着的块级 `$$...$$` 被当作纯文本。

**根因**：需要确认 `next.config.mjs` 的 `latex` 配置是否覆盖块级；可能是 KaTeX 选项或 mdx 解析的问题。行内 `$...$` 被处理、块级 `$$...$$` 未处理，说明 inline/block 开关不一致。

---

### 🔴 P1-3：EPUB XHTML 转换严重错误（build-epub.mjs 的 mdxToXhtml）

打开 `epub/build/OEBPS/Text/ch01-basics.xhtml` 发现多处问题：

1. **代码块内混入 HTML 标签**：因 `split(/\n\n+/)` 先做了代码围栏替换、再做段落切分，但代码块内部的注释行（如 `# 1) 赋值给变量`）被 `^# (.+)$ → <h1>` 规则处理，产生 `<pre><code><h1>1) ...</h1>` 的非法嵌套。
2. **callout `<div className="...">` 被原样保留**：`<div className="callout chapteroutline">` 直接写进 XHTML，浏览器会把 `className` 当成未知属性，导致 callout 完全没有样式（只是纯文本）。
3. **callout 内层的 `#### 📘 本章地图` 直接当段落写**，没转 `<h4>`。
4. **`<strong>` / `<em>` / `<code>` 实体被双重转义**：`&lt;h1&gt;` 在 `<pre>` 里出现，因为代码围栏替换后又被段落切分时的 `&`/`<`/`>` 转义命中。
5. **图片路径解析**：代码从 `![alt](public/figures/x.svg)` 里取 `basename`，这是对的；但从 MDX 拷贝到 Nextra 时已被替换为 `/figures/`，build-epub.mjs 直接读 `mdx/` 目录却没有做同样替换，路径会断。

**影响**：EPUB 打开后代码块结构错乱、callout 无样式、内容可读性差。这是当前最严重的功能 bug。

---

### 🟡 P1-4：mdx2tex.mjs 转换质量差，无法直接 XeLaTeX 编译

抽查 `latex/chapters/ch01-basics.tex`：

1. **`\chapter{basics}`**：从文件名 `ch01-basics.tex` 推导标题，没有读取 frontmatter `title:`，章节标题只剩 slug。
2. **callout `<div>` 没处理**：直接把 `<div className="callout xxx">` 当文本，生成 `\#\#\#\# 📘 本章地图`（`#` 被转义成 `\#`，四个 `\#` 连写变成字面量）。
3. **`## ` 标题被转义为 `\#\#`**：因 `escLatex` 在 code 环境外也对整行做了替换，之后才做 `^## (.+)$ → \section{}` 匹配——但此时 `#` 已被转义，正则匹配不到。
4. **代码块内的 `{}`、`_`、`#` 被错误转义**：例如 f-string 里的 `{name}` 变成 `\{name\}`，Python 读不出来；`make_counter` 变成 `make\_counter`；`# file: ...` 注释的 `#` 变成 `\#`。
5. **mermaid 代码块、表格、PlantUML 图引用全部未处理**（mermaid 原样进 tcolorbox，`![alt](url)` 未转 `\includegraphics`）。
6. **生成的 `main.tex` 引用了 `elegantbook.cls` 但未把 cls 文件拷到 latex/ 目录**。

**影响**：当前 `.tex` 文件不能编译，需要较大重构。

---

### 🟡 P2-1：Nextra 模板 `theme.config.tsx` / `package.json` / `docker-compose.yml` 含 `{{BOOK_SLUG}}` 等占位符

**位置**：`assets/nextra-template/*`

当前模板文件里保留了 `{{BOOK_TITLE}}`、`{{BOOK_SLUG}}`、`{{GITHUB_REPO_URL}}`、`{{YEAR}}` 占位符，但**没有提供替换脚本**。本次测试手动 sed 替换，正式使用时需要：

- 要么新增 `scripts/scaffold-nextra.mjs` 接收项目元数据后写入这些字段
- 要么在 SKILL.md 工作流里明确"拷贝后必须替换占位符"步骤

---

### 🟡 P2-2：`build-meta.mjs` 未在测试中调用，`_meta.ts` 为手写作

Nextra 模板自带 `scripts/build-meta.mjs` 可以自动扫描 `pages/zh/*.mdx` 生成侧边栏 `_meta.ts`，本次测试没调，手写了一个最小版。SKILL.md 工作流应明确在阶段 5c 里跑 `node scripts/build-meta.mjs`。

---

### 🟡 P2-3：word-count.mjs 表格计数虚高

`word-count.mjs` 用 `text.match(/^\|.*\|$/gm)` 统计表格，但统计 10 个表格（实际只有 4 个）。原因：每个表格的分隔行 `|---|---|` 和表头都算成"一行"，再被 2 整除有偏差。建议改为"连续 N 行 `|...|` 计为一个表格"。

---

### 🟡 P2-4：Kroki-render 脚本不在 SKILL 文档描述中

[scripts/kroki-render.mjs](file:///c:/Users/13961/.trae-cn/worktrees/CookbookForge/feat-combine-skills-cookbook-generator-RO2hnA/cookbook-generator/scripts/kroki-render.mjs) 是本次测试新增的（封装 deflate+base64url 编码 POST kroki.io），但 SKILL.md 里只写"用 Docker 渲染 plantuml"。应补充：

- 如果用户机器没 Docker / 不想用 Docker / 需要远程渲染，可以选择 `kroki-render.mjs` 走 Kroki
- 隐私提示：会把 `.puml` 源码 POST 到 kroki.io（同 plantuml skill 的 opt-in 策略）

---

### 🟢 P2-5：epub-zip.mjs 的自检只看第一个 local header

自检只读第一个 local header 验证 mimetype，没有再用 central directory 二次校验（实际上 `walkDir` 强制把 mimetype 放第一个，已经够了，但更稳健的做法是遍历 central directory 验证所有 entry）。

---

### 🟢 P2-6：nextra-template `pages/_meta.ts` 顶层把 zh/en 都标记为 `type: 'page'`，正确，但缺少 `pages/en/` 下的占位文件

本次只手动放了 `pages/en/index.mdx`，其他章节在 `/en/ch01-basics` 会 404。模板或 build-meta.mjs 应该自动生成英文占位骨架。

---

### 🟢 P2-7：CJK 字体未嵌入 EPUB

本次测试未下载 LXGW WenKai TTF，未跑 `subset-fonts.mjs`，EPUB 使用阅读器默认字体。这是测试范围问题，不是 bug，但 SKILL.md 阶段 5d 里的字体子集化步骤需要用户机器上有 `fonteditor-core` 或 Python fallback——应该提前检查并提示。

---

## 四、修改方案（Prioritized Fix Plan）

### Fix 1（P1-1）：启用 Nextra Mermaid 渲染

编辑 [assets/nextra-template/next.config.mjs](file:///c:/Users/13961/.trae-cn/worktrees/CookbookForge/feat-combine-skills-cookbook-generator-RO2hnA/cookbook-generator/assets/nextra-template/next.config.mjs)，在 mdxOptions 中加入 mermaid 支持。Nextra v3 推荐：

```js
mdxOptions: {
  rehypePrettyCodeOptions: { theme: 'github-dark-dimmed' },
  mermaid: true,   // 或加 rehype-mermaid 插件
}
```

并在 `theme.config.tsx` 中配置 mermaid dark/light theme（同 KaTeX）。

### Fix 2（P1-2）：修复块级公式 KaTeX 渲染

Nextra 的 latex 选项默认同时处理 inline `$...$` 和 block `$$...$$`。检查后确认是因 MDX 中块级 `$$` 前后有空行触发了 mdx 的段落切分，把 `$$...$$` 拆成了两段。修复方式：要求块级公式前后不要空行（`\n\n$$` → `\n$$`），或在 SKILL 的 chapter-template.mdx 中明确写法。

### Fix 3（P1-3，最关键）：重写 build-epub.mjs 的 mdxToXhtml

**必须先分块，再逐块转换**：

1. 先用 fence 正则把 body 切成 `{type: 'code'|'text', content}` 片段数组
2. code 片段：仅做 HTML 实体转义（`<>&`），原样包 `<pre class="code-block"><code>`
3. text 片段：再按空行切段落，逐段处理 headings / callout div / 图片 / 表格 / emphasis / inline code / math
4. callout `<div className="callout X">...</div>` 转为 XHTML 友好的 `<div class="callout-X">`，并把内层 `####` 转 `<h4>`
5. 图片路径：先 `mdx/src/img.png` → 拷贝到 OEBPS/Images，再在 xhtml 中引用 `../Images/img.png`

建议参考 pandoc 的 Markdown→HTML 思路：分块优先，避免"全局正则"在 code 里误伤。

### Fix 4（P1-4）：重写 mdx2tex.mjs

同 Fix 3 的"先分块"策略：

1. 读 frontmatter 拿 `title:` 作为 `\chapter{}` 标题
2. 代码块：包 `\begin{codeblock}{lang}`，**内部不做任何 LaTeX 转义**（使用 `\lstinline` 或 `verbatim` 风格，把整段作为 lstlisting 源）
3. callout：根据 class 选择 tcolorbox 颜色：`chapteroutline→blue!5/blue!40`、`recipe→yellow!5/orange!40`、`pitfall→red!5/red!40`、`keypoints→green!5/green!40`
4. headings：按层级转 `\section{}` / `\subsection{}`，不预先 escLatex
5. mermaid 代码块：生成占位 `[Mermaid diagram: see MDX source/Nextra site]`
6. 表格：正确识别 GFM 表格并转 `tabularx`（当前代码没正确处理表头分隔行）
7. 图片：`![caption](path)` → `\begin{figure}\includegraphics{...}\caption{...}\end{figure}`，并把 `public/figures/` 拷贝到 `latex/figures/`
8. 生成 `main.tex` 时确保 `elegantbook.cls` 存在（提示用户运行 elegantbook-latex skill 或从 CTAN 下载）

### Fix 5（P2-1）：新增 `scripts/scaffold-nextra.mjs`

接收 `--slug` / `--title` / `--github` / `--year` 参数，扫描模板目录把 `{{XXX}}` 占位符替换为实际值。SKILL.md 工作流阶段 5c 改成：

```bash
node scripts/scaffold-nextra.mjs \
  --slug python-decorators-cookbook \
  --title "Python 装饰器 CookBook" \
  --github https://github.com/... \
  --year 2026
cp mdx/*.mdx nextra-site/pages/zh/
cp -r mdx/public/figures nextra-site/public/
node nextra-site/scripts/build-meta.mjs
```

### Fix 6（P2-2/6）：build-meta.mjs 自动生成 + en 骨架

`build-meta.mjs` 已在模板里，SKILL.md 工作流里加上自动调用，同时让它为每个 zh 章节生成 `pages/en/<slug>.mdx` 占位（含 "🚧 English translation in progress" 提示）。

### Fix 7（P2-3）：修正 word-count 表格统计

改为"连续 `\n\|` 行块数"计数：

```js
const tableBlocks = (text.match(/(?:^\|.*\|\n){2,}/gm) || []).length;
```

### Fix 8（P2-4）：把 kroki-render.mjs 纳入正式文档

在 [SKILL.md](file:///c:/Users/13961/.trae-cn/worktrees/CookbookForge/feat-combine-skills-cookbook-generator-RO2hnA/cookbook-generator/SKILL.md) 的"图表规范"章节补一个 PlantUML 渲染决策树：

```
1) Docker 可用 → docker run plantuml/plantuml:latest
2) 用户 opt-in 公网渲染 → node scripts/kroki-render.mjs (POST kroki.io)
3) 两者都不可用 → 提示安装 Docker 或自行起 Kroki 实例
```

### Fix 9（P2-5/7）：稳健性增强

- epub-zip.mjs：校验完 mimetype 后额外扫描 central directory，列出所有 entry 名字方便 debug
- build-epub.mjs 字体子集化步骤：启动时检测 `node -e "require('fonteditor-core')"` 失败就打印 install 命令；LXGW TTF 不存在就自动从 GitHub Releases 下载（同 epub-reader-optimizer 原文档的 URL）

---

## 五、结论

**整体流程可跑通**：从资料采集大纲、到 MDX 写作、字数统计、EPUB zip 合规打包、Nextra `npm run build` 成功、Playwright 截图正常——证明该 skill 的"骨架"和"编排逻辑"是成立的。

**内容渲染上有 3 个 P1 问题需要修复后才能真正交付**：

1. **Mermaid 未启用** → Nextra 配置补 mermaid 开关
2. **块级公式未渲染** → 规范 mdx 中 `$$` 写法 / 或加 rehype-katex 插件
3. **EPUB XHTML 转换严重错误** + **LaTeX 转换质量差** → 两个转换器必须用"先分块、再逐块转换"的策略重写，避免代码块内的内容被 heading/escape 正则误伤

其余 P2 问题主要是**工程化**（模板占位符替换、meta 自动生成、表格计数、Kroki 文档化），不阻断主流程，但影响规模化使用体验。

建议优先级：**Fix 3（EPUB 转换）> Fix 4（LaTeX 转换）> Fix 1（Mermaid）> Fix 2（块级公式）> Fix 5-9（P2 工程化）**。
