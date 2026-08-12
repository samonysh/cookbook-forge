---
name: "cookbook-forge"
slug: "cookbook-forge"
displayName: "Cookbook Forge"
version: "1.3.0"
license: "MIT"
summary: "从多源资料生成深度技术 CookBook / Handbook / Survey，产出 MDX -> ElegantBook PDF、Nextra 网站、优化 EPUB、Typst PDF。"
description: "Generates deep technical CookBooks, Handbooks, and Surveys from user materials (websites, PDFs, EPUBs, GitHub repos, arxiv papers, docs). Produces MDX chapters first, then ElegantBook LaTeX/PDF, Nextra website, optimized EPUB, and Typst PDF. Invoke when user asks to write a Cookbook, handbook, survey, technical book, or structured long-form documentation for a project/domain."
tags: [writing, cookbook, handbook, documentation, mdx, latex, pdf, epub, nextra, typst, research]
---

# Cookbook Forge

Domain CookBook / Handbook / Survey 生成器。从用户提供的自然语言需求与多源资料（网页、PDF、EPUB、GitHub、arxiv 论文、项目文档等）出发，按照 O'Reilly CookBook 与 Springer Handbook 的行文布局风格，先生成章节化 **MDX**（基于 unified/MDX），再按用户指定转换为：

- ElegantBook LaTeX 工程 + PDF
- Nextra v3 电子文档网站
- 优化排版的 EPUB（贴近 ElegantBook 样式，适配电子阅读器）
- Typst 工程 + PDF（使用 ilm 模板，中文字体优化排版）

默认输出 MDX；用户可指定任意子集组合。每个输出格式独占一个子文件夹。

---

## 触发条件

满足以下任一条件时调用本 Skill：

- 用户要求为某个项目、技术栈、主题、领域**写一本 CookBook / 手册 / 综述 / 技术书**。
- 用户提供多种资料（网页、PDF、EPUB、GitHub 仓库、arxiv 链接、本地文档）要求整理为结构化长文档。
- 用户要求输出 LaTeX/PDF、在线网站、EPUB 中的任一或多个格式，且源头是结构化的多章内容。
- 用户要求参考 O'Reilly CookBook 或 Springer Handbook 风格写作。
- 用户提到 "Cookbook"、"手册"、"综述"、"Handbook"、"技术书"、"生成教程长文"、"整本书" 等关键词。

## 何时不调用

- 单篇博客/短文/单页文档 -> 直接写 MDX/Markdown 即可。
- 用户仅要求转换已有 LaTeX -> Nextra 网站而没有原始资料采集/写作阶段 -> 用 `latex-to-nextra-site`。
- 用户仅要求优化 EPUB 排版 -> 用 `epub-reader-optimizer`。
- 用户仅要求把 MD/笔记排版成 PDF -> 用 `elegantbook-latex`。

---

## 必须联动的 Skills 与工具

本 Skill 是**编排型 Skill**，执行时按需联动以下能力（由主 agent 在调用本 skill 后自行调度，或由本 skill 描述指示）：

| 能力 | 用途 |
|---|---|
| `agent-browser` / `vivaldi-automation` | 爬取网页、抓取站点地图、遍历文档站 |
| `WebFetch` / `WebSearch` | 获取网页内容、网络搜索补充资料 |
| `arxiv-watcher` / `connected-papers-browser` | 获取 arxiv 及相关论文 |
| `paper-search` (MCP) | 搜索、下载、阅读学术论文（arXiv、PubMed、Semantic Scholar 等 20+ 来源），替代或补充 arxiv-watcher |
| `doc2x-cli` | PDF OCR/解析为 Markdown/文本 |
| `gh-cli` | 读取 GitHub 仓库结构、README、源码、docs |
| `plantuml` / `drawio` / `excalidraw` / `chart-visualization` | 生成图表（架构图、类图、时序图、流程图、数据图表） |
| `elegantbook-latex` | 编译 ElegantBook LaTeX -> PDF |
| `Read` / 文件读取 | 本地 EPUB、MD、代码、PDF 文本提取 |

本 Skill 自带 assets 与 scripts：

