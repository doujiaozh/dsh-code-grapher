/**
 * cg_render — HTML template (single file, D3 v7)
 * =======================================================
 * The generated index.html loads knowledge-graph.json and renders an
 * interactive force-directed graph with:
 *  - module-cluster coloring + convex hulls (toggle)
 *  - drag nodes / zoom & pan / reset view
 *  - click a node -> details panel (summary, layer, domain, symbols)
 *  - sidebar: layer & language filters, module list, text search
 *  - click a module node -> collapse/expand its files
 *  - stats bar; "/" focuses search; "?" shows help
 *
 * D3 comes from jsDelivr CDN by default; --inline-d3 bundles the library
 * into the HTML so the artifact works fully offline.
 */
import { KnowledgeGraph } from '../types';
import { sortedLayers } from './graphData';

export const D3_CDN = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js';

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export interface EmitContext {
  graph: KnowledgeGraph;
  inlineD3: boolean;
  /** Only when inlineD3=true: the D3 library source to embed. */
  d3Source?: string;
}

export function renderHtml(ctx: EmitContext): string {
  const { graph, inlineD3 } = ctx;
  const legend = sortedLayers(graph.meta.stats.layers);
  const d3Tag = inlineD3 && ctx.d3Source
    ? `<script>${ctx.d3Source}<\/script>`
    : `<script src="${D3_CDN}" crossorigin="anonymous"><\/script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Code Knowledge Graph — ${escapeHtml(graph.meta.project)}</title>
<style>
  :root {
    --bg: #0d1220; --panel: #141b2e; --panel2: #1a2338; --line: #273154;
    --text: #dbe4ff; --muted: #8b98bd; --accent: #6ea8fe; --accent2: #7ee0c3;
    --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: radial-gradient(1200px 700px at 70% -10%, #18223c 0%, var(--bg) 55%);
    color: var(--text); font: 14px/1.45 -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    overflow: hidden;
  }
  #app { display: grid; grid-template-columns: 272px 1fr 320px; grid-template-rows: 44px 26px 1fr; height: 100vh; }
  header {
    grid-column: 1 / 4; display: flex; align-items: center; gap: 14px; padding: 0 14px;
    background: linear-gradient(180deg, #182142, #121a30); border-bottom: 1px solid var(--line);
  }
  header .title { font-weight: 700; letter-spacing: .3px; }
  header .title small { color: var(--muted); font-weight: 400; margin-left: 8px; }
  header .model { color: var(--accent2); font-family: var(--mono); font-size: 12px; }
  #statsbar {
    grid-column: 1 / 4; display: flex; gap: 16px; align-items: center; padding: 0 14px;
    background: rgba(10,14,26,.55); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px;
  }
  #statsbar b { color: var(--text); font-weight: 600; }
  aside#left {
    background: var(--panel); border-right: 1px solid var(--line); overflow-y: auto; padding: 10px;
  }
  aside#right {
    background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; padding: 12px;
  }
  main { position: relative; overflow: hidden; }
  svg { width: 100%; height: 100%; display: block; cursor: grab; }
  svg:active { cursor: grabbing; }
  .h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 8%; color: var(--muted); margin: 14px 0 6px; }
  .h2:first-child { margin-top: 0; }
  .searchbox { width: 100%; background: var(--panel2); border: 1px solid var(--line); color: var(--text);
    border-radius: 6px; padding: 7px 9px; outline: none; }
  .searchbox:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(110,168,254,.18); }
  .chiprow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  .chip {
    border: 1px solid var(--line); background: var(--panel2); color: var(--muted);
    padding: 3px 9px; border-radius: 999px; cursor: pointer; user-select: none; font-size: 12px;
  }
  .chip.on { color: #06101f; background: var(--accent); border-color: var(--accent); font-weight: 600; }
  .chip:hover { border-color: var(--accent); }
  .legend-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; cursor: pointer; color: var(--muted); }
  .legend-row:hover { color: var(--text); }
  .legend-row.off { opacity: .35; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
  .legend-row .cnt { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 11px; }
  .modrow { padding: 4px 6px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; align-items: center; }
  .modrow:hover { background: var(--panel2); }
  .modrow .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .modrow .n { margin-left: auto; color: var(--muted); font-size: 11px; }
  #details h3 { margin: 0 0 4px; font-family: var(--mono); font-size: 14px; word-break: break-all; }
  #details .path { color: var(--muted); font-family: var(--mono); font-size: 12px; word-break: break-all; margin-bottom: 10px; }
  #details .kv { display: grid; grid-template-columns: 78px 1fr; gap: 4px 8px; margin: 8px 0; font-size: 13px; }
  #details .kv dt { color: var(--muted); }
  #details .summary { background: var(--panel2); border: 1px solid var(--line); border-left: 3px solid var(--accent);
    padding: 8px 10px; border-radius: 6px; margin: 10px 0; }
  #details .symb { font-family: var(--mono); font-size: 12px; max-height: 260px; overflow-y: auto; }
  #details .symb .s { padding: 1px 0; color: var(--muted); }
  #details .symb .s b { color: var(--accent2); font-weight: 600; }
  #details .symb .s .k { color: #c9a4ff; }
  .layerbadge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #06101f; }
  .toolbar { position: absolute; top: 10px; left: 10px; display: flex; flex-direction: column; gap: 6px; z-index: 5; }
  .tbtn { background: rgba(20,27,46,.9); border: 1px solid var(--line); color: var(--text);
    border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 12px; backdrop-filter: blur(4px); }
  .tbtn:hover { border-color: var(--accent); }
  .hint { position: absolute; bottom: 10px; left: 10px; color: var(--muted); font-size: 11px;
    background: rgba(13,18,32,.72); padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); }
  .empty { color: var(--muted); padding: 20px 6px; font-size: 13px; }
  #toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: #1c2745;
    border: 1px solid var(--accent); color: var(--text); padding: 7px 14px; border-radius: 8px; display: none; z-index: 20; }
  a { color: var(--accent); }
  @media (max-width: 1100px) { #app { grid-template-columns: 220px 1fr 260px; } }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="title">🧭 Code Knowledge Graph <small>${escapeHtml(graph.meta.project)}</small></div>
    <div class="model">${graph.meta.model ? 'model: ' + escapeHtml(graph.meta.model) : ''}</div>
    <div style="margin-left:auto; color:var(--muted); font-size:12px">
      generated ${escapeHtml(new Date(graph.meta.createdAt).toLocaleString())} by dsh-code-grapher v${escapeHtml(graph.meta.version)}
    </div>
  </header>
  <div id="statsbar"></div>
  <aside id="left">
    <div class="h2">Search <span style="color:var(--muted)">/</span></div>
    <input id="search" class="searchbox" placeholder="file, symbol, domain…" />
    <div class="h2">Layers</div>
    <div id="layers"></div>
    <div class="h2">Languages</div>
    <div id="langs" class="chiprow"></div>
    <div class="h2">Modules</div>
    <div id="modules"></div>
  </aside>
  <main>
    <div class="toolbar">
      <button class="tbtn" id="btn-reset">⤾ Reset view</button>
      <button class="tbtn" id="btn-hulls">◌ Hulls: on</button>
      <button class="tbtn" id="btn-labels">A Labels: on</button>
      <button class="tbtn" id="btn-collapse">⇣ Collapse all</button>
    </div>
    <svg id="graph" role="img" aria-label="Code knowledge graph"></svg>
    <div class="hint">drag nodes · scroll zoom · click node for details · click module to fold · ? for help</div>
  </main>
  <aside id="right"><div id="details"><div class="empty">Click a node to inspect it.<br><br>Edges: contains (module→file, thin) · imports (file→file/file→pkg, arrows).</div></div></aside>
</div>
<div id="toast"></div>
${d3Tag}
<script>
'use strict';
/* =====================================================================
 * Interactive rendering of knowledge-graph.json (D3 v7 force layout).
 * Runs fully offline once D3 is available (inlined or cached CDN).
 * ===================================================================== */
(function () {
  var KG = window.__KG_DATA__;      // injected by render pipeline
  var stats = KG.meta.stats;

  // ---------- colors ----------
  var LAYER_COLORS = {
    Entry:'#ffb454', Controller:'#ff7a7a', Service:'#6ea8fe', Data:'#9d7bff',
    UI:'#ff8fd0', Util:'#7ee0c3', Config:'#c9d2e8', Test:'#ffd166', Asset:'#8b98bd', Unknown:'#5b6685'
  };
  function layerColor(l){ return LAYER_COLORS[l] || LAYER_COLORS.Unknown; }

  // ---------- state ----------
  var activeLayers = {};      // layer -> bool
  var activeLangs = {};       // lang -> bool
  var query = '';
  var showHulls = true;
  var showLabels = true;
  var collapsedModules = {};  // moduleId -> bool

  // ---------- stats bar ----------
  var bar = document.getElementById('statsbar');
  function stat(label, value) {
    var s = document.createElement('span');
    s.innerHTML = label + ' <b>' + value + '</b>';
    return s;
  }
  bar.appendChild(stat('files', stats.files));
  bar.appendChild(stat('modules', stats.modules));
  bar.appendChild(stat('edges', stats.edges));
  bar.appendChild(stat('lines', stats.totalLines.toLocaleString()));
  bar.appendChild(stat('analyzed', stats.analyzed + '/' + stats.files));
  bar.appendChild(stat('ext packages', stats.externalPackages));

  // ---------- sidebar: layers ----------
  var layersEl = document.getElementById('layers');
  (KG.meta.layersList || []).forEach(function (row) {
    var name = row[0], count = row[1];
    activeLayers[name] = true;
    var div = document.createElement('div');
    div.className = 'legend-row';
    div.innerHTML = '<span class="dot" style="background:' + layerColor(name) + '"></span><span>' + name + '</span><span class="cnt">' + count + '</span>';
    div.onclick = function () {
      activeLayers[name] = !activeLayers[name];
      div.classList.toggle('off', !activeLayers[name]);
      applyFilters();
    };
    layersEl.appendChild(div);
  });

  // ---------- sidebar: languages ----------
  var langsEl = document.getElementById('langs');
  Object.keys(stats.languages).sort().forEach(function (lang) {
    activeLangs[lang] = true;
    var chip = document.createElement('span');
    chip.className = 'chip on';
    chip.textContent = lang;
    chip.onclick = function () {
      activeLangs[lang] = !activeLangs[lang];
      chip.classList.toggle('on', activeLangs[lang]);
      applyFilters();
    };
    langsEl.appendChild(chip);
  });

  // ---------- sidebar: modules ----------
  var modulesEl = document.getElementById('modules');
  KG.modules.forEach(function (m) {
    var div = document.createElement('div');
    div.className = 'modrow';
    div.innerHTML = '<span class="dot" style="background:' + moduleColor(m.id) + '"></span><span class="nm">' + escapeHtml(m.name) + '</span><span class="n">' + m.fileCount + '</span>';
    div.onclick = function () { toggleModule(m.id); };
    modulesEl.appendChild(div);
  });
  function moduleColor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',55%,58%)';
  }

  // ---------- search ----------
  var searchEl = document.getElementById('search');
  searchEl.addEventListener('input', function () { query = searchEl.value.trim().toLowerCase(); applyFilters(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== searchEl) { e.preventDefault(); searchEl.focus(); }
    if (e.key === 'Escape') { searchEl.value = ''; query = ''; applyFilters(); }
    if (e.key === '?') toast('drag · zoom · click node = details · click module = fold · / search · Esc clear');
  });

  // ---------- graph model ----------
  var NODES = KG.nodes.map(function (n) { return Object.assign({}, n); });
  var BY_ID = {}; NODES.forEach(function (n) { BY_ID[n.id] = n; });
  var EDGES = KG.edges
    .map(function (e) { return { source: BY_ID[e.source], target: BY_ID[e.target], kind: e.kind, weight: e.weight || 1 }; })
    .filter(function (e) { return e.source && e.target; });

  NODES.forEach(function (n) {
    n.degree = 0; n.expanded = true;
    if (n.kind === 'file') n.r = 6 + Math.min(8, Math.sqrt((n.lines || 10) / 60));
    else if (n.kind === 'module') n.r = 14;
    else n.r = 5;
  });
  EDGES.forEach(function (e) { e.source.degree++; e.target.degree++; });

  var fileNodes = NODES.filter(function (n) { return n.kind === 'file'; });
  var moduleNodes = NODES.filter(function (n) { return n.kind === 'module'; });
  var moduleById = {}; moduleNodes.forEach(function (m) { moduleById[m.id] = m; });

  // ---------- svg ----------
  var svg = d3.select('#graph');
  var W = svg.node().clientWidth, H = svg.node().clientHeight;
  var defs = svg.append('defs');
  var arrow = defs.append('marker').attr('id', 'arr').attr('viewBox', '0 -5 10 10')
    .attr('refX', 14).attr('refY', 0).attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto');
  arrow.append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#3f5494');

  var g = svg.append('g').attr('class', 'zoomroot');
  var hullG = g.append('g').attr('class', 'hulls');
  var linkG = g.append('g').attr('class', 'links');
  var nodeG = g.append('g').attr('class', 'nodes');

  var zoom = d3.zoom().scaleExtent([0.12, 6]).on('zoom', function (ev) { g.attr('transform', ev.transform); });
  svg.call(zoom);
  document.getElementById('btn-reset').onclick = function () {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
  };

  var linkSel = linkG.selectAll('line').data(EDGES).enter().append('line')
    .attr('stroke', function (d) { return d.kind === 'imports' ? '#3f5494' : '#22304f'; })
    .attr('stroke-width', function (d) { return d.kind === 'imports' ? 1.1 : 0.7; })
    .attr('stroke-opacity', 0.75)
    .attr('marker-end', function (d) { return d.kind === 'imports' ? 'url(#arr)' : null; });

  var nodeSel = nodeG.selectAll('g.node').data(NODES).enter().append('g')
    .attr('class', 'node').style('cursor', 'pointer').call(drag());
  var circle = nodeSel.append('circle')
    .attr('r', function (d) { return d.r; })
    .attr('fill', function (d) {
      if (d.kind === 'module') return moduleColor(d.id);
      if (d.kind === 'external') return '#3a4a6d';
      return layerColor(d.layer || 'Unknown');
    })
    .attr('stroke', function (d) { return d.kind === 'file' ? '#0d1220' : '#e8eeff'; })
    .attr('stroke-width', function (d) { return d.kind === 'file' ? 1.4 : 1.2; });
  nodeSel.append('title').text(function (d) { return d.label + (d.summary ? ' — ' + d.summary : ''); });
  var labels = nodeSel.append('text')
    .text(function (d) { return d.label; })
    .attr('x', function (d) { return (d.r || 6) + 4; })
    .attr('y', 3)
    .attr('fill', '#aab6d6')
    .attr('font-size', function (d) { return d.kind === 'module' ? 12 : 10; })
    .attr('font-family', 'Consolas, monospace')
    .attr('paint-order', 'stroke')
    .attr('stroke', '#0d1220')
    .attr('stroke-width', 3);

  nodeSel.on('click', function (event, d) {
    event.stopPropagation();
    if (d.kind === 'module') { toggleModule(d.id); return; }
    showDetails(d);
    highlightNeighborhood(d);
  });
  svg.on('click', function () { highlightNeighborhood(null); });

  // ---------- force simulation (module hubs on an outer ring) ----------
  var ringR = Math.min(W, H) * 0.36;
  moduleNodes.forEach(function (m, i) {
    var a = (i + 0.5) / Math.max(1, moduleNodes.length) * 2 * Math.PI;
    m.fx = W / 2 + Math.cos(a) * ringR; m.fy = H / 2 + Math.sin(a) * ringR;
  });
  fileNodes.forEach(function (n) {
    var a = n.cluster || 0;
    n.x = W / 2 + Math.cos(a) * (ringR * 0.5) + (Math.random() - 0.5) * 120;
    n.y = H / 2 + Math.sin(a) * (ringR * 0.5) + (Math.random() - 0.5) * 120;
  });

  var sim = d3.forceSimulation(NODES)
    .force('charge', d3.forceManyBody().strength(function (d) { return d.kind === 'module' ? -260 : -38; }))
    .force('link', d3.forceLink(EDGES).id(function (d) { return d.id; })
      .distance(function (d) { return d.kind === 'imports' ? 95 : 42; }).strength(0.22))
    .force('collide', d3.forceCollide().radius(function (d) { return (d.r || 6) + 9; }).iterations(2))
    .force('radial', d3.forceRadial(function (d) {
      if (d.kind === 'module') return ringR;
      if (collapsedModules[d.module]) return ringR * 0.72;
      return ringR * 0.55;
    }, W / 2, H / 2).strength(0.12))
    .alpha(1).alphaDecay(0.022).on('tick', ticked);

  function ticked() {
    linkSel.attr('x1', function (d) { return d.source.x; }).attr('y1', function (d) { return d.source.y; })
           .attr('x2', function (d) { return d.target.x; }).attr('y2', function (d) { return d.target.y; });
    nodeSel.attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });
    if (showHulls) drawHulls(); else hullG.selectAll('path').remove();
  }

  // ---------- convex hulls per module ----------
  function drawHulls() {
    hullG.selectAll('path').remove();
    if (!showHulls) return;
    KG.modules.forEach(function (m) {
      var members = fileNodes.filter(function (n) { return n.module === m.id && visible(n); });
      if (members.length < 2) return;
      var pts = members.map(function (n) { return [n.x, n.y]; });
      var hull = d3.polygonHull(pts);
      if (!hull) return;
      var hub = moduleById[m.id];
      if (hub) hull.push([hub.x, hub.y], [hub.x, hub.y]);
      hullG.append('path')
        .attr('d', 'M' + hull.join('L') + 'Z')
        .attr('fill', moduleColor(m.id))
        .attr('fill-opacity', 0.05)
        .attr('stroke', moduleColor(m.id))
        .attr('stroke-opacity', 0.30)
        .attr('stroke-width', 1.2);
    });
  }

  // ---------- visibility / filtering ----------
  function visible(n) {
    if (n.kind === 'module') return true;
    if (n.kind === 'file') {
      if (!activeLayers[n.layer || 'Unknown']) return false;
      if (!activeLangs[n.language || 'unknown']) return false;
      if (query) {
        var hay = (n.path + ' ' + n.label + ' ' + (n.summary || '') + ' ' + (n.domain || '')).toLowerCase();
        if (hay.indexOf(query) === -1) return false;
      }
      if (collapsedModules[n.module]) return false;
    }
    return true;
  }

  function applyFilters() {
    nodeSel.style('display', function (d) { return visible(d) ? null : 'none'; });
    linkSel.style('display', function (d) {
      return visible(d.source) && visible(d.target) ? null : 'none';
    });
    labels.style('display', showLabels ? null : 'none');
    drawHulls();
    sim.alpha(0.35).restart();
  }

  // ---------- collapse / expand ----------
  function toggleModule(id) {
    collapsedModules[id] = !collapsedModules[id];
    applyFilters();
    toast((collapsedModules[id] ? 'Folded ' : 'Expanded ') + id.replace(/^mod:/, ''));
  }
  document.getElementById('btn-collapse').onclick = function () {
    var anyOpen = KG.modules.some(function (m) { return !collapsedModules[m.id]; });
    KG.modules.forEach(function (m) { collapsedModules[m.id] = anyOpen; });
    applyFilters();
  };

  // ---------- toolbar toggles ----------
  document.getElementById('btn-hulls').onclick = function (ev) {
    showHulls = !showHulls;
    ev.target.textContent = '◌ Hulls: ' + (showHulls ? 'on' : 'off');
    hullG.selectAll('path').remove(); if (showHulls) drawHulls();
  };
  document.getElementById('btn-labels').onclick = function (ev) {
    showLabels = !showLabels;
    ev.target.textContent = 'A Labels: ' + (showLabels ? 'on' : 'off');
    labels.style('display', showLabels ? null : 'none');
  };

  // ---------- neighborhood highlight ----------
  function highlightNeighborhood(node) {
    if (!node) {
      circle.attr('opacity', 1); linkSel.attr('stroke-opacity', 0.75);
      return;
    }
    var keep = {}; keep[node.id] = true;
    EDGES.forEach(function (e) {
      if (e.source.id === node.id) keep[e.target.id] = true;
      if (e.target.id === node.id) keep[e.source.id] = true;
    });
    circle.attr('opacity', function (d) { return keep[d.id] ? 1 : 0.12; });
    linkSel.attr('stroke-opacity', function (e) {
      return e.source.id === node.id || e.target.id === node.id ? 0.95 : 0.05;
    });
  }

  // ---------- details panel ----------
  var symbolsByPath = window.__KG_SYMBOLS__ || {};
  function showDetails(n) {
    var el = document.getElementById('details');
    var html = '';
    if (n.kind === 'module') {
      var files = NODES.filter(function (x) { return x.kind === 'file' && x.module === n.id; });
      html = '<h3>' + escapeHtml(n.label) + '</h3><div class="path">module · ' + n.fileCount + ' files</div>'
        + '<div class="summary">' + files.slice(0, 18).map(function (f) { return escapeHtml(f.path); }).join('<br>') + (files.length > 18 ? '<br>…+' + (files.length - 18) : '') + '</div>';
    } else if (n.kind === 'external') {
      html = '<h3>' + escapeHtml(n.label) + '</h3><div class="path">external package</div>'
        + '<div class="summary">Referenced through bare import specifiers (not part of this repository).</div>';
    } else {
      var syms = symbolsByPath[n.path || ''] || [];
      html = '<h3>' + escapeHtml(n.label) + '</h3>'
        + '<div class="path">' + escapeHtml(n.path || '') + '</div>'
        + (n.summary ? '<div class="summary">' + escapeHtml(n.summary) + (n.confidence != null ? ' <span style="color:var(--muted)">· conf ' + Number(n.confidence).toFixed(2) + '</span>' : '') + '</div>' : '')
        + '<dl class="kv">'
        + '<dt>layer</dt><dd><span class="layerbadge" style="background:' + layerColor(n.layer || 'Unknown') + '">' + escapeHtml(n.layer || 'Unknown') + '</span></dd>'
        + '<dt>domain</dt><dd>' + escapeHtml(n.domain || '—') + '</dd>'
        + '<dt>module</dt><dd>' + escapeHtml((n.module || '').replace(/^mod:/, '')) + '</dd>'
        + '<dt>language</dt><dd>' + escapeHtml(n.language || '—') + '</dd>'
        + '<dt>lines</dt><dd>' + (n.lines != null ? n.lines : '—') + '</dd>'
        + '<dt>size</dt><dd>' + (n.size != null ? Math.max(1, Math.round(n.size / 102.4) / 10) + ' KB' : '—') + '</dd>'
        + '<dt>degree</dt><dd>' + (n.degree || 0) + ' links</dd>'
        + '</dl>'
        + '<div class="h2">Symbols (' + syms.length + ')</div>'
        + '<div class="symb">' + (syms.length ? syms.slice(0, 200).map(function (s) {
            return '<div class="s"><span class="k">' + escapeHtml(s.kind) + '</span> <b>' + escapeHtml(s.name) + '</b>' + (s.detail ? ' ' + escapeHtml(s.detail) : '') + ' <span>L' + s.line + '</span></div>';
          }).join('') : '<div class="empty">No symbols extracted.</div>') + '</div>';
    }
    el.innerHTML = html;
  }

  // ---------- drag ----------
  function drag() {
    function started(event, d) { if (!event.active) sim.alphaTarget(0.25).restart(); d.fx0 = d.fx; d.fy0 = d.fy; }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function ended(event, d) { if (!event.active) sim.alphaTarget(0); if (d.kind !== 'module') { d.fx = null; d.fy = null; } }
    return d3.drag().on('start', started).on('drag', dragged).on('end', ended);
  }

  // ---------- helpers ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2200);
  }

  window.addEventListener('resize', function () {
    W = svg.node().clientWidth; H = svg.node().clientHeight;
    sim.force('radial', d3.forceRadial(function (d) { return d.kind === 'module' ? Math.min(W, H) * 0.36 : Math.min(W, H) * 0.5; }, W / 2, H / 2));
    sim.alpha(0.3).restart();
  });

  applyFilters();
})();
</script>
</body>
</html>`;
}

/** Inject the graph payload + symbol index into the HTML as a data island. */
export function injectData(html: string, graph: KnowledgeGraph): string {
  const symbolsByPath: Record<string, Array<{ kind: string; name: string; line: number; detail?: string }>> = {};
  for (const f of graph.files) {
    if (f.symbols && f.symbols.length) symbolsByPath[f.relPath] = f.symbols;
  }
  const payload = {
    ...graph,
    meta: { ...graph.meta, layersList: sortedLayers(graph.meta.stats.layers) },
  };
  const dataScript = `<script>window.__KG_DATA__ = ${sanitizeJson(payload)}; window.__KG_SYMBOLS__ = ${sanitizeJson(symbolsByPath)};<\/script>`;
  return html.replace('</body>', dataScript + '\n</body>');
}

/** JSON.stringify + escape sequences that would terminate a <script> block. */
function sanitizeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Fetch the D3 vendor bundle (only used with --inline-d3). */
export async function fetchD3Source(): Promise<string | null> {
  try {
    const res = await fetch(D3_CDN);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
