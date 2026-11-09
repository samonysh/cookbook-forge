# 阶段 5d：EPUB（LLM 驱动，推荐）

从 `mdx/` 权威内容生成 EPUB，使用 **LLM 逐章节转换**流程。

## 步骤

### 1. LLM 逐章节 MDX -> XHTML 转换（核心步骤，使用 Task 工具调用子 agent）

对每个 `mdx/*.mdx` 文件，使用 Task 工具启动子 agent：
- 子 agent 读取 `assets/prompts/mdx-to-epub.md` 转换规则
- 子 agent 读取对应的 MDX 源文件
- 子 agent 输出合法的 EPUB3 XHTML 章节文件
- **关键**：每个章节独立转换，LLM 语义理解保证转换质量

LLM 转换 vs 脚本转换的优势：
- ✅ Callout 卡片（JSX div）正确转为语义化 HTML div，附 CSS 类名
- ✅ 代码块内容正确 HTML 实体转义（`&`->`&amp;`，`<`->`&lt;`）
- ✅ 公式正确包裹为 `<span class="math-inline">` / `<div class="math-block">`
- ✅ GFM 表格正确转为 `<table class="gfm-table">` 含 thead/tbody
- ✅ 图片用 `<figure>` + `<figcaption>` 语义化包裹
- ✅ 内部章节链接（`./chXX.mdx`）正确转为 `chXX.xhtml`
- ✅ XHTML 合法性（XML 声明、标签闭合、属性双引号）

### 2. 组装 EPUB3 结构

在 `epub/build/` 下建立：
- `mimetype`（第一文件，STORED，内容固定 `application/epub+zip`）
- `META-INF/container.xml`
- `OEBPS/content.opf`（manifest + spine + 元数据）
- `OEBPS/nav.xhtml`（EPUB3 导航）
- `OEBPS/Text/*.xhtml`（LLM 生成的章节）
- `OEBPS/Images/`（拷贝图）
- `OEBPS/Fonts/`（LXGW WenKai 子集化 WOFF2）
- `OEBPS/css/stylesheet.css`

### 3. CSS 样式

使用 `assets/stylesheet.template.css`（epub-reader-optimizer 风格），已优化：
- **标题层级**：h1/h2/h3/h4 分别 1.9 / 1.5 / 1.22 / 1.08em（相对正文 1em），字重 700/700/600/600，行高随字号收紧，上间距 2 / 1.6 / 1.3em 逐级递减，级差一眼可辨
- **可反转配色**：文字一律 `color: inherit`，背景 `transparent`，边框/分隔线/代码底用中性半透明灰 `rgba(127,127,127,…)`；不写死黑/白，深浅色模式与阅读器强制反色均可读
- 中文字体栈：LXGW WenKai / 霞鹜文楷 / Source Han Serif / SimSun
- 代码字体：LXGW WenKai Mono / Source Code Pro / Consolas
- 代码块：中性半透明灰底 + 圆角 + 左侧 4px 灰条，0.9em，长行自动换行
- 表格 booktabs 风格（顶/底 2px `currentColor` 粗线 + 行间 1px 半透明细线），0.95em
- Callout 卡片：中性半透明底 + 左侧 4px 语义色边框（蓝/橙/红/绿对应 chapteroutline/recipe/pitfall/keypoints）
- 响应式图片（`max-width: 100%`），封面等比 `object-fit: contain`
- 图题/表题 0.9em、居中、`opacity: 0.82`，与标题留白协调
- 数学公式行内/块级样式
- 不写 `@media (prefers-color-scheme: dark)` 块：不锁死配色，交给阅读器主题
- 分页控制（标题/代码块/图表 `page-break-inside: avoid`）

### 4. 字体子集化嵌入（必须）

- LXGW WenKai Lite 14MB TTF -> ~300KB WOFF2（仅保留 EPUB 实际使用字符）
- 用 `scripts/subset-fonts.mjs`（优先 fonteditor-core，Python fonttools fallback）
- 在 `content.opf` 登记 `media-type="font/woff2"`

### 5. 若内容含"公式即图片"

