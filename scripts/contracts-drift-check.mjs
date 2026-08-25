#!/usr/bin/env node
// Fails when the backend's emitted contract declarations do not match the
// frontend's committed copy (research D2 — a schema change must break the
// frontend BUILD, not production).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');
const emittedPath = join(backendRoot, 'dist', 'contracts-emitted', 'types.d.ts');
const frontendCopy = join(
  backendRoot,
  process.env.CONTRACT_SYNC_TARGET ?? '..',
  'lead-distribution-web',
  'src',
  'types',
  'api-contract.d.ts',
);

let emitted;
try {
  emitted = readFileSync(emittedPath, 'utf8');
} catch {
  console.error('drift:check → backend artifact missing; run `npm run contracts:build`.');
  process.exit(1);
}

const emittedHash = createHash('sha256').update(emitted).digest('hex');

let copy;
try {
  copy = readFileSync(frontendCopy, 'utf8');
} catch {
  console.error(`drift:check → ${frontendCopy} missing; run \`npm run contracts:sync\`.`);
  process.exit(1);
}

const declaredHash = /hash: ([0-9a-f]{64})/.exec(copy)?.[1];
if (declaredHash !== emittedHash) {
  console.error(
    'drift:check → CONTRACT DRIFT detected.\n' +
      '  backend emitted : ' + emittedHash.slice(0, 12) + '…\n' +
      '  frontend copy   : ' + (declaredHash ?? 'none').slice(0, 12) + '…\n' +
      'Fix: cd backend && npm run contracts:build && npm run contracts:sync,\n' +
      'then commit the regenerated frontend/src/types/api-contract.d.ts.',
  );
  process.exit(1);
}
console.log(`drift:check → OK (${emittedHash.slice(0, 12)}…)`);
