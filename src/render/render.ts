/**
 * cg_render — orchestration
 * =========================
 * Loads scan/parse/analyze artifacts, assembles knowledge-graph.json and
 * writes the interactive HTML. Optionally inlines D3 for a fully offline
 * artifact, and (Windows only) opens the result in the default browser.
 */
import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeGraph, AnalysisResult } from '../types';
import { ScanReport } from '../scan/scanner';
import { ParseOutcome } from '../parse/parser';
import { assembleGraph } from './graphData';
import { renderHtml, injectData, fetchD3Source } from './htmlTemplate';

export interface RenderInput {
  report: ScanReport;
  parseResults: ParseOutcome[];
  analysis: AnalysisResult[];
  root: string;
  outDir: string;
  model?: string;
  inlineD3?: boolean;
  open?: boolean;
}

export interface RenderOutput {
  graphJsonPath: string;
  htmlPath: string;
  graph: KnowledgeGraph;
  inlinedD3: boolean;
}

export async function renderGraph(input: RenderInput): Promise<RenderOutput> {
  fs.mkdirSync(input.outDir, { recursive: true });

  const graph = assembleGraph({
    report: input.report,
    parseResults: input.parseResults,
    analysis: input.analysis,
    model: input.model,
  });

  const graphJsonPath = path.join(input.outDir, 'knowledge-graph.json');
  fs.writeFileSync(graphJsonPath, JSON.stringify(graph, null, 2), 'utf8');

  let d3Source: string | undefined;
  if (input.inlineD3) {
    d3Source = (await fetchD3Source()) ?? undefined;
    if (!d3Source) {
      console.warn('[cg_render] could not fetch D3 bundle for inlining; falling back to CDN.');
    }
  }

  const html = injectData(
    renderHtml({ graph, inlineD3: !!d3Source, d3Source }),
    graph,
  );
  const htmlPath = path.join(input.outDir, 'index.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  if (input.open) {
    openInBrowser(htmlPath);
  }
  return { graphJsonPath, htmlPath, graph, inlinedD3: !!d3Source };
}

function openInBrowser(file: string): void {
  const { exec } = require('child_process') as typeof import('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${file}"` : process.platform === 'darwin' ? `open "${file}"` : `xdg-open "${file}"`;
  exec(cmd, (err) => {
    if (err) console.warn('[cg_render] open failed: ' + err.message);
  });
}
