#!/usr/bin/env node
// build-skill.mjs — Pack the cookbook-forge skill into a SkillHub-compatible zip.
// Output: dist/cookbook-forge-<version>.zip and dist/cookbook-forge-latest.zip
//
// Zip structure (root = skill name):
//   cookbook-forge/
//     ├── SKILL.md
//     ├── scripts/...
//     ├── assets/...
//     └── references/...  (if exists)
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import jszip from "jszip";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep)).replace(/^([A-Za-z]:)/, "$1");
// Simpler:
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SKILL_MD = path.join(ROOT, "SKILL.md");
const DIST = path.join(ROOT, "dist");

const raw = await fs.readFile(SKILL_MD, "utf8");
const versionMatch = raw.match(/^version:\s*["']?([\d.]+)["']?/m);
const nameMatch = raw.match(/^name:\s*["']?([\w-]+)["']?/m);
const VERSION = versionMatch ? versionMatch[1] : "0.0.0";
const NAME = nameMatch ? nameMatch[1] : "cookbook-forge";
console.log(`Packaging ${NAME} v${VERSION}`);

const zip = new jszip();
const root = zip.folder(NAME);

async function addDir(rel, prefix) {
  const abs = path.join(ROOT, rel);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) return;
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    const n = e.name;
    if (n.startsWith(".") || n === "node_modules" || n === "dist" || n === "__pycache__" || n.endsWith(".epub") || n.endsWith(".pdf")) continue;
    const full = path.join(abs, n);
    const zipPath = prefix ? `${prefix}/${n}` : n;
    if (e.isDirectory()) {
      // Recursively add (avoid test-output entirely)
      if (n === "test-output" || n === ".next" || n === "coverage") continue;
      await addDir(path.join(rel, n), zipPath);
    } else {
      const data = await fs.readFile(full);
      root.file(zipPath, data);
      console.log("  +", zipPath);
    }
  }
}

root.file("SKILL.md", await fs.readFile(SKILL_MD));
console.log("  + SKILL.md");
await addDir("scripts", "scripts");
await addDir("assets", "assets");

// references/ is optional
const refsDir = path.join(ROOT, "references");
if (await fs.stat(refsDir).catch(() => null)) {
  await addDir("references", "references");
}

await fs.mkdir(DIST, { recursive: true });
const versioned = path.join(DIST, `${NAME}-${VERSION}.zip`);
const latest = path.join(DIST, `${NAME}-latest.zip`);

const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
await fs.writeFile(versioned, buf);
await fs.writeFile(latest, buf);

const sizeKB = (buf.length / 1024).toFixed(1);
console.log(`\n✓ ${versioned} (${sizeKB} KB)`);
console.log(`✓ ${latest} (${sizeKB} KB)`);
