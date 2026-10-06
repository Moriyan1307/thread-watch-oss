import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
