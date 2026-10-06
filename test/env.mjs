// Offline synthetic installation only. Loaded before any test module imports.
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../examples/demo.env', import.meta.url), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const index = line.indexOf('=');
  process.env[line.slice(0, index)] = line.slice(index + 1);
}
