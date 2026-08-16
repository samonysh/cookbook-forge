# 阶段 5b：ElegantBook LaTeX + PDF（LLM 驱动，推荐）

调用 `elegantbook-latex` skill，使用 **LLM 逐章节转换**流程。

## 步骤

### 1. 初始化工程目录

在 `latex-pdf/latex/` 下创建标准结构：
- `main.tex`（使用 `assets/elegantbook-main.template.tex.txt` 模板）
- `chapters/` 每章一个 `.tex`（由 LLM 生成）
- `figures/` 图片（从 `mdx/public/figures/` 拷贝）
- `diagrams/` 图表源文件
- `metadata/` 元数据

### 2. LLM 逐章节转换（核心步骤，使用 Task 工具调用子 agent）

对每个 `mdx/*.mdx` 文件，使用 Task 工具启动子 agent：
- 子 agent 读取 `assets/prompts/mdx-to-latex.md` 转换规则
- 子 agent 读取对应的 MDX 源文件
- 子 agent 输出高质量 LaTeX 代码到 `chapters/<slug>.tex`
- **关键**：每个章节独立转换，LLM 能够正确理解语义结构（callout、代码、公式、表格、图片）

逐章转换的优势对比脚本转换：
- ✅ Callout 卡片（JSX div）正确转为 tcolorbox，标题提取准确
- ✅ 代码块原样保留在 verbatim 环境中，不转义内部字符
- ✅ 公式 $...$ 和 $$...$$ 正确识别并保留
- ✅ GFM 表格正确转为 booktabs/tabularx，列数自动匹配
- ✅ 图片路径正确转换，caption 提取准确
- ✅ 行内格式（粗体、斜体、代码、链接）语义正确转换
- ✅ LaTeX 特殊字符仅在纯文本中转义，不污染代码/公式

### 3. 组装 main.tex

使用 `scripts/lmdx2tex.mjs` 或手工将 `\input{chapters/xxx}` 写入 main.tex。

### 4. 样式优化

main.tex 基于 ElegantBook 文档类，已优化：
- codeblock 环境（listings + tcolorbox，灰色背景+圆角边框）
- callout tcolorbox（蓝/黄/红/绿四色对应 chapteroutline/recipe/pitfall/keypoints）
- booktabs 表格（`\arraystretch=1.25`，`\tabcolsep=5pt`）
- hyperref 蓝色链接
- 图形路径 `\graphicspath{{figures/}}`
- 防止孤行寡行

### 5. 并行质量检查（check ⇄ fix，≤3 轮）

使用 `scripts/latex-check.mjs`（与 Typst 流程同模式，以章节为单位并行暴露全部问题）：

```bash
node scripts/latex-check.mjs --project latex --fix --compile
```

- **静态 lint**（`scripts/lib/latex-lint.mjs`）：Markdown 标题/粗体/表格残留、环境配对（`\begin`/`\end`）、花括号平衡、图片文件存在性；跳过 verbatim/lstlisting 内容
- **`--fix` 安全修复**：`**x**` -> `\textbf{x}`、`[text](url)` -> `\href{url}{text}`（跳过注释与代码块）
- **`--compile` 每章 probe 并行编译**：为每章生成 probe.tex（复用 main.tex 导言 + `\input` 单章），并行 xelatex，N 章错误一次全部暴露（`_check_report.json`，含行号）
- 规则修不掉的按章对照 MDX 原文交给子 agent 修，复查：`node scripts/latex-check.mjs --project latex --compile --only <slug>`

**模板注意**：`elegantbook.cls` 已 `\RequirePackage[many]{tcolorbox}`，main.tex 中**禁止再** `\usepackage[...]{tcolorbox}`（option clash）；所需库用幂等的 `\tcbuselibrary{...}` 声明。

### 6. 整书编译

ElegantBook 文档类依赖 `elegantbook.cls`，需要先准备好 cls 文件：
- **TeXLive/MiKTeX 用户**：`tlmgr install elegantbook`（或在 TeXLive Manager 中搜索安装）
- **手动获取**：从 [ElegantLaTeX/elegantbook](https://github.com/ElegantLaTeX/elegantbook) 下载 `elegantbook.cls`，复制到 `latex/` 目录
- 准备好后运行：`cd latex && xelatex main.tex && xelatex main.tex`（两遍以生成目录/交叉引用）

### 7. 质量闸门

- [ ] `latex-check.mjs --fix --compile` 退出码 0（每章 probe 编译全通过）
- [ ] PDF 不得出现 Markdown 表格源码
- [ ] 表格必须 LaTeX 环境，不得过挤
- [ ] 代码块必须 tcolorbox/listings 样式
- [ ] 封面非空
- [ ] 字数达标
- [ ] LaTeX 可复现编译（零 error）

### 8. 收尾抽查（子 agent）

生成完成后，使用 Task 工具启动子 agent 检查所有输出文件：
- 检查 LaTeX 编译零 error、PDF 无 Markdown 残留
- 检查表格为 LaTeX 环境、代码块为 tcolorbox 样式
- 检查封面非空、图片引用路径正确
- 发现错误立即修复，修复后重新 xelatex 编译验证

## 图表处理

- mermaid/plantuml 代码块由 `scripts/lib/diagram-renderer.mjs` 预处理渲染为 SVG
- 渲染后的 SVG 拷贝到 `latex/figures/`
- 在 LaTeX 中通过 `\includegraphics` 引用
- drawio/excalidraw/chart 图表同样导出为 SVG/PNG 后引用
