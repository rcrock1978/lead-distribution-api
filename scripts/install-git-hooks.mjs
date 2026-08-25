#!/usr/bin/env node
// Installs the pre-push hook enforcing contract sync (research D2).
import { writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const hook = join(repoRoot, '.git', 'hooks', 'pre-push');

writeFileSync(
  hook,
  `#!/bin/sh\n# Contract drift gate (research D2)\ncd "$(git rev-parse --show-toplevel)/backend" && node scripts/contracts-drift-check.mjs\n`,
);
chmodSync(hook, 0o755);
console.log(`pre-push hook installed at ${hook}`);
