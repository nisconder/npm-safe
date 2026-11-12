import { LlmProviderError } from './parse.js';
import type { LlmSourceReviewInput } from './provider.js';

export const SOURCE_PROMPT_BYTES = 512 * 1024;
export const SOURCE_RESPONSE_BYTES = 256 * 1024;
const SOURCE_HTTP_RESPONSE_BYTES = 1024 * 1024;

export function assertSourceResponse(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > SOURCE_RESPONSE_BYTES) {
    throw new LlmProviderError('Source-review response exceeds the byte budget.');
  }
}

/** Do not let a direct provider caller bypass the source coordinator's budget. */
export function assertSourcePrompt(input: LlmSourceReviewInput): void {
  input.signal?.throwIfAborted();
  if (Buffer.byteLength(input.systemPrompt, 'utf8') + Buffer.byteLength(input.prompt, 'utf8') > SOURCE_PROMPT_BYTES) {
    throw new LlmProviderError('Source-review prompt exceeds the byte budget.');
  }
}

/** Bound the HTTP envelope before JSON parsing, including a streaming response. */
export async function readSourceResponse(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > SOURCE_HTTP_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new LlmProviderError('Source-review response exceeds the byte budget.');
  }
  if (!response.body) throw new LlmProviderError('Source-review response contained no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SOURCE_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LlmProviderError('Source-review response exceeds the byte budget.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch {
    throw new LlmProviderError('Source-review HTTP response was not valid JSON.');
  }
}
