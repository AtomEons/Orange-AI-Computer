import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ORANGE5_ROOT = resolve(
  process.env.ORANGE5_ROOT || resolve(HERE, '..', '..'),
).replace(/\\/g, '/');
