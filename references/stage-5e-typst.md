# 阶段 5e：Typst（ilm 模板，LLM 驱动）

从 `mdx/` 权威内容生成 Typst 工程，使用 **LLM 逐章节转换**流程。

## 配置驱动（P1-4）

排版规则集中在 `assets/typst-default.config.json`，由 `lmdx2typst.mjs`（生成 main.typ / callout.typ / prompt 片段）与 `typst-check.mjs`（`--fix` 优化 pass + lint 规则开关）共同消费。**改模板行为改配置，不改脚本**。

配置解析顺序：`--config <path>` > 工作目录 `typst.config.json` > `assets/typst-default.config.json`（默认）。项目级覆盖只需在工作目录放一份 `typst.config.json`。

可配置项（节选）：
- `headings`：`autoNumber`（模板自动编号）、`level1Pattern`（如 `第 {n} 章`）、`numbering`（如 `1.1`）、`stripManualNumbers`（优化器剥离 LLM 手动编号）
- `figures` / `tables`：`autoNumber`、`numbering`（如 `1-1` 即 图 C-S）、`supplement`（图/表）、`labelPrefix`（fig/tab）、`autoLabel`（优化器注入 `<fig-C-S>`）、`stripCaptionPrefix`（剥离 caption 里与自身编号一致的前缀）、`tables.splitThreshold`（长表自动注入 `breakable: true` 的行数阈值，默认 12）
- `callout.palette`：四色 fill/stroke/icon；`callout.types`：callout 类型 -> 颜色 + 默认标题
- `fonts`：正文/代码字体回退栈与字号

**编号统一约定**：章号 C 取 main.typ 的 include 顺序（第 1 个被 include 的章 = 1），与模板 `counter(heading)` 渲染出的「第 C 章 / C.S / 图 C-S」天然一致。

## 模板

使用 ilm 模板（`@preview/ilm:2.1.1`），样式由配置驱动，默认值如下：
- **中文字体**：LXGW WenKai（霞鹜文楷）+ Noto Serif CJK SC / Source Han Serif SC / SimSun 回退栈
- **代码字体**：LXGW WenKai Mono + DejaVu Sans Mono / Source Code Pro / Consolas 回退栈
- **行内代码**：浅灰背景（luma 240）+ 2pt 圆角
- **块级代码**：浅灰背景（luma 245）+ 1pt 灰色边框（`#444`）+ 4pt 圆角 + 10pt 内边距
- **标题/图表编号**：模板自动生成（`第 C 章`、`C.S`、`图 C-S`、`表 C-S`），LLM 输出的手动编号由优化器剥离（见下文 P0-1/P0-2）
- **Callout 提示框**：四色左边框（4pt）+ 浅色背景 + 圆角，调色板来自 `callout.palette` 配置
  - 蓝（`#3b82f6`）：本章地图
  - 橙（`#f59e0b`）：Recipe
  - 红（`#ef4444`）：陷阱
  - 绿（`#22c55e`）：核心要点
- **表格**：booktabs 风格（`table.hline` 粗顶线 1.2pt + 细中线 0.6pt + 粗底线 1.2pt）
- **图片**：70% 宽度居中 + caption
- **索引**：启用插图索引、表格索引、代码索引

## 步骤

### 1. 运行转换脚本

```bash
node scripts/lmdx2typst.mjs --title "书名" --author "作者"
```

脚本会：
- 读取 `mdx/*.mdx` 文件
- 预处理 mermaid/plantuml 代码块，渲染为 SVG
- 为每章生成 prompt 文件（`typst/chapters/._prompt_<slug>.txt`）
- 写入占位符 `.typ` 文件（首行 `#import "../callout.typ": callout-box`）
- 拷贝图片到 `typst/figures/`
- 生成 `typst/main.typ`（基于 `assets/ilm-template.typ.txt` 模板）与 `typst/callout.typ`（基于 `assets/ilm-callout.typ.txt`，callout-box 提示框模块）
- 输出 `typst/.conversion-plan.json` 任务清单

**注意**：Typst 的 `#include` 不继承 main.typ 的 `#let` 词法作用域，因此 callout-box 必须放在独立模块，章节文件首行 `#import "../callout.typ": callout-box` 自行导入；图片路径必须写 `../figures/<name>`（相对章节文件解析）。

### 2. LLM 逐章节转换（核心步骤，使用 Task 工具调用子 agent）

