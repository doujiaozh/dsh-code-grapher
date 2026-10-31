/**
 * cg_render — graph assembly
 * ==========================
 * Merges scan + parse + analyze data into a single knowledge-graph.json:
 *   nodes:  module nodes (cluster hubs), file nodes, external-package nodes
 *   edges:  module->file "contains", file->file "imports",
 *           file->external-package "imports"
 * Layout metadata (cluster radians) is precomputed so the client can render
 * a force-directed graph with module-cluster coloring without any extra
 * computation.
 */
import { KnowledgeGraph, AnalysisResult, GraphEdge, GraphNode, Layer, ModuleInfo } from '../types';
import { ScanReport, moduleOf } from '../scan/scanner';
import { ParseOutcome } from '../parse/parser';

export interface AssembleInput {
  report: ScanReport;
  parseResults: ParseOutcome[];
  analysis: AnalysisResult[];
  model?: string;
}

export function assembleGraph({ report, parseResults, analysis, model }: AssembleInput): KnowledgeGraph {
  const parseByPath = new Map(parseResults.map((p) => [p.path, p]));
  const analysisByPath = new Map(analysis.map((a) => [normalize(a.path), a]));

  // ---- edges: parse-level import resolution ----
  const { edges: fileEdges, externalPackages } = resolveAllImports(report, parseResults);

  // ---- module assignment ----
  const modules: ModuleInfo[] = report.modules.map((m) => ({ ...m, fileCount: 0 }));
  const moduleOfCache = new Map<string, ModuleInfo>();

  // ---- nodes ----
  const nodes: GraphNode[] = [];
  const fileNodeIds = new Set<string>();
  const layerCounts: Record<string, number> = {};
  const langCounts: Record<string, number> = {};
  let totalLines = 0;

  // module nodes
  for (const m of modules) nodes.push({ id: m.id, kind: 'module', label: m.name, fileCount: 0, cluster: 0 });

  // file nodes
  for (const f of report.files) {
    let mod = moduleOfCache.get(f.relPath);
    if (!mod) {
      mod = moduleOf(f.relPath, modules);
      moduleOfCache.set(f.relPath, mod);
    }
    mod.fileCount++;
    const pr = parseByPath.get(f.path);
    const an = analysisByPath.get(normalize(f.relPath));
    const id = 'file:' + f.relPath;
    fileNodeIds.add(id);
    nodes.push({
      id,
      kind: 'file',
      label: basename(f.relPath),
      module: mod.id,
      language: f.language,
      layer: an?.layer ?? 'Unknown',
      domain: an?.domain,
      summary: an?.summary,
      path: f.relPath,
      lines: pr?.lines,
      size: f.size,
    });
    if (pr) totalLines += pr.lines;
    const layer = an?.layer ?? 'Unknown';
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
    langCounts[f.language] = (langCounts[f.language] ?? 0) + 1;
  }

  // propagate module file counts into nodes
  for (const n of nodes) {
    if (n.kind === 'module') n.fileCount = modules.find((m) => m.id === n.id)?.fileCount ?? 0;
  }

  // external package nodes
  const extIds = new Map<string, string>();
  for (const pkg of externalPackages) {
    const id = 'ext:' + pkg;
    extIds.set(pkg, id);
    nodes.push({ id, kind: 'external', label: pkg, cluster: -1 });
  }

  // ---- graph edges ----
  const edges: GraphEdge[] = [];
  // module contains file
  for (const n of nodes) {
    if (n.kind === 'file' && n.module) {
      edges.push({ id: `e:${n.module}->${n.id}`, source: n.module, target: n.id, kind: 'contains', weight: 1 });
    }
  }
  // file imports file
  const edgeKey = new Set<string>();
  for (const [fromRel, targets] of fileEdges) {
    const fromId = 'file:' + fromRel;
    for (const toRel of targets) {
      const key = fromId + '|file:' + toRel;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({ id: 'e:' + key, source: fromId, target: 'file:' + toRel, kind: 'imports', weight: 1 });
    }
  }
  // file imports external (deduped): attach ext nodes to the files
  // that referenced them via bare import specifiers.
  for (const pr of parseResults) {
    if (!pr.imports || pr.imports.length === 0) continue;
    const fromRel = normalizeRel(pr.path, report.root);
    if (!fileNodeIds.has('file:' + fromRel)) continue;
    for (const spec of pr.imports) {
      if (isRelative(spec)) continue;
      const pkg = barePackageName(spec);
      const extId = extIds.get(pkg);
      if (!extId) continue;
      const key = 'file:' + fromRel + '|' + extId;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({ id: 'e:' + key, source: 'file:' + fromRel, target: extId, kind: 'imports', weight: 1 });
    }
  }

  // ---- cluster radians for module hubs ----
  const moduleOrder = modules.map((m) => m.id);
  for (const n of nodes) {
    if (n.kind === 'file' && n.module) {
      const idx = moduleOrder.indexOf(n.module);
      n.cluster = ((idx + 0.5) / Math.max(1, moduleOrder.length)) * 2 * Math.PI;
    }
  }

  return {
    meta: {
      tool: 'dsh-code-grapher',
      version: pkgVersion(),
      project: basename(report.root),
      root: report.root,
      createdAt: new Date().toISOString(),
      model,
      layersList: sortedLayers(layerCounts),
      stats: {
        files: report.files.length,
        analyzed: analysis.length,
        modules: modules.length,
        externalPackages: externalPackages.size,
        edges: edges.length,
        totalLines,
        layers: layerCounts,
        languages: langCounts,
      },
    },
    modules,
    files: report.files.map((f) => ({
      ...f,
      ...(parseByPath.get(f.path) ?? {}),
      ...(analysisByPath.get(normalize(f.relPath)) ?? {}),
    })),
    nodes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// Local import-resolution wrapper: reuses cg_parse resolver so render does
// not duplicate specifier mapping logic.
// ---------------------------------------------------------------------------

import { resolveDependencies } from '../parse/parser';

function resolveAllImports(report: ScanReport, parseResults: ParseOutcome[]) {
  return resolveDependencies(report.files, parseResults, report.root);
}

function basename(p: string): string {
  const seg = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return seg[seg.length - 1] ?? p;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeRel(abs: string, root: string): string {
  const rp = require('path');
  return rp.relative(root, abs).split(rp.sep).join('/');
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function barePackageName(spec: string): string {
  return spec.split('/')[0] || spec;
}

let cachedVersion = '';
function pkgVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const fs = require('fs');
    const path = require('path');
    const here = path.resolve(__dirname, '..', 'package.json');
    cachedVersion = JSON.parse(fs.readFileSync(here, 'utf8')).version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** Sort layers for deterministic legend output. */
export function sortedLayers(layers: Record<string, number>): Array<[string, number]> {
  const order: Layer[] = ['Entry', 'Controller', 'Service', 'Data', 'UI', 'Util', 'Config', 'Test', 'Asset', 'Unknown'];
  return order.filter((l) => layers[l]).map((l) => [l, layers[l]!]);
}
