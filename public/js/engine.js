// The RAG pipeline: index documents, retrieve with four strategies, answer
// with citations, and evaluate retrieval on a golden set.
// Dependencies (API client, embedding cache) are injected, so the whole
// pipeline runs in Node tests with fakes.

import {
  Bm25Index, VectorIndex, chunkDocument, chunkSearchText, rrf, sigmoid,
  firstRelevantRank, summarize, parseCitations, citationCoverage, detectLang,
} from './rag.js';

const MODES = ['bm25', 'vector', 'hybrid', 'rerank'];
const POOL = 20; // candidates kept from each retriever and sent to the reranker
const WEAK_EVIDENCE = 0.05; // reranker probability below which evidence is flagged as weak

const PRICES = { // US$ per million tokens (input, output)
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5-5': [2, 10],
};

function now() {
  return (typeof performance !== 'undefined' ? performance : Date).now();
}

function rankMap(list) {
  const m = new Map();
  list.forEach((h, i) => m.set(h.id, i + 1));
  return m;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

class Engine {
  constructor({ api, cache = null, embedModel = 'embed' }) {
    this.api = api;
    this.cache = cache;
    this.embedModel = embedModel;
    this.docs = [];
    this.chunks = [];
    this.byId = new Map();
    this.bm25 = new Bm25Index();
    this.vectors = new VectorIndex();
    this.settings = { size: 600, overlap: 0.15 };
    this.vectorsReady = false;
    this.vectorError = null;
    this.indexStats = null;
  }

  get canEmbed() { return Boolean(this.api.config && this.api.config.embeddings); }
  get canRerank() { return Boolean(this.api.config && this.api.config.rerank); }

  setDocs(docs) { this.docs = docs.slice(); }

  addDoc(doc) {
    const clean = { ...doc, lang: doc.lang || detectLang(doc.text) };
    this.docs = this.docs.filter((d) => d.id !== clean.id).concat(clean);
  }

  removeDoc(id) { this.docs = this.docs.filter((d) => d.id !== id); }

  // Chunks every document, builds BM25 at once, then embeds (cached chunks are
  // not sent again). Vector search stays off if embedding fails; BM25 works
  // regardless.
  async build(onProgress = () => {}) {
    const t0 = now();
    const size = this.settings.size;
    const overlap = Math.round(size * this.settings.overlap);
    this.chunks = this.docs.flatMap((d) => chunkDocument(d, { size, overlap }));
    this.byId = new Map(this.chunks.map((c) => [c.id, c]));
    this.bm25 = new Bm25Index();
    for (const c of this.chunks) this.bm25.add(c.id, chunkSearchText(c));
    this.vectors = new VectorIndex();
    this.vectorsReady = false;
    this.vectorError = null;
    const stats = { docs: this.docs.length, chunks: this.chunks.length, cached: 0, embedded: 0, ms: 0, dim: 0 };
    onProgress({ phase: 'bm25', done: this.chunks.length, total: this.chunks.length });

    if (this.canEmbed && this.chunks.length) {
      try {
        const texts = this.chunks.map(chunkSearchText);
        const keys = this.cache ? await Promise.all(texts.map((t) => this.cache.hashKey(this.embedModel, t))) : [];
        const cached = this.cache ? await this.cache.getMany(keys) : texts.map(() => null);
        const missing = [];
        cached.forEach((v, i) => { if (!v) missing.push(i); });
        stats.cached = texts.length - missing.length;
        onProgress({ phase: 'embed', done: stats.cached, total: texts.length });
        if (missing.length) {
          const fresh = await this.api.embed(missing.map((i) => texts[i]), (done) => {
            onProgress({ phase: 'embed', done: stats.cached + done, total: texts.length });
          });
          missing.forEach((idx, j) => { cached[idx] = fresh[j]; });
          stats.embedded = missing.length;
          if (this.cache) await this.cache.putMany(missing.map((idx, j) => [keys[idx], fresh[j]]));
        }
        this.chunks.forEach((c, i) => this.vectors.add(c.id, cached[i]));
        stats.dim = this.vectors.dim;
        this.vectorsReady = true;
      } catch (err) {
        this.vectorError = (err && err.code) || 'embed_failed';
        this.vectors = new VectorIndex();
      }
    }
    stats.ms = Math.round(now() - t0);
    this.indexStats = stats;
    onProgress({ phase: 'done', done: this.chunks.length, total: this.chunks.length });
    return stats;
  }

  effectiveMode(mode) {
    if (!this.vectorsReady) return 'bm25';
    if (mode === 'rerank' && !this.canRerank) return 'hybrid';
    return MODES.includes(mode) ? mode : 'rerank';
  }

  // Runs the retrieval for one question and returns every intermediate list,
  // so the interface can show how each stage changed the ranking.
  async retrieve(question, { mode = 'rerank', k = 5, queryVector = null } = {}) {
    const used = this.effectiveMode(mode);
    const timings = {};
    const lists = { bm25: [], vector: [], fused: [], reranked: [] };

    let t = now();
    lists.bm25 = this.bm25.search(question, POOL);
    timings.bm25 = now() - t;

    if (used !== 'bm25') {
      t = now();
      const qv = queryVector || (await this.api.embed([question]))[0];
      timings.embed = now() - t;
      t = now();
      lists.vector = this.vectors.search(qv, POOL);
      timings.vector = now() - t;
    }
    if (used === 'hybrid' || used === 'rerank') {
      t = now();
      lists.fused = rrf([lists.bm25, lists.vector], 60, POOL);
      timings.fuse = now() - t;
    }
    if (used === 'rerank' && lists.fused.length) {
      t = now();
      const candidates = lists.fused.map((h) => this.byId.get(h.id));
      const scores = await this.api.rerank(question, candidates.map(chunkSearchText));
      lists.reranked = candidates
        .map((c, i) => ({ id: c.id, score: sigmoid(scores[i]), raw: scores[i] }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      timings.rerank = now() - t;
    }

    const finalList = { bm25: lists.bm25, vector: lists.vector, hybrid: lists.fused, rerank: lists.reranked }[used];
    const ranks = { bm25: rankMap(lists.bm25), vector: rankMap(lists.vector), fused: rankMap(lists.fused), reranked: rankMap(lists.reranked) };
    const final = finalList.slice(0, k).map((h, i) => ({
      id: h.id,
      rank: i + 1,
      score: h.score,
      chunk: this.byId.get(h.id),
      ranks: {
        bm25: ranks.bm25.get(h.id) || 0,
        vector: ranks.vector.get(h.id) || 0,
        fused: ranks.fused.get(h.id) || 0,
        reranked: ranks.reranked.get(h.id) || 0,
      },
    }));
    const topProbability = used === 'rerank' && lists.reranked.length ? lists.reranked[0].score : null;
    return {
      question,
      requested: mode,
      mode: used,
      lists,
      final,
      timings,
      weakEvidence: topProbability !== null && topProbability < WEAK_EVIDENCE,
      topProbability,
    };
  }

  async answer(question, retrieval, { lang, model } = {}) {
    const passages = retrieval.final.map((f) => ({ title: f.chunk.title, section: f.chunk.section, text: f.chunk.text }));
    const t = now();
    const res = await this.api.answer({ question, passages, lang: lang || detectLang(question), model });
    const ms = now() - t;
    const text = String(res.text || '');
    const usage = res.usage || {};
    const price = PRICES[res.model] || PRICES['claude-haiku-4-5'];
    const cost = ((usage.input_tokens || 0) * price[0] + (usage.output_tokens || 0) * price[1]) / 1e6;
    return {
      text,
      model: res.model,
      ms,
      usage,
      cost,
      citations: parseCitations(text, passages.length),
      coverage: citationCoverage(text),
    };
  }

  // Retrieval evaluation on a golden set. Every method sees the same query
  // vectors; the reranker reorders the hybrid pool. Returns per-method metrics,
  // a breakdown by question type and the rank of the first relevant passage
  // for every question and method (0 = not in the top 10).
  async evaluate(questions, onProgress = () => {}) {
    const methods = this.vectorsReady ? (this.canRerank ? MODES : MODES.slice(0, 3)) : ['bm25'];
    const qvecs = this.vectorsReady ? await this.api.embed(questions.map((q) => q.q)) : [];
    let done = 0;
    const rows = await mapLimit(questions, 4, async (q, i) => {
      const row = { id: q.id, q: q.q, type: q.type, ranks: {}, ms: {} };
      const t0 = now();
      const bm = this.bm25.search(q.q, POOL);
      row.ms.bm25 = now() - t0;
      row.ranks.bm25 = firstRelevantRank(bm.slice(0, 10).map((h) => h.id), this.byId, q.expect);
      if (methods.includes('vector')) {
        const t1 = now();
        const vec = this.vectors.search(qvecs[i], POOL);
        row.ms.vector = now() - t1;
        row.ranks.vector = firstRelevantRank(vec.slice(0, 10).map((h) => h.id), this.byId, q.expect);
        const fused = rrf([bm, vec], 60, POOL);
        row.ms.hybrid = row.ms.bm25 + row.ms.vector;
        row.ranks.hybrid = firstRelevantRank(fused.slice(0, 10).map((h) => h.id), this.byId, q.expect);
        if (methods.includes('rerank')) {
          const t2 = now();
          const candidates = fused.map((h) => this.byId.get(h.id));
          const scores = await this.api.rerank(q.q, candidates.map(chunkSearchText));
          const order = candidates.map((c, j) => ({ id: c.id, s: scores[j] })).sort((a, b) => b.s - a.s);
          row.ms.rerank = row.ms.hybrid + (now() - t2);
          row.ranks.rerank = firstRelevantRank(order.slice(0, 10).map((h) => h.id), this.byId, q.expect);
        }
      }
      done += 1;
      onProgress(done, questions.length);
      return row;
    });

    const metrics = {};
    const byType = {};
    const types = [...new Set(questions.map((q) => q.type))];
    for (const m of methods) {
      metrics[m] = summarize(rows.map((r) => r.ranks[m]));
      metrics[m].ms = rows.reduce((s, r) => s + (r.ms[m] || 0), 0) / rows.length;
      byType[m] = {};
      for (const type of types) {
        const sub = rows.filter((r) => r.type === type);
        byType[m][type] = { n: sub.length, ...summarize(sub.map((r) => r.ranks[m])) };
      }
    }
    return { methods, metrics, byType, types, rows, chunks: this.chunks.length, settings: { ...this.settings } };
  }
}

export { Engine, MODES, POOL, WEAK_EVIDENCE, PRICES, mapLimit };
