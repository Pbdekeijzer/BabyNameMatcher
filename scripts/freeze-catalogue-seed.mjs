import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = resolve(root, 'packages/shared/src/catalogue.json');
const seedPath = resolve(root, 'packages/shared/src/catalogue-seed.json');
const catalogue = JSON.parse(await readFile(cataloguePath, 'utf8'));
await writeFile(
  seedPath,
  `${JSON.stringify(
    catalogue.names.map(({ displayName, category }) => ({ displayName, category })),
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`Froze ${catalogue.names.length} reviewed names as the dependency-free seed.`);