对每个 `mdx/*.mdx` 文件，使用 Task 工具启动子 agent：
- 子 agent 读取 `assets/prompts/mdx-to-typst.md` 转换规则
- 子 agent 读取对应的 prompt 文件（含 MDX 源文件）
- 子 agent 输出高质量 Typst 代码到 `typst/chapters/<slug>.typ`
- **关键**：每个章节独立转换，LLM 正确理解语义结构并转为 Typst 原生语法

LLM 转换的优势：
- ✅ Callout 卡片（JSX div）正确转为 `callout-box()` 函数调用
- ✅ 代码块原样保留在 Typst raw text 中，不转义内部字符
- ✅ 数学公式正确转为 Typst 数学模式（`$...$` 行内、`$ ... $` 块级）
- ✅ GFM 表格正确转为 `table()` + `table.hline()` booktabs 风格
- ✅ 图片路径正确转换，caption 提取准确
- ✅ 行内格式（粗体 `*...*`、斜体 `_..._`、代码 `` `...` ``）语义正确转换
- ✅ 专业术语翻译为 `中文术语（English Term）` 格式
- ✅ 标题层级使用 Typst 原生 `=` `==` `===` 语法
- ✅ 严禁混用 LaTeX 语法（`$$...$$`、`\frac{}{}` 等）

### 3. 重新运行脚本组装最终 main.typ

```bash
node scripts/lmdx2typst.mjs --title "书名" --author "作者"
```

脚本此时会对全部已转换章节做**快速静态 lint**（零依赖、秒级），并在 `.conversion-plan.json` 的 `lintIssues` 字段输出问题清单。

### 4. 检查与修复循环（check ⇄ fix，≤ 3 轮）-- 借鉴 pdf-to-typst-notes

**不要**直接反复编译整本 main.typ（一次只报第一个错、串行低效）。使用 `scripts/typst-check.mjs`：

```bash
# 一步到位：静态 lint + 固化规则自动修复 + 每章独立 probe 并行编译
node scripts/typst-check.mjs --project typst --fix --compile
```

检查器会把 ilm 模板作为硬闸门：`typst/main.typ` 必须同时包含
`@preview/ilm:<version>` 导入和 `#show: ilm.with(...)`。如果已有项目的
`main.typ` 被覆盖或损坏，带 `--fix` 运行时会重新调用 `lmdx2typst.mjs` 组装入口，
依据现有 `mdx/` 与章节文件重新补充 `main.typ`/`callout.typ`；不带 `--fix` 则直接失败，
避免不使用 ilm 的项目被误判为合格。

三段能力：

1. **静态 lint**（默认执行）：检查 Markdown/LaTeX 残留（`$$`、`\frac`、`#` 标题、`**粗体**`、Markdown 表格/链接）、数学块内裸中文/裸缩写、`diff`/`cdot`/`matrix` 等易错符号、数学调用参数漏 `#`、占位符残留、图片路径存在性、表格质量（hline 重复/越界、单元格数与列数一致性、长表格分页）、callout 健壮性（内容块 `[ ]` 闭合、颜色键合法、参数个数、嵌套警告）、章节引用完整性（正文「第 N 章」引用不存在的章号告警）、代码块质量（>60 字符长行溢出告警、正文裸 `@` 未转义）-> 写 `typst/_lint_report.json`
2. **`--fix` 自动修复 + 确定性优化**（幂等，重复运行零改动）：
   - **数学块固化规则**：只作用于数学块（引号保护、长模式先于短前缀），包括 `\frac{a}{b}` -> `frac(a, b)`、`\left|\right` 剥离、`diff` -> `dif`、`cdot` -> `dot.c`、`cdots` -> `dots.c`、`matrix(` -> `mat(`、`langle/rangle` -> `⟨⟩`、`\oplus`/`\rightarrow`/`\geq` 等符号映射（P1-3）、数学内裸中文/缩写自动加引号、`limits: true` -> `limits: #true`、`augment: 2` -> `augment: #2`、`delim: ("(",")")` -> `delim: #("(",")")`、图片路径 `figures/` -> `../figures/`（存在时）。绝不碰正文、代码块、注释
   - **确定性优化器**（`scripts/lib/typst-optimize.mjs`，配置驱动）：
     - **P0-1 标题手动编号剥离**：`第 1 章 概述` -> `概述`、`1.2 变量` -> `变量`——编号交给模板 `set heading(numbering: ...)` 自动生成，杜绝「第 1 章 第 1 章」双编号
     - **P0-2 figure label 自动化**：为 `#figure(image(...))` 注入 `<fig-C-S>`、为 `#figure(table(...))` 注入 `<tab-C-S>`（C=章号按 include 顺序、S=章内序号），并剥离 caption 里与自身编号一致的前缀（`图 1-1 数据流` -> `数据流`）
     - **P0-2 引用转换**：正文纯文本引用「图 C-S / 表 C-S」在对应 label 存在时转为 `@fig-C-S` 交叉引用（渲染自动带编号与超链接）；label/引用是全局语义，此 pass 覆盖 chapters/ 全部章节（不受 `--only` 影响），跨章引用（ch02 引 ch01 的图）正常解析，probe 编译会过滤「label 在其他章存在」的误报
     - **P1-1 章节标题 label + 引用**：为一等标题注入 `<ch-<slug>>`、二级及以下注入 `<sec-<slug>-<seq>>`（供跳转锚点与 TOC）；正文「第 N 章」纯文本引用在对应章节 label 存在时转为 `@ch-<slug>`（标题行不转，避免误伤章标题）；引用不存在的章号由 lint 的 `chapter-ref` 兜底
