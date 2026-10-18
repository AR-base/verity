// Builds public/data/corpus.json from the Markdown files in corpus/.
// Deterministic: same input files, same output (checked in CI).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLang } from '../public/js/rag.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'corpus');
const docs = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    const title = (text.match(/^#\s+(.+)$/m) || [null, file])[1].trim();
    return { id: file.replace(/\.md$/, ''), title, lang: detectLang(text), source: 'demo', text };
  });
writeFileSync(join(root, 'public/data/corpus.json'), JSON.stringify({ company: 'Nexa Digital (fictional)', docs }, null, 1) + '\n');
console.log(`corpus.json: ${docs.length} documents, ${docs.reduce((s, d) => s + d.text.length, 0)} characters`);
for (const d of docs) console.log(`  ${d.lang}  ${d.id}`);
