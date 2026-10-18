// Safe Markdown renderer for answers. Everything is HTML-escaped first; only a
// fixed set of patterns (headings, bold, italics, code, lists, tables, http(s)
// links, [n] citations) is turned into markup afterwards. No raw HTML passes.

let citeCount = 0;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)"']{1,500})\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  if (citeCount) {
    s = s.replace(/\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\]/g, (m, list) => list.split(/[,;]/).map((x) => {
      const n = Number(x.trim());
      return n >= 1 && n <= citeCount
        ? `<button type="button" class="cite" data-cite="${n}" aria-label="source ${n}">${n}</button>`
        : `<span class="cite bad" title="invented citation">${n}</span>`;
    }).join(''));
  }
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function renderTable(rows) {
  const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return '<div class="tbl"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') +
    '</tr></thead><tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function renderMarkdown(md, { cites = 0 } = {}) {
  citeCount = cites;
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim().replace(/[^\w-]/g, '');
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre class="code"${lang ? ` data-lang="${lang}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      out.push(renderTable(rows));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    if (!para.length) { para.push(line); i += 1; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  citeCount = 0;
  return out.join('');
}

export { renderMarkdown, esc };
