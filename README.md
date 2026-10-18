# Verity

**A RAG engine you can measure: hybrid search (BM25 + multilingual embeddings), cross-encoder reranking, answers that cite every sentence, and a live evaluation that compares retrieval methods on a labelled question set.**

Verity ships with the internal documents of a fictional company, *Nexa Digital* (a web agency in Angers): 15 documents in French and English covering billing, security policy, GDPR retention, support SLAs, HR, incident response, backups, API reference and more. Visitors can add their own PDF, Word, Markdown or text files, or a deliberately poisoned document to test prompt-injection resistance.

## What it shows

| View | What you see |
|---|---|
| **Ask** | The answer with clickable `[n]` citations, the five source passages with query terms highlighted, and a **retrieval trace**: the latency of each stage and how BM25, vectors, RRF fusion and the reranker each ranked the passages that were kept. Switch method and the same question re-runs. |
| **Documents** | Every indexed document, upload, chunk-size and overlap settings, and a **chunk inspector** showing exactly how a document was split (the overlap carried from the previous chunk is shaded). |
| **Evaluation** | 24 golden questions (exact codes, French paraphrases, cross-language questions) labelled with the section that holds the answer. One click measures **hit@1/3/5 and MRR** for BM25, vectors, hybrid and hybrid + rerank, broken down by question type, with per-question ranks and CSV export. |
| **How it works** | The pipeline, the design choices, the security model and the limits. |

## Architecture

```
 Browser (documents and index stay here)          Cloudflare Worker                 Providers
 ───────────────────────────────────────          ─────────────────                 ─────────
 Chunker (section-aware, overlap)                 POST /api/embed   ─────────────▶  Workers AI  @cf/baai/bge-m3
 BM25 index                                       POST /api/rerank  ─────────────▶  Workers AI  @cf/baai/bge-reranker-base
 Vector index (cosine, cached in IndexedDB)       POST /api/answer  ─────────────▶  Claude API  (Haiku 4.5 by default)
 RRF fusion, metrics, citation checks             · rate limits, access code
                                                  · validates every field
                                                  · fixed system prompt and model list
```

**Query path:** BM25 top 20 + vector top 20 → reciprocal rank fusion → the reranker reorders the fused 20 → the top 5 go to Claude, which must cite `[n]` for every factual sentence or say the answer is not in the documents.

## Design decisions

* **Hybrid retrieval.** Embeddings (bge-m3, multilingual) handle paraphrases and cross-language questions; BM25 handles exact identifiers such as `NX-409` or "article 10" that embeddings blur. RRF combines them by rank, so the two score scales never need calibrating.
* **Reranking.** A cross-encoder reads question and passage together, which is more precise than comparing two independent vectors; it only runs on 20 candidates, so it stays fast and cheap.
* **Contextual chunk headers.** Each chunk is indexed as `document › section` + text, so a passage like "30 days" still carries what it is about.
* **Section-aware chunking.** Chunks never cross a heading; whole paragraphs and tables are kept together when they fit; overlap repeats whole sentences, or the last words when sentences are long. A short preamble before the first heading is skipped as metadata.
* **Labels by section, not by chunk.** Golden questions point to a document section, so the evaluation stays valid when the chunk size changes.
* **Checked citations.** The interface counts the share of cited sentences and flags any `[n]` that points to no source.
* **Graceful degradation.** Without Workers AI, Verity falls back to BM25; without an Anthropic key, it still shows the retrieved passages.

## Security

* System prompt, model allowlist and output limit are fixed on the server; the browser sends only a question and passages, which are re-validated field by field (types, lengths, counts, control characters).
* Retrieved text is fenced inside `<source>` tags; any `<source>` tag inside a document is neutralised, and the prompt treats source text as data. The "poisoned document" button demonstrates an injection attempt.
* Strict Content-Security-Policy (no inline script or style, `connect-src 'self'`), HSTS, frame denial, COOP/CORP, HTTPS redirect.
* Per-IP rate limits (retrieval and answers separately), optional access code compared in constant time, request size caps, provider error bodies never forwarded.
* Model output is HTML-escaped before the minimal Markdown formatting; source passages are highlighted by walking DOM text nodes, never by re-parsing HTML.

## Run and deploy

No npm dependencies are needed to test or deploy (`npx` fetches Wrangler).

```bash
npm test                                  # 31 unit tests (Node 20+)
node scripts/build_corpus.mjs             # rebuild public/data/corpus.json from corpus/*.md
npx wrangler deploy                       # deploy to Cloudflare (Workers AI binding included)
npx wrangler secret put ANTHROPIC_API_KEY # paste the key at the prompt
npx wrangler secret put ACCESS_CODE       # recommended for a public demo
```

End-to-end test (real page, real Worker, fake providers): `node test/e2e/server.mjs &` then `python3 test/e2e/run.py` (Playwright for Python; 31 checks including the access code, answers, citations, trace, chunk inspector, uploads, the poisoned document, evaluation, CSV export and the mobile layout).

## Cost

* **Embeddings and reranking:** Workers AI, about $0.012 per million tokens for bge-m3; indexing the demo corpus is a few thousand tokens, inside the free daily allowance.
* **Answers:** Claude Haiku 4.5 at $1 / $5 per million input/output tokens; a typical answer reads ~1,900 tokens of sources and writes ~100, about **$0.0025 per question**. Each answer shows its own token count and cost.

## Limits and next steps

* The index lives in the browser: right for a demo and up to a few thousand passages. A production version keeps vectors server-side (pgvector, Cloudflare Vectorize) and filters by each user's document permissions before ranking.
* No follow-up question rewriting yet (each question is standalone) and no OCR for scanned PDFs.
* The evaluation measures retrieval; generation quality (faithfulness, answer relevance) with an LLM judge is the next step.
* Reranker probabilities are not calibrated; the "weak evidence" flag is a heuristic, while the decision to answer "not found" stays with the model.

---
*Nexa Digital, its people and its documents are fictional.*
