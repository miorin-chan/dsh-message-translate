/**
 * Client UI: one Translate icon in each message's native action row and an
 * inline translation card directly below that row.
 *
 * The user-row icon has no extension slot of its own, so the seat component
 * anchors a hidden marker in `conversation.chat.user.before`, finds the durable
 * Chat node through `data-chat-node-key`, and portals the icon into the native
 * action row after Copy. The assistant row exposes `conversation.chat.assistant-actions`,
 * where the icon renders inline. Both paths place the card in a host element
 * created after the row, so the result stays under the message instead of
 * inside the icon strip.
 *
 * DSH-internal shape (verified against 0.2.2-rc.5):
 * - `[data-chat-node-key]` wraps one Chat node and owns the user action row.
 * - The user action row is `[data-clock="start"]`; its first direct button is Copy.
 * - The assistant action row is likewise `[data-clock="end"]`.
 * Missing markers leave the page as shipped instead of throwing.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import {
  extractAssistantText, extractUserText, sameLanguage, translateText,
} from '../lib/translate.js'
import type { TranslationFailure } from '../lib/translate.js'
import type { LabelKey, namespace } from './labels.js'

/** Shared visual constants; theme tokens keep the plugin inside the host skin. */
export const STYLES = `
.dshmt-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dshmt-action svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
.dshmt-action[data-clock='end'] svg {
  width: calc(17px + var(--dsh-content-font-delta, 0px));
  height: calc(17px + var(--dsh-content-font-delta, 0px));
}
.dshmt-action[data-open] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
@media (hover: hover) {
  .dshmt-action:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.dshmt-action:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dshmt-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 2px 0 4px;
  padding: 10px 12px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.6;
}
.dshmt-host {
  box-sizing: border-box;
  width: 100%;
}
.dshmt-host-user {
  display: flex;
  justify-content: flex-end;
}
.dshmt-host-user > .dshmt-card {
  width: fit-content;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
}
.dshmt-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 16px;
}
.dshmt-brand {
  flex: none;
  font-weight: 500;
}
.dshmt-langs {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dshmt-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px -6px -4px 0;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dshmt-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dshmt-close:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dshmt-close svg {
  width: 14px;
  height: 14px;
}
.dshmt-body {
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dshmt-card[data-state='loading'] .dshmt-body {
  color: var(--dsw-alias-label-secondary);
}
.dshmt-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  color: var(--dsw-alias-label-secondary);
}
.dshmt-error-msg {
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.dshmt-dot {
  flex: none;
  margin-top: 5px;
}
`

/** Locale id and its Google target language, plus the host label to show. */
export interface TranslationSettings {
  readonly active: string
  readonly target: string
  readonly label: string
}

/** Business face injected by `apply`. */
export interface TranslationInjected {
  readonly translationTarget: () => TranslationSettings
}

type Locale = PropsLocale<typeof namespace>

type TranslationStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly text: string; readonly detected?: string }
  | { readonly kind: 'error'; readonly reason: TranslationFailure }

interface TranslationControl {
  readonly open: boolean
  readonly status: TranslationStatus
  readonly toggle: () => void
  readonly retry: () => void
  readonly close: () => void
}

/** Request lifecycle shared by the inline and portaled seats. */
function useTranslation(text: string, settings: TranslationSettings): TranslationControl {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<TranslationStatus>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const targetRef = useRef(settings.target)

  useEffect(() => () => { abortRef.current?.abort() }, [])

  // A locale switch retires the old result instead of relabeling it.
  useEffect(() => {
    if (targetRef.current === settings.target) return
    targetRef.current = settings.target
    abortRef.current?.abort()
    setStatus({ kind: 'idle' })
    setOpen(false)
  }, [settings.target])

  const run = (): void => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStatus({ kind: 'loading' })
    void translateText(text, settings.target, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        setStatus(result.detected === undefined
          ? { kind: 'done', text: result.text }
          : { kind: 'done', text: result.text, detected: result.detected })
      } else {
        setStatus({ kind: 'error', reason: result.reason })
      }
    })
  }

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (status.kind !== 'done' && status.kind !== 'loading') run()
  }

  return {
    open,
    status,
    toggle,
    retry: run,
    close: () => { setOpen(false) },
  }
}

