// Reading and writing small pieces of Paradox script (the same rules as backend/pdx_script.py).

const TOKEN = /(\s+|#[^\n]*)|("(?:[^"\\]|\\.)*")|(\{)|(\})|(\?=|==|!=|>=|<=|=|>|<)|(@\[[^\]]*\]|[^\s{}=<>!?#"]+)|(.)/gy;
const KINDS = [null, 'skip', 'string', 'open', 'close', 'op', 'word', 'other'];

function tokenize(text) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(text))) {
    const kind = KINDS[match.slice(1).findIndex((group) => group !== undefined) + 1];
    if (kind !== 'skip') tokens.push({ kind, text: match[0], start: match.index, end: TOKEN.lastIndex });
  }
  return tokens;
}

const unquote = (token) => token.slice(1, -1).replace(/\\"/g, '"');

// Parse a fragment into its top-level entries:
//   {key, op, value, start, end}  with value a string or {entries} (a block)
// Bare list items have key null. Returns null when the braces do not match.
export function parseScript(text) {
  const tokens = tokenize(text);
  let pos = 0;
  let ok = true;

  function block(isTop) {
    const entries = [];
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.kind === 'close') {
        pos++;
        if (isTop) { ok = false; continue; }
        return { entries, end: tok.end };
      }
      if (tok.kind === 'open') {
        pos++;
        const inner = block(false);
        entries.push({ key: null, op: null, value: inner, start: tok.start, end: inner.end });
        continue;
      }
      pos++;
      if (tok.kind !== 'word' && tok.kind !== 'string') continue;
      const key = tok.kind === 'string' ? unquote(tok.text) : tok.text;
      const op = tokens[pos];
      if (!op || op.kind !== 'op') {
        entries.push({ key: null, op: null, value: key, start: tok.start, end: tok.end });
        continue;
      }
      pos++;
      const value = tokens[pos];
      if (value && value.kind === 'open') {
        pos++;
        const inner = block(false);
        entries.push({ key, op: op.text, value: inner, start: tok.start, end: inner.end });
      } else if (value && (value.kind === 'word' || value.kind === 'string')) {
        pos++;
        entries.push({ key, op: op.text, value: value.kind === 'string' ? unquote(value.text) : value.text,
          start: tok.start, end: value.end });
      } else {
        ok = false;  // `key =` with nothing usable after it
      }
    }
    if (!isTop) ok = false;  // ran out of tokens inside a block
    return { entries, end: text.length };
  }

  const top = block(true);
  return ok ? top.entries : null;
}

// Remove the common indentation of a fragment cut out of a larger text.
export function dedent(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '';
  lines[0] = lines[0].trimStart();  // a fragment starts right at its first token
  const indents = lines.slice(1).filter(Boolean).map((line) => line.length - line.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return [lines[0], ...lines.slice(1).map((line) => line.slice(cut))].join('\n');
}

export function indent(text) {
  return text.split('\n').map((line) => (line ? '\t' + line : line)).join('\n');
}

// `key = { ...lines }` with the lines indented.
export function blockText(key, lines) {
  return `${key} = {\n${indent(lines.join('\n'))}\n}`;
}

export const isBlock = (value) => value !== null && typeof value === 'object';

// Same check as the backend's braces_balanced: { } match, ignoring strings and comments.
export function bracesBalanced(text) {
  let depth = 0;
  for (const line of text.split('\n')) {
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (char === '#') break;
      else if (char === '{') depth++;
      else if (char === '}' && --depth < 0) return false;
    }
  }
  return depth === 0;
}
