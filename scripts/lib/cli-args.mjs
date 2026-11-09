/**
 * scripts/lib/cli-args.mjs
 *
 * 命令行参数解析的共用约定。
 *
 * 背景：chapter-lint / ratio-count / render-figures 只认 `--root=<book>`。
 * 若写成 `--root <book>`（空格形式），旧实现会静默忽略参数、回退到当前目录，
 * 表现为「检查了错误的书」而不是报错。这里统一改为显式失败并给出正确用法。
 */

/**
 * 取出 `--root=<book>` 的值；若出现空格形式则直接报错退出。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @param {string} scriptName 脚本文件名，用于提示正确命令
 * @returns {string|null} 目录参数；未提供时为 null
 */
export function resolveRoot(argv, scriptName) {
  const bare = argv.find((a) => a === "--root" || a.startsWith("--root "));
  if (bare !== undefined) {
    console.error("用法错误：--root 只支持等号写法，空格形式会静默回退到当前目录。");
    console.error("");
    console.error(`  正确：node scripts/${scriptName} --root=<book>`);
    console.error(`  错误：node scripts/${scriptName} --root <book>`);
    process.exit(2);
  }
  const hit = argv.find((a) => a.startsWith("--root="));
  if (!hit) return null;
  const value = hit.slice("--root=".length).trim();
  if (!value) {
    console.error("用法错误：--root 后面缺少书目录。");
    console.error("");
    console.error(`  正确：node scripts/${scriptName} --root=<book>`);
    process.exit(2);
  }
  return value;
}
