// Local server for end-to-end tests: the real Worker with fake Workers AI and
// a fake Claude API, serving the real static files.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import worker from '../../src/worker.js';
import { fakeEmbed } from '../helpers.js';
import { tokenize } from '../../public/js/rag.js';

const root = join(import.meta.dirname, '../../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const env = {
  ACCESS_CODE: process.env.ACCESS_CODE ?? 'nexa2026',
  ANTHROPIC_API_KEY: 'sk-test-not-real',
  ANSWER_MODEL: 'claude-haiku-4-5',
  AI: {
    async run(model, input) {
      await new Promise((r) => setTimeout(r, 15));
      if (model.includes('m3')) return { shape: [input.text.length, 256], data: input.text.map(fakeEmbed) };
      const q = new Set(tokenize(input.query));
      return { response: input.contexts.map((c, i) => ({ id: i, score: tokenize(c.text).filter((t) => q.has(t)).length - 2 })) };
    },
  },
  ASSETS: {
    async fetch(request) {
      let path = new URL(request.url).pathname;
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root)) return new Response('no', { status: 403 });
      try {
        return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(init.body);
    const content = body.messages[0].content;
    const n = (content.match(/<source id=/g) || []).length;
    const question = content.slice(content.lastIndexOf('Question:'));
    const text = /salaire|salary/i.test(question)
      ? 'Je ne trouve pas cette information dans les documents.'
      : `Le télétravail est possible jusqu’à **deux jours par semaine** après la période d’essai [1]. Le mardi est un jour de présence obligatoire [1]${n > 1 ? '[2]' : ''}.`;
    await new Promise((r) => setTimeout(r, 40));
    return new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 1850, output_tokens: 64 }, stop_reason: 'end_turn' }), { status: 200 });
  }
  return realFetch(url, init);
};

const port = Number(process.env.PORT || 8788);
createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`e2e server on http://localhost:${port}`));
