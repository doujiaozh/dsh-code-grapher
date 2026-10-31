/**
 * cg_analyze — LLM semantic analysis
 * ==================================
 * Batches groups of files into one LLM request (batchSize), asks for a
 * strictly-formatted one-line-per-file answer, parses it into
 * { summary, layer, domain, confidence }, and:
 *   - persists a checkpoint after every batch (crash-safe resume),
 *   - falls back to keyword heuristics when the LLM is unavailable,
     disabled (dry-run) or the request for a group fails repeatedly.
 *
 * The "crew" is mapWithConcurrency workers pulling batches off a queue —
 * each LLM call goes through the RateLimiter first (50 RPM ceiling).
 */
import * as fs from 'fs';
import * as path from 'path';
import { AnalysisResult, Language, Layer, ParseResult, ScannedFile } from '../types';
import { AppConfig } from '../config';
import { InkStoneClient } from './llmClient';
import { RateLimiter, mapWithConcurrency } from './rateLimit';

export const LAYERS: Layer[] = [
  'Entry',
  'Controller',
  'Service',
  'Data',
  'UI',
  'Util',
  'Config',
  'Test',
  'Asset',
  'Unknown',
];

export interface AnalyzeInput {
  file: ScannedFile;
  parse?: ParseResult;
}

export interface AnalyzeOutput {
  results: AnalysisResult[];
  checkpointPath: string;
  stats: {
    batches: number;
    llmCalls: number;
    failures: number;
    synthetic: number;
    retried: number;
  };
  warnings: string[];
}

interface Batch {
  relPaths: string[];
  contexts: string[];
}

const SYSTEM_PROMPT = `You are a senior software architect auditing a code repository.
For EACH supplied source file return EXACTLY ONE line in this format:
<relPath> | <one-sentence summary of the file's business purpose> | <layer> | <domain> | <confidence 0..1>
Rules:
- <layer> MUST be one of: Entry, Controller, Service, Data, UI, Util, Config, Test, Asset, Unknown
  (Entry=bootstrap/CLI/main; Controller=API route/handler/dispatcher; Service=core business logic;
   Data=models/DAO/repos/db/schema; UI=rendering/components/templates; Util=helpers pure functions;
   Config=settings/deps wiring; Test=specs/fixtures/mocks; Asset=static/styles/i18n/data;
   Unknown=can't decide)
- <domain> = 1-2 lowercase words naming the business area (e.g. auth, billing, rendering, cli, utils).
- <summary> = one sentence, max ~25 words, describe WHAT the file does for the business, not syntax.
- <confidence> = decimal 0..1 of your classification certainty.
- Output ONLY the pipe-delimited lines, no markdown, no prose, no bullets.
- If a file is empty/trivial, still emit one line with summary "Empty or trivial file." layer Util.`;

