// Verity retrieval core: chunking, BM25, vector search, rank fusion, metrics.
// Pure functions and small classes with no browser dependency, so the same
// code runs in the page and in the Node test suite.

// ---------------------------------------------------------------- text

const STOP = new Set(`a au aux avec ce ces cet cette dans de des du elle en et eux il ils je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou où par pas pour qu que qui quel quelle quels quelles sa se ses son sur ta te tes toi ton tu un une vos votre vous c d j l m n s t y été être est sont ont fait faire plus peut doit faut combien comment est-ce chez depuis puis entre sans sous aussi tout tous toute toutes très bien
the of and to in is are was were be been for on with as by at or an it this that from which not but have has had can will would should what how when where who why all any each other some such no nor only own same so than too very do does did my our your we you they i`.split(/\s+/));

function normalize(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Deliberately light stemming for French and English: plural endings and a
// few frequent suffixes. Enough to match "factures" with "facture".
function stem(word) {
  if (/^\d/.test(word) || word.includes('-')) return word;
  if (word.length > 6 && word.endsWith('ement')) return word.slice(0, -5);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 3 && /[sx]$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

// Codes such as NX-409, F-AAAA-NNNN or SEV1 are kept whole: they are exactly
// the tokens that semantic search tends to miss.
function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9_-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function detectLang(text) {
  const t = ` ${normalize(text)} `;
  const fr = (t.match(/ (le|la|les|des|est|une|pour|dans|que|du|au|sont|avec) /g) || []).length;
  const en = (t.match(/ (the|is|are|and|for|with|what|how|your|our|of|to) /g) || []).length;
  return en > fr ? 'en' : 'fr';
}

// ---------------------------------------------------------------- chunking

function splitSentences(text) {
  return String(text).match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) || [String(text)];
}

// Heading-aware chunker. Each chunk stays inside one section, is at most
// `size` characters (a whole paragraph or table is never cut unless it is
// longer than `size` by itself), and starts with the tail of the previous
// chunk of the same section (`overlap` characters, whole sentences).
// Every chunk remembers its document and section: that header is added to the
// text used for search, so a chunk "knows" what it is about.
function chunkDocument(doc, { size = 900, overlap = 120 } = {}) {
  const lines = String(doc.text).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = { section: doc.title, body: [] };
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (h) {
      if (h[1].length === 1 && !sections.length && !current.body.join('').trim()) continue; // document title
      if (current.body.join('').trim()) sections.push(current);
      current = { section: h[2].replace(/[*_`]/g, ''), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('').trim()) sections.push(current);
  // A short preamble before the first heading (version line, disclaimer) is
  // metadata, not knowledge: it would only add noise to retrieval.
  if (sections.length > 1 && sections[0].section === doc.title && sections[0].body.join(' ').trim().length < 120) sections.shift();

  const chunks = [];
  for (const sec of sections) {
    const paras = sec.body.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const pieces = [];
    for (const p of paras) {
      if (p.length <= size) { pieces.push(p); continue; }
      let buf = '';
      for (const s of splitSentences(p)) {
        if (buf && buf.length + s.length > size) { pieces.push(buf.trim()); buf = ''; }
        if (s.length > size) {
          for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size).trim());
        } else buf += s;
      }
      if (buf.trim()) pieces.push(buf.trim());
    }
    let buf = '';
    let carried = 0;
    const sectionChunks = [];
    for (const piece of pieces) {
      if (buf && buf.length + piece.length + 2 > size) {
        sectionChunks.push({ text: buf.trim(), overlap: carried });
        // The carried tail never pushes the next chunk over the size limit.
        const tail = overlap > 0 ? tailSentences(buf, Math.min(overlap, size - piece.length - 2)) : '';
        carried = tail.length;
        buf = tail ? `${tail}\n\n` : '';
      }
      buf += (buf && !buf.endsWith('\n\n') ? '\n\n' : '') + piece;
    }
    if (buf.trim()) sectionChunks.push({ text: buf.trim(), overlap: carried });
    sectionChunks.forEach(({ text, overlap: overlapChars }, i) => {
      chunks.push({
        id: `${doc.id}#${chunks.length}`,
        docId: doc.id,
        title: doc.title,
        section: sec.section,
        part: sectionChunks.length > 1 ? i + 1 : 0,
        lang: doc.lang || detectLang(text),
        overlap: overlapChars,
        text,
      });
    });
  }
  return chunks;
}

// The end of a chunk, repeated at the start of the next one: whole sentences
// when they fit, otherwise the last words up to maxChars.
function tailSentences(text, maxChars) {
  const sentences = splitSentences(text.trim());
  let tail = '';
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const next = sentences[i] + tail;
    if (next.length > maxChars) break;
    tail = next;
  }
  tail = tail.trim();
  if (!tail && maxChars >= 20) {
    const cut = text.trim().slice(-maxChars);
    const space = cut.indexOf(' ');
    tail = (space >= 0 ? cut.slice(space + 1) : cut).trim();
  }
  return tail;
}

