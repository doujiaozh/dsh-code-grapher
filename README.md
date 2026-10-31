# dsh-code-grapher

A **code knowledge graph generator** for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) — an "Understand Anything" style plugin toolset that scans a local codebase, extracts lightweight structure (no native bindings), summarizes every file with an LLM, and emits a **single interactive HTML graph** you can open in any browser.

```
┌─────────┐   ┌─────────┐   ┌───────────┐   ┌──────────┐
│ cg_scan │ → │ cg_parse│ → │ cg_analyze│ → │ cg_render│ →  knowledge-graph.json
│ files   │   │ symbols │   │ LLM batch │   │ D3 graph │ →  index.html (standalone)
└─────────┘   └─────────┘   └───────────┘   └──────────┘
```

## Features

- **cg_scan** — walks a repo, detects JS/TS/JSX/TSX/Python (plus JSON/Markdown/config), skips `node_modules`, `.git`, `dist`, `__pycache__`, `.venv` and 30+ other noise dirs; groups files into modules.
- **cg_parse** — regex + hand-rolled state-machine extraction of imports, exports, functions, classes and methods from a comment/string-stripped source view. **Zero native dependencies**: no tree-sitter, no esbuild, no rollup.
- **cg_analyze** — batches files through the **Intern InkStone** OpenAI-compatible API (`deepseek-v4.1-flash-1017` by default) to produce one-line summaries plus **layer** (Entry/Controller/Service/Data/UI/Util/Config/Test/Asset) and **domain** tags. Includes a sliding-window rate limiter (RPM cap), bounded worker pool, exponential backoff retries, checkpoint/resume, and heuristic fallback when a batch fails.
- **cg_render** — assembles `knowledge-graph.json` (modules → files → external packages, import + containment edges) and a self-contained `index.html` with a D3.js force-directed graph: drag, zoom, click-to-inspect (symbols, summary, layer), module clustering with convex hulls, layer/language filters, `/` search, `?` help.

## Install

Requires **Node.js ≥ 18** (uses global `fetch`). Works on Windows 7 — the toolchain is 100% pure JS/TypeScript (see *Win7 notes* below).

```bash
git clone <this-repo> dsh-code-grapher
cd dsh-code-grapher
npm install            # only typescript + @types/node, no native modules
npm run build          # tsc -p tsconfig.json  (uses the pure-JS tsc)
```

Then either put `dist/cli.js` behind a `cg` bin (`npm link`), or call it directly:

```bash
node dist/cli.js <subcommand> [flags]
# cg scan | cg parse | cg analyze | cg render | cg graph | version | help
```

`graph` runs the full pipeline (scan → parse → analyze → render) in one shot.

## Configure the LLM (Intern InkStone)

All LLM settings resolve as **CLI flag > env var > `.env` file > default**. Copy `.env.example` to `.env` and fill in:

```ini
INKSTONE_BASE_URL=https://discovery-api.intern-ai.org.cn/v1
INKSTONE_API_KEY=sk-...                # your InkStone key
INKSTONE_MODEL=deepseek-v4.1-flash-1017
```

Or export them in your shell:

```powershell
$env:INKSTONE_API_KEY = "sk-..."
node dist/cli.js graph ./my-project
```

```bash
export INKSTONE_API_KEY="sk-..."
node dist/cli.js graph ./my-project
```

### Rate limiting & quota (important for the free tier)

- InkStone free tier is **50 RPM**. The sliding-window limiter is hard-capped to never exceed it; default is `CG_RPM=45`.
- Free **channels also cap completion tokens per request**. If you see `HTTP 429 quota exceeded` / `Channel rate limit reached for model`, lower the completion budget and batch size:

```bash
export CG_MAX_TOKENS=150      # max_tokens sent per request (default 180, paid plans can go higher)
export CG_BATCH_SIZE=3        # files per LLM request (default 6)
export CG_WORKERS=2           # parallel in-flight requests (default 4)
node dist/cli.js graph ./my-project --limit 20
```

