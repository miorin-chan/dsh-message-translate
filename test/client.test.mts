import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractAssistantText,
  extractUserText,
  isTargetLanguage,
  parseGoogleTranslateResponse,
  sameLanguage,
  splitForTranslation,
  targetLanguageOf,
  translateText,
} from '../src/lib/translate.ts'

/** Capture the module registration the browser module loader would receive. */
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry
    },
  },
}
await import('../client.js')

assert.equal(registration.id, '@miorin/dsh-message-translate')

/** Minimal React and platform modules the bundle factory requires. */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (current) => ({ current }),
  useState: (initial) => [initial, () => {}],
}
const jsx = (type, props) => react.createElement(type, props)
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const reactDom = { createPortal: (node) => node }
const primitives = {
  Button: (props) => react.createElement('button', props),
  Tooltip: ({ children }) => children,
}
const plugin = registration.factory((name) => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === 'react-dom') return reactDom
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require(${name})`)
})

/** A minimal host: recorded effects, a locale service, a slot registry, and a document. */
function fakeContext() {
  const effects = []
  const locales = new Map()
  const slots = new Map()
  const styles = []
  const document = {
    createElement: (tag) => ({
      tag,
      dataset: {},
      textContent: '',
      removed: false,
      remove() { this.removed = true },
    }),
    head: { appendChild: (element) => { styles.push(element) } },
  }
  const ctx = {
    effect(install, label) {
      const dispose = install()
      effects.push({ label, dispose })
      return dispose
    },
    locale: {
      register(namespace, labels) {
        locales.set(namespace, labels)
        return () => { locales.delete(namespace) }
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(typeof name, 'string')
        return callback()
      },
      register(options, component) {
        assert.equal(typeof component, 'function')
        slots.set(options.name, options)
        return () => { slots.delete(options.name) }
      },
    },
  }
  return { ctx, effects, locales, slots, styles, document }
}

test('declares the services it injects', () => {
  assert.ok(Array.isArray(plugin.inject))
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'])
})

test('registers both message actions and releases them on unload', () => {
  const { ctx, effects, locales, slots, styles, document } = fakeContext()
  const previousDocument = globalThis.document
  globalThis.document = document
  try {
    plugin.apply(ctx)

    assert.ok(locales.has('dsh-message-translate'), 'locale labels are registered')
    assert.equal(Object.keys(locales.get('dsh-message-translate')).length, 8)
    assert.equal(styles.length, 1, 'one stylesheet is attached')
    assert.ok(slots.has('conversation.chat.assistant-actions'))
    assert.ok(slots.has('conversation.chat.user.before'))

    const assistant = slots.get('conversation.chat.assistant-actions')
    assert.equal(assistant.id, 'dsh-message-translate')
    assert.equal(assistant.locale, 'dsh-message-translate')

    const user = slots.get('conversation.chat.user.before')
    assert.equal(user.priority, 100)
    assert.equal(user.select({ kind: 'user' }), true)
    assert.equal(user.select({ kind: 'steering' }), true)
    assert.equal(user.select({ kind: 'assistant' }), null)

    for (const effect of effects) effect.dispose()
    assert.equal(locales.size, 0, 'disposing removes the locale namespace')
    assert.equal(slots.size, 0, 'disposing removes both slot entries')
    assert.equal(styles[0].removed, true, 'disposing removes the stylesheet')
  } finally {
    globalThis.document = previousDocument
  }
})

test('normalizes interface locales to Google targets', () => {
  assert.equal(targetLanguageOf('zh'), 'zh-CN')
  assert.equal(targetLanguageOf('zh-TW'), 'zh-TW')
  assert.equal(targetLanguageOf('zh_HK'), 'zh-TW')
  assert.equal(targetLanguageOf('zh-Hant'), 'zh-TW')
  assert.equal(targetLanguageOf('en'), 'en')
  assert.equal(targetLanguageOf('ja-JP'), 'ja')
  assert.equal(targetLanguageOf(''), 'en')
  assert.equal(targetLanguageOf('english'), 'en')
  assert.equal(isTargetLanguage('zh-CN'), true)
  assert.equal(isTargetLanguage('zh-CN<script>'), false)
})

test('detects when the source already matches the target language', () => {
  assert.equal(sameLanguage('en', 'en'), true)
  assert.equal(sameLanguage('en-US', 'en'), true)
  assert.equal(sameLanguage('zh', 'zh-CN'), true)
  assert.equal(sameLanguage('zh-CN', 'zh-TW'), false)
  assert.equal(sameLanguage('fr', 'en'), false)
})

test('extracts only prose from user and assistant messages', () => {
  assert.equal(extractUserText([
    { type: 'text', text: '第一段' },
    { type: 'image', attachment: { attachmentId: 'a' } },
    { type: 'text', text: '\n第二段' },
  ]), '第一段\n第二段')
  assert.equal(extractUserText([{ type: 'image' }]), '')

  assert.equal(extractAssistantText([
    { kind: 'reasoning', text: 'thinking' },
    { kind: 'text', text: 'Hello' },
    { kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: '{}' },
    { kind: 'text', text: 'World ' },
  ]), 'Hello\n\nWorld')
  assert.equal(extractAssistantText([{ kind: 'text', text: '   ' }]), '')
})

test('splits long text on line boundaries and hard-cuts long lines', () => {
  assert.deepEqual(splitForTranslation(''), [])
  assert.deepEqual(splitForTranslation('  hi  '), ['hi'])
  assert.deepEqual(splitForTranslation('a\nb', 10), ['a\nb'])
  assert.deepEqual(splitForTranslation('aaaa\nbbbb', 5), ['aaaa', 'bbbb'])
  assert.deepEqual(splitForTranslation('abcdef', 3), ['abc', 'def'])
})

test('reads translated segments and the detected language', () => {
  assert.deepEqual(parseGoogleTranslateResponse([
    [['你好', 'Hello', null, null, 10], ['世界', 'world', null, null, 10]],
    null,
    'en',
  ]), { text: '你好世界', detected: 'en' })
  assert.deepEqual(parseGoogleTranslateResponse([[['你好', 'Hello']]]), { text: '你好' })
  assert.equal(parseGoogleTranslateResponse([[['', 'x']]]), undefined)
  assert.equal(parseGoogleTranslateResponse(null), undefined)
  assert.equal(parseGoogleTranslateResponse([[]]), undefined)
  assert.equal(parseGoogleTranslateResponse([['not a segment']]), undefined)
})

test('posts each chunk to Google Translate and joins the results', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify([[['译文', 'text', null, null, 10]], null, 'en']), { status: 200 })
  }
  const result = await translateText('Hello', 'zh-CN', { fetchImpl })
  assert.deepEqual(result, { ok: true, text: '译文', detected: 'en' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /client=gtx/)
  assert.match(calls[0].url, /tl=zh-CN/)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(new URLSearchParams(calls[0].init.body).get('q'), 'Hello')

  const long = `${'a'.repeat(2000)}\n${'b'.repeat(2000)}`
  const longResult = await translateText(long, 'zh-CN', { fetchImpl })
  assert.equal(calls.length, 3, 'two chunks in this call followed one request before it')
  assert.deepEqual(longResult, { ok: true, text: '译文\n译文', detected: 'en' })
})

test('reports request and parsing failures without throwing', async () => {
  assert.deepEqual(await translateText('', 'zh-CN', { fetchImpl: async () => { throw new Error('unused') } }), { ok: false, reason: 'empty' })
  assert.deepEqual(await translateText('hi', 'zh-CN<script>', { fetchImpl: async () => { throw new Error('unused') } }), { ok: false, reason: 'invalid-target' })
  assert.deepEqual(await translateText('hi', 'en', { fetchImpl: async () => { throw new Error('offline') } }), { ok: false, reason: 'network' })
  assert.deepEqual(await translateText('hi', 'en', { fetchImpl: async () => new Response('nope', { status: 500 }) }), { ok: false, reason: 'http' })
  assert.deepEqual(await translateText('hi', 'en', { fetchImpl: async () => new Response('not json', { status: 200 }) }), { ok: false, reason: 'parse' })
  assert.deepEqual(await translateText('hi', 'en', { fetchImpl: async () => new Response('[[],null,"en"]', { status: 200 }) }), { ok: false, reason: 'parse' })

  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await translateText('hi', 'en', {
    signal: controller.signal,
    fetchImpl: async () => { throw new Error('aborted') },
  }), { ok: false, reason: 'aborted' })

  assert.deepEqual(await translateText('hi', 'en', {
    timeoutMs: 10,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
    }),
  }), { ok: false, reason: 'network' })
})
