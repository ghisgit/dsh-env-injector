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
 * Narrow an injected service to the one registration this plugin needs.
 * @param view - the value read from `ctx.get('tools')`.
 * @returns the registrar view, or `undefined` when the service is absent or not
 *   the shape this hook needs.
 */
export function asToolEventSource(view) {
    if (view === null || (typeof view !== 'object' && typeof view !== 'function'))
        return undefined;
    const candidate = view;
    return typeof candidate.on === 'function' ? view : undefined;
}
