/**
 * InkStone OpenAI-compatible chat client
 * ======================================
 * Minimal fetch-based client for Intern InkStone
 * (base https://discovery-api.intern-ai.org.cn/v1, POST /chat/completions).
 * No SDK dependency: Node >= 18 ships global fetch, which keeps the tool
 * 100% native-binding free (Win7 0xc0000005 safe).
 */
import { AppConfig } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMError extends Error {
  status?: number;
  body?: string;
  retryable: boolean;
}

function llmError(message: string, status?: number, body?: string): LLMError {
  const e = new Error(message) as LLMError;
  e.status = status;
  e.body = body;
  // 429 / 5xx are transient; 4xx (bad key, bad model) are not
  e.retryable = status === undefined ? true : status === 429 || status >= 500;
  return e;
}

export interface ChatResult {
  content: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
  raw?: unknown;
}

export class InkStoneClient {
  constructor(private cfg: AppConfig) {}

  get baseURL(): string {
    return this.cfg.baseURL.replace(/\/+$/, '');
  }

  /**
   * Send a chat completion with exponential-backoff retries.
   * @throws LLMError
   */
  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<ChatResult> {
    const url = this.baseURL + '/chat/completions';
    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 180,
      stream: false,
    });

    const attempts = 4;
    let lastErr: LLMError | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + this.cfg.apiKey,
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = llmError(
            `InkStone HTTP ${res.status}: ${truncate(text, 300)}`,
            res.status,
            text,
          );
          if (!err.retryable || attempt === attempts - 1) throw err;
          lastErr = err;
        } else {
          const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const content = json.choices?.[0]?.message?.content ?? '';
          if (!content) {
            throw llmError('InkStone returned an empty completion', 200, JSON.stringify(json).slice(0, 300));
          }
          return {
            content: content.trim(),
            finishReason: json.choices?.[0]?.finish_reason,
            usage: {
              promptTokens: json.usage?.prompt_tokens,
              completionTokens: json.usage?.completion_tokens,
              totalTokens: json.usage?.total_tokens,
            },
            raw: json,
          };
        }
      } catch (e) {
        const err = e as LLMError;
        if (err.retryable === false) throw err;
        if (err.status === undefined && err.name === 'AbortError') {
          (err as LLMError).retryable = true;
        }
        lastErr = err.status === undefined ? llmError('Network error: ' + err.message) : err;
        if (attempt === attempts - 1) throw lastErr;
      } finally {
        clearTimeout(timer);
      }
      // exponential backoff with jitter: 1.5s, 3s, 6s (+ random up to 50%)
      const backoff = 1500 * Math.pow(2, attempt) * (0.5 + Math.random());
      await sleep(Math.min(backoff, 15000));
    }
    throw lastErr ?? llmError('InkStone request failed after retries');
  }
}

const REQUEST_TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
