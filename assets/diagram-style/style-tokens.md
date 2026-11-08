# Diagram Design 样式 token 摘要

来源：`diagram-design`（https://github.com/cathrynlavery/diagram-design）。本目录只 vendor 导出脚本与 token 摘要，供 CookBook 出图时引用，不复制其全部类型参考。

## 用法

```bash
python assets/diagram-style/export_svg.py <diagram.html> <out.svg> --system-fonts
```

- 输入：一个包含 `<style>` 与 `<svg viewBox="...">` 的 HTML 文件。
- 输出：可独立打开/内联的 SVG。
- `--system-fonts`：不请求 Google Fonts，改用系统字体栈，适合离线构建。

## 颜色角色

| 角色 | 用途 | 默认值（light） | 本书约定 |
|---|---|---|---|
| `paper` | 页面背景、节点默认填充 | `#f5f5f5` | **构图时直接写纯白 `#ffffff`**（导出脚本不做颜色替换，保持 vendored 原样） |
| `paper-2` | 容器/次级填充 | `#ececec` | 保持 |
| `ink` | 主文字、主描边 | `#2d3142` | 保持，不改 |
| `muted` | 次级文字、默认箭头 | `#4f5d75` | 保持 |
| `soft` | 子标签、边界标签 | `#5a6580` | 保持 |
| `rule` | 细边框 | `rgba(45,49,66,0.12)` | 保持 |
| `rule-solid` | 强边框、基线 | `#bfc0c0` | 保持 |
| `accent` | 每图 1–2 个焦点 | `#bf4520` | 保持，不改 |
| `accent-tint` | 焦点框填充 | `rgba(191,69,32,0.08)` | 保持 |
| `link` | HTTP/API、外部箭头 | `#2e5aa8` | 保持 |

**焦点规则**：`accent` 每张图最多用在 1–2 个元素上；其余用 `ink` / `muted` / `soft`。不要用颜色编码状态。

## 字体

| 槽位 | 字体 | 字号 | 字重 | 用途 |
|---|---|---|---|---|
| `title` | Instrument Serif | 1.75rem | 400 | 图标题 |
| `node-name` | Geist / 系统 sans | 12px | 600 | 节点名 |
| `sublabel` | Geist Mono | 9px | 400 | 端口、协议、字段类型 |
| `eyebrow` | Geist Mono | 7–8px | 500 | 类型标签、轴标签 |
| `arrow-label` | Geist Mono | 8px | 400 | 箭头注释 |
| `callout` | Instrument Serif italic | 14px | 400 | 旁注 |

中文节点名沿用系统 sans 栈：`Geist, 'Noto Sans SC', 'Microsoft YaHei', sans-serif`。技术与协议名保留 Mono。

## 构图约定

- 节点圆角 `rx=6`；类型标签用直角 `rx=2`，不要胶囊。
- 箭头默认 `muted`；主路径用 `accent`；HTTP/API 用 `link`；可选/异步/返回用虚线 `5,4`。
- 箭头先画，节点后画，保证线在盒子后面。
- 有箭头的标签要加不透明背景 rect，避免压线。
- 背景只保留纯色或极轻点阵；不要装饰性插画。