- `scripts/epub-zip.mjs` - EPUB 合规打包（Node 内置 zlib 手写 ZIP，零依赖；保证 mimetype STORED 且为第一；打包后遍历 central directory 二次校验）。
- `scripts/subset-fonts.mjs` - 字体子集化（基于 `fonteditor-core`，TTF -> WOFF2；未安装时会提示 `npm install fonteditor-core` 并给出 Python fallback 命令）。
- `scripts/optimize-formula-images.mjs` - 公式即图片型 HTML 结构修复（纯 JS 正则替换）。
- `scripts/lmdx2tex.mjs` - **LLM 驱动**的 MDX -> ElegantBook LaTeX 转换器。通过子 agent 逐章节调用 LLM 智能转换，避免正则的脆弱性。
- `scripts/lmdx2typst.mjs` - **LLM 驱动**的 MDX -> Typst（ilm 模板）转换器。通过子 agent 逐章节调用 LLM 智能转换为 Typst 原生语法。
- `scripts/word-count.mjs` - 字数统计（GFM 表格按"表头+分隔行"块计数，不再虚高）。
- `scripts/lbuild-epub.mjs` - **LLM 驱动**的 MDX -> EPUB3 转换器。通过子 agent 逐章节调用 LLM 智能转换为 XHTML，然后组装为 EPUB。
- `scripts/kroki-render.mjs` - PlantUML 通过 Kroki.io 远程渲染（deflate+base64url 编码 GET，含隐私提示）。
- `assets/prompts/mdx-to-latex.md` - LLM 转换 MDX->LaTeX 的系统 Prompt 模板（定义所有映射规则）。
- `assets/prompts/mdx-to-epub.md` - LLM 转换 MDX->EPUB XHTML 的系统 Prompt 模板。
- `assets/prompts/mdx-to-typst.md` - LLM 转换 MDX->Typst 的系统 Prompt 模板（定义 Typst 原生语法映射规则，严禁混用 LaTeX 语法）。
- `assets/elegantbook-main.template.tex.txt` - 优化版 ElegantBook main.tex 模板（.tex.txt 后缀以兼容 SkillHub 文件类型白名单，脚本读取时按纯文本处理）。
- `assets/ilm-template.typ.txt` - 优化版 Typst ilm 模板主文件（中文字体 LXGW WenKai、代码块圆角边框、四色 callout 提示框、booktabs 表格）。
- `assets/nextra-template/scripts/scaffold-nextra.mjs` - 把模板里的 `{{BOOK_SLUG}}`/`{{BOOK_TITLE}}`/`{{GITHUB_REPO_URL}}`/`{{YEAR}}` 占位符替换为真实值，自动拷贝 mdx->pages/zh、figures->public/figures、生成 pages/en 英文骨架。
- `assets/stylesheet.template.css` / `assets/stylesheet.formula-image.css` - EPUB 样式表。
- `assets/template-mdx/` - 单章 MDX 模板（含 `$$` 块级公式写法约定）。
- `assets/nextra-template/` - Nextra 站点骨架（已启用 mermaid + KaTeX）。
- `references/style-guide-oreilly.md` - O'Reilly CookBook 行文布局参考。
- `references/style-guide-springer.md` - Springer Handbook 行文布局参考。
- `references/stage-5a-mdx.md` - 阶段 5a：MDX 输出子流程（按需读取）。
- `references/stage-5b-latex.md` - 阶段 5b：ElegantBook LaTeX + PDF 子流程（按需读取）。
- `references/stage-5c-nextra.md` - 阶段 5c：Nextra v3 网站子流程（按需读取）。
- `references/stage-5d-epub.md` - 阶段 5d：EPUB 子流程（按需读取）。
- `references/stage-5e-typst.md` - 阶段 5e：Typst（ilm 模板）子流程（按需读取）。

---

## 总体目标

产出一本面向目标读者（默认是中高级开发者/架构师/研究者）的深度书籍。要求：

1. **资料穷尽**：对用户提供的所有资料都尽力抽取；对缺失资料进行网络/论文搜索补充。
2. **架构先行**：先出整体全景图与章节目录，与用户对齐后再逐章写作。
3. **每章一个 MDX**：使用 MDX（MDXJS + unified）作为权威中间格式，每章独立文件，便于多格式转换。
4. **内容深入**：兼顾原理与实用，包含背景引入、章节地图、正文、代码（带注释）、图表、表格、Recipe、陷阱、要点总结、参考文献。
5. **图表丰富**：至少每章 1–2 张图（mermaid/plantuml/drawio/excalidraw/chart 视用户要求而定），表格按需。
6. **字数可配置**：默认 8 万字以上；可按需求调整（短篇手册 2–3 万字，综述 3–5 万字，完整 CookBook 8–15 万字）。
7. **多格式输出**：默认 MDX；按用户指定输出 `mdx/`、`latex-pdf/`、`nextra-site/`、`epub/`、`typst/` 子文件夹。

