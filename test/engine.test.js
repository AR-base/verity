import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../public/js/engine.js';
import { fakeApi, memoryCache, corpus, golden } from './helpers.js';

async function built(opts = {}) {
  const api = fakeApi(opts);
  const cache = memoryCache();
  const engine = new Engine({ api, cache, embedModel: 'm' });
  engine.setDocs(corpus);
  await engine.build();
  return { engine, api, cache };
}

test('build indexes every chunk and caches embeddings', async () => {
  const { engine, api, cache } = await built();
  assert.ok(engine.vectorsReady);
  assert.equal(engine.vectors.size, engine.chunks.length);
  assert.equal(cache.map.size, engine.chunks.length);
  const before = api.calls.embeddedTexts;
  await engine.build();
  assert.equal(api.calls.embeddedTexts, before, 'second build is served from the cache');
  assert.equal(engine.indexStats.cached, engine.chunks.length);
});

test('retrieve in each mode returns ranked passages with per-stage ranks', async () => {
  const { engine } = await built();
  for (const mode of ['bm25', 'vector', 'hybrid', 'rerank']) {
    const r = await engine.retrieve('Combien de jours de télétravail par semaine ?', { mode, k: 5 });
    assert.equal(r.mode, mode);
    assert.equal(r.final.length, 5);
    assert.deepEqual(r.final.map((f) => f.rank), [1, 2, 3, 4, 5]);
    assert.ok(r.final.every((f) => f.chunk && f.chunk.text));
  }
  const r = await engine.retrieve('télétravail jours semaine', { mode: 'rerank' });
  assert.ok(r.lists.fused.length > 0 && r.lists.reranked.length === r.lists.fused.length);
  assert.ok(r.final[0].ranks.reranked === 1);
  assert.ok(typeof r.timings.rerank === 'number');
});

test('falls back to BM25 when embeddings are unavailable or fail', async () => {
  const off = await built({ embeddings: false });
  assert.equal((await off.engine.retrieve('NX-409', { mode: 'rerank' })).mode, 'bm25');
  const failing = await built({ failEmbed: true });
  assert.equal(failing.engine.vectorsReady, false);
  assert.equal(failing.engine.vectorError, 'embeddings_failed');
  assert.equal((await failing.engine.retrieve('NX-409', { mode: 'hybrid' })).mode, 'bm25');
  const noRerank = await built({ rerank: false });
  assert.equal((await noRerank.engine.retrieve('NX-409', { mode: 'rerank' })).mode, 'hybrid');
});

test('answer reports citations, invented citations, coverage and cost', async () => {
  const { engine } = await built();
  const r = await engine.retrieve('télétravail', { mode: 'hybrid', k: 4 });
  const a = await engine.answer('télétravail ?', r, { lang: 'fr' });
  assert.deepEqual(a.citations.used, [1]);
  assert.deepEqual(a.citations.invalid, [7]);
  assert.ok(Math.abs(a.cost - (2000 * 1 + 100 * 5) / 1e6) < 1e-12);
});

test('evaluation returns metrics for all four methods and a BM25 floor', async () => {
  const { engine } = await built();
  let progress = 0;
  const ev = await engine.evaluate(golden, (d) => { progress = d; });
  assert.equal(progress, golden.length);
  assert.deepEqual(ev.methods, ['bm25', 'vector', 'hybrid', 'rerank']);
  for (const m of ev.methods) {
    for (const key of ['hit@1', 'hit@3', 'hit@5', 'mrr']) assert.ok(ev.metrics[m][key] >= 0 && ev.metrics[m][key] <= 1);
  }
  assert.ok(ev.metrics.bm25['hit@5'] >= 0.6, `BM25 hit@5 is ${ev.metrics.bm25['hit@5']}`);
  assert.deepEqual(new Set(ev.types), new Set(['exact', 'paraphrase', 'cross-lingual']));
  assert.equal(ev.rows.length, 24);
  const bmOnly = await built({ embeddings: false });
  assert.deepEqual((await bmOnly.engine.evaluate(golden)).methods, ['bm25']);
});

test('uploaded documents join the index and can be removed', async () => {
  const { engine } = await built();
  engine.addDoc({ id: 'up-1', title: 'Note', text: '# Note\n\n## Parking\n\nLe parking vélo est au sous-sol, badge zorglub requis.' });
  await engine.build();
  const r = await engine.retrieve('zorglub', { mode: 'bm25' });
  assert.equal(r.final[0].chunk.docId, 'up-1');
  engine.removeDoc('up-1');
  await engine.build();
  assert.ok(!engine.chunks.some((c) => c.docId === 'up-1'));
});
