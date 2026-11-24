/**
 * Pure translation helpers for the Client half: message text extraction,
 * request chunking, Google response parsing, and language selection.
 *
 * The unofficial Google Translate endpoint is queried from the browser, so it
 * must answer with permissive CORS. It does (`access-control-allow-origin: *`)
 * and accepts a form-encoded POST, which keeps long messages out of the URL.
 * Everything here is runtime-free so the tests can exercise it directly.
 */

/** Public Google Translate endpoint used by the built-in translate widgets. */
export const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'

/**
 * Per-request character budget. A POST body allows far more than a URL, but
 * smaller chunks keep the parser stable and let a failure preserve the rest.
 */
export const MAX_CHUNK_LENGTH = 2800

/** Languages Google accepts in `tl`; locale ids are normalized to these. */
const TARGET_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/

/** Structured failure so the UI never has to interpret an exception. */
export type TranslationFailure = 'aborted' | 'empty' | 'http' | 'invalid-target' | 'network' | 'parse'

export type TranslationResult =
  | { readonly ok: true; readonly text: string; readonly detected?: string }
  | { readonly ok: false; readonly reason: TranslationFailure }

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TranslateOptions {
  /** Cancels the request; an aborted result is not an error the UI reports. */
  readonly signal?: AbortSignal
  /** Injection point for tests; defaults to the browser fetch. */
  readonly fetchImpl?: FetchLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Text blocks of a user message, in order, without attachment placeholders. */
export function extractUserText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** Answer text of an assistant step; reasoning and tool calls are not prose. */
export function extractAssistantText(blocks: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (isRecord(block) && block.kind === 'text' && typeof block.text === 'string') {
      const text = block.text.trim()
      if (text !== '') parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/**
 * Split text into request-sized chunks, preferring line boundaries so a
 * multi-line message keeps its shape. A single long line is cut at the budget.
 * @param text - message text to translate.
 * @param limit - maximum characters per chunk.
 * @returns chunks in original order; an empty result when there is no text.
 */
export function splitForTranslation(text: string, limit = MAX_CHUNK_LENGTH): readonly string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized === '') return []
  if (normalized.length <= limit) return [normalized]

  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  const flush = (): void => {
    if (current.length === 0) return
    chunks.push(current.join('\n'))
    current = []
    size = 0
  }

  for (const line of normalized.split('\n')) {
    if (line.length > limit) {
      flush()
      for (let index = 0; index < line.length; index += limit) chunks.push(line.slice(index, index + limit))
      continue
    }
    const addition = current.length === 0 ? line.length : line.length + 1
    if (size + addition > limit) flush()
    current.push(line)
    size += current.length === 1 ? line.length : line.length + 1
  }
  flush()
  return chunks
}

/** Read the translated segments and detected language out of Google's reply. */
export function parseGoogleTranslateResponse(value: unknown): { text: string; detected?: string } | undefined {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return undefined
  const segments: unknown[] = value[0]
  let text = ''
  for (const segment of segments) {
    if (!Array.isArray(segment)) continue
    const translated = segment[0]
    if (typeof translated === 'string') text += translated
  }
  if (text === '') return undefined
  const rawDetected = value[2]
  const detected = typeof rawDetected === 'string' && rawDetected !== '' ? rawDetected : undefined
  return detected === undefined ? { text } : { text, detected }
}

/**
 * Normalize a DSH locale id to a Google target language. Chinese splits into
 * simplified and traditional by its region or script subtag.
 */
export function targetLanguageOf(locale: string): string {
  const normalized = locale.trim().replace(/_/g, '-')
  const [rawLanguage = '', ...subtags] = normalized.split('-')
  const language = rawLanguage.toLowerCase()
  if (language === '') return 'en'
  if (language === 'zh') {
    const rest = subtags.join('-').toLowerCase()
    return rest.includes('tw') || rest.includes('hk') || rest.includes('hant') ? 'zh-TW' : 'zh-CN'
  }
  return language.length <= 3 && TARGET_LANGUAGE.test(language) ? language : 'en'
}


/** Whether Google's detected language already maps to the requested target. */
export function sameLanguage(detected: string, target: string): boolean {
  return targetLanguageOf(detected) === targetLanguageOf(target)
}

/** Whether a candidate target is a plain Google language code this module can send. */
export function isTargetLanguage(value: string): boolean {
  return TARGET_LANGUAGE.test(value)
}

/**
 * Translate text into one target language, chunk by chunk.
 * @param text - message text.
 * @param target - Google language code.
 * @param options - abort signal and fetch injection.
 * @returns translated text together with the language Google detected.
 */
export async function translateText(
  text: string,
  target: string,
  options: TranslateOptions = {},
): Promise<TranslationResult> {
  const chunks = splitForTranslation(text)
  if (chunks.length === 0) return { ok: false, reason: 'empty' }
  if (!isTargetLanguage(target)) return { ok: false, reason: 'invalid-target' }

  const fetchImpl: FetchLike = options.fetchImpl ?? fetch
  const translated: string[] = []
  let detected: string | undefined

  for (const chunk of chunks) {
    let response: Response
    try {
      response = await fetchImpl(
        `${GOOGLE_TRANSLATE_ENDPOINT}?${new URLSearchParams({ client: 'gtx', sl: 'auto', tl: target, dt: 't' })}`,
        {
          method: 'POST',
          body: new URLSearchParams({ q: chunk }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      )
    } catch {
      return options.signal?.aborted === true
        ? { ok: false, reason: 'aborted' }
        : { ok: false, reason: 'network' }
    }

    if (!response.ok) return { ok: false, reason: 'http' }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { ok: false, reason: 'parse' }
    }

    const parsed = parseGoogleTranslateResponse(payload)
    if (parsed === undefined) return { ok: false, reason: 'parse' }
    translated.push(parsed.text)
    if (detected === undefined) detected = parsed.detected
  }

  return detected === undefined
    ? { ok: true, text: translated.join('\n') }
    : { ok: true, text: translated.join('\n'), detected }
}