用 `scripts/optimize-formula-images.mjs` 修复 HTML 结构，使用 `assets/stylesheet.formula-image.css`。

### 6. 打包

用 `scripts/epub-zip.mjs`（Node 内置 zlib，零依赖；**不要用 PowerShell Compress-Archive 或 Python zipfile 手工打包**），产物按书名输出 `epub/<书名>.epub`，并保证：
- `mimetype` 第一个条目且 STORED（不压缩）
- 其他文件 DEFLATE 压缩
- 打包后遍历 central directory 二次校验（条目数、mimetype 位置与压缩方式）

书名解析优先级：`--title` > `metadata/outline.md` 一级标题 > `latex/main.tex` 的 `\title{}`；文件名只取主标题（冒号前），非法字符与路径分隔符清洗为 `-`，兼容 Windows/macOS/Linux。

**封面（机制不变）**：`lbuild-epub.mjs` 会识别 `figures/cover.(png|jpe?g)`，自动生成 `cover.xhtml`
作为 spine 首项，并在 `content.opf` 中登记 `properties="cover-image"` 与
`<meta name="cover" content="cover-image"/>`。EPUB 的封面机制与 LaTeX/Typst 的封面落位改造无关，
保持现状；封面规格 1280×1024，来源规则同 LaTeX/Typst（无素材时画全书架构图）。样式上使用
`fit contain`（`max-width:100%; max-height:100vh`），保证不裁切、不压字。

### 7. 并行质量检查（check ⇄ fix，≤3 轮）

使用 `scripts/epub-check.mjs`（与 Typst/LaTeX 流程同模式，以章节为单位并行暴露全部问题）：

```bash
node scripts/epub-check.mjs --project epub --fix
```

- **静态 lint + XML 良构校验**（`scripts/lib/epub-lint.mjs`，纯 JS 零依赖）：标签配对/交叉嵌套、属性引号、未转义 `&`、裸 `<`（这是阅读器能否打开的**硬闸门**，等价于编译检查）；Markdown 标题/粗体、JSX `className` 残留、图片文件存在性；跳过 `<pre>/<code>` 内容
- **`--fix` 安全修复**：`className` -> `class`、裸 `&` -> `&amp;`、`**x**` -> `<strong>x</strong>`（保护代码段后修复再还原）
- **包结构检查**：content.opf manifest/spine 完整性（资源未登记/引用缺失）、nav.xhtml 存在、`<书名>.epub` 的 mimetype 第一且 STORED（产物名由 `scripts/lib/book-meta.mjs` 解析，不硬编码）
- 规则修不掉的按章对照 MDX 原文交给子 agent 修，复查：`node scripts/epub-check.mjs --project epub --only <slug>`
- 全部通过后重跑 `node scripts/lbuild-epub.mjs` 重新打包

### 8. 自检（已由 epub-check.mjs 自动覆盖）

- [ ] `epub-check.mjs --fix` 退出码 0（每章 XML 良构 + 包结构全通过）
- [ ] `mimetype` 是第一个条目且 STORED
- [ ] `z.read("mimetype") == b"application/epub+zip"`
- [ ] 所有图片/字体/章节均在 manifest 中
- [ ] 章节在 spine 中顺序正确
- [ ] 封面为 spine 首项，`content.opf` 含 `cover-image` 与 `<meta name="cover">`

### 9. 收尾抽查（子 agent）

生成完成后，使用 Task 工具启动子 agent 检查所有输出文件：
- 检查 mimetype 第一且 STORED、所有图片/字体/章节在 manifest 中
- 检查 XHTML 文件合法 XML、章节在 spine 中顺序正确
- 检查字体子集化嵌入、代码块/表格样式生效
- 发现错误立即修复，修复后重新打包验证

## 图表处理

- mermaid/plantuml 代码块由 `scripts/lib/diagram-renderer.mjs` 预处理渲染为 SVG
- 渲染后的 SVG 拷贝到 `OEBPS/Images/`
- 在 XHTML 中通过 `<figure><img src="../Images/xxx.svg"/>` 引用
- drawio/excalidraw/chart 图表同样导出为 SVG/PNG 后引用
