#!/usr/bin/env node
/**
 * cg — unified CLI for dsh-code-grapher
 * =====================================
 * Usage:
 *   cg scan    <root>  [--ignore g] [--max-files n] [--lang js,ts] [--depth n] [--out dir]
 *   cg parse   <root>  [--out dir]
 *   cg analyze <root>  [--model m] [--rpm n] [--workers n] [--batch n] [--limit n]
 *                      [--force] [--dry-run] [--no-dotenv]
 *   cg render  <root>  [--inline-d3] [--open] [--out dir]
 *   cg graph   <root>  [...all of the above...]   # full pipeline, one shot
 *
 * Config resolution: CLI flags > env vars > .env > defaults.
 * Environment: INKSTONE_BASE_URL, INKSTONE_API_KEY, INKSTONE_MODEL,
 *              CG_RPM, CG_WORKERS, CG_BATCH_SIZE, CG_CONTEXT_CHARS.
 */
import * as path from 'path';
import { loadDotEnv, resolveConfigGuarded, AppConfig, DEFAULTS } from './config';
import { scanProject } from './scan/scanner';
import { parseFiles } from './parse/parser';
import { analyzeProject } from './analyze/analyzer';
import { renderGraph } from './render/render';
import { runPipeline } from './index';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagNum(args: Args, name: string, fallback: number): number {
  const v = args.flags[name];
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function flagStr(args: Args, name: string, fallback: string): string {
  const v = args.flags[name];
  if (typeof v !== 'string') return fallback;
  // empty string is treated as "not provided" so resolveConfig's ?? chain
  // (CLI flag > env > default) keeps falling through to env/defaults
  return v === '' ? fallback : v;
}

function flagList(args: Args, name: string): string[] | undefined {
  const v = args.flags[name];
  if (v === undefined || v === true) return undefined;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function relRoot(p: string): string {
  return path.resolve(process.cwd(), p || '.');
}

function humanBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0] ?? 'help';
  const root = relRoot(args.positional[1] ?? '.');

  if (!args.flags['no-dotenv']) loadDotEnv(path.dirname(root));

  switch (command) {
    case 'scan':
      return cmdScan(args, root);
    case 'parse':
      return await cmdParse(args, root);
    case 'analyze':
      return await cmdAnalyze(args, root);
    case 'render':
      return await cmdRender(args, root);
    case 'graph':
      return await cmdGraph(args, root);
    case 'version':
      console.log('dsh-code-grapher ' + require('../package.json').version);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error('Unknown command: ' + command + " (see 'cg help')");
      return 2;
  }
}