export async function analyzeProject(
  inputs: AnalyzeInput[],
  cfg: AppConfig,
  outDir: string,
  options: { force?: boolean; limit?: number; dryRun?: boolean; onProgress?: (done: number, total: number, batchInfo?: string) => void } = {},
): Promise<AnalyzeOutput> {
  const items = options.limit ? inputs.slice(0, options.limit) : inputs;
  fs.mkdirSync(outDir, { recursive: true });
  const checkpointPath = path.join(outDir, 'analyze-checkpoint.json');

  // ---- resume from checkpoint ----
  const checkpoint = new Map<string, AnalysisResult>();
  if (!options.force) {
    try {
      const raw = fs.readFileSync(checkpointPath, 'utf8');
      const arr = JSON.parse(raw) as AnalysisResult[];
      for (const r of arr) checkpoint.set(normalize(r.path), r);
    } catch {
      // no or corrupted checkpoint: start fresh
    }
  }

  const client = options.dryRun ? null : new InkStoneClient(cfg);
  const limiter = new RateLimiter(cfg.rpm);

  const results = new Map<string, AnalysisResult>();
  // seed with checkpoint hits so re-runs cost zero tokens
  for (const [k, v] of checkpoint) results.set(k, v);

  // queue only files without an analysis yet
  const queue: AnalyzeInput[] = [];
  for (const it of items) {
    const key = normalize(it.file.relPath);
    if (!results.has(key)) queue.push(it);
  }

  // group into batches
  const batches: Batch[] = [];
  for (let i = 0; i < queue.length; i += cfg.batchSize) {
    const slice = queue.slice(i, i + cfg.batchSize);
    batches.push({
      relPaths: slice.map((s) => s.file.relPath),
      contexts: slice.map((s) => buildFileContext(s, cfg.contextChars)),
    });
  }

  const warnings: string[] = [];
  let llmCalls = 0;
  let failures = 0;
  let synthetic = 0;
  let retried = 0;
  let done = 0;

  if (queue.length === 0 && batches.length === 0) {
    warnings.push('All files already analyzed (checkpoint hit); nothing to do.');
  }

  await mapWithConcurrency(
    batches,
    cfg.workers,
    limiter,
    async (batch: Batch) => {
      if (options.dryRun || !client) {
        for (let i = 0; i < batch.relPaths.length; i++) {
          const r = heuristicAnalysis(batch.relPaths[i], '' /* no context needed */);
          r.path = batch.relPaths[i];
          results.set(normalize(r.path), r);
          synthetic++;
        }
        done++;
        options.onProgress?.(done, batches.length, 'heuristic batch');
        saveCheckpoint(checkpointPath, results);
        return;
      }
      try {
        const userPrompt = buildUserPrompt(batch.relPaths, batch.contexts);
        const chat = await client.chat(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          // per-file line budget capped by cfg.maxTokens (free channels cap this hard)
          { maxTokens: Math.min(cfg.maxTokens, 900 + 180 * batch.relPaths.length) },
        );
        const content = chat.content;
        llmCalls++;
        const parsed = parseLLMResponse(content, batch.relPaths);
        let unparsed = 0;
        for (const [rel, r] of parsed) {
          if (r) {
            results.set(normalize(rel), r);
          } else {
            unparsed++;
            const h = heuristicAnalysis(rel, '');
            h.path = rel;
            results.set(normalize(rel), h);
            synthetic++;
          }
        }
        if (unparsed > 0) warnings.push(`Batch had ${unparsed} unparseable line(s); filled with heuristics.`);
        if (parsed.size < batch.relPaths.length) {
          warnings.push('LLM omitted some file lines; missing ones filled from heuristics.');
        }
      } catch (e) {
        failures++;
        const msg = (e as Error).message ?? String(e);
        if (/HTTP 4\d\d/.test(msg) && !/429/.test(msg)) {
          warnings.push(`LLM call failed hard (${msg}); batch kept via heuristics. Check INKSTONE_API_KEY.`);
        } else {
          retried++;
          warnings.push(`LLM call failed (${truncateStr(msg, 120)}); batch filled via heuristics.`);
        }
        for (const rel of batch.relPaths) {
          if (!results.has(normalize(rel))) {
            const h = heuristicAnalysis(rel, '');
            h.path = rel;
            results.set(normalize(rel), h);
            synthetic++;
          }
        }
      }
      done++;
      options.onProgress?.(done, batches.length, `crew workers=${cfg.workers} rpm=${cfg.rpm}`);
      saveCheckpoint(checkpointPath, results);
    },
  );

  // compact: only keep results for files in this run (drop stale entries)
  const wanted = new Set(items.map((it) => normalize(it.file.relPath)));
  const finalResults = Array.from(results.entries())
    .filter(([k]) => wanted.has(k))
    .map(([, v]) => v);
  saveCheckpoint(checkpointPath, new Map(finalResults.map((r) => [normalize(r.path), r])));

  return {
    results: finalResults,
    checkpointPath,
    stats: { batches: batches.length, llmCalls, failures, synthetic, retried },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// prompt building / parsing
// ---------------------------------------------------------------------------

function buildFileContext(inp: AnalyzeInput, contextChars: number): string {
  const { file, parse } = inp;
  const head: string[] = [`### FILE: ${file.relPath}`, `language: ${file.language}  lines: ${parse?.lines ?? '?'}`];
  if (parse && parse.symbols.length > 0) {
    const sig = parse.symbols
      .slice(0, 40)
      .map((s) => `${s.kind} ${s.name}${s.detail ? ' ' + s.detail : ''} (L${s.line})`)
      .join('\n');
    head.push('symbols:\n' + sig);
  }
  head.push('imports: ' + (parse?.imports?.slice(0, 20).join(', ') ?? 'none'));
  let body = '';
  try {
    const src = fs.readFileSync(file.path, 'utf8');
    body = truncateToLines(src, contextChars);
  } catch {
    body = '(unreadable)';
  }
  return head.join('\n') + '\n--- source (truncated) ---\n' + body;
}

function truncateToLines(src: string, maxChars: number): string {
  if (src.length <= maxChars) return src;
  const half = Math.floor(maxChars / 2);
  return src.slice(0, half) + '\n…[truncated]…\n' + src.slice(src.length - half);
}

function buildUserPrompt(relPaths: string[], contexts: string[]): string {
  return [
    `Analyze the following ${relPaths.length} file(s). Answer for EACH, in order, one line each.`,
    ...contexts,
    'Now output the pipe-delimited lines.',
  ].join('\n\n');
}

export function parseLLMResponse(
  content: string,
  expectedPaths: string[],
): Map<string, AnalysisResult | null> {
  const out = new Map<string, AnalysisResult | null>();
  for (const p of expectedPaths) out.set(p, null);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('```')) continue;
    if (!line.includes('|')) continue;
    // path | summary | layer | domain | confidence
    const parts = splitTopLevel(line, 5);
    if (parts.length < 5) continue;
    const [pRaw, summary, layerRaw, domain, confidenceRaw] = parts;
    const rel = pRaw.trim().replace(/^["']|["']$/g, '');
    // tolerate models echoing a slightly different path: match by suffix
    let matched: string | null = null;
    for (const expected of expectedPaths) {
      if (expected === rel || expected.endsWith(rel) || rel.endsWith(expected)) {
        matched = expected;
        break;
      }
    }
    if (!matched) continue;
    const layer = normalizeLayer(layerRaw);
    const confidence = clamp01(Number(confidenceRaw));
    out.set(matched, {
      path: matched,
      summary: summary.trim().replace(/^["']|["']$/g, ''),
      layer,
      domain: domain.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '') || 'misc',
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
    });
  }
  return out;
}

function splitTopLevel(line: string, limit: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of line) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0 && parts.length < limit - 1) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

function normalizeLayer(raw: string): Layer {
  const t = raw.trim().replace(/^["']|["']$/g, '');
  const capped = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  return (LAYERS as string[]).includes(capped) ? (capped as Layer) : 'Unknown';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// heuristic fallback (also used by --dry-run)
// ---------------------------------------------------------------------------

const LAYER_KEYWORDS: Array<[RegExp, Layer]> = [
  [/\b(main|cli|bin|bootstrap|index|app|entry|start|launch)\b/i, 'Entry'],
  [/\b(route|router|controller|handler|endpoint|api|middleware|resolver)\b/i, 'Controller'],
  [/\b(service|logic|manager|orchestrat|processor|engine|scheduler|worker|analyz|calc|generat|build)\b/i, 'Service'],
  [/\b(model|schema|entity|migration|dao|repository|repo|store|database|db|query|orm|prisma|collection)\b/i, 'Data'],
  [/\b(component|view|page|render|ui|widget|template|style|css|theme|layout|screen|dialog|modal)\b/i, 'UI'],
  [/\b(util|utilit|helper|common|shared|misc|format|validate|sanitiz|convert|text|math)\b/i, 'Util'],
  [/\b(config|setting|env|constant|option|preference|rollup|webpack|vite|tsconfig|babel|\.env)\b/i, 'Config'],
  [/\b(test|spec|mock|fixture|__tests__|bench)\b/i, 'Test'],
  [/\b(asset|image|icon|font|static|public|locale|i18n|lang|translation|\.md$|\.json$)\b/i, 'Asset'],
];

export function heuristicAnalysis(relPath: string, _context: string): AnalysisResult {
  const segments = relPath.split('/');
  const name = segments[segments.length - 1] ?? relPath;
  const haystack = relPath;
  let layer: Layer = 'Unknown';
  for (const [re, l] of LAYER_KEYWORDS) {
    if (re.test(haystack)) {
      layer = l;
      break;
    }
  }
  const domainGuess = guessDomain(segments, name);
  return {
    path: relPath,
    summary: heuristicSummary(name, layer),
    layer,
    domain: domainGuess,
    confidence: 0.35,
    synthetic: true,
  };
}

function guessDomain(segments: string[], name: string): string {
  const domainish = segments.filter((s) => !['src', 'lib', 'app', 'dist', 'test', 'tests', 'main', 'core'].includes(s));
  if (domainish.length > 0) return domainish[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return (name.replace(/\.[a-z]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'core');
}

function heuristicSummary(name: string, layer: Layer): string {
  const base = name.replace(/\.[a-z0-9]+$/, '');
  const verbs: Record<string, string> = {
    Entry: 'Bootstraps the application and wires startup dependencies',
    Controller: 'Handles incoming requests and dispatches them to services',
    Service: 'Implements core business logic',
    Data: 'Defines data shapes and storage access',
    UI: 'Renders user interface content',
    Util: 'Provides stateless helper utilities',
    Config: 'Declares configuration and build wiring',
    Test: 'Covers behavior with fixtures and assertions',
    Asset: 'Holds static or generated content',
    Unknown: 'Contributes to the project structure',
  };
  return `${verbs[layer] ?? 'Supports the project'} (${base}).`;
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function saveCheckpoint(checkpointPath: string, results: Map<string, AnalysisResult>): void {
  try {
    const arr = Array.from(results.values());
    const tmp = checkpointPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, checkpointPath); // atomic-ish on same volume
  } catch (e) {
    console.warn('[cg_analyze] checkpoint write failed: ' + (e as Error).message);
  }
}

function truncateStr(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
