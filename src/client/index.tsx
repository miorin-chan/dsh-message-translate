/**
 * Browser half of `dsh-message-translate`.
 *
 * Adds one Translate icon to the native action row under every user and
 * assistant message. Clicking it asks the unofficial Google Translate endpoint
 * for a translation into the current DSH interface language and shows the
 * result in an inline card directly below that row. The button's label and the
 * card chrome follow the active interface locale; the translation itself is
 * the target language, not the interface language.
 *
 * The bundle is Client-only: the Host half is inert and the Web module loader
 * activates this file through `dsh.client`. Registering both slots inside one
 * `ctx.effect` means disabling the bundle removes the buttons, the card hosts,
 * the stylesheet, and the locale dictionaries together.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { targetLanguageOf } from '../lib/translate.js'
import { labels, namespace } from './labels.js'
import { AssistantTranslateAction, STYLES, UserTranslateSeat } from './ui.js'
import type { TranslationSettings } from './ui.js'

/** Services this Client half needs before `apply` runs. */
export const inject = ['slots', 'locale']

/** Read the host language and the Google target it maps to. */
function translationSettings(ctx: Context): TranslationSettings {
  const snapshot = ctx.locale.getSnapshot()
  const active = snapshot.active
  const label = snapshot.locales.find(locale => locale.id === active)?.label ?? active
  return { active, target: targetLanguageOf(active), label }
}

/**
 * Register the stylesheet, locale dictionary, and the two message actions.
 * @param ctx - Client context carrying the `slots` and `locale` services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, labels), 'dsh-message-translate: locale')

  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset.plugin = namespace
    element.textContent = STYLES
    document.head.appendChild(element)
    return () => element.remove()
  }, 'dsh-message-translate: styles')

  ctx.effect(() => {
    const translationTarget = (): TranslationSettings => translationSettings(ctx)
    const assistant = ctx.slots.inject('conversation.chat.assistant-actions', () =>
      ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: namespace,
        order: 20,
        locale: namespace,
        inject: () => ({ translationTarget }),
      }, AssistantTranslateAction))
    const user = ctx.slots.inject('conversation.chat.user.before', () =>
      ctx.slots.register({
        name: 'conversation.chat.user.before',
        locale: namespace,
        priority: 100,
        select: owner => (owner.kind === 'user' || owner.kind === 'steering' ? true : null),
        inject: () => ({ translationTarget }),
      }, UserTranslateSeat))
    return () => {
      assistant()
      user()
    }
  }, 'dsh-message-translate: message actions')
}

/** Test seam for the pure pieces. */
export { __test } from './ui.js'
