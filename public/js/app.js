// Verity interface. Wires the RAG engine to the four views.
// All dynamic text goes through esc() or the escaping Markdown renderer.

import { api, ApiError } from './api.js';
import { Engine, MODES } from './engine.js';
import { hashKey, getMany, putMany } from './store.js';
import { tokenize, detectLang } from './rag.js';
import { renderMarkdown, esc } from './markdown.js';
import { STRINGS, SUGGESTIONS } from './i18n.js';
import { fileToDoc, poisonedDoc } from './ingest.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  lang: 'fr',
  view: 'ask',
  mode: 'rerank',
  busy: false,
  building: false,
  retrieval: null,
  answer: null,
  evaluation: null,
  inspecting: null,
};

let engine = null;
let golden = [];

// ------------------------------------------------------------------ helpers

function t(key) {
  const parts = key.split('.');
  let v = STRINGS[state.lang];
  for (const p of parts) v = v && v[p];
  return v === undefined ? key : v;
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function ms(v) {
  if (v === undefined || v === null) return '—';
  if (v < 1) return `${v.toFixed(2)} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(1)} s`;
}

function pct(v) { return `${Math.round(v * 100)} %`; }

function errorText(err) {
  const code = err && (err.code || err.message);
  return STRINGS[state.lang].errors[code] || STRINGS[state.lang].errors.default;
}

// Inline style attributes are blocked by the CSP, so widths are applied
// through the CSSOM after rendering.
function applyWidths(root) {
  $$('[data-w]', root).forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`; });
}

// Wraps the query's terms in <mark> inside already-rendered (escaped) HTML,
// by walking text nodes: no string is ever re-parsed as HTML.
function highlightDom(root, query) {
  const terms = new Set(tokenize(query));
  if (!terms.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.nodeValue.split(/([\p{L}\p{N}_-]+)/u);
    if (parts.length < 2) continue;
    let changed = false;
    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => {
      const tok = i % 2 === 1 ? tokenize(part)[0] : null;
      if (tok && terms.has(tok)) {
        const m = document.createElement('mark');
        m.textContent = part;
        frag.append(m);
        changed = true;
      } else if (part) {
        frag.append(document.createTextNode(part));
      }
    });
    if (changed) node.replaceWith(frag);
  }
}

function rankClass(r) {
  if (!r) return 'r-none';
  if (r === 1) return 'r1';
  if (r <= 3) return 'r2';
  if (r <= 10) return 'r3';
  return 'r4';
}

// ------------------------------------------------------------------ i18n

function applyLang() {
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  $$('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  $$('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  renderModes();
  renderSuggestions();
  renderStatus();
  if (state.retrieval) renderResults();
  renderLibrary();
  if (state.evaluation) renderEval(state.evaluation);
}

// ------------------------------------------------------------------ views

function showView(view) {
  state.view = view;
  $$('[data-view-panel]').forEach((p) => { p.hidden = p.dataset.viewPanel !== view; });
  $$('.tab').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  store('verity.view', view);
}

function renderStatus() {
  const el = $('#status');
  if (!engine) return;
  if (state.building) {
    el.className = 'status busy';
    return;
  }
  const s = engine.indexStats;
  if (!s) { el.textContent = ''; return; }
  const vec = engine.vectorsReady;
  el.className = `status ${vec ? 'ok' : 'warn'}`;
  el.textContent = `${vec ? t('status.ready') : t('status.bm25only')} · ${s.chunks} ${t('chunks')}`;
}

function renderModes() {
  const box = $('#modes');
  box.innerHTML = MODES.map((m) => {
    const disabled = engine && engine.indexStats && engine.effectiveMode(m) !== m;
    return `<button type="button" role="radio" class="mode m-${m}" data-mode="${m}" aria-checked="${state.mode === m}" ${disabled ? 'disabled' : ''}>
      <span class="swatch"></span>${esc(t(`modes.${m}`))}</button>`;
  }).join('');
}

function renderSuggestions() {
  $('#suggestions').innerHTML = SUGGESTIONS.map((s, i) => `<button type="button" class="chip" data-suggest="${i}">
    <span class="chip-tag">${esc(t(`suggestionTags.${s.tag}`))}</span>${esc(s[state.lang])}</button>`).join('');
}

// ------------------------------------------------------------------ ask

function setProgress(text) {
  const p = $('#progress');
  p.hidden = !text;
  $('#progress-text').textContent = text || '';
}

function setNotice(el, text, kind = 'warn') {
  el.hidden = !text;
  el.className = `notice ${kind}`;
  el.textContent = text || '';
}

async function ask(question) {
  question = question.trim();
  if (!question) { setNotice($('#notice'), t('emptyQuestion')); return; }
  if (state.busy || state.building) return;
  state.busy = true;
  $('#ask-btn').disabled = true;
  $('#intro').hidden = true;
  $('#answer').hidden = true;
  setNotice($('#notice'), '');
  state.answer = null;
  try {
    setProgress(t('retrieving'));
    state.retrieval = await engine.retrieve(question, { mode: state.mode, k: 5 });
    renderResults();
    if (state.retrieval.mode !== state.mode) setNotice($('#notice'), t('degraded'));
    if (!api.config.answers) {
      setNotice($('#notice'), t('noAnswerKey'), 'info');
      return;
    }
    setProgress(t('answering'));
    const lang = detectLang(question);
    state.answer = await engine.answer(question, state.retrieval, { lang, model: api.config.defaultAnswerModel });
    renderResults();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'access_code') openAccess(true);
    setNotice($('#notice'), errorText(err), 'error');
  } finally {
    setProgress('');
    state.busy = false;
    $('#ask-btn').disabled = false;
  }
}

function renderResults() {
  const r = state.retrieval;
  if (!r) return;
  renderTrace(r, state.answer);
  renderSources(r, state.answer);
  renderAnswer(state.answer, r);
}

function renderAnswer(a, r) {
  const box = $('#answer');
  if (!a) { box.hidden = true; return; }
  box.hidden = false;
  $('#answer-model').textContent = a.model || '';
  $('#answer-body').innerHTML = renderMarkdown(a.text, { cites: r.final.length });
  const invalid = a.citations.invalid.length
    ? `<span class="meta-item bad">${esc(t('invalidCites'))} : ${a.citations.invalid.map((n) => `[${n}]`).join(' ')}</span>`
    : `<span class="meta-item good">${esc(t('noInvalid'))}</span>`;
  const tokens = a.usage ? `${(a.usage.input_tokens || 0).toLocaleString()} → ${(a.usage.output_tokens || 0).toLocaleString()} tokens` : '';
  $('#answer-meta').innerHTML = `
    <span class="meta-item"><b>${pct(a.coverage)}</b> ${esc(t('coverage'))}</span>
    ${invalid}
    <span class="meta-item mono">${esc(tokens)}</span>
    <span class="meta-item mono">${esc(t('cost'))} $${a.cost.toFixed(4)}</span>
    <span class="meta-item mono">${ms(a.ms)}</span>`;
  if (r.weakEvidence) setNotice($('#notice'), t('weak'), 'info');
}

function renderSources(r, a) {
  const cited = a ? new Set(a.citations.used) : null;
  $('#sources').hidden = !r.final.length;
  $('#source-list').innerHTML = r.final.map((f, i) => {
    const n = i + 1;
    const c = f.chunk;
    const score = r.mode === 'rerank' ? `${t('relevance')} ${pct(f.score)}` : r.mode === 'vector' ? `cos ${f.score.toFixed(3)}` : r.mode === 'bm25' ? `bm25 ${f.score.toFixed(2)}` : `rrf ${f.score.toFixed(4)}`;
    const dim = cited && !cited.has(n) ? ' uncited' : '';
    return `<li class="source${dim}" id="src-${n}" data-n="${n}">
      <div class="src-head">
        <span class="src-n">${n}</span>
        <div class="src-title"><b>${esc(c.title)}</b><span>${esc(c.section)}${c.part ? ` · ${c.part}` : ''}</span></div>
        <span class="src-score mono">${esc(score)}</span>
      </div>
      <div class="src-text md">${renderMarkdown(c.text)}</div>
      <div class="src-foot mono"><span class="lang-tag">${esc(c.lang.toUpperCase())}</span>${esc(c.docId)}</div>
    </li>`;
  }).join('');
  $$('#source-list .src-text').forEach((el) => highlightDom(el, r.question));
}

function renderTrace(r, a) {
  const tm = r.timings;
  const segments = [
    ['bm25', 'BM25', tm.bm25],
    ['embed', t('embedQuery'), tm.embed],
    ['vector', t('stageVector'), tm.vector],
    ['fuse', 'RRF', tm.fuse],
    ['rerank', t('stageRerank'), tm.rerank],
    ['answer', 'Claude', a ? a.ms : undefined],
  ].filter((s) => typeof s[2] === 'number');
  const total = segments.reduce((s, x) => s + x[2], 0) || 1;
  const bar = `<div class="latency">
      <div class="lat-bar">${segments.map(([k, , v]) => `<i class="seg s-${k}" data-w="${(v / total) * 100}"></i>`).join('')}</div>
      <ul class="lat-legend">${segments.map(([k, label, v]) => `<li><span class="sw s-${k}"></span>${esc(label)} <b class="mono">${ms(v)}</b></li>`).join('')}
        <li class="lat-total">${esc(t('total'))} <b class="mono">${ms(total)}</b></li></ul>
    </div>`;

  const stages = [
    ['bm25', t('stageBm25'), r.lists.bm25.length],
    ['vector', t('stageVector'), r.lists.vector.length],
    ['fused', t('stageFused'), r.lists.fused.length],
    ['reranked', t('stageRerank'), r.lists.reranked.length],
  ];
  const head = `<div class="rf-row rf-head"><span>${esc(t('passage'))}</span>${stages.map(([k, label, n]) => `<span class="rf-stage st-${k}${n ? '' : ' off'}">${esc(label)}</span>`).join('')}</div>`;
  const rows = r.final.map((f, i) => {
    const cells = stages.map(([k, , n]) => {
      if (!n) return '<span class="rf-cell off">·</span>';
      const rank = f.ranks[k];
      return `<span class="rf-cell ${rankClass(rank)}">${rank || '—'}</span>`;
    }).join('');
    const prob = r.mode === 'rerank' ? `<i class="prob"><i data-w="${f.score * 100}"></i></i>` : '';
    return `<div class="rf-row"><span class="rf-label"><b>${i + 1}</b>${esc(f.chunk.title)}<em>${esc(f.chunk.section)}</em>${prob}</span>${cells}</div>`;
  }).join('');
  const mode = `<p class="trace-mode"><span class="swatch m-${r.mode}"></span>${esc(t(`modes.${r.mode}`))}${r.mode !== 'bm25' ? ` · bge-m3` : ''}${r.mode === 'rerank' ? ' · bge-reranker-base' : ''}</p>`;
  $('#trace-body').innerHTML = mode + bar + `<div class="rankflow">${head}${rows}</div>`;
  applyWidths($('#trace-body'));
}

// ------------------------------------------------------------------ library

function renderLibrary() {
  if (!engine) return;
  const s = engine.indexStats;
  $('#index-stats').innerHTML = s ? `
    <div><b>${s.docs}</b><span>${esc(t('docs'))}</span></div>
    <div><b>${s.chunks}</b><span>${esc(t('chunks'))}</span></div>
    <div><b>${engine.vectorsReady ? s.dim : '—'}</b><span>dim</span></div>
    <div><b>${s.cached}</b><span>${esc(t('cached'))}</span></div>` : '';
  $('#chunk-size').value = String(engine.settings.size);
  $('#chunk-overlap').value = String(engine.settings.overlap);
  const counts = new Map();
  for (const c of engine.chunks) counts.set(c.docId, (counts.get(c.docId) || 0) + 1);
  $('#doc-list').innerHTML = engine.docs.map((d) => `<li class="${state.inspecting === d.id ? 'active' : ''}">
      <button type="button" class="doc" data-doc="${esc(d.id)}">
        <span class="lang-tag">${esc((d.lang || 'fr').toUpperCase())}</span>
        <span class="doc-title">${esc(d.title)}</span>
        <span class="doc-count mono">${counts.get(d.id) || 0}</span>
      </button>
      ${d.source === 'upload' ? `<button type="button" class="remove" data-remove="${esc(d.id)}" aria-label="${esc(t('remove'))}">×</button>` : ''}
    </li>`).join('');
  renderInspector();
}

function renderInspector() {
  const box = $('#inspector');
  const id = state.inspecting;
  $('#inspector-hint').hidden = Boolean(id);
  if (!id) { box.innerHTML = ''; return; }
  const chunks = engine.chunks.filter((c) => c.docId === id);
  box.innerHTML = chunks.map((c, i) => {
    // Shade the part repeated from the previous chunk of the same section.
    const body = c.overlap
      ? `<span class="ov" title="${esc(t('overlapPart'))}">${esc(c.text.slice(0, c.overlap))}</span>${esc(c.text.slice(c.overlap))}`
      : esc(c.text);
    return `<div class="chunk">
      <div class="chunk-head mono"><b>#${i + 1}</b><span>${esc(c.title)} › ${esc(c.section)}</span><span>${c.text.length} ${esc(t('chars'))}</span></div>
      <div class="chunk-body">${body}</div>
    </div>`;
  }).join('');
}

async function rebuild() {
  state.building = true;
  renderStatus();
  $('#rebuild-btn').disabled = true;
  try {
    await engine.build(({ phase, done, total }) => {
      $('#status').textContent = `${t('status.indexing')} ${phase === 'embed' ? `${done}/${total}` : ''}`.trim();
    });
  } finally {
    state.building = false;
    $('#rebuild-btn').disabled = false;
    state.retrieval = null;
    state.answer = null;
    state.evaluation = null;
    $('#eval-results').innerHTML = '';
    $('#csv-btn').disabled = true;
    renderStatus();
    renderModes();
    renderLibrary();
    if (engine.vectorError === 'access_code') openAccess(true);
  }
}

async function addFiles(files) {
  const log = $('#upload-log');
  const lines = [];
  for (const file of files) {
    try {
      const doc = await fileToDoc(file);
      engine.addDoc(doc);
      lines.push(`<li class="good">${esc(file.name)} — ${esc(t('fileAdded'))}</li>`);
      state.inspecting = doc.id;
    } catch {
      lines.push(`<li class="bad">${esc(file.name)} — ${esc(t('fileFailed'))}</li>`);
    }
  }
  log.innerHTML = `<ul>${lines.join('')}</ul>`;
  await rebuild();
}

// ------------------------------------------------------------------ evaluation

const METHOD_KEYS = { bm25: 'bm25', vector: 'vector', hybrid: 'hybrid', rerank: 'rerank' };

async function runEval() {
  if (state.busy || state.building) return;
  state.busy = true;
  $('#eval-btn').disabled = true;
  const prog = $('#eval-progress');
  prog.hidden = false;
  setNotice($('#eval-notice'), engine.vectorsReady ? '' : t('evalBm25Only'), 'info');
  try {
    const ev = await engine.evaluate(golden, (done, total) => {
      $('#eval-progress-text').textContent = `${t('running')} ${done}/${total}`;
    });
    state.evaluation = ev;
    renderEval(ev);
    $('#csv-btn').disabled = false;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'access_code') openAccess(true);
    setNotice($('#eval-notice'), errorText(err), 'error');
  } finally {
    prog.hidden = true;
    state.busy = false;
    $('#eval-btn').disabled = false;
  }
}

function renderEval(ev) {
  const cols = ['hit@1', 'hit@3', 'hit@5', 'mrr'];
  const best = {};
  for (const c of cols) best[c] = Math.max(...ev.methods.map((m) => ev.metrics[m][c]));
  const table = `<table class="metrics">
    <thead><tr><th>${esc(t('method'))}</th>${cols.map((c) => `<th>${c === 'mrr' ? 'MRR' : c}</th>`).join('')}<th>${esc(t('latency'))}</th></tr></thead>
    <tbody>${ev.methods.map((m) => `<tr>
      <th><span class="swatch m-${m}"></span>${esc(t(`modes.${METHOD_KEYS[m]}`))}</th>
      ${cols.map((c) => {
        const v = ev.metrics[m][c];
        return `<td class="${v === best[c] ? 'best' : ''}"><span class="num">${c === 'mrr' ? v.toFixed(2) : pct(v)}</span><i class="bar m-${m}"><i data-w="${v * 100}"></i></i></td>`;
      }).join('')}
      <td class="mono">${ms(ev.metrics[m].ms)}</td>
    </tr>`).join('')}</tbody></table>
    <p class="hint">${esc(t('evalSettings'))} : ${ev.chunks} · ${ev.settings.size} ${esc(t('chars'))} · ${esc(t('overlap'))} ${pct(ev.settings.overlap)}</p>`;

  const byType = `<h3 class="sub">${esc(t('byType'))}</h3><div class="types">${ev.types.map((type) => `
    <div class="type-group">
      <h4>${esc(t(`types.${type}`))} <span class="muted">(${ev.byType[ev.methods[0]][type].n})</span></h4>
      ${ev.methods.map((m) => {
        const v = ev.byType[m][type]['hit@5'];
        return `<div class="tbar"><span class="tbar-label">${esc(t(`modesShort.${m}`))}</span><i class="bar m-${m}"><i data-w="${v * 100}"></i></i><b class="mono">${pct(v)}</b></div>`;
      }).join('')}
    </div>`).join('')}</div>`;

  const perQ = `<h3 class="sub">${esc(t('perQuestion'))}</h3><p class="hint">${esc(t('rankLegend'))}</p>
    <div class="tbl"><table class="perq"><thead><tr><th>#</th><th>Question</th><th></th>${ev.methods.map((m) => `<th>${esc(t(`modesShort.${m}`))}</th>`).join('')}</tr></thead>
    <tbody>${ev.rows.map((r) => `<tr><td class="mono muted">${esc(r.id)}</td><td>${esc(r.q)}</td><td><span class="type-tag t-${esc(r.type)}">${esc(t(`types.${r.type}`))}</span></td>
      ${ev.methods.map((m) => `<td><span class="rf-cell ${rankClass(r.ranks[m])}">${r.ranks[m] || '—'}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  $('#eval-results').innerHTML = `<div class="eval-grid"><div>${table}</div><div>${byType}</div></div>${perQ}`;
  applyWidths($('#eval-results'));
}

function exportCsv() {
  const ev = state.evaluation;
  if (!ev) return;
  const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['id', 'type', 'question', ...ev.methods.map((m) => `rank_${m}`)].join(',')];
  for (const r of ev.rows) lines.push([r.id, r.type, quote(r.q), ...ev.methods.map((m) => r.ranks[m])].join(','));
  lines.push('');
  lines.push(['method', 'hit@1', 'hit@3', 'hit@5', 'mrr', 'avg_ms'].join(','));
  for (const m of ev.methods) {
    const x = ev.metrics[m];
    lines.push([m, x['hit@1'].toFixed(3), x['hit@3'].toFixed(3), x['hit@5'].toFixed(3), x.mrr.toFixed(3), x.ms.toFixed(1)].join(','));
  }
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'verity-evaluation.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ access code

let accessResolve = null;

function openAccess(wrong = false) {
  const dlg = $('#access');
  $('#access-error').hidden = !wrong;
  if (!dlg.open) dlg.showModal();
  $('#access-input').value = '';
  $('#access-input').focus();
  return new Promise((resolve) => { accessResolve = resolve; });
}

async function checkAccess() {
  // Any protected call validates the code; a one-word embedding is the cheapest.
  if (!api.config.embeddings) return true;
  try {
    await api.embed(['ping']);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'access_code') return false;
    return true;
  }
}

// ------------------------------------------------------------------ events

function bind() {
  $$('.tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('.lang button').forEach((b) => b.addEventListener('click', () => {
    state.lang = b.dataset.lang;
    store('verity.lang', state.lang);
    applyLang();
  }));
  $('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask($('#q').value); });
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#q').value); }
  });
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.disabled) return;
    state.mode = b.dataset.mode;
    renderModes();
    if (state.retrieval && !state.busy) ask(state.retrieval.question);
  });
  $('#suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-suggest]');
    if (!b) return;
    const q = SUGGESTIONS[Number(b.dataset.suggest)][state.lang];
    $('#q').value = q;
    ask(q);
  });
  $('#answer-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cite]');
    if (!b) return;
    const card = $(`#src-${b.dataset.cite}`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  });
  $('#doc-list').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      engine.removeDoc(rm.dataset.remove);
      if (state.inspecting === rm.dataset.remove) state.inspecting = null;
      await rebuild();
      return;
    }
    const d = e.target.closest('[data-doc]');
    if (d) { state.inspecting = d.dataset.doc; renderLibrary(); }
  });
  $('#file-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) addFiles(files);
  });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (files.length) addFiles(files);
  });
  $('#poison-btn').addEventListener('click', async () => {
    const doc = poisonedDoc(state.lang);
    engine.addDoc(doc);
    state.inspecting = doc.id;
    await rebuild();
  });
  $('#rebuild-btn').addEventListener('click', () => {
    engine.settings.size = Number($('#chunk-size').value);
    engine.settings.overlap = Number($('#chunk-overlap').value);
    rebuild();
  });
  $('#eval-btn').addEventListener('click', runEval);
  $('#csv-btn').addEventListener('click', exportCsv);
  $('#access-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    api.setAccessCode($('#access-input').value.trim());
    if (await checkAccess()) {
      $('#access').close();
      if (accessResolve) accessResolve(true);
    } else {
      $('#access-error').hidden = false;
      $('#access-input').select();
    }
  });
  $('#access').addEventListener('cancel', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ start

async function start() {
  const saved = recall('verity.lang');
  state.lang = saved === 'en' || saved === 'fr' ? saved : (navigator.language || 'fr').startsWith('fr') ? 'fr' : 'en';
  bind();
  applyLang();
  const view = recall('verity.view');
  showView(['ask', 'library', 'eval', 'how'].includes(view) ? view : 'ask');

  const [config, corpus, goldenSet] = await Promise.all([
    api.loadConfig(),
    fetch('/data/corpus.json').then((r) => r.json()),
    fetch('/data/golden.json').then((r) => r.json()),
  ]);
  golden = goldenSet.questions;
  engine = new Engine({ api, cache: { hashKey, getMany, putMany }, embedModel: config.embedModel || 'bge-m3' });
  engine.setDocs(corpus.docs);

  if (config.accessCodeRequired && !(api.hasAccessCode() && (await checkAccess()))) await openAccess(false);
  await rebuild();
  applyLang();
}

start();
