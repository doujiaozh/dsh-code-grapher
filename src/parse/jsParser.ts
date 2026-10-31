/**
 * JS / TS / JSX / TSX symbol extractor (regex AST-lite)
 * ======================================================
 * Runs against the stripped source (comments & strings blanked out,
 * newlines preserved) so every match index maps 1:1 to a source line.
 *
 * Extracted:
 *   - imports:  import x from 'p', import 'p', require('p'), import('p')
 *   - exports:  export function/class/const..., export default
 *   - functions: function decls + arrow-function const assignments
 *   - classes:  class X extends Y + their methods
 *   - constants: exported const/let/var
 *
 * Known heuristic limits (documented, by design): regex literals and
 * division operators can confuse the stripper; decorators and TypeScript
 * generics are tolerated. This is NOT a parser — we trade precision for
 * zero native dependencies (see README "limitations").
 */
import { SymbolInfo } from '../types';
import { lineOf } from './strip';

export interface JsExtractResult {
  symbols: SymbolInfo[];
  imports: string[];
  exports: string[];
}

interface RawMatch {
  index: number;
  name: string;
  from?: string;
}

// Line-safe import specifiers. Each pattern is anchored so it can never
// span statements: the specifier string must immediately follow the keyword.
//   import x from 'p' / export * from 'p' / export { a } from './b'
//   import 'p'                       (side-effect import)
//   import('p')                      (dynamic import)
//   require('p')                     (CJS)
// NOTE: every pattern uses a backreference ((["']) ... \1) so an opening
// single quote can only be closed by a single quote — a mismatched pair
// would swallow arbitrary code between two unrelated quotes on far-apart
// lines. The lookbehind also excludes quotes and '-', so the keyword can't
// be the tail of a string ('not-an-import') or a kebab word, and captures
// never cross a line.
const RE_IMPORT_FROM = /(?<![\w$.\-'"`])from\s*(["'])([^"'\n]*)\1/g;
const RE_IMPORT_SIDE = /(?<![\w$.\-'"`])import\s*(["'])([^"'\n]*)\1/g;
const RE_IMPORT_DYNAMIC = /(?<![\w$.\-'"`])import\s*\(\s*(["'])([^"'\n]*)\1\s*\)/g;
const RE_IMPORT_REQUIRE = /(?<![\w$.\-'"`])require\s*\(\s*(["'])([^"'\n]*)\1\s*\)/g;

const RE_FUNCTION =
  /(?<![\w$.])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/g;
const RE_ARROW =
  /(?<![\w$.])(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::\s*[^=;]+)?=\s*(?:async\s*)?\(?[^()]*\)?\s*=>/g;
const RE_CLASS =
  /(?<![\w$.])(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)(?:\s*<[^{]*>)?(?:\s+extends\s+([\w$.]+))?/g;
const RE_METHOD =
  /(?:^|\n)(?:(?:export|public|private|protected|static|abstract|readonly|async|get|set|override)\s+)*([\w$]+)\s*(?:<[^()]*>)?\([^()]*\)\s*(?::\s*[^{=]+)?[{=]/g;

const RE_EXPORT_NAMED =
  /(?<![\w$.])export\s+(?:(?:async\s+)?function\s*\*?\s*([\w$]+)|(?:abstract\s+)?class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))/g;
const RE_EXPORT_DEFAULT_FN = /(?<![\w$.])export\s+default\s+function\s+([\w$]+)?/g;

function uniqueSpecifiers(matches: RawMatch[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const v = m.from ?? m.name;
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function extractJsSymbols(stripped: string, importSource?: string): JsExtractResult {
  const importView = importSource ?? stripped;
  const symbols: SymbolInfo[] = [];
  const collect = (re: RegExp, kind: SymbolInfo['kind'], mapper: (m: RegExpExecArray) => RawMatch) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) {
      const r = mapper(m);
      if (r && r.name) symbols.push({ kind, name: r.name, line: lineOf(stripped, m.index) });
    }
  };

  // ---- imports (need the keepStrings view: specifiers live in literals) ----
  const importMatches: RawMatch[] = [];
  for (const re of [RE_IMPORT_FROM, RE_IMPORT_SIDE, RE_IMPORT_DYNAMIC, RE_IMPORT_REQUIRE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(importView)) !== null) {
      importMatches.push({ index: m.index, name: '', from: m[2] });
    }
  }
  const imports = uniqueSpecifiers(importMatches);

  // ---- exports ----
  const exportNames: string[] = [];
  collect(RE_EXPORT_NAMED, 'export', (m) => ({ index: m.index, name: m[1] ?? m[2] ?? m[3] ?? '' }));
  {
    RE_EXPORT_DEFAULT_FN.lastIndex = 0;
    const m = RE_EXPORT_DEFAULT_FN.exec(stripped);
    if (m && m[1]) exportNames.push(m[1]);
  }
  // named exports recorded via symbols; collect names for the exports field
  for (const s of symbols) if (s.kind === 'export') exportNames.push(s.name);
  const exports = Array.from(new Set(exportNames));

  // ---- classes (with their methods) ----
  RE_CLASS.lastIndex = 0;
  let cm: RegExpExecArray | null;
  const classSpans: Array<{ name: string; start: number; end: number }> = [];
  while ((cm = RE_CLASS.exec(stripped)) !== null) {
    const name = cm[1];
    const symbol: SymbolInfo = {
      kind: 'class',
      name,
      line: lineOf(stripped, cm.index),
    };
    if (cm[2]) symbol.detail = 'extends ' + cm[2];
    symbols.push(symbol);
    // find the class body span for method extraction
    let braceStart = stripped.indexOf('{', cm.index + cm[0].length);
    if (braceStart === -1) braceStart = cm.index + cm[0].length;
    let depth = 0;
    let end = stripped.length;
    for (let i = braceStart; i < stripped.length; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    classSpans.push({ name, start: braceStart, end });
    void symbol;
  }
  // methods inside class bodies
  for (const span of classSpans) {
    const body = stripped.slice(span.start, span.end);
    RE_METHOD.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = RE_METHOD.exec(body)) !== null) {
      const name = mm[1];
      if (!name || RESERVED.has(name)) continue;
      if (/^[A-Z_$]/.test(name) && mm[0].endsWith('{')) continue; // decorator-ish / prop
      symbols.push({
        kind: 'method',
        name,
        detail: span.name + '#' + name,
        line: lineOf(stripped, span.start + mm.index + 1),
      });
    }
  }

  // ---- functions ----
  collect(RE_FUNCTION, 'function', (m) => ({ index: m.index, name: m[1] }));
  collect(RE_ARROW, 'function', (m) => ({ index: m.index, name: m[1] }));

  // ---- exported constants ----
  {
    const re =
      /(?<![\w$.])export\s+(?:const|let|var)\s+([\w$]+)\s*(?::\s*[^=;]+)?=/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      symbols.push({ kind: 'constant', name: m[1], line: lineOf(stripped, m.index) });
    }
  }

  symbols.sort((a, b) => a.line - b.line);
  return { symbols, imports, exports };
}

const RESERVED = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'delete',
  'typeof',
  'void',
  'do',
  'else',
  'try',
  'finally',
  'class',
  'function',
  'super',
  'this',
  'constructor',
]);
