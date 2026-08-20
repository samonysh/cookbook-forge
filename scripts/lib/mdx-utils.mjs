// scripts/lib/mdx-utils.mjs
// 共享的 MDX frontmatter 解析工具，被 lmdx2tex.mjs / lbuild-epub.mjs 等复用。

export function normalizeNewlines(raw) {
  return String(raw).replace(/\r\n/g, "\n");
}

/**
 * 解析 MDX frontmatter。支持：
 *   key: value           简单键值
 *   key: "quoted value"  带引号（自动去引号）
 *   key:                 列表，后跟 "  - item" 行，收集为数组
 * @param {string} raw  MDX 原文
 * @param {string} [sourceName="chapter.mdx"] 源文件名，用于无 frontmatter 时推断 slug/title
 * @returns {{ title: string, slug: string, fm: Record<string, string|string[]>, body: string }}
 */
export function parseFrontmatter(raw, sourceName = "chapter.mdx") {
  const normalized = normalizeNewlines(raw);
  // 只有紧随开头分隔线的内容像 YAML 键值时才视为 frontmatter。
  // 这样不会把正文中的 `---` 或损坏的 frontmatter 块吞进元数据。
  const m = normalized.match(/^---\n(?=[A-Za-z_][\w-]*:\s*)([\s\S]*?)\n---\n/);
  if (!m) {
    const slug = String(sourceName).replace(/\\/g, "/").split("/").pop().replace(/\.mdx$/i, "") || "chapter";
    const h1 = normalized.match(/^#\s+(.+?)\s*#?\s*$/m);
    return { title: h1?.[1]?.trim() || slug, slug, fm: {}, body: normalized };
  }

  const fm = {};
  const lines = m[1].split("\n");
  let currentKey = null;
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      currentKey = key;
      if (val === "" || val === "[]") {
        fm[key] = [];
      } else {
        fm[key] = val.replace(/^["']|["']$/g, "");
      }
      continue;
    }
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && currentKey) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(item[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  const body = normalized.slice(m[0].length);
  const fallbackSlug = String(sourceName).replace(/\\/g, "/").split("/").pop().replace(/\.mdx$/i, "") || "chapter";
  const h1 = body.match(/^#\s+(.+?)\s*#?\s*$/m);
  return {
    title: (typeof fm.title === "string" && fm.title) || h1?.[1]?.trim() || fallbackSlug,
    slug: (typeof fm.slug === "string" && fm.slug) || fallbackSlug,
    fm,
    body,
  };
}
