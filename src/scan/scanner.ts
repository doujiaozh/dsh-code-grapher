/**
 * cg_scan — project scanner
 * =========================
 * Walks a repository, detects the dominant languages, filters noise
 * directories (node_modules, .git, dist, build artifacts, ...) and
 * produces a bounded file inventory + module (directory) list.
 *
 * Memory guards (Win7 / 8GB friendly):
 *  - depth-first with a file cap (maxFiles) — never holds file contents
 *  - a single stat() per entry, no buffering of file bodies
 *  - maxFileSize guard so later parse/analyze stages never OOM on blobs
 */
import * as fs from 'fs';
import * as path from 'path';
import { Language, ModuleInfo, ScanOptions, ScannedFile } from '../types';

/** Directories always skipped (case-insensitive). */
export const DEFAULT_IGNORE_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.vercel',
  'coverage',
  '.nyc_output',
  'vendor',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  '.docusaurus',
  '.code-graph',
  '.cg-cache',
  'target',
  '.gradle',
  '.terraform',
  '.serverless',
]);

/** File patterns always skipped. */
const DEFAULT_IGNORE_FILES = new Set<string>([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  '.gitignore',
  '.npmignore',
  '.dockerignore',
  'license',
  'license.md',
  'license.txt',
]);

const EXT_LANGUAGE: Record<string, Language> = {
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyw': 'python',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

/** Which languages are parseable into symbols (feeds cg_parse). */
export const PARSEABLE_LANGUAGES: ReadonlySet<Language> = new Set([
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
]);

export function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_LANGUAGE[ext] ?? 'unknown';
}

function globToRegExp(glob: string): RegExp {
  // very small glob support: * / ** / ? / leading /
  let re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/^\*\*/, '.*')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]');
  if (re.startsWith('\\/')) re = re.slice(2);
  if (re.startsWith('/')) re = re.slice(1);
  return new RegExp(re + '$', 'i');
}

export interface ScanReport {
  root: string;
  files: ScannedFile[];
  modules: ModuleInfo[];
  languageCounts: Record<string, number>;
  totalBytes: number;
  truncated: boolean;
  unmatchedIgnorePatterns: string[];
}

/**
 * Scan a project directory.
 * @throws Error if root is not a readable directory.
 */
