/**
 * Annotation plugin 2.0 browser entry. Mounts the per-session pending-annotation
 * registry, registers the annotation trigger source (codec routing for the
 * fixed-format prompt-context batch), and mounts the composer.dock panel —
 * the ONLY DOM this plugin owns (no body observer, no polling; highlight
 * repositioning is rAF-merged).
 */

// Type-only: brings the ui-conversation slot declarations (composer.dock) and
// the ui-slash source contract into scope; erased at build time.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlashServiceContract } from '@deepseek-ai/dsh-client-ui-slash/client'
import { createAnnotationSource } from './codec.ts'
import { AnnotationPanel, type AnnotationPanelInjected } from './panel.tsx'
import { createSessionRegistry } from './session-registry.ts'
import { ensureStyles } from './styles.ts'

/** Required services: session scopes, the slash roster, and the slot ledger. */
export const inject = ['sessions', 'slash', 'slots']

export function apply(ctx: ClientContext): void {
  ensureStyles(document)
  const registry = createSessionRegistry(localStorage)
  const source = createAnnotationSource(registry)

  ctx.effect(() => {
    const slash = ctx.get('slash') as SlashServiceContract | undefined
    if (slash === undefined) return () => {}
    const dispose = slash.registerSource(source)
    return () => { dispose() }
  }, 'dsh-annotation: @ source')

  ctx.inject(['slots', 'sessions'], (scope: ClientContext) => {
    const sessions = scope.sessions
    scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name: 'conversation.composer.dock',
      id: 'dsh-annotation-2',
      order: 100,
      inject: (sessionId): AnnotationPanelInjected => {
        return {
          sessionId: String(sessionId),
          actx: sessions.scope(sessionId),
          registry,
        }
      },
    }, AnnotationPanel))
  })
}
