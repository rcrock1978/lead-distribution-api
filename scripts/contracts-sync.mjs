#!/usr/bin/env node
// Copies the emitted contract declarations into the frontend repository and
// stamps the artifact hash. Run AFTER `npm run contracts:build`.
import { createHash } from 'node:crypto';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');
const emitted = join(backendRoot, 'dist', 'contracts-emitted', 'types.d.ts');
const targetDir = join(backendRoot, '..', 'frontend', 'src', 'types');
const target = join(targetDir, 'api-contract.d.ts');

let content;
try {
  content = readFileSync(emitted, 'utf8');
} catch {
  console.error('contracts:sync → emitted file missing. Run `npm run contracts:build` first.');
  process.exit(1);
}

const hash = createHash('sha256').update(content).digest('hex');
mkdirSync(targetDir, { recursive: true });
writeFileSync(
  target,
  `/* GENERATED from backend/src/contracts/types.ts — DO NOT EDIT BY HAND.\n` +
    `   Regenerate: cd backend && npm run contracts:build && npm run contracts:sync\n` +
    `   hash: ${hash} */\n\n${content}`,
);
copyFileSync(emitted, join(backendRoot, 'dist', 'contracts-emitted', 'types.synced.d.ts'));
console.log(`contracts:sync → ${target} (${hash.slice(0, 12)}…)`);