Failed batches are retried with exponential backoff; if a batch still fails, those files fall back to **heuristic** summaries (marked `synthetic`) so the graph always renders. Per-batch checkpoints in `.cg-cache/analyze-checkpoint.json` mean an interrupted run **resumes** instead of re-paying for analyzed files (`--force` disables the cache).

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--out <dir>` | `.code-graph` | output directory |
| `--ignore <glob>` | — | extra ignore patterns (repeatable, e.g. `--ignore "tests/**"`) |
| `--max-files <n>` | `20000` | hard cap on scanned files (OOM guard) |
| `--lang <list>` | all | comma list, e.g. `--lang ts,py` |
| `--depth <n>` | unlimited | max directory depth |
| `--model <id>` | cfg | override `INKSTONE_MODEL` |
| `--base-url <url>` | cfg | override `INKSTONE_BASE_URL` |
| `--api-key <key>` | cfg | override `INKSTONE_API_KEY` |
| `--rpm <n>` | 45 | requests per minute cap |
| `--workers <n>` | 4 | parallel LLM requests |
| `--batch <n>` | 6 | files per LLM request |
| `--max-tokens <n>` | 180 | completion token budget per request |
| `--limit <n>` | all | only analyze first *n* files (smoke tests) |
| `--force` | — | ignore analysis checkpoint cache |
| `--dry-run` | — | heuristics only, no LLM calls, no API key needed |
| `--inline-d3` | — | embed D3.js source into the HTML (fully offline) |
| `--open` | — | open `index.html` when done |

## Avoiding memory blowups on large projects

The scanner and parser are streaming-ish and bounded, but huge monorepos can still hurt. The knobs, in order of effectiveness:

1. **`--max-files`** (default `20000`) — the walk stops and flags `truncated: true`; falling back to a bounded file set is the single biggest memory guard.
2. **`--ignore`** for giant generated dirs — anything you skip is never read, parsed, or embedded.
3. **`--lang ts`** — restrict languages; non-code files are only listed, but limiting still shrinks the graph.
4. **`CG_CONTEXT_CHARS`** (default `4000`, max `20000`) — source snippet size **per file** sent to the LLM. This drives request payload size, not local RAM, but keeps prompts (and quota burn) small.
5. **`--depth`** — cap directory depth for shallow first passes.
6. **`--batch` / `--workers`** — smaller batches and fewer workers bound peak memory of in-flight requests.
7. Files above `512 KB` are skipped as assets, and parse input is truncated at `256 KB` — a single pathological file can never dominate.
8. Analysis is **checkpointed per batch** (`.cg-cache/`), so `Ctrl-C` and re-run continue where you stopped instead of reloading everything.

For a first look at an unknown repo, a good combo is:

```bash
node dist/cli.js graph ./big-repo --max-files 4000 --batch 4 --workers 2 --limit 200
```

## Output

```
.code-graph/
  scan.json              # file inventory, modules, language stats
  knowledge-graph.json   # nodes (module/file/external) + edges (contains/imports) + stats
  index.html             # standalone interactive D3 graph (fetches D3 from CDN unless --inline-d3)
.cg-cache/
  analyze-checkpoint.json  # resume state
```

Open `index.html` directly — no server needed. With `--inline-d3` it also works with no network.

## Win7 / zero-native-dependency notes

This project was built on a **Windows 7, 8 GB RAM** host where native `.node` binaries (and Go-compiled `tsc`) crash with `0xc0000005`. Everything here avoids that:

- TypeScript compile runs via the **pure-JS** compiler: `node node_modules/typescript/bin/tsc -p tsconfig.json` (do **not** use a global `tsc` — some distributions ship a native binary).
- Parsing uses a hand-written state machine + regex — **no tree-sitter, no esbuild, no rollup**. (Set `--max-files` lower if you need to trade coverage for RAM.)
- HTTP uses Node's built-in `fetch` — no axios. No dotenv either (`.env` is parsed by ~20 lines of code).

## Development

```bash
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
npm run dev        # tsc --watch
node dist/cli.js graph . --dry-run --max-files 300   # no-LLM smoke test of the whole pipeline
```

## License

MIT
