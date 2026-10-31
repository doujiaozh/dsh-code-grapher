/**
 * cg_parse — AST-lite parsing dispatcher
 * ======================================
 * Reads each scanned file ON DEMAND (never keeps contents in memory),
 * strips comments/strings, extracts symbols via the dialect extractor
 * and records import specifiers for later edge resolution.
 */
import * as fs from 'fs';
import { Language, ParseResult, ScannedFile } from '../types';
import { stripCommentsAndStrings, Dialect } from './strip';
import { extractJsSymbols } from './jsParser';
import { extractPySymbols } from './pyParser';
import { PARSEABLE_LANGUAGES } from '../scan/scanner';

export interface ParseOutcome extends ParseResult {
  /** True when the file could not be read / was skipped. */
  unread?: boolean;
}

export function parseFile(
  file: ScannedFile,
  maxSourceChars = 262144,
): ParseOutcome {
  let src: string;
  try {
    // read with an explicit cap; mention ascii-preserving utf8 here
    const buf = fs.readFileSync(file.path, { encoding: 'utf8' }) as string;
    src = buf.length > maxSourceChars ? buf.slice(0, maxSourceChars) : buf;
  } catch {
    return {
      path: file.path,
      language: file.language,
      lines: 0,
      blankLines: 0,
      symbols: [],
      imports: [],
      exports: [],
      unread: true,
    };
  }
  const dialect: Dialect =
    file.language === 'python' ? 'py' : file.language === 'json' || file.language === 'markdown' ? 'none' : 'js';
  const stripped = stripCommentsAndStrings(src, dialect);
  // import specifiers live inside string literals — keep them for that pass
  const importView = stripCommentsAndStrings(src, dialect, true);

  if (!PARSEABLE_LANGUAGES.has(file.language)) {
    // json/markdown/unknown: structural inventory only
    const lines = countLines(src);
    return {
      path: file.path,
      language: file.language,
      lines,
      blankLines: countBlank(src),
      symbols: [],
      imports: [],
      exports: [],
    };
  }

  if (dialect === 'py') {
    const r = extractPySymbols(stripped, importView);
    return {
      path: file.path,
      language: file.language,
      lines: countLines(src),
      blankLines: countBlank(src),
      symbols: r.symbols,
      imports: r.imports,
      exports: r.exports,
    };
  }
  const r = extractJsSymbols(stripped, importView);
  return {
    path: file.path,
    language: file.language,
    lines: countLines(src),
    blankLines: countBlank(src),
    symbols: r.symbols,
    imports: r.imports,
    exports: r.exports,
  };
}

/** Parse many files, streaming (bounded by caller; results returned as array). */
export function parseFiles(files: ScannedFile[], maxSourceChars?: number): ParseOutcome[] {
  const out: ParseOutcome[] = [];
  for (let i = 0; i < files.length; i++) {
    out.push(parseFile(files[i], maxSourceChars));
    if ((i & 0x3ff) === 0x3ff) setImmediateSync(); // yield occasionally
  }
  return out;
}

/** Synchronous "yield" that does not starve the event loop on huge projects. */
function setImmediateSync(): void {
  // fs.readFileSync is sync anyway; this is a no-op hook kept so the pipeline
  // can be swapped for a streaming implementation without API churn.
  void 0;
}

function countLines(src: string): number {
  let lines = 1;
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lines++;
  return src.length === 0 ? 0 : lines;
}
function countBlank(src: string): number {
  let blank = 0;
  let sawNonSpace = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') {
      if (!sawNonSpace) blank++;
      sawNonSpace = false;
    } else if (c !== ' ' && c !== '\t' && c !== '\r') {
      sawNonSpace = true;
    }
  }
  return blank;
}

/**
 * Resolve import specifiers to concrete file paths within the project.
 * Returns a map: file relPath -> array of target file relPaths.
 *
 * Rules (best effort):
 *  - relative specifiers ("./x", "../x/y") resolve with extensions
 *    [ (js: .ts/.tsx/.js/.jsx/.json/index) | (py: .py/__init__.py) ]
 *  - bare specifiers ("react", "lodash/get") resolve to:
 *      a) a scanned file dir if it shadows the name (rare), else
 *      b) an EXTERNAL package node (name = first path segment)
 */
