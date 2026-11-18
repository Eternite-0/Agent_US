import { readFileSync } from 'node:fs';
import { seal } from '../src/vault.js';
seal(process.argv[2], JSON.parse(readFileSync(0, 'utf8')));
