# 阶段 5e：Typst（ilm 模板，LLM 驱动）

从 `mdx/` 权威内容生成 Typst 工程，使用 **LLM 逐章节转换**流程。

## 模板

使用 ilm 模板（`@preview/ilm:2.1.1`），样式优化如下：
- **中文字体**：LXGW WenKai（霞鹜文楷）+ Noto Serif CJK SC / Source Han Serif SC / SimSun 回退栈
- **代码字体**：LXGW WenKai Mono + DejaVu Sans Mono / Source Code Pro / Consolas 回退栈
- **行内代码**：浅灰背景（luma 240）+ 2pt 圆角
- **块级代码**：浅灰背景（luma 245）+ 1pt 灰色边框（`#444`）+ 4pt 圆角 + 10pt 内边距
- **Callout 提示框**：四色左边框（4pt）+ 浅色背景 + 圆角
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

三段能力：

1. **静态 lint**（默认执行）：检查 Markdown/LaTeX 残留（`$$`、`\frac`、`#` 标题、`**粗体**`、Markdown 表格/链接）、数学块内裸中文/裸缩写、`diff`/`cdot`/`matrix` 等易错符号、数学调用参数漏 `#`、占位符残留、图片路径存在性 -> 写 `typst/_lint_report.json`
2. **`--fix` 固化规则自动修复**：只作用于数学块（引号保护、长模式先于短前缀），包括 `\frac{a}{b}` -> `frac(a, b)`、`\left|\right` 剥离、`diff` -> `dif`、`cdot` -> `dot.c`、`cdots` -> `dots.c`、`matrix(` -> `mat(`、`langle/rangle` -> `⟨⟩`、数学内裸中文/缩写自动加引号、`limits: true` -> `limits: #true`、`augment: 2` -> `augment: #2`、`delim: ("(",")")` -> `delim: #("(",")")`、图片路径 `figures/` -> `../figures/`（存在时）。绝不碰正文、代码块、注释
3. **`--compile` 每章独立 probe 并行编译**：每章生成 `_probe/p-<slug>.typ`（复用 main.typ 导言 + include 单章），并行编译，N 章错误一次全部暴露 -> 写 `typst/_check_report.json`（`{"passed": [...], "failed": {slug: [{line, col, message}]}}`）

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
├── main.typ                    # 主文件（ilm 模板 + 章节引用）
├── callout.typ                 # callout-box 提示框模块（章节首行 import）
├── chapters/
│   ├── ch00-overview.typ
│   ├── ch01-xxx.typ
│   └── ...
├── figures/                    # 图片（SVG/PNG）
├── _lint_report.json           # 静态检查报告（typst-check.mjs 产出）
├── _check_report.json          # 编译检查报告（typst-check.mjs --compile 产出）
└── .conversion-plan.json       # LLM 转换任务清单
```
