import { UserMessage } from "@deepseek-ai/dsh-session";
//#region ../../.dsh/source/staging-20260811T152241Z/packages/util/brand/lib/types/index.d.ts
/**
 * The `Branded<B>` nominal-typing primitive — a type-only utility (no runtime
 * code, no harness-package dependency) shared by every package that owns a
 * cross-boundary id.
 *
 * A brand makes structurally-identical strings non-interchangeable at the type
 * level: a `SessionId` cannot be passed where a `CallId` is expected, even
 * though both are plain strings at runtime. Construction goes through a per-id
 * factory in the OWNING package (a plain cast inside — zero runtime cost);
 * comparison, logging, and serialization all behave as ordinary strings.
 *
 * Policy: a package brands the ids it owns — `CallId` in dsh-llm (tool-call
 * correlation), the shared agent/session `SessionId` in dsh-session, and
 * `TaskId` in dsh-tasks. Branding is for ids that cross package boundaries and
 * could plausibly be confused; not every string needs a brand.
 * This package owns ONLY the primitive — no concrete id, no runtime code beyond
 * the (erased) type — so the brand vocabulary stays dependency-free and a
 * package can brand its ids without depending on an unrelated capability
 * package.
 *
 * @module @deepseek-ai/dsh-brand
 */
declare const BRAND: unique symbol;
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & {
  readonly [BRAND]: B;
};
//#endregion
//#region ../../.dsh/source/staging-20260811T152241Z/packages/llm/llm/lib/types/brand.d.ts
/** Stable identity carried by one message across inbox, log, and model-request boundaries. */
type MessageId = Branded<'MessageId'>;
/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; no validation is performed.
 */
declare function MessageId(id: string): MessageId;
//#endregion
//#region src/shared/envelope.d.ts
/**
 * Strict versioned envelope carrying one annotation through the native
 * reference channel. The browser codec serializes items into these envelopes
 * (plain text inside the message), and the plugin's Node half splits them out
 * into native context + clean question at `agent/pre-step` time. JSON special
 * characters are escaped so content can never forge a closing tag.
 */
/** One envelope payload (version 1). */
interface AnnotationEnvelopeV1 {
  readonly version: 1;
  /** Global-unique annotation id (also the reference id). */
  readonly id: string;
  /** The quoted anchor text. */
  readonly quote: string;
  /** The user's note (may be empty). */
  readonly note: string;
}
//#endregion
//#region src/node/index.d.ts
declare const PLUGIN_NAME = "dsh-annotation";
/**
 * Split envelopes out of one claimed message batch. Returns null when no
 * user message carries a valid envelope (caller keeps the batch untouched) —
 * including the case where ANY envelope is malformed (whole message kept).
 */
declare function splitAnnotationMessages(messages: readonly UserMessage[]): readonly UserMessage[] | null;
/** The native collapsed context row (plugin source, notice form). */
declare function buildContextMessage(originalId: MessageId, envelopes: readonly AnnotationEnvelopeV1[]): UserMessage;
/** The plugin body: one `agent/pre-step` listener, ordinary path is a no-op. */
declare const _default: {
  name: string;
  apply(ctx: {
    on(event: string, listener: (...args: never[]) => unknown): unknown;
  }): void;
};
//#endregion
export { PLUGIN_NAME, buildContextMessage, _default as default, splitAnnotationMessages };