export function resolveDependencies(
  files: ScannedFile[],
  parseResults: ParseOutcome[],
  root: string,
): { edges: Map<string, Set<string>>; externalPackages: Set<string> } {
  const relSet = new Set(files.map((f) => f.relPath));
  const edges = new Map<string, Set<string>>();
  const externalPackages = new Set<string>();

  const byDirIndex = new Map<string, string[]>();
  for (const f of files) {
    const dir = f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : '';
    const arr = byDirIndex.get(dir) ?? [];
    arr.push(f.relPath);
    byDirIndex.set(dir, arr);
  }
  // top-level project directories — used to tell an unresolved internal
  // python module (app.services.auth where app/ exists) from a real package
  const topLevelDirs = new Set(
    [...relSet].map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')),
  );

  for (const pr of parseResults) {
    if (!pr.imports || pr.imports.length === 0) continue;
    const relFile = toRel(pr.path, root);
    const fileLang: Language = pr.language;
    const targets = edges.get(relFile) ?? new Set<string>();
    for (const spec of pr.imports) {
      const resolved = resolveSpecifier(spec, relFile, fileLang, relSet, byDirIndex);
      if (resolved) {
        targets.add(resolved);
      } else if (isRelative(spec)) {
        // unresolved relative import: ignore (probably generated)
      } else {
        const isPy = pr.language === 'python';
        const pkg = isPy ? spec.split('.')[0] : barePackageName(spec);
        const builtins = isPy ? PYTHON_STDLIB : RUNTIME_BUILTINS;
        if (builtins.has(pkg)) continue; // runtime, not a dependency
        if (isPy && topLevelDirs.has(pkg)) continue; // internal module we failed to resolve
        externalPackages.add(pkg);
      }
    }
    if (targets.size > 0) edges.set(relFile, targets);
  }
  return { edges, externalPackages };
}

function toRel(absPath: string, root: string): string {
  const r = require('path');
  return r.relative(root, absPath).split(r.sep).join('/');
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function barePackageName(spec: string): string {
  const seg = spec.replace(/^node:/, '').split('/')[0];
  return seg || spec;
}

/**
 * Node.js / browser builtins. These are part of the runtime, not project
 * dependencies, so they are excluded from external-package nodes.
 */
const RUNTIME_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'test', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib', 'npn', 'node',
]);

/**
 * Python standard library — same treatment as RUNTIME_BUILTINS for .py files.
 * (Python also re-uses a few names from the Node set, so keep them separate.)
 */
const PYTHON_STDLIB = new Set([
  'abc', 'argparse', 'asyncio', 'base64', 'bisect', 'builtins', 'calendar', 'cmath',
  'cmd', 'codecs', 'collections', 'colorsys', 'concurrent', 'configparser', 'contextlib',
  'copy', 'copyreg', 'csv', 'dataclasses', 'datetime', 'decimal', 'difflib', 'dis',
  'doctest', 'email', 'encodings', 'enum', 'errno', 'faulthandler', 'fcntl', 'fnmatch',
  'fractions', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib',
  'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'math', 'mimetypes', 'mmap', 'multiprocessing', 'netrc', 'nntplib',
  'numbers', 'operator', 'optparse', 'os', 'pathlib', 'pickle', 'pickletools', 'plistlib',
  'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue',
  'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'runpy', 'sched',
  'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'smtpd', 'sndhdr', 'socket', 'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics',
  'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig',
  'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'textwrap', 'threading', 'time',
  'timeit', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'types',
  'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'winreg', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp',
  'zipfile', 'zipimport', 'zlib', '__future__',
]);

function resolveSpecifier(
  spec: string,
  fromRelFile: string,
  language: Language,
  relSet: Set<string>,
  byDirIndex: Map<string, string[]>,
): string | null {
  const path = require('path');
  const fromDir = fromRelFile.includes('/') ? fromRelFile.slice(0, fromRelFile.lastIndexOf('/')) : '';
  void byDirIndex;

  if (isRelative(spec)) {
    const base = path.posix.normalize(fromDir + '/' + spec).replace(/^\.\//, '');
    const exts =
      language === 'python'
        ? ['.py', '/__init__.py']
        : ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    for (const e of exts) {
      const cand = base + e;
      if (relSet.has(cand)) return cand;
    }
    // also try the specifier as-is (already has extension)
    if (relSet.has(base)) return base;
    return null;
  }

  if (language === 'python') {
    // from foo.bar import x -> <pkg>/foo/bar.py or foo/bar/__init__.py
    const cand = spec.replace(/\./g, '/');
    for (const e of ['.py', '/__init__.py']) {
      if (relSet.has(cand + e)) return cand + e;
    }
    // try relative to every src root: src/<module>, <module>
    const roots = ['src', 'lib', 'app', ''];
    for (const root0 of roots) {
      const base = root0 ? root0 + '/' + cand : cand;
      for (const e of ['.py', '/__init__.py']) {
        if (relSet.has(base + e)) return base + e;
      }
    }
    return null;
  }

  // JS bare specifier: "lodash/map" -> node_modules, out of scope for file
  // edges unless it maps onto a workspace file with same name (monorepo).
  const pkg = barePackageName(spec);
  if (relSet.has(pkg + '/index.ts') || relSet.has(pkg + '/index.js')) {
    return relSet.has(pkg + '/index.ts') ? pkg + '/index.ts' : pkg + '/index.js';
  }
  return null;
}