3. **`--compile` 每章独立 probe 并行编译**：每章生成 `_probe/p-<slug>.typ`（复用 main.typ 导言 + include 单章），并行编译，N 章错误一次全部暴露 -> 写 `typst/_check_report.json`（`{"passed": [...], "failed": {slug: [{line, col, message, suggestion}]}}`）；错误信息经 P1-5 知识库映射，逐条附带一线修复建议 `suggestion`
4. **`typst-fonts-check.mjs`（P1-4 字体预检）**：`node scripts/typst-fonts-check.mjs` 运行 `typst fonts` 与配置 `fonts` 栈比对，报告缺失字体（编译前跑一次可避免中文豆腐块）

修复顺序：

1. 先跑 `--fix`（已知规则自动修）；
2. 规则修不掉的：读 `_lint_report.json` / `_check_report.json` 的 failed，按章对照 MDX 原文交给子 agent 修（截断的 URL、语义级公式重组等）；
3. 复查单章：`node scripts/typst-check.mjs --project typst --compile --only <slug>`；
4. check ⇄ fix 循环 **≤ 3 轮**，超限章节单独人工介入。

### 5. 编译

```bash
cd typst && typst compile main.typ
```

或使用 Typst Web App：`https://typst.app/`

### 6. 质量闸门

- [ ] `typst-check.mjs --fix --compile` 退出码 0（全部章节 probe 编译通过）
- [ ] Typst 编译零 error
- [ ] 不包含 Markdown 语法残留（`#` 标题、`**bold**` 等）
- [ ] 不包含 LaTeX 语法残留（`$$...$$`、`\frac{}{}` 等）
- [ ] 数学公式使用 Typst 原生语法；数学块内无裸中文/裸缩写；数学调用参数 `#` 前缀齐全
- [ ] 标题无手动编号残留（`第 C 章`/`C.S` 由模板自动生成，不出现「第 1 章 第 1 章」双编号）
- [ ] 每个 `#figure` 都有 label（`<fig-C-S>`/`<tab-C-S>`），caption 无与自身编号重复的前缀
- [ ] 正文对图表的引用使用 `@fig-C-S`/`@tab-C-S` 交叉引用（无悬空引用；probe 编译零 `label does not exist` 错误）
- [ ] 优化器幂等：重跑 `--fix` 后章节文件哈希不变（0 处变更）
- [ ] 标题已注入 `<ch-<slug>>`/`<sec-<slug>-<seq>>` label；正文「第 N 章」引用不指向不存在的章号
- [ ] 代码块无 >60 字符长行；正文裸 `@` 已转义为 `\@`
- [ ] 编译错误在 `_check_report.json` 中带 `suggestion` 修复建议
- [ ] 字体预检 `typst-fonts-check.mjs` 通过（字体栈无缺失）
- [ ] 表格使用 `table()` + `table.hline()` booktabs 风格
- [ ] 图片使用 `#figure(image("../figures/...", ...), caption: [...])` 语法
- [ ] Callout 使用 `callout-box()` 函数
- [ ] 中文字体正确配置
- [ ] 代码块样式生效（灰色背景 + 圆角边框）
- [ ] 插图/表格/代码索引生成正确
- [ ] 无 `LLM_CONVERSION_PENDING` 占位符残留

### 7. 质量检查与修复（子 agent）

