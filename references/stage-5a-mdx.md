# 阶段 5a：MDX 输出（默认必出）

直接保留 `mdx/` 目录作为权威中间格式输出。

## 步骤

1. 直接保留 `mdx/` 目录。
2. 生成 `mdx/_meta.ts`（章节顺序 + separator 分组）。
3. 图表全部就位：
   - mermaid 保留为代码围栏（Nextra 客户端渲染）
   - 其他图表（plantuml/drawio/excalidraw/chart）渲染为 SVG/PNG 放入 `mdx/public/figures/`
   - 原始图表源码保留在 `mdx/public/diagrams-src/`
4. 输出 README 说明 MDX 结构与后续转换方法。

## 图表引用规范

- mermaid：直接用 ` ```mermaid ` 代码围栏
- 已渲染的图表：`![图 N-M：标题](/figures/diagram-xxx.svg)`
- 源码保留：`diagrams-src/diagram-xxx.{mmd,puml,drawio,excalidraw}`

## 质量检查

- [ ] 所有 MDX 文件 frontmatter 完整
- [ ] `_meta.ts` 章节顺序正确
- [ ] 图表全部有编号、标题、正文引用
- [ ] 代码块全部带语言标识 + 中文注释

## 质量检查与修复（子 agent）

生成完成后，使用 Task 工具启动子 agent 检查所有输出文件：
- 检查所有 MDX 文件 frontmatter 完整性、`_meta.ts` 章节顺序
- 检查图表引用路径正确性、代码块语言标识
- 检查内部链接有效、无裸 `<`/`>` 字符
- 发现错误立即修复
