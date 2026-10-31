/**
 * dsh-code-grapher — shared types
 * =================================
 * Data model shared by cg_scan / cg_parse / cg_analyze / cg_render.
 */

/** Programming languages recognized by the scanner/parser. */
export type Language =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'json'
  | 'markdown'
  | 'unknown';

/** Supported layer taxonomy for architecture-level classification. */
export type Layer =
  | 'Entry'
  | 'Controller'
  | 'Service'
  | 'Data'
  | 'Util'
  | 'UI'
  | 'Config'
  | 'Test'
  | 'Asset'
  | 'Unknown';

/** A single symbol extracted by cg_parse. */
export interface SymbolInfo {
  /** Function | Class | Method | Constant | Define | Import | Export */
  kind: 'function' | 'class' | 'method' | 'constant' | 'import' | 'export';
  name: string;
  /** 1-based line number in the source file. */
  line: number;
  /** Only for classes/exports: base class or kind hint. */
  detail?: string;
}

/** Structural extraction result for one file (cg_parse output). */
export interface ParseResult {
  path: string;
  language: Language;
  lines: number;
  blankLines: number;
  symbols: SymbolInfo[];
  /** Raw import specifiers, e.g. "./utils", "fs", "../types". */
  imports: string[];
  /** Exported symbol names. */
  exports: string[];
}

/** LLM semantic analysis for one file (cg_analyze output). */
export interface AnalysisResult {
  path: string;
  /** One-sentence business summary. */
  summary: string;
  /** Architecture layer, one of LAYERS. */
  layer: Layer;
  /** Business domain, e.g. "auth", "billing", "rendering". */
  domain: string;
  /** 0..1 confidence reported by the model. */
  confidence: number;
  /** True when the row comes from a checkpoint/heuristic and not the LLM. */
  synthetic?: boolean;
}

/** A scanned file (cg_scan output; ParseResult is merged in later). */
export interface ScannedFile {
  path: string;
  /** Path relative to project root, using forward slashes. */
  relPath: string;
  language: Language;
  size: number;
}

/** A discovered module (= a significant directory) from cg_scan. */
export interface ModuleInfo {
  id: string;
  /** Directory name or "<root>". */
  name: string;
  /** Directory path relative to root, forward slashes. */
  path: string;
  fileCount: number;
}

/** Scan options. */
export interface ScanOptions {
  root: string;
  /** Extra ignore patterns (gitignore-style globs, in addition to defaults). */
  ignore?: string[];
  /** Hard cap on number of files (memory guard). Default 20000. */
  maxFiles?: number;
  /** Skip files larger than this many bytes. Default 512*1024. */
  maxFileSize?: number;
  /** Only include these languages; empty = all. */
  languages?: Language[];
  /** Max depth of directory traversal. 0 = unlimited. */
  maxDepth?: number;
}

/** Parse options. */
export interface ParseOptions {
  /** Truncate source after this many chars before stripping (memory guard). */
  maxSourceChars?: number;
}

/** Analyze options. */
export interface AnalyzeOptions {
  root: string;
  outDir: string;
  rpm: number;
  workers: number;
  batchSize: number;
  model: string;
  apiKey: string;
  baseURL: string;
  /** File content chars sent to the LLM per file. */
  contextChars?: number;
  /** Abort analysis for remaining files after this many minutes. */
  timeoutMin?: number;
  /** Force re-analysis even if checkpoint exists. */
  force?: boolean;
  /** Analyze at most N files (debug / smoke test). */
  limit?: number;
  /** Run LLM calls in dry-run mode (no network; synthetic summaries). */
  dryRun?: boolean;
}

/** Render options. */
export interface RenderOptions {
  root: string;
  outDir: string;
  /** Also inline the D3 vendor bundle into the HTML (offline-ready). */
  inlineD3?: boolean;
  /** Open the generated HTML in the default browser when done. */
  open?: boolean;
}

/** Node kinds in the rendered graph. */
export type GraphNodeKind = 'file' | 'module' | 'external';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Module id the file belongs to. */
  module?: string;
  language?: Language;
  layer?: Layer;
  domain?: string;
  summary?: string;
  path?: string;
  lines?: number;
  size?: number;
  /** radian slot used for module clustering layout. */
  cluster?: number;
  /** how many files in the module (module nodes). */
  fileCount?: number;
}

export type EdgeKind = 'imports' | 'contains';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** number of distinct import statements (edge weight). */
  weight: number;
}

/** The final knowledge-graph.json document. */
export interface KnowledgeGraph {
  meta: {
    tool: string;
    version: string;
    project: string;
    root: string;
    createdAt: string;
    model?: string;
    /** Ordered [layer, count] pairs for deterministic legend rendering. */
    layersList?: Array<[string, number]>;
    stats: {
      files: number;
      analyzed: number;
      modules: number;
      externalPackages: number;
      edges: number;
      totalLines: number;
      layers: Record<string, number>;
      languages: Record<string, number>;
    };
  };
  modules: ModuleInfo[];
  files: Array<ScannedFile & Partial<ParseResult> & Partial<AnalysisResult>>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
