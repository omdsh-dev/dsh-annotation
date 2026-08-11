/**
 * Plugin-owned styles, injected once at apply time. Scoped with a unique
 * prefix so hot reloads never double-apply (the tag is idempotent).
 */

export const STYLE_ID = 'dsh-annotation-2-style'

export const STYLE_TEXT = `
[data-dsh-annotation-2] { all: initial; }
[data-dsh-annotation-2] *, [data-dsh-annotation-2] *::before, [data-dsh-annotation-2] *::after { box-sizing: border-box; }
.dsh-ann2-panel { font-family: var(--dsw-font-family, system-ui); font-size: 12px; line-height: 1.5; }
.dsh-ann2-panel-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; cursor: pointer; }
.dsh-ann2-panel-row:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-panel-row[data-expanded] { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-size: 11px; font-weight: 600; color: #fff; background: var(--dsw-alias-accent, #5e9eff); }
.dsh-ann2-body { padding: 2px 8px 8px 26px; }
.dsh-ann2-item { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 8px; align-items: start; padding: 6px 8px; border-radius: 8px; }
.dsh-ann2-item:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 50%, transparent); }
.dsh-ann2-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; font-weight: 600; color: #fff; background: var(--dsw-alias-accent, #5e9eff); }
.dsh-ann2-quote { color: var(--dsw-alias-text-secondary, #999); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ann2-note { white-space: pre-wrap; word-break: break-word; }
.dsh-ann2-note[data-empty] { color: var(--dsw-alias-text-tertiary, #666); font-style: italic; }
.dsh-ann2-moved { color: var(--dsw-alias-danger, #ff6b6b); font-size: 11px; }
.dsh-ann2-toolbar { display: flex; gap: 4px; }
.dsh-ann2-tool { border: none; background: transparent; color: var(--dsw-alias-text-secondary, #999); font-size: 12px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
.dsh-ann2-tool:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); color: var(--dsw-alias-text-primary, #eee); }
.dsh-ann2-editor { width: 100%; min-height: 48px; resize: vertical; background: var(--dsw-alias-fill-input, #1c1c1e); color: var(--dsw-alias-text-primary, #eee); border: 1px solid var(--dsw-alias-border, #3a3a3c); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; }
.dsh-ann2-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.dsh-ann2-btn { border: 1px solid var(--dsw-alias-border, #3a3a3c); background: transparent; color: var(--dsw-alias-text-primary, #eee); border-radius: 8px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.dsh-ann2-btn:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-btn[data-primary] { background: var(--dsw-alias-accent, #5e9eff); border-color: transparent; color: #fff; }
.dsh-ann2-floatbar { position: fixed; z-index: 1200; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-inverted, #555); background: var(--dsw-specific-menu, #2c2c2e); box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,.4)); font-family: var(--dsw-font-family, system-ui); }
.dsh-ann2-floatbar button { border: none; background: transparent; color: var(--dsw-alias-text-primary, #eee); font-size: 12px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.dsh-ann2-floatbar button:hover { background: color-mix(in srgb, var(--dsw-alias-fill-hover, #3a3a3c) 60%, transparent); }
.dsh-ann2-overlay { position: fixed; z-index: 1199; pointer-events: none; }
.dsh-ann2-pin { position: absolute; transform: translate(-50%, -100%); display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 10px; font-weight: 600; color: #fff; background: var(--dsw-alias-accent, #5e9eff); pointer-events: auto; cursor: pointer; }
.dsh-ann2-chip-label { font-size: 10px; color: var(--dsw-alias-accent, #5e9eff); }
`

/** Inject the stylesheet once; returns the tag (no-op on re-entry). */
export function ensureStyles(root: Document): void {
  if (root.getElementById(STYLE_ID) !== null) return
  const style = root.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  root.head.appendChild(style)
}
