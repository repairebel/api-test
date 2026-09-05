import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../dist/modules/pricing/', import.meta.url), { recursive: true });
await copyFile(new URL('../src/modules/pricing/catalog-data.json', import.meta.url), new URL('../dist/modules/pricing/catalog-data.json', import.meta.url));
