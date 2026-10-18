import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function req(path, { method = 'POST', body, headers = {} } = {}) {
  return new Request(`https://verity.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function fakeAI() {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (model.includes('m3')) return { shape: [input.text.length, 3], data: input.text.map((t, i) => [i, t.length, 1]) };
      return { response: input.contexts.map((c, i) => ({ id: i, score: c.text.length })).reverse() };
    },
  };
}

test('config reports capabilities without leaking secrets', async () => {
  const res = await worker.fetch(req('/api/config', { method: 'GET' }), { AI: fakeAI(), ANTHROPIC_API_KEY: 'sk-secret', ACCESS_CODE: 'c' });
  const body = await res.json();
  assert.equal(body.embeddings, true);
  assert.equal(body.answers, true);
  assert.equal(body.accessCodeRequired, true);
  assert.ok(!JSON.stringify(body).includes('sk-secret'));
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('embed and rerank go through Workers AI with validated input', async () => {
  const AI = fakeAI();
  const e = await worker.fetch(req('/api/embed', { body: { texts: ['abc', 'de'] } }), { AI });
  assert.equal(e.status, 200);
  const eb = await e.json();
  assert.equal(eb.dim, 3);
  assert.deepEqual(eb.vectors[1], [1, 2, 1]);
  assert.deepEqual(AI.calls[0].input, { text: ['abc', 'de'] });
  const r = await worker.fetch(req('/api/rerank', { body: { query: 'q', passages: ['a', 'bbb'] } }), { AI });
  assert.deepEqual((await r.json()).scores, [1, 3]);
  const bad = await worker.fetch(req('/api/embed', { body: { texts: [] } }), { AI });
  assert.equal(bad.status, 400);
});

test('embedding falls back to the contexts input shape', async () => {
  const AI = { calls: [], async run(model, input) { this.calls.push(input); if (input.text) throw new Error('bad input'); return { response: input.contexts.map(() => [0.5, 0.5]) }; } };
  const res = await worker.fetch(req('/api/embed', { body: { texts: ['a', 'b'] } }), { AI });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).vectors, [[0.5, 0.5], [0.5, 0.5]]);
  assert.equal(AI.calls.length, 2);
});

test('missing Workers AI binding answers 503, provider failure 502', async () => {
  assert.equal((await worker.fetch(req('/api/embed', { body: { texts: ['a'] } }), {})).status, 503);
  const broken = { async run() { throw new Error('boom'); } };
  const res = await worker.fetch(req('/api/rerank', { body: { query: 'q', passages: ['a'] } }), { AI: broken });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('boom'));
});

test('access code, method, content type, size and unknown routes', async () => {
  const env = { AI: fakeAI(), ACCESS_CODE: 'nexa' };
  assert.equal((await worker.fetch(req('/api/embed', { body: { texts: ['a'] } }), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/embed', { body: { texts: ['a'] }, headers: { 'x-access-code': 'nope' } }), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/embed', { body: { texts: ['a'] }, headers: { 'x-access-code': 'nexa' } }), env)).status, 200);
  assert.equal((await worker.fetch(req('/api/embed', { method: 'GET' }), env)).status, 405);
  assert.equal((await worker.fetch(req('/api/embed', { body: 'x', headers: { 'content-type': 'text/plain', 'x-access-code': 'nexa' } }), env)).status, 415);
  assert.equal((await worker.fetch(req('/api/embed', { body: '{bad', headers: { 'x-access-code': 'nexa' } }), env)).status, 400);
  const huge = JSON.stringify({ texts: ['x'.repeat(300_000)] });
  assert.equal((await worker.fetch(req('/api/embed', { body: huge, headers: { 'x-access-code': 'nexa' } }), env)).status, 413);
  assert.equal((await worker.fetch(req('/api/nothing', { method: 'GET' }), env)).status, 404);
});

test('rate limiter is applied per route', async () => {
  const env = { AI: fakeAI(), RETRIEVAL_RATE_LIMITER: { async limit() { return { success: false }; } } };
  const res = await worker.fetch(req('/api/embed', { body: { texts: ['a'] } }), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
});

test('answer calls Claude with the server prompt and masks provider errors', async () => {
  const original = globalThis.fetch;
  let sent = null;
  try {
    globalThis.fetch = async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Deux jours [1].' }], usage: { input_tokens: 10, output_tokens: 3 }, stop_reason: 'end_turn' }), { status: 200 });
    };
    const env = { ANTHROPIC_API_KEY: 'sk-test', ANSWER_MODEL: 'claude-haiku-4-5' };
    const res = await worker.fetch(req('/api/answer', { body: { question: 'Télétravail ?', passages: [{ title: 'Guide', text: '2 jours' }], system: 'evil' } }), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.text, 'Deux jours [1].');
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.init.headers['x-api-key'], 'sk-test');
    assert.ok(sent.body.system.startsWith('You are Verity'));
    assert.equal(sent.body.model, 'claude-haiku-4-5');

    globalThis.fetch = async () => new Response('{"error":{"message":"org xyz over quota"}}', { status: 400 });
    const err = await worker.fetch(req('/api/answer', { body: { question: 'q', passages: [] } }), env);
    assert.equal(err.status, 502);
    assert.ok(!(await err.text()).includes('xyz'));
    globalThis.fetch = async () => new Response('', { status: 529 });
    assert.equal((await worker.fetch(req('/api/answer', { body: { question: 'q', passages: [] } }), env)).status, 503);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal((await worker.fetch(req('/api/answer', { body: { question: 'q', passages: [] } }), {})).status, 503);
});

test('plain HTTP is redirected to HTTPS', async () => {
  const res = await worker.fetch(new Request('http://verity.example/'), {});
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://verity.example/');
});