---

## 标准输出目录

```text
<BookSlug>/
├── mdx/                              # 权威中间格式（默认必出）
│   ├── index.mdx                     # 封面/扉页
│   ├── preface.mdx
│   ├── ch00-overview.mdx             # 全景图章
│   ├── ch01-xxx.mdx
│   ├── ...
│   ├── appendix-a.mdx
│   ├── references.mdx
│   ├── _meta.ts                      # 章节顺序（Nextra 兼容）
│   └── public/
│       ├── figures/                  # 图片 / 渲染后的图表
│       └── diagrams-src/             # plantuml/.drawio/mermaid 源
├── latex-pdf/                        # 当用户要求 PDF 时生成
│   ├── latex/
│   │   ├── main.tex
│   │   ├── elegantbook.cls
│   │   ├── chapters/
│   │   ├── figures/
│   │   ├── diagrams/
│   │   └── metadata/
│   └── dist/<BookSlug>.pdf
├── nextra-site/                      # 当用户要求网站时生成
│   ├── package.json
│   ├── next.config.mjs
│   ├── theme.config.tsx
│   ├── middleware.js
│   ├── pages/zh/*.mdx
│   ├── pages/en/*.mdx                # 英文骨架（可选）
│   ├── public/figures/
│   ├── scripts/
│   ├── Dockerfile.txt                # 重命名为 Dockerfile 后可直接 docker compose up
│   └── docker-compose.yml
├── epub/                             # 当用户要求 EPUB 时生成
│   ├── <BookSlug>.epub
│   └── build/                        # 解包/构建中间目录（交付前可清理）
├── typst/                            # 当用户要求 Typst 时生成
│   ├── main.typ                      # ilm 模板主文件
│   ├── chapters/
│   │   ├── ch00-overview.typ
│   │   ├── ch01-xxx.typ
│   │   └── ...
│   └── figures/                      # 图片（SVG/PNG）
└── metadata/
    ├── sources.md                    # 所有参考资料来源
    ├── image-sources.md
    ├── word-count.txt
    └── outline.md                    # 最终章节大纲（与用户对齐版）
```

---

## 工作流程

### 阶段 0：输入识别与参数对齐

识别用户输入：

- 主题/领域（自然语言描述）
- 资料清单：URL（网页、文档站、arxiv、GitHub）、本地文件（PDF、EPUB、MD、代码目录）
- 目标读者：初学者 / 中级 / 高级 / 研究者 / 架构师
- 目标字数（默认 8 万字）
- 输出格式：MDX（默认）/ PDF / Nextra 网站 / EPUB / Typst，可组合
- 图表工具偏好：mermaid / plantuml / drawio / excalidraw / chart
- 主语言：中文（默认）/ 英文 / 双语
- 是否需要封面（默认需要）
- GitHub 仓库 URL、站点名、Logo（用于 Nextra 站部署）

若有缺失，**用 AskUserQuestion 简洁询问**，不要一次问超过 4 个问题。

### 阶段 1：资料采集（穷尽式）

按以下顺序穷尽资料，建立 `metadata/sources.md`：

1. **用户提供的 URL/文件**：
   - 网页 -> 用 `WebFetch` 抓正文；若是文档站，遍历 sitemap.xml 或导航栏抓取所有相关页。
   - GitHub 仓库 -> 用 `gh-cli` 读取 README、docs/、examples/、源码关键目录、CHANGELOG、issues/PR 中的设计讨论。
   - arxiv 论文 -> 用 `arxiv-watcher` 获取摘要、全文 PDF；如需相关论文用 `connected-papers-browser`。也可使用 `paper-search`（MCP，`https://github.com/openags/paper-search-mcp`）搜索、下载和阅读来自 arXiv、PubMed、Semantic Scholar 等 20+ 来源的论文。
   - PDF -> 用 `doc2x-cli` 做 OCR/解析为 Markdown；扫描版优先 OCR。
   - EPUB -> 解包后读取 XHTML 章节文本。
   - 本地代码目录 -> 用 SearchCodebase/Grep/Read 分析目录结构、关键模块、入口。
2. **网络补充搜索**：
   - 官方文档未覆盖时，用 `WebSearch` 搜博客、演讲、RFC、设计文档。
   - 交叉验证关键事实，至少 2 个来源。
