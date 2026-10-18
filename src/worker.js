// Verity — Cloudflare Worker.
//
// Serves the static app and four API routes:
//   GET  /api/config  what is available (embeddings, reranker, answers, access code)
//   POST /api/embed   texts  -> vectors        (Workers AI, bge-m3, multilingual)
//   POST /api/rerank  query + passages -> scores (Workers AI, bge-reranker-base)
//   POST /api/answer  question + passages -> cited answer (Claude API)
//
// Documents, chunks and the vector index live in the visitor's browser. The
// Worker only sees the texts it is asked to embed or rerank and the few
// passages used for an answer. The system prompt and the model list are fixed
// here; the browser cannot change them.

import {
  ANSWER_MODELS, DEFAULT_ANSWER_MODEL, EMBED_MODEL, LIMITS, RERANK_MODEL, ValidationError,
  answerText, buildAnswerRequest, parseEmbedResponse, parseRerankResponse,
  validateAnswer, validateEmbed, validateRerank,
} from '../lib/api.js';
import { httpsRedirect, withSecurityHeaders } from '../lib/security-headers.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const UPSTREAM_TIMEOUT_MS = 60_000;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Constant-time comparison over fixed-length digests.
async function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function rateLimited(limiter, key) {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

// Shared guard for every POST route: rate limit, access code, JSON body with
// a size cap. Returns { body } or { response } to send back as is.
async function readRequest(request, env, limiter) {
  if (await rateLimited(limiter, clientIp(request))) {
    return { response: json({ error: 'rate_limited' }, 429, { 'retry-after': '60' }) };
  }
  if (env.ACCESS_CODE && !(await sameSecret(request.headers.get('x-access-code') || '', env.ACCESS_CODE))) {
    return { response: json({ error: 'access_code' }, 401) };
  }
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('application/json')) return { response: json({ error: 'bad_request' }, 415) };
  if (Number(request.headers.get('content-length') || 0) > LIMITS.bodyBytes) return { response: json({ error: 'too_large' }, 413) };
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { response: json({ error: 'bad_request' }, 400) };
  }
  if (raw.length > LIMITS.bodyBytes) return { response: json({ error: 'too_large' }, 413) };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { response: json({ error: 'bad_request' }, 400) };
  }
}

function invalid(err) {
  if (err instanceof ValidationError) return json({ error: 'invalid', detail: err.message }, 400);
  throw err;
}

async function handleEmbed(request, env) {
  if (!env.AI) return json({ error: 'embeddings_unavailable' }, 503);
  const { body, response } = await readRequest(request, env, env.RETRIEVAL_RATE_LIMITER);
  if (response) return response;
  let input;
  try { input = validateEmbed(body); } catch (err) { return invalid(err); }
  // bge-m3 documents two input shapes; the second is tried if the first fails.
  const attempts = [{ text: input.texts }, { contexts: input.texts.map((text) => ({ text })) }];
  for (const payload of attempts) {
    try {
      const vectors = parseEmbedResponse(await env.AI.run(EMBED_MODEL, payload), input.texts.length);
      return json({ model: EMBED_MODEL, dim: vectors[0].length, vectors });
    } catch {
      // try the next input shape
    }
  }
  return json({ error: 'embeddings_failed' }, 502);
}

async function handleRerank(request, env) {
  if (!env.AI) return json({ error: 'rerank_unavailable' }, 503);
  const { body, response } = await readRequest(request, env, env.RETRIEVAL_RATE_LIMITER);
  if (response) return response;
  let input;
  try { input = validateRerank(body); } catch (err) { return invalid(err); }
  try {
    const res = await env.AI.run(RERANK_MODEL, {
      query: input.query,
      contexts: input.passages.map((text) => ({ text })),
      top_k: input.passages.length,
    });
    return json({ model: RERANK_MODEL, scores: parseRerankResponse(res, input.passages.length) });
  } catch {
    return json({ error: 'rerank_failed' }, 502);
  }
}

async function handleAnswer(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 503);
  const { body, response } = await readRequest(request, env, env.ANSWER_RATE_LIMITER);
  if (response) return response;
  let input;
  try { input = validateAnswer(body); } catch (err) { return invalid(err); }

  const payload = buildAnswerRequest(input, env.ANSWER_MODEL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    // Provider error bodies are never forwarded (they can reveal account details).
    const status = upstream.status === 429 || upstream.status === 529 ? 503 : 502;
    return json({ error: status === 503 ? 'busy' : 'upstream_error' }, status);
  }
  const data = await upstream.json();
  return json({ model: payload.model, text: answerText(data), usage: data.usage || null, stop_reason: data.stop_reason || null });
}

const POST_ROUTES = { '/api/embed': handleEmbed, '/api/rerank': handleRerank, '/api/answer': handleAnswer };

async function route(request, env) {
  const url = new URL(request.url);
  const handler = POST_ROUTES[url.pathname];
  if (handler) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405, { allow: 'POST' });
    return handler(request, env);
  }
  if (url.pathname === '/api/config') {
    return json({
      accessCodeRequired: Boolean(env.ACCESS_CODE),
      embeddings: Boolean(env.AI),
      rerank: Boolean(env.AI),
      answers: Boolean(env.ANTHROPIC_API_KEY),
      embedModel: EMBED_MODEL,
      rerankModel: RERANK_MODEL,
      answerModels: Object.entries(ANSWER_MODELS).map(([id, m]) => ({ id, label: m.label })),
      defaultAnswerModel: Object.hasOwn(ANSWER_MODELS, env.ANSWER_MODEL) ? env.ANSWER_MODEL : DEFAULT_ANSWER_MODEL,
    });
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const redirect = httpsRedirect(request);
    if (redirect) return redirect;
    try {
      return withSecurityHeaders(await route(request, env || {}));
    } catch {
      return withSecurityHeaders(json({ error: 'internal' }, 500));
    }
  },
};

export { route, sameSecret };