/** Display name for a Google language code, in the active host language. */
function languageName(code: string | undefined, locale: string): string | undefined {
  if (code === undefined || code === '') return undefined
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function failureText(t: Locale['t'], reason: TranslationFailure): string {
  if (reason === 'network') return t('failedNetwork')
  if (reason === 'http') return t('failedHttp')
  return t('failedOther')
}

function TranslateGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 1.75V3.5" />
      <path d="M1.75 3.5H9.25" />
      <path d="M7.4 3.5C6.8 6.5 4.8 8.6 2 9.75" />
      <path d="M3.6 5.1C4.5 7 6.1 8.5 8.2 9.5" />
      <path d="M8.75 14.25L11.5 7.25L14.25 14.25" />
      <path d="M9.6 12.1H13.4" />
    </svg>
  )
}

function CloseGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

function TranslateButton({ t, open, busy, clock, cardId, buttonRef, onClick }: {
  readonly t: Locale['t']
  readonly open: boolean
  readonly busy: boolean
  readonly clock: 'start' | 'end'
  readonly cardId: string
  readonly buttonRef: RefObject<HTMLButtonElement>
  readonly onClick: () => void
}): ReactNode {
  const label = open ? t('close') : t('translate')
  return (
    <Tooltip label={label} side="bottom">
      <button
        ref={buttonRef}
        type="button"
        className="dshmt-action"
        data-clock={clock}
        data-open={open || undefined}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-busy={busy || undefined}
        onClick={onClick}
      >
        <TranslateGlyph />
      </button>
    </Tooltip>
  )
}

function TranslationCard({ t, id, status, settings, onClose, onRetry }: {
  readonly t: Locale['t']
  readonly id: string
  readonly status: TranslationStatus
  readonly settings: TranslationSettings
  readonly onClose: () => void
  readonly onRetry: () => void
}): ReactNode {
  const same = status.kind === 'done'
    && status.detected !== undefined
    && sameLanguage(status.detected, settings.target)
  const detected = status.kind === 'done' && !same
    ? languageName(status.detected, settings.active)
    : undefined
  const languages = detected === undefined
    ? (status.kind === 'done' && same ? settings.label : t('toTarget', { language: settings.label }))
    : t('sourceToTarget', { source: detected, target: settings.label })
  const body = status.kind === 'done'
    ? (same ? t('alreadyIn', { language: settings.label }) : status.text)
    : t('translating')
  return (
    <div className="dshmt-card" id={id} data-state={status.kind} data-dshmt-card="">
      <div className="dshmt-head">
        <span className="dshmt-brand">{t('google')}</span>
        <span className="dshmt-langs" title={languages}>{languages}</span>
        <Tooltip label={t('close')} side="bottom" align="end">
          <button type="button" className="dshmt-close" aria-label={t('close')} onClick={onClose}>
            <CloseGlyph />
          </button>
        </Tooltip>
      </div>
      {status.kind === 'error' ? (
        <div className="dshmt-error">
          <div className="dshmt-body dshmt-error-msg" role="status" aria-live="polite" aria-atomic="true">
            <StateDot state="error" className="dshmt-dot" />
            <span>{failureText(t, status.reason)}</span>
          </div>
          <Button size="sm" variant="outline" onClick={onRetry}>{t('retry')}</Button>
        </div>
      ) : (
        <div className="dshmt-body" role="status" aria-live="polite" aria-atomic="true">{body}</div>
      )}
    </div>
  )
}

/** Create the card seat after the message's action row. */
function useCardHost(anchor: () => HTMLElement | null): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const row = anchor()
    if (row === null) return
    const element = document.createElement('div')
    element.className = 'dshmt-host dshmt-host-assistant'
    row.after(element)
    setHost(element)
    return () => {
      element.remove()
      setHost(null)
    }
  }, [anchor])
  return host
}

export function AssistantTranslateAction(props: PropsRuntime<'conversation.chat.assistant-actions'> & Locale & TranslationInjected): ReactNode {
  const { messageId, useChat, t, translationTarget } = props
  const text = useChat(chat => assistantTextOf(chat, messageId))
  if (text === '') return null
  return <AssistantSeat text={text} settings={translationTarget()} t={t} />
}

function isAssistantStepNode(node: ChatConversationViewNode): node is ChatNode<'assistant-step'> {
  return node.kind === 'assistant-step'
}

function isUserMessageNode(node: ChatConversationViewNode | undefined): node is ChatNode<'user' | 'steering'> {
  return node !== undefined && (node.kind === 'user' || node.kind === 'steering')
}

function assistantTextOf(snapshot: ChatSnapshot, messageId: MessageId): string {
  for (const node of snapshot.nodes.values()) {
    if (!isAssistantStepNode(node)) continue
    if (node.data.finalNode?.messageId !== messageId) continue
    return extractAssistantText(node.data.blocks)
  }
  return ''
}

