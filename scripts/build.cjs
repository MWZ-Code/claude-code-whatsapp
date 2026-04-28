#!/usr/bin/env node
// Build the TypeScript modules under channels/ and streams/ into CJS
// emitted to ./build/, with source maps. esbuild is fast enough to run
// at every start (npm run prestart) and tsc --noEmit handles type
// checking out-of-band.

const path = require("path");
const fs = require("fs");
const { build, context } = require("esbuild");

const ROOT = path.join(__dirname, "..");
const watch = process.argv.includes("--watch");

async function listEntryPoints() {
  const patterns = ["channels/**/*.ts", "streams/**/*.ts"];
  const out = [];
  // glob is not in deps; use a tiny manual recursion instead
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(p);
    }
  }
  walk(path.join(ROOT, "channels"));
  walk(path.join(ROOT, "streams"));
  return out;
}

(async () => {
  const entryPoints = await listEntryPoints();
  if (entryPoints.length === 0) {
    process.stderr.write("build: no .ts entry points found\n");
    process.exit(0);
  }

  const opts = {
    entryPoints,
    outdir: path.join(ROOT, "build"),
    outbase: ROOT,
    format: "cjs",
    platform: "node",
    target: "node20",
    bundle: false,
    sourcemap: true,
    logLevel: "info",
  };

  if (watch) {
    const ctx = await context(opts);
    await ctx.watch();
    process.stderr.write("build: watching for changes...\n");
  } else {
    await build(opts);
  }
})().catch((err) => {
  process.stderr.write(`build failed: ${err}\n`);
  process.exit(1);
});