// Text sent to the embedding model and indexed by BM25: a contextual header
// (document › section) followed by the passage.
function chunkSearchText(chunk) {
  return `${chunk.title} › ${chunk.section}\n${chunk.text}`;
}

// ---------------------------------------------------------------- BM25

class Bm25Index {
  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.items = [];
    this.df = new Map();
    this.totalLen = 0;
  }

  add(id, text) {
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.items.push({ id, tf, len: tokens.length });
    this.totalLen += tokens.length;
  }

  get size() { return this.items.length; }

  search(query, topK = 10) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.items.length) return [];
    const n = this.items.length;
    const avg = this.totalLen / n || 1;
    const scored = [];
    for (const { id, tf, len } of this.items) {
      let score = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / avg)));
      }
      if (score > 0) scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, topK);
  }
}

// ---------------------------------------------------------------- vectors

function l2normalize(vec) {
  const v = Float32Array.from(vec);
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i += 1) v[i] /= norm;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// Exact (brute-force) cosine search. Vectors are normalised once, so cosine
// similarity is a dot product. Fine up to tens of thousands of chunks; beyond
// that an approximate index (HNSW, pgvector, Vectorize) takes over.
class VectorIndex {
  constructor() { this.ids = []; this.vecs = []; this.dim = 0; }

  add(id, vec) {
    const v = l2normalize(vec);
    if (this.dim && v.length !== this.dim) throw new Error('dimension mismatch');
    this.dim = v.length;
    this.ids.push(id);
    this.vecs.push(v);
  }

  get size() { return this.ids.length; }

  search(queryVec, topK = 10) {
    if (!this.ids.length) return [];
    const q = l2normalize(queryVec);
    const scored = this.ids.map((id, i) => ({ id, score: dot(q, this.vecs[i]) }));
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, topK);
  }
}

// ---------------------------------------------------------------- fusion

// Reciprocal rank fusion: each list votes 1 / (k + rank) for its items. Uses
// ranks only, so BM25 scores and cosine similarities never need calibrating.
function rrf(lists, k = 60, topK = 20) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((hit, i) => scores.set(hit.id, (scores.get(hit.id) || 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, topK);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ---------------------------------------------------------------- evaluation

// A chunk is relevant to a golden question when it comes from an expected
// document and section. Labelling by section (not by chunk id) keeps the
// golden set valid whatever the chunk size.
function isRelevant(chunk, expect) {
  return expect.some((e) => chunk.docId === e.doc && normalize(chunk.section).includes(normalize(e.section)));
}

// 1-based rank of the first relevant result, or 0 when none is retrieved.
function firstRelevantRank(ids, chunksById, expect) {
  for (let i = 0; i < ids.length; i += 1) {
    const c = chunksById.get(ids[i]);
    if (c && isRelevant(c, expect)) return i + 1;
  }
  return 0;
}

function summarize(ranks, ks = [1, 3, 5]) {
  const n = ranks.length || 1;
  const out = {};
  for (const k of ks) out[`hit@${k}`] = ranks.filter((r) => r > 0 && r <= k).length / n;
  out.mrr = ranks.reduce((s, r) => s + (r > 0 && r <= 10 ? 1 / r : 0), 0) / n;
  return out;
}

// ---------------------------------------------------------------- citations

// Finds [n] markers in an answer. Returns the cited source numbers that exist
// and the ones that do not (a sign of an invented citation).
function parseCitations(text, sourceCount) {
  const used = new Set();
  const invalid = new Set();
  for (const m of String(text).matchAll(/\[(\d{1,2})(?:\s*[,;]\s*(\d{1,2}))*\]/g)) {
    for (const n of m[0].match(/\d{1,2}/g).map(Number)) (n >= 1 && n <= sourceCount ? used : invalid).add(n);
  }
  return { used: [...used].sort((a, b) => a - b), invalid: [...invalid].sort((a, b) => a - b) };
}

// Share of answer sentences that carry at least one citation.
function citationCoverage(text) {
  const sentences = splitSentences(String(text).replace(/^\s*[-*]\s+/gm, ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
  if (!sentences.length) return 0;
  return sentences.filter((s) => /\[\d{1,2}/.test(s)).length / sentences.length;
}

export {
  normalize, tokenize, stem, detectLang, splitSentences, chunkDocument, chunkSearchText,
  Bm25Index, VectorIndex, l2normalize, dot, rrf, sigmoid,
  isRelevant, firstRelevantRank, summarize, parseCitations, citationCoverage,
};
