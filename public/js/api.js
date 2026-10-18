// Thin client for the Verity Worker API. Adds the access code, splits large
// embedding jobs into batches and turns HTTP errors into ApiError codes.

const EMBED_BATCH = 32;

class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function readCode() {
  try { return sessionStorage.getItem('verity.code') || ''; } catch { return ''; }
}

function saveCode(code) {
  try { sessionStorage.setItem('verity.code', code); } catch { /* private mode: keep in memory only */ }
  memoryCode = code;
}

let memoryCode = '';

async function post(path, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-code': memoryCode || readCode() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError('network', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new ApiError((data && data.error) || `http_${res.status}`, res.status);
  return data;
}

const api = {
  config: null,

  async loadConfig() {
    try {
      const res = await fetch('/api/config', { headers: { accept: 'application/json' } });
      this.config = res.ok ? await res.json() : null;
    } catch {
      this.config = null;
    }
    if (!this.config) this.config = { accessCodeRequired: false, embeddings: false, rerank: false, answers: false, answerModels: [] };
    return this.config;
  },

  setAccessCode: saveCode,
  hasAccessCode() { return Boolean(memoryCode || readCode()); },

  // Returns one vector per text, in order. onBatch(done, total) reports progress.
  async embed(texts, onBatch) {
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await post('/api/embed', { texts: batch });
      if (!res || !Array.isArray(res.vectors) || res.vectors.length !== batch.length) throw new ApiError('bad_response', 200);
      out.push(...res.vectors);
      if (onBatch) onBatch(Math.min(i + EMBED_BATCH, texts.length), texts.length);
    }
    return out;
  },

  async rerank(query, passages) {
    const res = await post('/api/rerank', { query, passages });
    if (!res || !Array.isArray(res.scores) || res.scores.length !== passages.length) throw new ApiError('bad_response', 200);
    return res.scores;
  },

  async answer({ question, passages, lang, model }) {
    return post('/api/answer', { question, passages, lang, model });
  },
};

export { api, ApiError };
