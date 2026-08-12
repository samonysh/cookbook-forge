# 阶段 5c：Nextra v3 网站

参考 `latex-to-nextra-site` skill，从 `mdx/` 权威内容生成 Nextra 站点。

## 步骤

1. 在项目根下初始化 Nextra 工程：从 `assets/nextra-template/` 拷贝骨架到 `nextra-site/`。
2. 运行 `node nextra-site/scripts/scaffold-nextra.mjs --slug <BookSlug> --title "<Book Title>" --github <URL> --year <YYYY>`：
   - 把 `package.json`/`theme.config.tsx`/`docker-compose.yml` 里的 `{{XXX}}` 占位符替换为真实值
   - 自动拷贝 `mdx/*.mdx` -> `nextra-site/pages/zh/*.mdx`（图片路径自动从 `public/figures/` 改为 `/figures/`）
   - 自动生成 `pages/en/*.mdx` 英文占位骨架（"English translation in progress"）
   - 自动拷贝 `mdx/public/figures/*` -> `nextra-site/public/figures/`
3. 图表：PlantUML 用 Docker 或 Kroki 渲染为 SVG/PNG；drawio 导出 `.drawio.svg`；其他图片拷贝到 `public/figures/`。
4. 运行 `npm install`。
5. 运行 `npm run prepare:meta` 生成 `pages/zh/_meta.ts`（含 separator 分组，reading-order 编号）。
6. 若阅读顺序 ≠ 文件名字典序，跑 `scripts/renumber-content.mjs` 把"第 N 章"引用链接化（幂等，跳过已链接部分）。
7. `next.config.mjs` 已启用 KaTeX + mermaid + standalone 输出；`theme.config.tsx` 配 i18n、logo、暗色模式、搜索、mermaid 开关。
8. `middleware.js` 根路径重定向到 `/zh`。
9. `styles/globals.css` 含 callout/figure/表格滚动/下载按钮样式。
10. `npm run build` 必须成功（warning 允许，error 必须为零）。
11. 写 `Dockerfile` + `docker-compose.yml`（三阶段构建 + healthcheck），`docker compose up -d --build` 验证 healthy。
12. 写 `DEPLOY.md` 说明 GitHub + Vercel + Docker 三路部署。

## 关键陷阱（务必遵守）

- PlantUML 必须用 Docker `plantuml/plantuml:latest`，不要用内置 PS1 脚本（GBK PowerShell 会失败）。
- 每个 .puml 必须含 `skinparam defaultFontName "WenQuanYi Micro Hei"`，否则中文豆腐块。
- PlantUML 输出文件名由 `@startuml NAME` 决定，脚本必须同时产出 "按文件名" 与 "按 alias" 两份 SVG/PNG。
- MDX 中裸 `<`/`>` 必须转义为 `&lt;`/`&gt;`。
- `npm run build` 出现 `[nextra] Next.js doesn't support i18n by locale folder names` 是已知告警，可忽略。

## 质量检查

- [ ] `npm run build` 成功
- [ ] Docker healthy
- [ ] `/zh` 返回 200
- [ ] 所有图表返回 200

## 质量检查与修复（子 agent）

生成完成后，使用 Task 工具启动子 agent 检查所有输出文件：
- 检查 `npm run build` 零 error、`/zh` 返回 200
- 检查所有图表返回 200、MDX 无裸 `<`/`>`
- 检查 PlantUML 中文无豆腐块、图片路径正确
- 发现错误立即修复，修复后重新 `npm run build` 验证