function AssistantSeat({ text, settings, t }: {
  readonly text: string
  readonly settings: TranslationSettings
  readonly t: Locale['t']
}): ReactNode {
  const buttonRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const control = useTranslation(text, settings)
  const cardId = useId()
  const retryRequested = useRef(false)
  const anchor = useRef(() => buttonRef.current?.closest<HTMLElement>('[data-clock="end"]') ?? null)
  const host = useCardHost(anchor.current)

  useEffect(() => {
    if (!retryRequested.current || !control.open || control.status.kind !== 'done') return
    retryRequested.current = false
    triggerRef.current?.focus()
  }, [control.open, control.status])

  const close = (): void => {
    control.close()
    triggerRef.current?.focus()
  }
  const retry = (): void => {
    retryRequested.current = true
    control.retry()
  }

  return (
    <>
      <span ref={buttonRef} style={{ display: 'contents' }}>
        <TranslateButton
          t={t}
          open={control.open}
          busy={control.status.kind === 'loading'}
          clock="end"
          cardId={cardId}
          buttonRef={triggerRef}
          onClick={control.toggle}
        />
      </span>
      {control.open && host !== null && createPortal(
        <TranslationCard t={t} id={cardId} status={control.status} settings={settings} onClose={close} onRetry={retry} />,
        host,
      )}
    </>
  )
}

export function UserTranslateSeat(props: PropsRuntime<'conversation.chat.user.before'> & Locale & TranslationInjected): ReactNode {
  const { useChat, t, translationTarget } = props
  const marker = useRef<HTMLSpanElement>(null)
  const [nodeKey, setNodeKey] = useState<string | null>(null)

  useLayoutEffect(() => {
    const key = marker.current?.closest('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? null
    setNodeKey(previous => (previous === key ? previous : key))
  }, [])

  const node = useChat(chat => (nodeKey === null ? undefined : chat.nodes.get(nodeKey)))
  const text = isUserMessageNode(node) ? extractUserText(node.data.content) : ''

  return (
    <>
      <span hidden ref={marker} />
      {text !== '' && <UserSeat key={nodeKey} marker={marker} text={text} settings={translationTarget()} t={t} />}
    </>
  )
}

function UserSeat({ marker, text, settings, t }: {
  readonly marker: RefObject<HTMLSpanElement | null>
  readonly text: string
  readonly settings: TranslationSettings
  readonly t: Locale['t']
}): ReactNode {
  const [seats, setSeats] = useState<{ readonly button: HTMLElement; readonly card: HTMLElement } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const control = useTranslation(text, settings)
  const cardId = useId()
  const retryRequested = useRef(false)

  useLayoutEffect(() => {
    const row = marker.current?.closest('[data-chat-node-key]')?.querySelector<HTMLElement>('[data-clock="start"]')
    if (row === null || row === undefined) return
    // DSH 0.2.2-rc.5: MessageIconActions renders the user Copy button first.
    const copy = row.querySelector<HTMLButtonElement>(':scope > button')
    const buttonHost = document.createElement('span')
    buttonHost.style.display = 'contents'
    if (copy === null) row.append(buttonHost)
    else copy.after(buttonHost)
    const cardHost = document.createElement('div')
    cardHost.className = 'dshmt-host dshmt-host-user'
    row.after(cardHost)
    setSeats({ button: buttonHost, card: cardHost })
    return () => {
      buttonHost.remove()
      cardHost.remove()
      setSeats(null)
    }
  }, [marker])

  useEffect(() => {
    if (!retryRequested.current || !control.open || control.status.kind !== 'done') return
    retryRequested.current = false
    triggerRef.current?.focus()
  }, [control.open, control.status])

  const close = (): void => {
    control.close()
    triggerRef.current?.focus()
  }
  const retry = (): void => {
    retryRequested.current = true
    control.retry()
  }

  if (seats === null) return null
  return (
    <>
      {createPortal(
        <TranslateButton
          t={t}
          open={control.open}
          busy={control.status.kind === 'loading'}
          clock="start"
          cardId={cardId}
          buttonRef={triggerRef}
          onClick={control.toggle}
        />,
        seats.button,
      )}
      {control.open && createPortal(
        <TranslationCard t={t} id={cardId} status={control.status} settings={settings} onClose={close} onRetry={retry} />,
        seats.card,
      )}
    </>
  )
}

/** Test seam for the pure pieces; the bundle's UI is exercised in the real page. */
export const __test = {
  assistantTextOf,
  languageName,
}
