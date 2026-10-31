/**
 * dsh-code-grapher — configuration resolution
 * ===========================================
 * Resolves CLI flags > process env > .env file > built-in defaults.
 * The LLM provider is Intern InkStone (OpenAI-compatible), same provider
 * the DSH harness itself uses (see ~/.dsh/profiles/desktop/cordis.patch.yml).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  /** OpenAI-compatible base URL, default https://discovery-api.intern-ai.org.cn/v1 */
  baseURL: string;
  /** API key (env INKSTONE_API_KEY). */
  apiKey: string;
  /** Model id, default deepseek-v4.1-flash-1017. */
  model: string;
  /** Requests per minute cap. InkStone free tier = 50, we default to 45. */
  rpm: number;
  /** Parallel crew workers. */
  workers: number;
  /** Files per LLM batch request. */
  batchSize: number;
  /** Source context chars sent per file. */
  contextChars: number;
  /**
   * Completion token budget per LLM request. Free InkStone channels may cap
   * this very low (observed: requests with max_tokens >= 200 rejected with
   * HTTP 429 "Channel rate limit reached for model"), so the default is
   * conservative; raise it for paid channels.
   */
  maxTokens: number;
}

export const DEFAULTS = {
  baseURL: 'https://discovery-api.intern-ai.org.cn/v1',
  model: 'deepseek-v4.1-flash-1017',
  rpm: 45,
  workers: 4,
  batchSize: 6,
  contextChars: 4000,
  maxTokens: 180,
} as const;

/** Minimal .env loader (no dotenv dependency — zero native deps). */
export function loadDotEnv(dir: string = process.cwd()): void {
  const envPath = path.join(dir, '.env');
  let text: string;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // no .env: fine, env vars may already exist
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Resolve config with explicit CLI overrides winning over env/defaults. */
export function resolveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  // NOTE: string fields use || not ?? so an empty string (CLI flag passed as
  // "--base-url ''" or an empty .env value) falls through to env/default
  // instead of silently wiping the endpoint URL.
  return {
    baseURL: overrides.baseURL || process.env.INKSTONE_BASE_URL || DEFAULTS.baseURL,
    apiKey: overrides.apiKey || process.env.INKSTONE_API_KEY || '',
    model: overrides.model || process.env.INKSTONE_MODEL || DEFAULTS.model,
    rpm: overrides.rpm ?? num('CG_RPM', DEFAULTS.rpm, 1, 60),
    workers: overrides.workers ?? num('CG_WORKERS', DEFAULTS.workers, 1, 16),
    batchSize: overrides.batchSize ?? num('CG_BATCH_SIZE', DEFAULTS.batchSize, 1, 20),
    contextChars:
      overrides.contextChars ?? num('CG_CONTEXT_CHARS', DEFAULTS.contextChars, 200, 20000),
    maxTokens: overrides.maxTokens ?? num('CG_MAX_TOKENS', DEFAULTS.maxTokens, 32, 8192),
  };
}

/**
 * Resolve config with rpm/platform guards applied. Separated from
 * resolveConfig so callers can inspect raw values in error messages.
 */
export function resolveConfigGuarded(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg = resolveConfig(overrides);
  // InkStone hard ceiling: free tier is 50 RPM, never allow more.
  cfg.rpm = Math.min(cfg.rpm, 50);
  return cfg;
}
