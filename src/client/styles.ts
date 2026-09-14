/**
 * The card's stylesheet.
 *
 * The Plugin configuration tab owns the section, not the cards: a card arrives
 * through the `settings.plugin.item` slot and owns its own chrome, controls,
 * and copy. So this file is the card's chrome — the same tokens, radii, and
 * hairline borders the section's own cards use (`--dsw-alias-*`), under class
 * names this plugin owns, which is what keeps the two visually one surface
 * without either reaching into the other.
 *
 * The stylesheet is installed once per page at module materialization, keyed by
 * a `data-plugin-css` marker the same way every DSH client bundle does it, so a
 * reload or an HMR replace never stacks duplicate style tags.
 *
 * @module dsh-env-injector/client/styles
 */

/** The class names the card renders. */
export const c = {
  card: 'evi-card',
  cardOpen: 'evi-cardOpen',
  header: 'evi-header',
  headText: 'evi-headText',
  name: 'evi-name',
  description: 'evi-description',
  chevron: 'evi-chevron',
  chevronOpen: 'evi-chevronOpen',
  pending: 'evi-pending',
  body: 'evi-body',
  notice: 'evi-notice',
  field: 'evi-field',
  option: 'evi-option',
  optionText: 'evi-optionText',
  label: 'evi-label',
  badges: 'evi-badges',
  reset: 'evi-reset',
  hint: 'evi-hint',
  error: 'evi-error',
  rules: 'evi-rules',
  rulesHead: 'evi-rulesHead',
  rulesLabel: 'evi-rulesLabel',
  rulesHint: 'evi-rulesHint',
  rule: 'evi-rule',
  ruleGrid: 'evi-ruleGrid',
  ruleCell: 'evi-ruleCell',
  ruleLabel: 'evi-ruleLabel',
  ruleFoot: 'evi-ruleFoot',
  empty: 'evi-empty',
  actions: 'evi-actions',
  footer: 'evi-footer',
  failed: 'evi-failed',
} as const

/** The marker that makes the stylesheet's presence checkable and idempotent. */
const STYLE_TAG_ID = 'dsh-env-injector/client/card.css'

/** The stylesheet text. */
const CSS = `
.evi-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.evi-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.evi-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.evi-header{appearance:none;width:100%;height:auto;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.evi-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.evi-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.evi-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.evi-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.evi-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.evi-chevronOpen{transform:rotate(180deg)}
.evi-pending{flex:none}
.evi-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.evi-notice{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.evi-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.evi-field+.evi-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.evi-option{align-items:flex-start;gap:10px;display:flex}
.evi-option .evi-optionText{flex:1;flex-direction:column;gap:2px;min-width:0;display:flex}
.evi-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.evi-badges{align-items:center;gap:8px;flex:none;display:inline-flex}
.evi-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.evi-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.evi-reset:disabled{cursor:default;opacity:.5}
.evi-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.evi-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.evi-rules{border:0;margin:0;padding:4px 0 0;flex-direction:column;display:flex}
.evi-rulesHead{align-items:baseline;gap:8px;flex-wrap:wrap;display:flex}
.evi-rulesLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.evi-rule{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;margin:8px 0 0;padding:10px 12px;flex-direction:column;gap:8px;display:flex}
.evi-ruleGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.evi-ruleCell{flex-direction:column;gap:4px;min-width:0;display:flex}
.evi-ruleLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.evi-ruleFoot{align-items:center;gap:8px;display:flex}
.evi-ruleFoot .evi-optionText{flex:1}
.evi-empty{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:1.5}
.evi-actions{padding:8px 0 0;display:flex}
.evi-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.evi-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
`

/**
 * Install the card's stylesheet once per page.
 *
 * Guarded rather than tracked: the marker attribute is what a reload, an HMR
 * replace, or a second card registration checks, so the tag is never stacked.
 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-env-injector'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
