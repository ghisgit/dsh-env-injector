/**
 * dsh-env-injector — browser half.
 *
 * The host half registers the `env-injector` settings namespace; this half is
 * what makes that namespace configurable in the Web UI. The **Settings →
 * Plugins → Plugin configuration** tab dispatches `settings.plugin.item` by
 * settings namespace — it renders the intersection of the namespaces the Host
 * serves and the cards registered under that key — so a namespace whose owner
 * ships no card renders nothing at all. This module is that card's owner:
 *
 * 1. it registers the card's own locale namespace, so the section can render
 *    its copy in the reader's language;
 * 2. it binds the `env-injector` settings scope (the browser half of the same
 *    seam the host plugin registered) and hands the scope to a controller that
 *    stages edits;
 * 3. it registers one card into `settings.plugin.item` under key
 *    `env-injector` — the key is the pairing device, so the tab never has to
 *    learn what the namespace means.
 *
 * The card writes nothing until a user saves, and every write goes through the
 * client settings scope, which is the user layer of `$DSH_HOME/settings.yaml`.
 * The host plugin's own schema and `validate` hook stay authoritative: a write
 * it refuses surfaces in the card as a failed save with the drafts kept.
 *
 * @module dsh-env-injector/client
 */

import type { Context } from '@deepseek-ai/cordis'
/* Type-only: the `settings.plugin.item` slot is declared by the surface that
 * dispatches it (`settings.plugin.item` → keyed on the settings namespace), and
 * loading its contract is what keeps this registration type-checked against the
 * owner's declaration instead of a copy of it. */
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
/* Type-only: `ctx.settingsScope`, the browser half of the settings transport.
 * It registers no runtime import here — the service arrives through `inject`. */
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
/* Type-only: `ctx.slots`, the renderer-owned slot registry this card registers
 * into (the service itself arrives through `inject`). */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/* Type-only: `ctx.locale`, whose dictionaries this card registers. */
import type {} from '@deepseek-ai/dsh-client-locale/client'

import { EnvInjectorCard } from './card.tsx'
import type { EnvInjectorSection } from './contracts.ts'
import { EnvInjectorCardController } from './controller.ts'
import { NS, en, zh } from './locales.ts'

/**
 * Services this browser plugin needs before it can apply: the slot registry it
 * registers into, the locale service its copy lives in, and the settings scope
 * binder that reaches the `env-injector` namespace.
 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the card.
 *
 * Every registration here is an effect on this plugin's fiber, so unloading the
 * browser plugin removes the card, its dictionaries, and its scope subscription
 * together — the same lifecycle the tab's own cards follow.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'env-injector: card dictionaries')

  const controller = new EnvInjectorCardController(ctx.settingsScope.bind<EnvInjectorSection>({ namespace: NS }))
  ctx.effect(() => () => {
    controller.dispose()
  }, 'env-injector: card state')

  /* `slots.inject` waits for the slot's declaration rather than assuming an
   * order: the Plugins section declares `settings.plugin.item` inside its own
   * registration, and registering into an undeclared slot throws. */
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: NS,
    inject: () => controller.inject(),
  }, EnvInjectorCard))
}
