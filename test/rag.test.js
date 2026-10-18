import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, detectLang, chunkDocument, chunkSearchText, Bm25Index, VectorIndex, rrf, sigmoid,
  isRelevant, firstRelevantRank, summarize, parseCitations, citationCoverage,
} from '../public/js/rag.js';
import { corpus, golden } from './helpers.js';

test('tokenizer keeps codes whole, folds accents and drops stop words', () => {
  assert.deepEqual(tokenize("Que signifie l'erreur NX-409 ?"), ['signifie', 'erreur', 'nx-409']);
  assert.ok(tokenize('Échéance des Factures').includes('echeance'));
  assert.ok(tokenize('factures').includes('facture'));
});

test('language detection', () => {
  assert.equal(detectLang('What is the maximum resolution time for a ticket?'), 'en');
  assert.equal(detectLang('Quel est le délai de résolution pour les tickets ?'), 'fr');
});

for (const size of [300, 600, 1200]) {
  test(`chunker at ${size} chars: unique ids, one section per chunk, size respected`, () => {
    const chunks = corpus.flatMap((d) => chunkDocument(d, { size, overlap: Math.round(size * 0.15) }));
    assert.ok(chunks.length >= corpus.length);
    assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
    for (const c of chunks) {
      assert.ok(c.text.length <= size + 2, `${c.id} is ${c.text.length} chars`);
      assert.ok(c.section && c.title && c.docId);
      assert.ok(!c.text.startsWith('# '), 'document title is not a chunk');
    }
  });
}

test('chunker overlap repeats the end of the previous chunk of the same section', () => {
  const doc = { id: 'd', title: 'D', text: `# D\n\n## S\n\n${'Phrase un est ici. '.repeat(10)}\n\n${'Phrase deux est là. '.repeat(10)}\n\n${'Phrase trois finit. '.repeat(10)}` };
  const chunks = chunkDocument(doc, { size: 250, overlap: 60 });
  assert.ok(chunks.length >= 2);
  const tail = chunks[0].text.slice(-20).trim();
  assert.ok(chunks[1].text.includes(tail));
  assert.ok(chunks[1].overlap > 0);
  assert.ok(chunks[0].text.endsWith(chunks[1].text.slice(0, chunks[1].overlap)));
  // Long sentences: falls back to the last words instead of no overlap at all.
  const long = { id: 'l', title: 'L', text: `# L\n\n## S\n\n${'Une phrase assez longue qui dépasse largement la limite de chevauchement. '.repeat(3)}\n\n${'Un second paragraphe tout aussi long pour forcer une coupure nette. '.repeat(3)}` };
  const lc = chunkDocument(long, { size: 260, overlap: 40 });
  assert.ok(lc[1].overlap > 0 && lc[1].overlap <= 40);
  const none = chunkDocument(doc, { size: 250, overlap: 0 });
  assert.equal(none[1].overlap, 0);
  assert.ok(!none[1].text.startsWith(none[0].text.slice(-19).trim()));
});

test('every golden question has at least one relevant chunk at every chunk size', () => {
  for (const size of [300, 600, 1200]) {
    const chunks = corpus.flatMap((d) => chunkDocument(d, { size, overlap: 0 }));
    for (const g of golden) assert.ok(chunks.some((c) => isRelevant(c, g.expect)), `${g.id} at ${size}`);
  }
  assert.equal(golden.length, 24);
  assert.equal(new Set(golden.map((g) => g.id)).size, 24);
});

test('BM25 ranks the exact error code first', () => {
  const chunks = corpus.flatMap((d) => chunkDocument(d, { size: 600, overlap: 90 }));
  const bm = new Bm25Index();
  chunks.forEach((c) => bm.add(c.id, chunkSearchText(c)));
  const hit = chunks.find((c) => c.id === bm.search('What does NX-503 mean?', 3)[0].id);
  assert.equal(hit.docId, '14-nexa-gestion-api-guide');
  assert.deepEqual(bm.search('', 3), []);
});

test('vector index returns nearest by cosine, independent of length', () => {
  const vi = new VectorIndex();
  vi.add('a', [1, 0, 0]);
  vi.add('b', [0, 10, 0]);
  vi.add('c', [1, 1, 0]);
  assert.deepEqual(vi.search([0, 3, 0], 2).map((h) => h.id), ['b', 'c']);
  assert.throws(() => vi.add('d', [1, 2]), /dimension/);
});

test('reciprocal rank fusion rewards agreement between lists', () => {
  const fused = rrf([[{ id: 'x' }, { id: 'y' }, { id: 'z' }], [{ id: 'y' }, { id: 'w' }]], 60, 10);
  assert.equal(fused[0].id, 'y');
  assert.equal(fused.length, 4);
  assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-9);
});

test('metrics: hit@k and MRR', () => {
  const m = summarize([1, 3, 0, 6]);
  assert.equal(m['hit@1'], 0.25);
  assert.equal(m['hit@3'], 0.5);
  assert.equal(m['hit@5'], 0.5);
  assert.ok(Math.abs(m.mrr - (1 + 1 / 3 + 1 / 6) / 4) < 1e-9);
  const by = new Map([['a', { docId: 'd', section: '2. Télétravail' }], ['b', { docId: 'e', section: 'x' }]]);
  assert.equal(firstRelevantRank(['b', 'a'], by, [{ doc: 'd', section: 'teletravail' }]), 2);
});

test('citations: valid, invented and coverage', () => {
  const c = parseCitations('Deux jours [1]. Mardi obligatoire [2][7]. Voir [1, 3].', 5);
  assert.deepEqual(c.used, [1, 2, 3]);
  assert.deepEqual(c.invalid, [7]);
  assert.equal(citationCoverage('Le télétravail est limité à deux jours [1]. Le mardi est un jour de présence obligatoire.'), 0.5);
});