3. **用户的其他相关 skills** -> 若用户工作区有领域特定 skill（如某框架内部 skill），读取其 SKILL.md 作为领域知识。
4. **用户拥有的其他手段** -> 除上述工具外，也可使用用户环境中可用的其他资料采集方法（如浏览器自动化、MCP 工具、其他已安装的 skills/plugins 等），穷尽一切可用手段获取资料。

每条资料记录：URL/路径、标题、作者/组织、访问日期、使用章节。

### 阶段 2：全景图与章节大纲设计（架构先行）

参考 O'Reilly CookBook 与 Springer Handbook 结构，产出 `metadata/outline.md`：

典型结构（按书的规模缩放，短篇手册可精简）：

```text
00 前言、目标读者、阅读路线、致谢
01 领域/项目全景图（含一张总览架构图，必读）
02 基础概念与术语
03 快速开始 / Hello World / 最小可运行示例
04 安装、环境、构建系统
05 核心概念与编程模型
06 整体架构（架构图）
07 关键模块/子系统深度解析（分多章）
08 核心调用链/生命周期/数据流（时序图/流程图）
09 配置、扩展、插件机制
10 实战 Recipes（至少 10–20 个任务导向案例）
11 性能、安全、可观测性、错误处理
12 测试与调试
13 部署与生产实践
14 生态、对比、路线图
15 总结与展望
附录 A API/配置速查表
附录 B 术语表
附录 C 参考资料
```

每章在大纲中写明：

- 章节目标（读者读完能做什么）
- 在全书中的位置（与哪些章相互引用）
- 预估字数
- 必含图表/表格/代码块数
- 依赖的来源资料

**必须用 AskUserQuestion 把 outline.md 发给用户确认后再进入写作阶段。**

### 阶段 3：逐章 MDX 写作（权威中间格式）

每章一个 `.mdx` 文件，放入 `mdx/`。章节命名规则 `chNN-slug.mdx`，附录 `appendix-X-slug.mdx`。

#### MDX frontmatter 规范

```mdx
---
title: "第 1 章 项目全景图"
chapter: 1
slug: "ch01-overview"
wordCountTarget: 4000
status: "draft"
references:
  - "https://example.com/docs"
  - "sources.md#section-1"
---
```

#### 章节内部结构（必须遵循）

参考 `references/style-guide-oreilly.md` 与 `references/style-guide-springer.md`，每章按如下模板组织（来自 `assets/template-mdx/chapter-template.mdx`）：

1. **章节引入（Why this matters）**：告诉读者为什么需要这一章，解决什么问题，这一章在整体中的位置（链接到全景图章）。
2. **本章地图（Chapter Map）**：用 callout 卡片列出章内小节结构。
3. **正文小节**：每个小节：
   - 原理（Why / How it works）
   - 实用（How to use it / 代码示例，**代码必须带中文注释**）
   - 表格（对比、参数、配置项）
   - 图（mermaid/plantuml/drawio/excalidraw/chart）
   - 关键术语（首次出现加粗）
4. **Recipes**（可选但推荐）：任务导向的小案例，包含 Problem / Solution / Discussion / See Also。
5. **常见陷阱（Pitfalls）**：callout 警告框，列出踩坑点。
6. **章节总结（Key Points）**：callout 要点框，3–7 条要点。
7. **延伸阅读（See also）**：指向其他章节与外部资料。
8. **参考文献**：章末列出本章引用的 sources 条目。

#### 图表规范

**图表生成规则**：在撰写章节内容时，使用 Task 工具调用子 agent 生成图表。子 agent 根据章节内容需求，生成 mermaid/plantuml/drawio/excalidraw/chart 等类型的图表源码，并将源码保存到 `mdx/public/diagrams-src/` 目录。**所有图表必须保留原始格式源码，同时渲染为 SVG 或 PNG 格式后引用到 MDX、EPUB、LaTeX、Typst 中。**

图表类型与处理方式：

