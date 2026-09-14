/**
 * The slice of the tool-registry contract this plugin consumes, declared
 * structurally.
 *
 * The plugin's ONLY hard dependency is `ctx.subprocess`; output redaction rides
 * on the tools registry when a deployment mounts one. That makes the registry an
 * OPTIONAL seam, and an optional seam is declared the way {@link EnvBearingSpec}
 * declares the subprocess spec: the few fields this plugin reads, not the
 * provider's whole published type surface. Requiring `@deepseek-ai/dsh-tools`
 * would pull its ten peer packages (agent, session, code-runtime, …) into every
 * consumer's install for a listener that touches four fields.
 *
 * These declarations deliberately do NOT augment cordis' `Events`: the real
 * `@deepseek-ai/dsh-tools` already declares `tools/post-execute`, and merging a
 * second, structurally different signature over it is a compile error in any
 * program that has both (i.e. inside DSH itself). {@link ToolEventSource} is
 * cast onto the injected context instead, keeping the coupling to one `on` call
 * — the same "declare the seam, do not import the provider" rule the rest of
 * this package follows.
 *
 * @module dsh-env-injector/tools
 */
/**
 * The result-block fields redaction reads: text is rewritten, everything else is passed through.
 */
export interface ToolResultBlock {
    readonly type?: string;
    readonly text?: string;
}
/** What `tools/post-execute` hands a listener before the result is materialized. */
export interface ToolResultLike {
    readonly content?: readonly ToolResultBlock[];
}
/**
 * The post-dispatch decision envelope. This plugin only ever REPLACES the
 * content of an accepted result (never `value`, never `block`), so the union is
 * declared narrowly enough to express exactly that.
 */
export type ToolDecision = {
    readonly kind: 'accept';
    readonly content?: readonly ToolResultBlock[];
    readonly value?: unknown;
    readonly additionalContexts?: unknown;
} | {
    readonly kind: 'block';
    readonly feedback: readonly ToolResultBlock[];
    readonly additionalContexts?: unknown;
};
/** The registry surface this plugin attaches to: one listener registration. */
export interface ToolEventSource {
    on(name: 'tools/post-execute', listener: (this: unknown, exec: unknown, result: ToolResultLike, next: () => Promise<ToolDecision>) => Promise<ToolDecision>): unknown;
}
/**
 * Narrow an injected service to the one registration this plugin needs.
 * @param view - the value read from `ctx.get('tools')`.
 * @returns the registrar view, or `undefined` when the service is absent or not
 *   the shape this hook needs.
 */
export declare function asToolEventSource(view: unknown): ToolEventSource | undefined;
