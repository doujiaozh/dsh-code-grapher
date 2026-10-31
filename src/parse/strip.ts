/**
 * Comment & string stripper
 * ========================
 * Replaces comment bodies and string literals with spaces (keeping every
 * newline) so that:
 *   1. regex extraction never matches inside comments/strings;
 *   2. strip(src).indexOf(rawMatch) still maps back to the original line,
 *      because the whitespace layout is line-for-line identical.
 *
 * With keepStrings=true, string literals are preserved verbatim (comments
 * still stripped). That view is what import extraction needs — specifiers
 * live inside string literals, so blanking them would erase every import.
 *
 * This is a tiny hand-rolled scanner, NOT a parser — it is deliberately
 * tolerant of broken syntax (we only need symbol names).
 */
export type Dialect = 'js' | 'py' | 'none';

const SMART_QUOTES = new Set(['‘', '’', '“', '”', '`']);

export function stripCommentsAndStrings(src: string, dialect: Dialect, keepStrings = false): string {
  const out: string[] = new Array(src.length);
  let i = 0;
  const n = src.length;
  let mode: 'code' | 'line_comment' | 'block_comment' | 'sq' | 'dq' | 'tpl' = 'code';
  let tplDepth = 0;

  const flush = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (mode === 'line_comment') {
      if (c === '\n') {
        out[i] = '\n';
        mode = 'code';
      } else {
        out[i] = ' ';
      }
      i++;
      continue;
    }
    if (mode === 'block_comment') {
      if (c === '*' && c2 === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        mode = 'code';
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      const quote = mode === 'sq' ? "'" : '"';
      if (c === '\\') {
        out[i] = ' ';
        out[i + 1] = src[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
        continue;
      }
      if (c === quote) {
        out[i] = ' ';
        mode = 'code';
        i++;
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') {
        out[i] = ' ';
        out[i + 1] = src[i + 1] === '\n' ? '\n' : ' ';
        i += 2;
        continue;
      }
      if (c === '`') {
        out[i] = ' ';
        mode = 'code';
        i++;
        continue;
      }
      // ${ ... } interpolation: recurse-less approximation — scan balanced
      if (c === '$' && c2 === '{') {
        let depth = 1;
        let j = i + 2;
        flush(i, i + 2);
        while (j < n && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          else if (src[j] === '\n') out[j] = '\n';
          else out[j] = ' ';
          j++;
        }
        i = j;
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    // mode === 'code'
    if (dialect !== 'py' && c === '/' && c2 === '/') {
      mode = 'line_comment';
      out[i] = ' ';
      i++;
      continue;
    }
    if (dialect !== 'py' && c === '/' && c2 === '*') {
      mode = 'block_comment';
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      continue;
    }
    if ((dialect === 'py' && c === '#') || (dialect === 'none' && c === '#')) {
      // python line comment (only if not inside a string — we are in code)
      mode = 'line_comment';
      out[i] = ' ';
      i++;
      continue;
    }
    if (keepStrings && c === '`') {
      // Template literals: keep the backticks as syntax but BLANK the body.
      // No import specifier ever lives inside a template, while template
      // bodies often hold prose like  from 'x'  that would otherwise bleed
      // into import extraction as a false positive.
      out[i] = '`';
      i++;
      while (i < n && src[i] !== '`') {
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = '`';
        i++;
      }
      continue;
    }
    if (keepStrings && (c === "'" || c === '"')) {
      // preserve the literal verbatim (escapes and all) — used by import
      // extraction; layout stays line-for-line identical either way.
      const q = c;
      out[i] = c;
      i++;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          out[i] = d;
          out[i + 1] = src[i + 1] ?? ' ';
          i += 2;
          continue;
        }
        out[i] = d;
        i++;
        if (d === q) break;
      }
      continue;
    }
    if (c === "'") {
      mode = 'sq';
      out[i] = ' ';
      i++;
      continue;
    }
    if (c === '"') {
      mode = 'dq';
      out[i] = ' ';
      i++;
      continue;
    }
    if (c === '`' && SMART_QUOTES.has('`')) {
      mode = 'tpl';
      tplDepth++;
      out[i] = ' ';
      i++;
      continue;
    }
    out[i] = c;
    i++;
  }
  void tplDepth;
  return out.join('');
}

/** 1-based line number of a character offset. */
export function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}
