// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Same answers, byte for byte, for every input. Built for speed instead of
// clarity of the pipeline: Markdown renders in one pass without token
// objects, templates compile to plain JavaScript, slugs and escaping take
// ASCII fast paths, and repeated lookups are memoised within a case.
// Standard library only — in fact this module imports nothing at all.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const has = (o, k) => Object.hasOwn(o, k);

// ---------------------------------------------------------------- text

// HTML escaping. Most strings hold no escapable character, so test once and
// return the string untouched; only a string that needs work is scanned.
const NEEDS_ESC = /[&<>"']/;
function esc(s) {
  if (!NEEDS_ESC.test(s)) return s;
  let out = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else continue;
    out += s.slice(from, i) + rep;
    from = i + 1;
  }
  return out + s.slice(from);
}

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}/gu;
const SLUG_MAX = 64;

/**
 * A slug: NFKD, combining marks dropped, A-Z lowered, every run of other
 * characters one "-", none at either end, cut to 64 characters with a "-"
 * left at the cut dropped, "untitled" when nothing is left. Pure ASCII text
 * skips normalisation entirely: NFKD is the identity on it and it holds no
 * combining marks. `cache` memoises within one case.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

// Unicode whitespace, the only kind a byte scan for ASCII whitespace misses.
const UNI_WS = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  if (UNI_WS.test(text)) {
    const m = text.match(/\S+/g);
    return m === null ? 0 : m.length;
  }
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { err: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { err: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { err: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { err: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'err' in s ? { err: `key "${key}": ${s.err}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { err: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { err: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { err: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { err: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { err: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { err: 'key "slug": not a slug' };
    default:
      return { err: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { err } with the first
 * reason it is refused. Finds the closing "---" without splitting the body.
 */
function parseFM(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { err: 'no front matter' };
  let closeAt = text.indexOf('\n---\n', nl);
  let bodyAt;
  if (closeAt !== -1) {
    bodyAt = closeAt + 5;
  } else if (text.endsWith('\n---') && text.length - 4 >= nl) {
    closeAt = text.length - 4;
    bodyAt = text.length;
  } else {
    return { err: 'the front matter is not closed' };
  }
  const fmText = text.slice(nl + 1, closeAt);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlank(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { err: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { err: `unknown key "${key}"` };
    if (has(data, key)) return { err: `key "${key}" is given twice` };
    if (raw === '') return { err: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('err' in v) return v;
    data[key] = v.value;
  }
  if (!has(data, 'title')) return { err: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- markdown

/** Spaces and tabs only (an empty line counts). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLt(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence's language, or null when the line does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

/** Whether the line closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return null;
  if (line.charCodeAt(h) === 35) return null;
  if (line.charCodeAt(h) !== 32 && line.charCodeAt(h) !== 9) return null;
  let s = h + 1;
  while (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: h, text: line.slice(s, e) };
}

/** Whether the line is a thematic break: "---" or "***", then spaces or tabs only. */
function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet item ("- " or "* "), or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  return null;
}

/** An ordered item ("N. "), or null. */
function orderedOf(line) {
  let i = 0;
  let num = 0;
  let digits = 0;
  while (digits < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    num = num * 10 + (c - 48);
    i++;
    digits++;
  }
  if (digits === 0) return null;
  const c = line.charCodeAt(i);
  if (c >= 48 && c <= 57) return null;
  if (c !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { ordered: true, start: num, text: line.slice(i + 2) };
}

const CONTINUED = /^ {2,}\S/;

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsPara(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = '\\`*_[]()#+-.!>';

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  let j = from;
  for (;;) {
    const hit = s.indexOf(what, j);
    if (hit === -1) return -1;
    const bs = s.indexOf('\\', j);
    if (bs === -1 || bs > hit) return hit;
    if (bs + 1 < s.length && ESCAPABLE.indexOf(s[bs + 1]) !== -1) j = bs + 2;
    else j = bs + 1;
    if (j > hit) continue;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const star = s.indexOf('*', j);
    if (star === -1) return -1;
    const bs = s.indexOf('\\', j);
    if (bs !== -1 && bs < star) {
      if (bs + 1 < s.length && ESCAPABLE.indexOf(s[bs + 1]) !== -1) j = bs + 2;
      else j = bs + 1;
      continue;
    }
    if (s[star + 1] === '*') {
      j = star + 2;
      continue;
    }
    return star;
  }
}

const HAS_WS = /\s/;

/** `s` rendered inline; `link(target)` is a link's href. */
function inlineMd(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let next = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < next) next = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < next) next = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < next) next = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < next) next = k;
    if (next > i) {
      out += esc(s.slice(i, next));
      i = next;
    }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.indexOf(s[i + 1]) !== -1) {
        out += esc(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inlineMd(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inlineMd(s.slice(i + 1, j), link)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    // c === '['
    const k2 = findUnesc(s, ']', i + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      out += `<a href="${esc(link(target))}">${inlineMd(s.slice(i + 1, k2), link)}</a>`;
      i = m + 1;
    } else {
      out += '[';
      i++;
    }
  }
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block followed by "\n"), its
 * table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). `slugFn` slugs heading text.
 */