- mermaid：源码存 `mdx/public/diagrams-src/*.mmd`；MDX 中保留 ` ```mermaid ` 代码围栏（Nextra 客户端渲染）；同时通过 `scripts/lib/diagram-renderer.mjs`（Kroki.io）渲染为 SVG 放入 `mdx/public/figures/`，供 PDF/EPUB/Typst 引用。
- plantuml：源码存 `mdx/public/diagrams-src/*.puml`，渲染为 SVG 放入 `mdx/public/figures/`。**渲染后端选择优先级（根据可用工具）：**
  1. **Docker**（推荐，零外网依赖）：`docker run --rm -v <srcDir>:/data -v <outDir>:/out plantuml/plantuml:latest -charset UTF-8 -output /out -tsvg /data/<file>.puml`；每个 .puml 必须含 `skinparam defaultFontName "WenQuanYi Micro Hei"`；渲染脚本必须同时产出"按文件名"与"按 @startuml alias"两份 SVG 以避免 404。
  2. **Kroki.io（远程，opt-in）**：`node scripts/kroki-render.mjs <input.puml> <output.svg>` 走 `https://kroki.io/plantuml/svg/<deflate-base64url>`。注意 Kroki 运行的 PlantUML 版本较旧，不支持 `<style>` CSS 块，必须使用 skinparam 变体。**会把 .puml 源码 POST 到 kroki.io，涉密图不要用。**
  3. 本地 `plantuml.jar`（需要 Java）：离线 fallback。
- drawio：`.drawio` 源码存 `diagrams-src/`，导出为 `.drawio.svg` 放入 `figures/`。
- excalidraw：`.excalidraw` 源码存 `diagrams-src/`，导出 PNG/SVG 放入 `figures/`。
- chart（数据图表）：用 `chart-visualization` skill 生成 PNG/SVG，源码（如 Chart.js 配置 JSON）存 `diagrams-src/`。

**双格式要求**：每张图必须同时保留原始源码（`diagrams-src/`）和渲染产物（`figures/`）。MDX 中 mermaid 可保留代码围栏，其他图表引用渲染后的 SVG/PNG。EPUB/LaTeX/Typst 中所有图表统一引用渲染后的 SVG/PNG。

每张图必须：

- 有编号（如图 1-1）和标题
- 在正文中被引用（"如图 1-1 所示"）
- 有说明段落

#### 表格规范

- 使用标准 GFM markdown 表格（MDX 支持）。
- 宽表用 `<div className="overflow-x-auto">` 包裹。
- 导出到 LaTeX 时自动转为 booktabs/tabularx（由后续脚本处理）。

#### 代码规范

- 使用围栏代码块 + 语言标识（```python / ```typescript 等）。
- 代码必须有中文注释解释关键步骤。
- 代码块可加标题注释（如 `# file: src/core/engine.py`）。
- 长代码（>50 行）拆为多块，每块前后有解释文字。

#### MDX 语法注意

- 正文裸 `<`、`>`、`{`、`}` 必须转义或包在代码块/反引号中。
- 中文段落与英文/数字之间保留半角空格（中英文混排规范）。
- 数学公式：行内 `$E=mc^2$`，块级 `$$...$$`（KaTeX 兼容）。
- 所有跨章引用用 markdown 链接形式：`[见第 3 章](./ch03-xxx.mdx)`。

### 阶段 4：字数统计与补足

写完所有章节后：

- 用脚本统计每章中文字符、英文词数，生成 `metadata/word-count.txt`。
- 若未达目标字数，按以下优先级扩写（禁止空话填充）：
  1. 新增 Recipes（任务导向）
  2. 加深源码/原理分析
  3. 扩展配置项/API 速查表
  4. 增加对比表格、故障排查章节
  5. 补充附录
- 再次统计直到达标或明确说明缺口原因。

### 阶段 5：多格式转换（按用户要求）

按用户指定的输出格式组合，**按需读取**对应子流程文档执行。每种格式独立转换，可并行。

**强制质量检查**：每种格式生成完成后，必须使用 Task 工具启动子 agent 检查该格式的所有输出文件是否有错误并修复。子 agent 的职责：
- 检查文件完整性与语法正确性（编译是否通过、结构是否合规）
- 检查内容完整性（章节是否齐全、图表是否引用正确、公式是否渲染）
- 检查格式规范性（无 Markdown/LaTeX 语法混入 Typst、无残留占位符等）
- 发现错误立即修复，修复后重新验证
- 每种格式的检查与修复可以并行执行

#### 5a. MDX（默认必出）

详见 `references/stage-5a-mdx.md`。

- 直接保留 `mdx/` 目录。
- 生成 `mdx/_meta.ts`（章节顺序 + separator 分组）。
- 图表全部就位：mermaid 保留代码围栏，其他图表渲染为 SVG/PNG。
- 输出 README 说明 MDX 结构与后续转换方法。
- **质量检查**：子 agent 检查所有 MDX 文件 frontmatter 完整性、`_meta.ts` 章节顺序、图表引用路径正确性、代码块语言标识；修复发现的问题。

#### 5b. ElegantBook LaTeX + PDF（LLM 驱动，推荐）

详见 `references/stage-5b-latex.md`。

调用 `elegantbook-latex` skill，使用 **LLM 逐章节转换**流程：
1. 初始化 `latex-pdf/latex/` 工程目录。
2. 对每个 MDX 文件，使用 Task 工具启动子 agent，读取 `assets/prompts/mdx-to-latex.md` 转换规则，输出 `.tex` 章节文件。
3. 使用 `scripts/lmdx2tex.mjs` 组装 main.tex。
4. xelatex 两遍编译出 PDF。
5. **质量检查**：子 agent 检查 LaTeX 编译零 error、PDF 无 Markdown 残留、表格为 LaTeX 环境、代码块为 tcolorbox 样式、封面非空；修复发现的问题后重新编译验证。

#### 5c. Nextra v3 网站

详见 `references/stage-5c-nextra.md`。

1. 从 `assets/nextra-template/` 拷贝骨架到 `nextra-site/`。
2. 运行 `scaffold-nextra.mjs` 替换占位符、拷贝 MDX 和图片。
3. 渲染图表（PlantUML Docker/Kroki，drawio 导出 SVG）。
4. `npm run build` 必须成功；Docker healthy。
5. **质量检查**：子 agent 检查 `npm run build` 零 error、`/zh` 返回 200、所有图表返回 200、MDX 无裸 `<`/`>`、PlantUML 中文无豆腐块；修复发现的问题后重新 build 验证。

#### 5d. EPUB（LLM 驱动，推荐）

详见 `references/stage-5d-epub.md`。

从 `mdx/` 生成 EPUB，使用 **LLM 逐章节转换**流程：
1. 对每个 MDX 文件，使用 Task 工具启动子 agent，读取 `assets/prompts/mdx-to-epub.md` 转换规则，输出 XHTML 章节文件。
2. 使用 `scripts/lbuild-epub.mjs` 组装 EPUB3 结构。
3. CSS 样式（白底黑字、中文字体、代码块 tcolorbox 风格、四色 callout）。
4. 字体子集化嵌入（LXGW WenKai -> WOFF2）。
5. Python zipfile 打包（mimetype STORED 优先）。
6. **质量检查**：子 agent 检查 mimetype 第一且 STORED、所有图片/字体/章节在 manifest 中、XHTML 文件合法 XML、字体子集化嵌入、代码块/表格样式生效；修复发现的问题后重新打包验证。

#### 5e. Typst（ilm 模板，LLM 驱动）

详见 `references/stage-5e-typst.md`。

从 `mdx/` 生成 Typst 工程，使用 **LLM 逐章节转换**流程：
1. 运行 `scripts/lmdx2typst.mjs --title "书名" --author "作者"` 初始化工程、生成 prompt 文件和占位符。
2. 对每个 MDX 文件，使用 Task 工具启动子 agent，读取 `assets/prompts/mdx-to-typst.md` 转换规则，输出 `.typ` 章节文件（Typst 原生语法，严禁混用 LaTeX 语法）。
3. 重新运行 `scripts/lmdx2typst.mjs` 组装最终 `main.typ`（使用 ilm 模板，中文字体 LXGW WenKai、代码块圆角边框、四色 callout 提示框）。
4. 编译：`cd typst && typst compile main.typ`。
5. **质量检查**：子 agent 检查 typst compile 零 error、无 Markdown/LaTeX 语法残留、数学公式使用 Typst 原生语法、表格使用 `table()` + `table.hline()`、中文字体正确配置、无残留占位符；修复发现的问题后重新编译验证。

模板样式优化（基于 ilm 模板）：
- 中文字体：LXGW WenKai + 回退栈
- 代码字体：LXGW WenKai Mono + 回退栈
- 行内代码：浅灰背景 + 圆角
- 块级代码：浅灰背景 + 灰色边框 + 圆角
- Callout 提示框：四色左边框（蓝/橙/红/绿）
- 表格：booktabs 风格（table.hline 粗细线）
- 图片：70% 宽度居中 + caption
- 启用插图索引、表格索引、代码索引

### 阶段 6：最终交付

1. 在 `metadata/word-count.txt` 写入最终统计（中文字符、英文词数、估算总字、章节数、Recipe、表格、代码块、图表数）。
2. 在 `metadata/sources.md` 列出所有参考资料。
3. 在根目录写中英文 README（见下文）。
4. 清理中间构建目录（`epub/build/`、`latex/latex/.aux` 等）。
5. 最终回复给用户：
   - 各输出格式子文件夹链接
   - 章节数 / 字数 / 图表数统计
   - 本地预览命令（Nextra：`cd nextra-site && npm install && npm run dev`；PDF：直接打开 PDF；EPUB：直接打开；Typst：`cd typst && typst compile main.typ`）
   - 未完成项/资料限制说明

---

## 强制质量闸门

交付前必须逐项打勾：

- [ ] 所有用户提供资料已处理（或明确说明无法访问原因）
- [ ] 大纲已与用户对齐
- [ ] 每章一个 MDX，frontmatter 完整
- [ ] 每章都有引入、章节地图、要点总结、延伸阅读
- [ ] 代码块全部带语言标识 + 关键中文注释
- [ ] 图表全部有编号、标题、正文引用、说明段落
- [ ] 表格无裸 LaTeX/Markdown 残留（在 MDX 阶段用 GFM 表格）
- [ ] 跨章引用都是可点击 markdown 链接
- [ ] 字数达标或明确说明缺口
- [ ] `metadata/sources.md` 记录所有参考资料
- [ ] MDX 输出存在且 `_meta.ts` 章节顺序正确
- [ ] 若输出 LaTeX/PDF：xelatex 两遍编译成功；封面 1280×1024 非空；PDF 无 Markdown 残留
- [ ] 若输出 Nextra：`npm run build` 成功；Docker healthy；`/zh` 200；所有图表 200
- [ ] 若输出 EPUB：zip 结构合规；mimetype 第一且 STORED；字体子集化嵌入；代码块/表格样式生效
- [ ] 若输出 Typst：typst compile 零 error；无 Markdown/LaTeX 语法残留；数学公式使用 Typst 原生语法；表格使用 table() + table.hline()；中文字体正确配置

---

## 中英文 README 要求

每个生成的书籍项目根目录必须包含：

- `README.md`（中文）：简介、目录、本地产出、格式说明、贡献指南
- `README.en.md`（英文）：同上英文版
- 若输出 Nextra：`DEPLOY.md` 说明 GitHub/Vercel/Docker 部署

本 Skill 自身目录包含：

- `SKILL.md`（本文件，英文 description，中文正文）
- `README.md`（中文，skill 自身使用说明）
- `README.en.md`（英文）

---

## 常见失败点速查

| 现象 | 根因 | 处理 |
|---|---|---|
| PlantUML 中文豆腐块 □□□ | .puml 未声明 CJK 字体 | 每个 .puml 加 `skinparam defaultFontName "WenQuanYi Micro Hei"` |
| PlantUML 图引用 404 | 输出名按 `@startuml NAME` 不按文件名 | 渲染脚本产出文件名 + alias 双份 |
| Nextra 构建 MDX 解析错误 `<` | 正文裸 `<` 被识别为 JSX | 转义 `&lt;`/`&gt;` 或包反引号 |
| Nextra `npm run build` i18n 告警 | Nextra pages/zh + Next.js i18n 同存 | 已知告警，可忽略 |
| Docker 构建后容器秒挂 | `next.config.mjs` 未设 `output: 'standalone'` | 开启 standalone；Dockerfile COPY public/ |
| EPUB 文字变白看不见 | 阅读器误触发 dark scheme | 强制白底黑字 `!important`；删掉 dark media 块 |
| EPUB 嵌入字体让书变 30MB | 用了完整 TTF | fontTools 子集化转 WOFF2，单字体 ~300KB |
| EPUB 打包后打不开 | mimetype 不是第一/被压缩 | 必须 Python zipfile，mimetype STORED 优先写入 |
| PDF 出现 `\| --- \|` Markdown 表格 | 未转 LaTeX 表格 | mdx2tex 脚本必须把 GFM 表格转为 booktabs/tabularx |
| PDF 封面空白 | 图片不存在/尺寸错 | 严格 1280×1024；验证文件存在 + PDF 首页非空 |
| 跨章引用"第 N 章"编号错乱 | reading order ≠ 文件名 | 跑 renumber-content.mjs 链接化 |
| 字数不够 8 万 | 只写了使用文档没深入原理/源码 | 扩写 Recipes、源码解析、配置速查、附录 |
| 资料受限无法抓取 | 网站有反爬/登录墙 | 不绕过限制；改用可访问来源并告知用户 |
| Typst 编译报错 `unknown variable` | 混用了 LaTeX 语法 | 检查公式用 Typst 原生语法（`$ frac(a,b) $` 而非 `$\frac{a}{b}$`） |
| Typst 中文显示豆腐块 | 未配置中文字体 | main.typ 中设置 `font: ("LXGW WenKai", "Noto Serif CJK SC", ...)` |
| Typst 表格无横线 | 未使用 table.hline | 添加 `table.hline(y: 0, stroke: 1.2pt)` 顶线 + `table.hline(stroke: 0.6pt)` 中线 |
| 图表在 PDF/EPUB 中不显示 | 只保留了源码未渲染 | 必须同时渲染 SVG/PNG 到 figures/ 并在正文中引用 |

---

## 推荐执行清单（Todo 模板）

执行时用 TodoWrite 建立：

```text
0. 识别输入：主题、资料、读者、字数、输出格式、图表偏好、语言、封面、部署参数
1. 穷尽式资料采集（URL/GitHub/arxiv/PDF/EPUB/本地目录/网络补充）-> metadata/sources.md
2. 设计章节大纲（含全景图、每章目标/字数/图表/来源）-> metadata/outline.md
3. AskUserQuestion 与用户对齐 outline
4. 准备封面图片（1280×1024，记录来源）
5. 逐章写作 mdx/*.mdx（含引入/地图/原理/实用/Recipes/陷阱/要点/延伸阅读）
6. 生成 mdx/public/diagrams-src/ 下的图表源 + 渲染到 mdx/public/figures/
7. 字数统计；不足则扩写
8. 生成 mdx/_meta.ts
9a. [可选] **LLM 驱动** MDX -> ElegantBook LaTeX（scripts/lmdx2tex.mjs + Task 子 agent 逐章转换），xelatex 两遍编译出 PDF。详见 references/stage-5b-latex.md
9b. [可选] 初始化 Nextra 站点，拷贝 mdx，渲染图表，npm run build + Docker 验证。详见 references/stage-5c-nextra.md
9c. [可选] **LLM 驱动** MDX -> EPUB（scripts/lbuild-epub.mjs + Task 子 agent 逐章转换），子集化字体，Python 打包，自检。详见 references/stage-5d-epub.md
9d. [可选] **LLM 驱动** MDX -> Typst（scripts/lmdx2typst.mjs + Task 子 agent 逐章转换），typst compile 出 PDF。详见 references/stage-5e-typst.md
10. 写中英文 README + DEPLOY.md（若有 Nextra）
11. 清理中间目录，输出最终交付链接 + 统计报告
```

---

## 示例用户请求

```text
请基于 https://docs.dapr.io/ 和 GitHub 仓库 dapr/dapr，
以及《Dapr 实战》PDF 这本书，
生成一本 10 万字的 Dapr CookBook，
目标读者是中高级后端开发者，
输出 MDX + PDF + Nextra 网站 + Typst，
图表用 plantuml 和 mermaid，
需要封面，网站名 Dapr CookBook，
部署到 Vercel。
```

执行：按上述阶段 0–6 全流程，最终交付 `Dapr-CookBook/{mdx,latex-pdf,nextra-site,typst}/`。

---

## 禁止事项

- 不要把所有章写在一个 MDX 文件里 -- 必须每章独立。
- 不要跳过"大纲与用户对齐"直接开写。
- 不要忽略用户提供的任何资料（无法访问需明确说明）。
- 不要生成空话/凑字数段落；扩写必须是源码/Recipe/速查表。
- 不要用 PowerShell `Compress-Archive` 打包 EPUB（必须 Python zipfile）。
- 不要在 EPUB 里写复杂 flex/grid。
- 不要在 PDF 中保留 Markdown 表格/围栏源码。
- 不要使用 plantuml skill 自带 PS1 脚本（GBK locale 会失败），直接 `docker run plantuml/plantuml:latest`。
- 不要在 Typst 输出中混用 LaTeX 语法（如 `$$...$$`、`\frac{}{}`、`\begin{}` 等），必须使用 Typst 原生语法。
- 不要在 Typst 输出中使用 Markdown 语法（如 `#` 标题、`**bold**`、`*italic*` 等）。
- 不要在生成图表时只保留渲染产物而不保留原始源码（必须同时存 `diagrams-src/` 和 `figures/`）。
- 不要擅自 commit/发布到 GitHub，除非用户明确要求。
