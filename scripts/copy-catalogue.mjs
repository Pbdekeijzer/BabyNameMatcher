import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'packages/shared/dist/catalogue.json');
await mkdir(dirname(destination), { recursive: true });
await copyFile(resolve(root, 'packages/shared/src/catalogue.json'), destination);