function renderMd(src, link, slugFn) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      let code = '<pre><code';
      if (lang !== '') code += ` class="language-${esc(lang)}"`;
      code += '>';
      while (i < n && !isFenceClose(lines[i])) code += `${esc(lines[i++])}\n`;
      i++;
      code += '</code></pre>';
      out.push(code);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqSlug(slugFn(hd.text), ids);
      const html = inlineMd(hd.text, link);
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let ql = lines[i++].slice(1);
        if (ql.charCodeAt(0) === 32) ql = ql.slice(1);
        ql = trimLt(ql);
        if (ql !== '') q.push(ql);
      }
      out.push(q.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineMd(q.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const first = bulletOf(line) ?? orderedOf(line);
    if (first !== null) {
      const items = [];
      let cur = [trimLt(first.text)];
      items.push(cur);
      i++;
      while (i < n) {
        const m2 = first.ordered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m2 !== null) {
          cur = [trimLt(m2.text)];
          items.push(cur);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          cur.push(trimLt(lines[i]));
          i++;
        } else break;
      }
      const tag = first.ordered ? 'ol' : 'ul';
      let lst = first.ordered && first.start !== 1 ? `<ol start="${first.start}">` : `<${tag}>`;
      lst += '\n';
      for (const it of items) lst += `<li>${inlineMd(it.join('\n'), link)}</li>\n`;
      lst += `</${tag}>`;
      out.push(lst);
      continue;
    }
    const para = [trimLt(line)];
    i++;
    while (i < n && !endsPara(lines[i])) para.push(trimLt(lines[i++]));
    const html = inlineMd(para.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>`);
  }
  return { html: out.length === 0 ? '' : `${out.join('\n')}\n`, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` holds spaces and tabs only. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- rendering: compiled templates over one flat scope ----------------------
// A render keeps one scope object S (no prototype, so a missing name reads
// undefined): the top-level values plus the loop bindings in force, saved
// and restored around each loop. Includes share it, so a compiled template
// is one function (O, S, D) — output array, scope, include depth.

/** The value at `path` in the flat scope: its first name from S, then own properties. */
function lookupPath(S, path) {
  let v = S[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !has(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txtOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txtOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered by interpretation (the fallback when compiling is refused). */
function interpNodes(nodes, S, D, parsed, O) {
  for (const nd of nodes) {
    if (nd.kind === 'text') O.push(nd.text);
    else if (nd.kind === 'var') O.push(esc(txtOf(lookupPath(S, nd.path))));
    else if (nd.kind === 'raw') O.push(txtOf(lookupPath(S, nd.path)));
    else if (nd.kind === 'if') {
      const branch = truthy(lookupPath(S, nd.path)) !== nd.not ? nd.then : nd.else;
      if (branch !== null) interpNodes(branch, S, D, parsed, O);
    } else if (nd.kind === 'for') {
      const xs = lookupPath(S, nd.path);
      if (!Array.isArray(xs)) continue;
      const hadName = has(S, nd.name);
      const oldName = S[nd.name];
      const hadLoop = has(S, 'loop');
      const oldLoop = S.loop;
      for (let k = 0; k < xs.length; k++) {
        S[nd.name] = xs[k];
        S.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
        interpNodes(nd.body, S, D, parsed, O);
      }
      if (hadName) S[nd.name] = oldName;
      else delete S[nd.name];
      if (hadLoop) S.loop = oldLoop;
      else delete S.loop;
    } else if (nd.kind === 'include') {
      const t = parsed.get(nd.name);
      if (t !== undefined && D < 8) interpNodes(t, S, D + 1, parsed, O);
    }
  }
}

/** JavaScript for a path lookup in the flat scope. */
function pathExpr(path) {
  let e = `S[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `g(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** JavaScript statements for `nodes`, appended to `parts`. */
function genNodes(nodes, parts) {
  for (const nd of nodes) {
    if (nd.kind === 'text') parts.push(`O.push(${JSON.stringify(nd.text)});`);
    else if (nd.kind === 'var') parts.push(`O.push(ev(${pathExpr(nd.path)}));`);
    else if (nd.kind === 'raw') parts.push(`O.push(tv(${pathExpr(nd.path)}));`);
    else if (nd.kind === 'if') {
      parts.push(`if(tru(${pathExpr(nd.path)})!==${nd.not ? 'true' : 'false'}){`);
      genNodes(nd.then, parts);
      if (nd.else !== null) {
        parts.push('}else{');
        genNodes(nd.else, parts);
      }
      parts.push('}');
    } else if (nd.kind === 'for') {
      const nm = JSON.stringify(nd.name);
      parts.push(`{const _xs=${pathExpr(nd.path)};if(Array.isArray(_xs)){const _sv=S[${nm}],_sh=${nm} in S,_lv=S["loop"],_lh="loop" in S;for(let _k=0;_k<_xs.length;_k++){S[${nm}]=_xs[_k];S["loop"]={index:_k+1,first:_k===0,last:_k===_xs.length-1,length:_xs.length};`);
      genNodes(nd.body, parts);
      parts.push(`}if(_sh)S[${nm}]=_sv;else delete S[${nm}];if(_lh)S["loop"]=_lv;else delete S["loop"];}}`);
    } else if (nd.kind === 'include') {
      parts.push(`if(D<8){const _f=F[${JSON.stringify(nd.name)}];if(_f)_f(O,S,D+1);}`);
    }
  }
}

/**
 * Every parsed template compiled to a function (O, S, D) in one generated
 * module, or null when the runtime refuses to compile it.
 */
function compileTemplates(parsed) {
  try {
    const parts = [];
    parts.push('const g=(v,k)=>(v!==null&&typeof v==="object"&&Object.hasOwn(v,k))?v[k]:undefined;');
    parts.push('const tv=(v)=>{if(typeof v==="string")return v;if(typeof v==="number")return String(v);if(typeof v==="boolean")return v?"true":"false";if(Array.isArray(v))return v.map(tv).join(", ");return "";};');
    parts.push('const tru=(v)=>{if(Array.isArray(v))return v.length>0;return v!==undefined&&v!==null&&v!==false&&v!==""&&v!==0;};');
    parts.push('const ev=(v)=>esc(tv(v));');
    parts.push('const F=Object.create(null);');
    for (const [name, nodes] of parsed) {
      const body = [];
      genNodes(nodes, body);
      parts.push(`F[${JSON.stringify(name)}]=function(O,S,D){${body.join('')}};`);
    }
    parts.push('return F;');
    return new Function('esc', parts.join('\n'))(esc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

/** Whether `target` carries a scheme (https:, mailto:, ...). */
function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, cards) {
  const card = s.post ? cards.get(s) : cardOf(s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(t, cards) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const slugCache = new Map();
  const slugFn = (t) => slugify(t, slugCache);

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = compileTemplates(parsed);

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // Sources, in code-unit order of their paths; line ends made "\n".
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // Front matter and the checks, in order; a refused source is reported and
  // dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('err' in fm) {
      report.push(`refused ${s.path}: ${fm.err}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
      continue;
    }
    if (s.post && !has(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqSlug(s.data.slug ?? slugFn(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (isScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const key = `${dir}\n${target}`;
      let href = resCache.get(key);
      if (href === undefined) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveRel(dir, rel);
        if (path !== null && bySource.has(path)) href = bySource.get(path).url + frag;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else href = null;
        resCache.set(key, href);
      }
      if (href === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return href;
    };
    const md = renderMd(s.body, link, slugFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugFn(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugFn(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugFn(name)) ?? { name, slug: slugFn(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const O = [];
    const S = Object.create(null);
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    S.page = vars.page;
    S.posts = vars.posts;
    S.pager = vars.pager;
    S.tag = vars.tag;
    if (compiled !== null) {
      const fn = compiled[name];
      if (fn === undefined) return null;
      fn(O, S, 0);
    } else {
      const nodes = parsed.get(name);
      if (nodes === undefined) return null;
      interpNodes(nodes, S, 0, parsed, O);
    }
    return O.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t, cards) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (has(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
