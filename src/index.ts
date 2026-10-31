/**
 * dsh-code-grapher — end-to-end pipeline
 * ======================================
 * scan -> parse -> analyze -> render
 * Everything runs inside <root>/.code-graph/ (never pollutes the repo).
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, resolveConfigGuarded } from './config';
import { ParallelCrew, CrewSummary } from './crew/crew';
import { parseFiles } from './parse/parser';
import { scanProject, ScanReport } from './scan/scanner';
import { analyzeProject, AnalyzeOutput } from './analyze/analyzer';
import { renderGraph, RenderOutput } from './render/render';

export interface PipelineOptions {
  root: string;
  outDir?: string;
  config?: Partial<AppConfig>;
  /** CLI/scan knobs */
  ignore?: string[];
  maxFiles?: number;
  languages?: string[];
  maxDepth?: number;
  /** analysis knobs */
  force?: boolean;
  limit?: number;
  dryRun?: boolean;
  inlineD3?: boolean;
  open?: boolean;
  /** progress sink */
  onProgress?: (stage: string, detail: string) => void;
}

export interface PipelineResult {
  report: ScanReport;
  analyze: AnalyzeOutput;
  crew: CrewSummary | null;
  render: RenderOutput;
  outDir: string;
}

export const DEFAULT_OUT = '.code-graph';

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root)) throw new Error(`Project root does not exist: ${root}`);
  const outDir = path.resolve(root, opts.outDir ?? DEFAULT_OUT);
  fs.mkdirSync(outDir, { recursive: true });

  const cfg = resolveConfigGuarded(opts.config ?? {});

  // ---------- 1. scan ----------
  opts.onProgress?.('scan', root);
  const report = scanProject({
    root,
    ignore: opts.ignore,
    maxFiles: opts.maxFiles ?? 20000,
    languages: normalizeLanguages(opts.languages),
    maxDepth: opts.maxDepth ?? 0,
  });
  if (report.files.length === 0) throw new Error('No analyzable files found under ' + root);
  if (report.truncated) {
    console.warn(`[cg_scan] file cap reached; only the first ${report.files.length} files were processed. Raise --max-files to scan more.`);
  }
  for (const bad of report.unmatchedIgnorePatterns) {
    console.warn(`[cg_scan] ignore pattern matched nothing: ${bad}`);
  }
  writeJson(path.join(outDir, 'scan.json'), {
    root: report.root,
    fileCount: report.files.length,
    languages: report.languageCounts,
    modules: report.modules,
    totalBytes: report.totalBytes,
    truncated: report.truncated,
    topFiles: report.files.slice(-20),
  });

  // ---------- 2. parse ----------
  opts.onProgress?.('parse', `${report.files.length} files`);
  const parseResults = parseFiles(report.files);

  // ---------- 3. analyze (crew) ----------
  const analyzeInputs = report.files.map((f, i) => ({ file: f, parse: parseResults[i] }));
  let crew: CrewSummary | null = null;
  const crewOrchestrator = new ParallelCrew(cfg);
  crew = crewOrchestrator.plan(analyzeInputs.length);
  crewOrchestrator.begin(crew);

  const analyze = await analyzeProject(analyzeInputs, cfg, outDir, {
    force: opts.force,
    limit: opts.limit,
    dryRun: opts.dryRun,
    onProgress: (done, total, info) => {
      const batch = info ? `batch ${done}/${total}${info ? ' (' + info + ')' : ''}` : `${done}/${total}`;
      opts.onProgress?.('analyze', batch + ' · ' + crewOrchestrator.describe(crew));
    },
  });
  crewOrchestrator.finish(crew, analyze.results.length);
  for (const w of analyze.warnings.slice(0, 10)) console.warn('[cg_analyze] ' + w);

  // ---------- 4. render ----------
  opts.onProgress?.('render', outDir);
  const render = await renderGraph({
    report,
    parseResults,
    analysis: analyze.results,
    root,
    outDir,
    model: cfg.model,
    inlineD3: opts.inlineD3,
    open: opts.open,
  });

  return { report, analyze, crew, render, outDir };
}

function normalizeLanguages(languages?: string[]) {
  if (!languages || languages.length === 0) return undefined;
  return languages.map((l) => {
    const k = l.toLowerCase();
    if (k === 'js') return 'javascript';
    if (k === 'ts') return 'typescript';
    return k;
  }) as never;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