function cmdScan(args: Args, root: string): number {
  const report = scanProject({
    root,
    ignore: flagList(args, 'ignore'),
    maxFiles: flagNum(args, 'max-files', 20000),
    maxFileSize: flagNum(args, 'max-file-size', 512 * 1024),
    languages: flagList(args, 'lang') as never,
    maxDepth: flagNum(args, 'depth', 0),
  });
  const langs = Object.entries(report.languageCounts).sort((a, b) => b[1] - a[1]);
  console.log(`root      : ${report.root}`);
  console.log(`files     : ${report.files.length}${report.truncated ? ' (CAPPED — raise --max-files)' : ''}`);
  console.log(`size      : ${humanBytes(report.totalBytes)}`);
  console.log(`modules   : ${report.modules.length}`);
  console.log('languages :');
  for (const [lang, count] of langs) console.log(`  ${lang.padEnd(12)} ${count}`);
  if (report.unmatchedIgnorePatterns.length) {
    console.log('unmatched --ignore patterns: ' + report.unmatchedIgnorePatterns.join(', '));
  }
  if (args.flags['out'] !== undefined) {
    const out = path.resolve(root, String(args.flags['out']));
    require('fs').mkdirSync(out, { recursive: true });
    require('fs').writeFileSync(path.join(out, 'scan.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('written   : ' + path.join(out, 'scan.json'));
  }
  return 0;
}

async function cmdParse(args: Args, root: string): Promise<number> {
  const out = path.resolve(root, flagStr(args, 'out', '.code-graph'));
  const report = scanProject({ root });
  const results = parseFiles(report.files);
  require('fs').mkdirSync(out, { recursive: true });
  require('fs').writeFileSync(path.join(out, 'parse.json'), JSON.stringify(results, null, 2), 'utf8');
  const symbols = results.reduce((s, r) => s + r.symbols.length, 0);
  const imports = results.reduce((s, r) => s + r.imports.length, 0);
  console.log(`parsed ${results.length} files: ${symbols} symbols, ${imports} imports -> ${path.join(out, 'parse.json')}`);
  return 0;
}

async function cmdAnalyze(args: Args, root: string): Promise<number> {
  const out = path.resolve(root, flagStr(args, 'out', '.code-graph'));
  const cfg = resolveConfigGuarded({
    model: flagStr(args, 'model', ''),
    rpm: flagNum(args, 'rpm', 0) || undefined,
    workers: flagNum(args, 'workers', 0) || undefined,
    batchSize: flagNum(args, 'batch', 0) || undefined,
    maxTokens: flagNum(args, 'max-tokens', 0) || undefined,
    baseURL: flagStr(args, 'base-url', ''),
    apiKey: flagStr(args, 'api-key', ''),
  });
  const effective: AppConfig = {
    baseURL: cfg.baseURL || DEFAULTS.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model || DEFAULTS.model,
    rpm: cfg.rpm || DEFAULTS.rpm,
    workers: cfg.workers || DEFAULTS.workers,
    batchSize: cfg.batchSize || DEFAULTS.batchSize,
    contextChars: cfg.contextChars || DEFAULTS.contextChars,
    maxTokens: cfg.maxTokens || DEFAULTS.maxTokens,
  };
  if (!effective.apiKey && !args.flags['dry-run']) {
    console.error('INGSTONE_API_KEY is not set. Set it in .env (see .env.example) or pass --api-key. Use --dry-run for heuristics only.');
    return 2;
  }
  const report = scanProject({ root });
  const parseResults = parseFiles(report.files);
  const inputs = report.files.map((f, i) => ({ file: f, parse: parseResults[i]! }));
  const started = Date.now();
  const res = await analyzeProject(inputs, effective, out, {
    force: !!args.flags['force'],
    limit: flagNum(args, 'limit', 0) || undefined,
    dryRun: !!args.flags['dry-run'],
    onProgress: (done, total, info) =>
      process.stdout.write(`\r[cg_analyze] batch ${done}/${total}${info ? ' — ' + info : ''}   `),
  });
  console.log('');
  console.log(`analyzed ${res.results.length} files in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`llm calls=${res.stats.llmCalls} synthetic=${res.stats.synthetic} failures=${res.stats.failures}`);
  console.log('checkpoint: ' + res.checkpointPath);
  return res.stats.failures > 0 && res.stats.llmCalls === 0 ? 3 : 0;
}

async function cmdRender(args: Args, root: string): Promise<number> {
  const out = path.resolve(root, flagStr(args, 'out', '.code-graph'));
  const report = scanProject({ root });
  const parseResults = parseFiles(report.files);
  let analysis = [];
  try {
    analysis = JSON.parse(require('fs').readFileSync(path.join(out, 'analyze-checkpoint.json'), 'utf8'));
  } catch {
    console.warn('[cg_render] no analyze-checkpoint.json found; rendering structure-only graph (no summaries/layers).');
  }
  const res = await renderGraph({
    report,
    parseResults,
    analysis,
    root,
    outDir: out,
    model: flagStr(args, 'model', ''),
    inlineD3: !!args.flags['inline-d3'],
    open: !!args.flags['open'],
  });
  console.log('graph json : ' + res.graphJsonPath);
  console.log('graph html : ' + res.htmlPath + (res.inlinedD3 ? ' (D3 inlined)' : ' (D3 via CDN)'));
  return 0;
}

async function cmdGraph(args: Args, root: string): Promise<number> {
  if (!args.flags['dry-run']) {
    const cfg = resolveConfigGuarded();
    if (!cfg.apiKey) {
      console.error('INGSTONE_API_KEY is not set (needed for LLM analysis). Options: add .env, pass --api-key, or rerun with --dry-run.');
      return 2;
    }
  }
  const started = Date.now();
  printBanner(root);
  try {
    const res = await runPipeline({
      root,
      outDir: flagStr(args, 'out', '.code-graph'),
      config: {
        model: flagStr(args, 'model', ''),
        rpm: flagNum(args, 'rpm', 0) || undefined,
        workers: flagNum(args, 'workers', 0) || undefined,
        batchSize: flagNum(args, 'batch', 0) || undefined,
        maxTokens: flagNum(args, 'max-tokens', 0) || undefined,
        baseURL: flagStr(args, 'base-url', ''),
        apiKey: flagStr(args, 'api-key', ''),
      },
      ignore: flagList(args, 'ignore'),
      maxFiles: flagNum(args, 'max-files', 20000),
      languages: flagList(args, 'lang'),
      maxDepth: flagNum(args, 'depth', 0),
      force: !!args.flags['force'],
      limit: flagNum(args, 'limit', 0) || undefined,
      dryRun: !!args.flags['dry-run'],
      inlineD3: !!args.flags['inline-d3'],
      open: !!args.flags['open'],
      onProgress: (stage, detail) => process.stdout.write(`\r[cg:${stage}] ${detail}` + ' '.repeat(6)),
    });
    console.log('');
    const s = res.render.graph.meta.stats;
    console.log('— done in ' + Math.round((Date.now() - started) / 1000) + 's —');
    console.log(`  files      : ${s.files}`);
    console.log(`  modules    : ${s.modules}`);
    console.log(`  edges      : ${s.edges}`);
    console.log(`  ext pkgs   : ${s.externalPackages}`);
    console.log(`  layers     : ${Object.entries(s.layers).map(([k, v]) => k + '=' + v).join(' ')}`);
    console.log(`  artifacts  : ${res.render.graphJsonPath}`);
    console.log(`              ${res.render.htmlPath}`);
    console.log(`  open with  : ${res.render.htmlPath}`);
    if (res.render.graph.meta.model) console.log(`  model      : ${res.render.graph.meta.model}`);
    return 0;
  } catch (e) {
    console.error('\n[fatal] ' + (e as Error).message);
    console.error((e as Error).stack ?? '');
    return 1;
  }
}

function printBanner(root: string): void {
  console.log('dsh-code-grapher — code knowledge graph generator');
  console.log('root: ' + root);
  console.log('');
}

function printHelp(): void {
  console.log(`cg — code knowledge graph generator (DSH plugin, zero native deps)

COMMANDS
  scan <root>     list files, languages and modules
  parse <root>    extract symbols/imports/exports (AST-lite regex)
  analyze <root>  LLM summaries + layer/domain per file (InkStone)
  render <root>   build knowledge-graph.json + interactive index.html
  graph <root>    run scan+parse+analyze+render in one shot
  version         print tool version
  help            this help

COMMON FLAGS
  --out <dir>        output directory (default .code-graph, inside root)
  --ignore <glob>    extra ignore pattern (repeatable via comma list)
  --max-files <n>    hard cap on scanned files (memory guard, default 20000)
  --max-file-size <n> skip files bigger than n bytes (default 524288)
  --lang <a,b>       only these languages (js,ts,tsx,py,json,md)
  --depth <n>        max directory depth (0 = unlimited)

ANALYZE FLAGS
  --model <id>       InkStone model (default ${DEFAULTS.model})
  --rpm <n>          requests/min cap (platform ceiling 50, default 45)
  --workers <n>      parallel crew workers (default ${DEFAULTS.workers})
  --batch <n>        files per LLM request (default ${DEFAULTS.batchSize})
  --max-tokens <n>   completion token budget per request (default ${DEFAULTS.maxTokens};
                       free channels reject large budgets with 429 — keep it low)
  --limit <n>        analyze only the first n files (smoke test)
  --force            ignore the analyze checkpoint and re-run everything
  --dry-run          no LLM calls; use heuristic summaries only
  --api-key <sk>     override INKSTONE_API_KEY
  --base-url <url>   override INKSTONE_BASE_URL
  --no-dotenv        do not read .env next to the project root

RENDER FLAGS
  --inline-d3        embed D3 v7 into the HTML (fully offline artifact)
  --open             open the HTML in the default browser when done

ENVIRONMENT (also read from .env — see .env.example)
  INKSTONE_BASE_URL  default ${DEFAULTS.baseURL}
  INKSTONE_API_KEY   required for analyze (unless --dry-run)
  INKSTONE_MODEL     default ${DEFAULTS.model}
  CG_RPM             default ${DEFAULTS.rpm}
  CG_WORKERS         default ${DEFAULTS.workers}
  CG_BATCH_SIZE      default ${DEFAULTS.batchSize}
  CG_MAX_TOKENS      default ${DEFAULTS.maxTokens}
  CG_CONTEXT_CHARS   source context per file (default ${DEFAULTS.contextChars})

EXAMPLES
  cg graph .                                   # full pipeline (needs API key)
  cg graph . --dry-run --open                  # structure-only, no LLM
  cg graph . --limit 30                        # smoke-test 30 files
  cg graph . --inline-d3 --rpm 40 --workers 3  # offline artifact, gentle rate
  cg scan . --out .code-graph                  # inventory only
`);
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((e) => {
    console.error('[fatal] ' + (e as Error).message);
    process.exit(1);
  });
