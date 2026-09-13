#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [, , srcArg, destArg] = process.argv;

if (!srcArg || !destArg) {
  console.error('Usage: node stage-images.js <source> <destination>');
  process.exit(1);
}

const src = path.resolve(srcArg);
const dest = path.resolve(destArg);

const EXCLUDED_DIRS = new Set(['original']);
const EXCLUDED_BASENAMES = new Set(['.DS_Store', 'process-minimal.js']);
const EXCLUDED_PATTERNS = [
  /\.log\.txt$/,
  /^rename.*\.sh$/
];

function isExcluded(sourcePath) {
  const rel = path.relative(src, sourcePath);
  if (rel === '') return false;

  const parts = rel.split(path.sep);
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) return true;
  }

  const base = path.basename(sourcePath);
  if (EXCLUDED_BASENAMES.has(base)) return true;

  for (const pat of EXCLUDED_PATTERNS) {
    if (pat.test(base)) return true;
  }

  return false;
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

fs.cpSync(src, dest, {
  recursive: true,
  filter: (source) => !isExcluded(source)
});

console.log(`Staged ${src} -> ${dest}`);