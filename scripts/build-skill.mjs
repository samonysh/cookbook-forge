#!/usr/bin/env node
// build-skill.mjs — Pack the cookbook-forge skill into a SkillHub-compatible zip.
// Output: dist/cookbook-forge-<version>.zip and dist/cookbook-forge-latest.zip
//
// Whitelist strategy: only ship files that the Skill runtime actually needs.
// Excluded:
//   - dist/, test-output/, node_modules/, .git, .next, coverage, __pycache__
//   - assets/logo/ (favicon/brand assets only used by this repo's website)
//   - assets/diagrams/ (architecture diagrams for the Skill's own docs, not needed at runtime)
//   - scripts/build-skill.mjs (this script itself)
//   - binary/book-build outputs: *.epub, *.pdf, *.zip
//   - .DS_Store, .env*, *.log, IDE files

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jszip from "jszip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SKILL_MD = path.join(ROOT, "SKILL.md");
const DIST = path.join(ROOT, "dist");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__",
  "test-output", ".vscode", ".idea",
  // within assets/:
  "logo", "diagrams",
]);
const SKIP_FILES = new Set([
  "build-skill.mjs", // don't ship the packager itself
  ".DS_Store", ".env", ".env.local",
]);
const SKIP_EXT = new Set([
  ".epub", ".pdf", ".zip", ".log",
]);

function shouldSkip(relPath, name, isDir) {
  const parts = relPath.split(path.sep);
  // skip hidden files/dirs (except .github if any)
  if (name.startsWith(".") && name !== ".github") return true;
  if (isDir && SKIP_DIRS.has(name)) return true;
  if (!isDir) {
    if (SKIP_FILES.has(name)) return true;
    const ext = path.extname(name).toLowerCase();
    if (SKIP_EXT.has(ext)) return true;
  }
  return false;
}

const raw = await fs.readFile(SKILL_MD, "utf8");
const versionMatch = raw.match(/^version:\s*["']?([\d.]+)["']?/m);
const nameMatch = raw.match(/^name:\s*["']?([\w-]+)["']?/m);
const VERSION = versionMatch ? versionMatch[1] : "0.0.0";
const NAME = nameMatch ? nameMatch[1] : "cookbook-forge";
console.log(`Packaging ${NAME} v${VERSION}`);

const zip = new jszip();
const root = zip.folder(NAME);
let fileCount = 0;

async function addTree(absDir, zipPrefix) {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(absDir, e.name);
    const rel = zipPrefix ? `${zipPrefix}/${e.name}` : e.name;
    if (shouldSkip(rel, e.name, e.isDirectory())) continue;
    if (e.isDirectory()) {
      await addTree(full, rel);
    } else {
      const data = await fs.readFile(full);
      root.file(rel, data);
      fileCount++;
      if (process.env.VERBOSE) console.log("  +", rel);
    }
  }
}

root.file("SKILL.md", await fs.readFile(SKILL_MD));
fileCount++;
console.log("  + SKILL.md");

// Core runtime directories
for (const top of ["scripts", "assets", "references"]) {
  const abs = path.join(ROOT, top);
  if (await fs.stat(abs).catch(() => null)) {
    await addTree(abs, top);
  }
}

await fs.mkdir(DIST, { recursive: true });
const versioned = path.join(DIST, `${NAME}-${VERSION}.zip`);
const latest = path.join(DIST, `${NAME}-latest.zip`);

const buf = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
await fs.writeFile(versioned, buf);
await fs.writeFile(latest, buf);

const sizeKB = (buf.length / 1024).toFixed(1);
console.log(`\n✓ Packed ${fileCount} files`);
console.log(`✓ ${versioned} (${sizeKB} KB)`);
console.log(`✓ ${latest} (${sizeKB} KB)`);