export function scanProject(options: ScanOptions): ScanReport {
  const root = path.resolve(options.root);
  const stat = fs.statSync(root); // throws on missing — surfaced to CLI
  if (!stat.isDirectory()) {
    throw new Error(`Scan root is not a directory: ${root}`);
  }

  const maxFiles = options.maxFiles ?? 20000;
  const maxFileSize = options.maxFileSize ?? 512 * 1024;
  const maxDepth = options.maxDepth ?? 0;
  const onlyLanguages = options.languages?.length
    ? new Set(options.languages)
    : undefined;

  const ignoreRegexes = (options.ignore ?? [])
    .filter((p) => p && !p.startsWith('#'))
    .map(globToRegExp);
  // pre-check which user patterns actually matched something, so we can warn
  const matched = new Array<boolean>(ignoreRegexes.length).fill(false);

  const files: ScannedFile[] = [];
  const dirFileCounts = new Map<string, number>();
  const languageCounts: Record<string, number> = {};
  let totalBytes = 0;
  let truncated = false;

  const rel = (p: string) => p.slice(root.length).replace(/\\/g, '/').replace(/^\//, '');

  function isIgnored(absPath: string, isDir: boolean): boolean {
    const rp = rel(absPath);
    for (let i = 0; i < ignoreRegexes.length; i++) {
      const re = ignoreRegexes[i];
      if (re.test(rp) || re.test(path.basename(absPath))) {
        matched[i] = true;
        return true;
      }
    }
    if (isDir) {
      return DEFAULT_IGNORE_DIRS.has(path.basename(absPath).toLowerCase());
    }
    const lower = path.basename(absPath).toLowerCase();
    if (DEFAULT_IGNORE_FILES.has(lower)) return true;
    if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return true;
    if (lower.endsWith('.map') || lower.endsWith('.lock')) return true;
    return false;
  }

  function walk(dir: string, depth: number): void {
    if (truncated) return;
    if (maxDepth > 0 && depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions): skip silently
    }
    // directories first for stable, depth-bounded traversal
    const dirs = entries.filter((e) => e.isDirectory());
    const fileEntries = entries.filter((e) => e.isFile() || e.isSymbolicLink());
    for (const d of dirs) {
      const abs = path.join(dir, d.name);
      if (isIgnored(abs, true)) continue;
      walk(abs, depth + 1);
    }
    for (const f of fileEntries) {
      const abs = path.join(dir, f.name);
      if (isIgnored(abs, false)) continue;
      const language = detectLanguage(f.name);
      if (onlyLanguages && !onlyLanguages.has(language)) continue;
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      if (size > maxFileSize) continue; // memory guard: skip blobs
      if (language === 'unknown' && !isProbablyConfig(f.name)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push({ path: abs, relPath: rel(abs), language, size });
      totalBytes += size;
      languageCounts[language] = (languageCounts[language] ?? 0) + 1;
      // attribute file to its parent directory chain for module discovery
      const parent = rel(path.dirname(abs)) || '<root>';
      dirFileCounts.set(parent, (dirFileCounts.get(parent) ?? 0) + 1);
    }
  }

  walk(root, 0);

  const modules = buildModules(files, dirFileCounts);

  return {
    root,
    files,
    modules,
    languageCounts,
    totalBytes,
    truncated,
    unmatchedIgnorePatterns: (options.ignore ?? []).filter((_, i) => !matched[i]),
  };
}

function isProbablyConfig(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('.env') ||
    lower === 'dockerfile' ||
    lower === 'makefile' ||
    lower === 'rakefile' ||
    lower.endsWith('.yml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.toml') ||
    lower.endsWith('.ini') ||
    lower.endsWith('.conf') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.bat')
  );
}

/**
 * Module = a directory that either is the root or contains ≥ MIN_MODULE_FILES
 * code files ( descendents counted ). Top-level directories are promoted so
 * src/* layouts produce sensible clusters.
 */
export function buildModules(
  files: ScannedFile[],
  dirFileCounts: Map<string, number>,
): ModuleInfo[] {
  const MIN_MODULE_FILES = 2;
  const modules: ModuleInfo[] = [];
  const seen = new Set<string>();
  for (const [dirPath, count] of dirFileCounts) {
    if (count < MIN_MODULE_FILES) continue;
    const parts = dirPath.split('/');
    let chosen: string | null = null;
    if (parts.length >= 2) {
      // top-level directory under root, e.g. src or packages
      chosen = parts[0] === '<root>' ? '<root>' : parts.slice(0, 2).join('/');
    } else {
      chosen = parts[0];
    }
    if (chosen && !seen.has(chosen)) {
      seen.add(chosen);
      modules.push({ id: 'mod:' + chosen, name: chosen, path: chosen, fileCount: 0 });
    }
  }
  // if nothing qualified, everything lands in <root>
  if (modules.length === 0) {
    modules.push({ id: 'mod:<root>', name: '<root>', path: '<root>', fileCount: 0 });
  }
  return modules;
}

/** Map a file's relPath to its module id using the discovered module list. */
export function moduleOf(relPath: string, modules: ModuleInfo[]): ModuleInfo {
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '<root>';
  // longest-prefix match wins
  let best: ModuleInfo | null = null;
  for (const m of modules) {
    if (m.path === '<root>') continue;
    if (dir === m.path || dir.startsWith(m.path + '/')) {
      if (!best || m.path.length > best.path.length) best = m;
    }
  }
  if (best) return best;
  return modules.find((m) => m.path === '<root>') ?? modules[0];
}
