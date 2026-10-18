// Test helpers: a deterministic fake embedding model (hashed bag of words)
// and a fake API client, so the pipeline can be tested without the network.
import { tokenize } from '../public/js/rag.js';
import { readFileSync } from 'node:fs';

const DIM = 256;

function fakeEmbed(text) {
  const v = new Array(DIM).fill(0);
  for (const t of tokenize(text)) {
    let h = 2166136261;
    for (const ch of t) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[Math.abs(h) % DIM] += 1;
  }
  v[0] += 0.01; // never a zero vector
  return v;
}

function fakeApi({ embeddings = true, rerank = true, failEmbed = false } = {}) {
  const calls = { embed: 0, rerank: 0, answer: 0, embeddedTexts: 0 };
  return {
    calls,
    config: { embeddings, rerank, answers: true },
    async embed(texts, onBatch) {
      calls.embed += 1;
      if (failEmbed) { const e = new Error('x'); e.code = 'embeddings_failed'; throw e; }
      calls.embeddedTexts += texts.length;
      if (onBatch) onBatch(texts.length, texts.length);
      return texts.map(fakeEmbed);
    },
    async rerank(query, passages) {
      calls.rerank += 1;
      const q = new Set(tokenize(query));
      return passages.map((p) => tokenize(p).filter((t) => q.has(t)).length - 2);
    },
    async answer({ passages }) {
      calls.answer += 1;
      return { model: 'claude-haiku-4-5', text: `Deux jours par semaine [1]. Le mardi est obligatoire [${passages.length + 3}].`, usage: { input_tokens: 2000, output_tokens: 100 } };
    },
  };
}

function memoryCache() {
  const map = new Map();
  return {
    map,
    async hashKey(model, text) { return `${model}:${text}`; },
    async getMany(keys) { return keys.map((k) => map.get(k) || null); },
    async putMany(entries) { for (const [k, v] of entries) map.set(k, Float32Array.from(v)); },
  };
}

const corpus = JSON.parse(readFileSync(new URL('../public/data/corpus.json', import.meta.url))).docs;
const golden = JSON.parse(readFileSync(new URL('../public/data/golden.json', import.meta.url))).questions;

export { fakeEmbed, fakeApi, memoryCache, corpus, golden };
