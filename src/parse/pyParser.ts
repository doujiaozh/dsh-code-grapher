/**
 * Python symbol extractor (regex AST-lite)
 * ========================================
 * Imports (import x / from x import y), defs (incl. async) and classes
 * (with base classes). Operates on the stripped source so indentation
 * semantics are untouched and line numbers stay exact.
 */
import { SymbolInfo } from '../types';
import { lineOf } from './strip';

export interface PyExtractResult {
  symbols: SymbolInfo[];
  imports: string[];
  exports: string[];
}

// No trailing group on purpose: an optional `import <names>` group would
// cross the newline of the NEXT "import x" line and swallow it. The tail
// below uses [ \t]+ (never \s) so it only consumes the names of a from-import
// on the same line:  from typing import List, Optional
const RE_PY_IMPORT = /(?<![\w.])(?:import|from)\s+([\w.]+)(?:[ \t]+import[ \t]+[^\n]*)?/g;
const RE_PY_DEF = /(?<![\w.])(?:async\s+)?def\s+(\w+)\s*\(/g;
const RE_PY_CLASS = /(?<![\w.])class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/g;

export function extractPySymbols(stripped: string, importSource?: string): PyExtractResult {
  const importView = importSource ?? stripped;
  const symbols: SymbolInfo[] = [];
  const imports: string[] = [];
  const seenImports = new Set<string>();

  RE_PY_IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PY_IMPORT.exec(importView)) !== null) {
    const module = m[1];
    // skip relative from-imports ("from . import x" / "from .pkg import y")
    if (!module || !/^[A-Za-z0-9_]/.test(module)) continue;
    if (!seenImports.has(module)) {
      seenImports.add(module);
      imports.push(module);
    }
    symbols.push({ kind: 'import', name: module, line: lineOf(importView, m.index) });
  }

  RE_PY_DEF.lastIndex = 0;
  while ((m = RE_PY_DEF.exec(stripped)) !== null) {
    symbols.push({ kind: 'function', name: m[1], line: lineOf(stripped, m.index) });
  }

  RE_PY_CLASS.lastIndex = 0;
  while ((m = RE_PY_CLASS.exec(stripped)) !== null) {
    const s: SymbolInfo = { kind: 'class', name: m[1], line: lineOf(stripped, m.index) };
    if (m[2]) s.detail = 'extends ' + m[2].trim();
    symbols.push(s);
  }

  symbols.sort((a, b) => a.line - b.line);
  // Python has no export keyword; module-level public defs/classes are the API.
  const exports = symbols
    .filter((s) => (s.kind === 'function' || s.kind === 'class') && !s.name.startsWith('_'))
    .map((s) => s.name);
  return { symbols, imports, exports };
}
