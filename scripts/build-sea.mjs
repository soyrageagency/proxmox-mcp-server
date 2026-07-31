/**
 * Build a standalone `rageprox` executable — no Node, no npm required to run.
 *
 * Uses Node's Single Executable Applications (SEA): bundle the already-built
 * terminal dashboard into one CommonJS file with esbuild, embed the update
 * channel, generate the SEA blob, copy the Node binary, and inject the blob with
 * postject. The result is a single downloadable file.
 *
 * Usage:  node scripts/build-sea.mjs      (build for the current OS)
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "postject";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build");
const platform = process.platform;
const exeName = platform === "win32" ? "rageprox.exe" : "rageprox";

const log = (m) => process.stdout.write(`[sea] ${m}\n`);

/** Run a Node script by absolute path (no shell — safe with spaces in paths). */
function node(args) {
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: root });
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // 1) Fresh dist/ (plain .js paths esbuild can resolve).
  log("building dist/ …");
  node([join(root, "node_modules/typescript/bin/tsc")]);

  // 2) Bundle the TUI entry → one CommonJS file.
  log("bundling with esbuild …");
  await build({
    entryPoints: [join(root, "dist/tui/index.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(out, "rageprox.cjs"),
    external: ["bufferutil", "utf-8-validate"],
    banner: { js: "const __seaMetaUrl = require('url').pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__seaMetaUrl" },
    logLevel: "warning",
  });

  // 3) Embed the update channel.
  const seaConfig = {
    main: join(out, "rageprox.cjs"),
    output: join(out, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { "updates.json": join(root, "updates.json") },
  };
  writeFileSync(join(out, "sea-config.json"), JSON.stringify(seaConfig, null, 2));

  // 4) Generate the SEA blob.
  log("generating SEA blob …");
  node(["--experimental-sea-config", join(out, "sea-config.json")]);

  // 5) Copy Node and inject the blob.
  const target = join(out, exeName);
  copyFileSync(process.execPath, target);
  log(`copied node → ${exeName}`);
  log("injecting blob with postject …");
  const blob = readFileSync(join(out, "sea-prep.blob"));
  await inject(target, "NODE_SEA_BLOB", blob, {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    machoSegmentName: platform === "darwin" ? "NODE_SEA" : undefined,
  });

  const size = (statSync(target).size / (1024 * 1024)).toFixed(1);
  log(`done → build/${exeName}  (${size} MB)`);
  log(`try it:  ./build/${exeName}`);
}

main().catch((err) => {
  process.stderr.write(`[sea] FAILED: ${err?.stack || err}\n`);
  process.exit(1);
});