生成完成后，使用 Task 工具启动子 agent 检查所有输出文件：
- 运行 `node scripts/typst-check.mjs --project typst --fix --compile`，确认退出码 0
- 检查 `_lint_report.json` / `_check_report.json` 是否为空，不空则按章修复后复查
- 检查中文字体正确配置、无残留占位符、图片引用路径正确（`../figures/`）
- 修复后重新编译验证

## 图表处理

- mermaid/plantuml 代码块由 `scripts/lib/diagram-renderer.mjs` 预处理渲染为 SVG
- 渲染后的 SVG 拷贝到 `typst/figures/`
- 在 Typst 中通过 `#figure(image("figures/xxx.svg", width: 70%), caption: [...])` 引用
- drawio/excalidraw/chart 图表同样导出为 SVG/PNG 后引用
- 原始图表源码保留在 `mdx/public/diagrams-src/`（Typst 工程不单独保留源码目录）

## 输出目录结构

```text
typst/
├── main.typ                    # 主文件（ilm 模板 + 章节引用，编号规则由配置生成）
├── callout.typ                 # callout-box 提示框模块（章节首行 import，调色板由配置生成）
├── chapters/
│   ├── ch00-overview.typ       # 标题无手动编号；figure 带 <fig-C-S> label；引用用 @fig-C-S
│   ├── ch01-xxx.typ
│   └── ...
├── figures/                    # 图片（SVG/PNG）
├── _lint_report.json           # 静态检查报告（typst-check.mjs 产出）
├── _check_report.json          # 编译检查报告（typst-check.mjs --compile 产出）
├── .conversion-plan.json       # LLM 转换任务清单
└── .typst-project.json         # 工程清单（章节顺序 + 内嵌配置快照）
```

## 常见坑

- **图号变「图 0-1」**：figure 编号里取章号必须用元素类型计数器 `counter(heading)`（标题实际步进的计数器）；`counter("heading")` 是同名字符串自定义计数器、永远为 0。
- **跨章引用 probe 误报**：单章 probe 编译时引用其他章的 label 会报 `label does not exist`；typst-check.mjs 已收集全章 label 集合过滤此类误报，勿手工「修复」。
- **手动编号双编号**：LLM 转换常把 MDX 里的「第 1 章」带进标题；模板自动编号 + 优化器剥离（P0-1）双保险，不要在 prompt 里要求 LLM 自己编号。
- **配置不生效**：确认配置解析顺序（`--config` > 工作目录 `typst.config.json` > 默认），并检查 `main.typ` 是否由配置重新生成（改配置后需重跑 `lmdx2typst.mjs` 组装）。
- **长表格溢出页面**：Typst table 没有 `split` 参数，分页开关是 `breakable: true`（0.14+）；且 figure 默认不可断页。模板已加 `#show figure.where(kind: table): set block(breakable: true)`，超阈值长表由优化器注入 `breakable`，两处配合才能跨页。
- **`cannot place horizontal line` / hline 叠加**：`table.hline` 的 y 重复或超出总行数（合法 0..rows，rows 为表底线）；lint 规则 `table-hline-duplicate` / `table-hline-out-of-range` 会定位到具体行号。
- **callout 报 `expected closing bracket` / `missing argument: body`**：内容块 `[ ]` 嵌套括号失衡未闭合；或只传了颜色键一个参数（尾部内容块被误当 title-text）。缺标题 `--fix` 自动补；未闭合块按 lint 行号人工配平。
- **callout 报 `unknown variable: pitfall`**：颜色参数写了类型名而非调色板键。`--fix` 按 `callout.types` 映射（pitfall→red、recipe→orange…）；完全未知的键报错不动，人工确认语义。
- **章节引用章号写错 / 转成 @ 失败**：正文「第 N 章」若 N 不在 include 顺序内，lint 报 `chapter-ref`；能解析到章节 label 时 `--fix` 自动转 `@ch-<slug>`。章标题本身（`= 第 N 章`）不会被转换——那是标题文本，不是引用。
- **正文裸 `@` 编译报错**：Typst 中 `@` 必跟 label 名，普通 `@`（如风球标记）需写成 `\@`；lint 规则 `code-bare-at` 会定位（邮箱等 `@` 后跟字母的不误报）。
- **符号 `\oplus`/`\rightarrow` 报 unknown variable**：0.14+ 对 LaTeX 命令名支持不稳；`--fix` 数学规则会替换为 Typst 原生符号（⊕/→/≥…）。
- **编译报错人工定位慢**：`_check_report.json` 每条错误已带 `suggestion`（P1-5 知识库映射），直接按建议修即可，不必全凭经验。
