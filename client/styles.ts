/**
 * Stylesheet for the console page.
 *
 * Written as one injected `<style>` element instead of CSS modules: the bundle
 * is produced by a plain rolldown build with no CSS pipeline, and a single
 * scoped sheet keeps the file list small. Every colour, radius and font size
 * comes from the host's `--dsw-*` tokens, so the page follows the active theme
 * (including dark mode) without carrying its own palette.
 *
 * The class names follow `参考界面设计/index.html` one for one, so the two can be
 * compared line by line; the only change is the `dshsql-` prefix, which keeps a
 * host update from colliding with `.card` or `.tabs`.
 *
 * Token care: several `--dsw-font-*` custom properties are `font` shorthands
 * (`13px/20px family`), so they may only be used with the `font:` property.
 * Sizes and families come from the matching `-font-size` / `-font-family`
 * siblings instead; `--dsw-font-markdown-code-block` is also a shorthand, so
 * the code face is read from `--dsw-font-markdown-code-font-family`.
 *
 * @module dsh-session-optimizer/client/styles
 */

const STYLE_ID = 'dsh-session-optimizer-console'

const CSS = `
.dshsql-page {
  --dshsql-bg: var(--dsw-alias-bg-base, #151517);
  --dshsql-surface: var(--dsw-alias-bg-layer-1, #232324);
  --dshsql-surface-2: var(--dsw-alias-bg-layer-2, #2c2c2e);
  --dshsql-hover: var(--dsw-alias-interactive-bg-hover, #ffffff14);
  /* Selection fill: the host has no "active" surface token, so this is the
     accent mixed into the card colour by hand. Here rather than inline so the
     two selected states (format card, segmented button) cannot drift apart. */
  --dshsql-active: var(--dsw-alias-interactive-bg-active, #1e2a3d);
  --dshsql-text: var(--dsw-alias-label-primary, #f9fafb);
  --dshsql-secondary: var(--dsw-alias-label-secondary, #cfd3d6);
  --dshsql-muted: var(--dsw-alias-label-tertiary, #adb2b8);
  --dshsql-border: var(--dsw-alias-border-l2, #ffffff1f);
  --dshsql-border-soft: var(--dsw-alias-border-l1, #ffffff0f);
  /* Token names checked against the host sheet rather than guessed: it exposes
     "state-business-primary" and "state-warn-primary", and has no
     "state-info-primary" / "state-warning-primary" at all. A missing custom
     property resolves to the empty string, which silently paints nothing --
     usage bars, legend rules, the p50 line and the primary button all vanished.
     Each one therefore carries a literal fallback, so a host rename dims the
     page instead of blanking it. (No backticks here: this CSS is a template
     literal.) */
  --dshsql-accent: var(--dsw-alias-state-business-primary, #7aaaff);
  --dshsql-accent-strong: var(--dsw-alias-button-info-hover, #3978bd);
  --dshsql-success: var(--dsw-alias-state-success-primary, #22c55e);
  --dshsql-warning: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dshsql-danger: var(--dsw-alias-state-error-primary, #f25a5a);
  --dshsql-radius: var(--dsw-radius-md, 6px);
  --dshsql-mono: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  --dshsql-small: var(--dsw-font-xs-13-font-size, 12px);

  display: flex; flex-direction: column; box-sizing: border-box;
  width: 100%; height: 100%; min-height: 0; min-width: 0;
  color: var(--dshsql-text);
  background: var(--dshsql-bg);
  font-family: var(--dsw-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif);
  font-size: 13px; line-height: 20px;
}
.dshsql-page * { box-sizing: border-box; }
.dshsql-page button, .dshsql-page input, .dshsql-page select { font: inherit; color: inherit; }
.dshsql-page button { cursor: pointer; }
.dshsql-page button:disabled { cursor: not-allowed; opacity: .45; }
.dshsql-page button:focus-visible, .dshsql-page input:focus-visible,
.dshsql-page select:focus-visible, .dshsql-page summary:focus-visible { outline: 2px solid var(--dshsql-accent); outline-offset: 2px; }

/* Chrome */
.dshsql-header {
  height: 65px; flex: none; display: flex; align-items: center; gap: 12px;
  padding: 0 20px; border-bottom: 1px solid var(--dshsql-border);
}
.dshsql-header h1 { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
.dshsql-tabs {
  display: flex; gap: 4px; height: 45px; flex: none; padding: 0 20px;
  border-bottom: 1px solid var(--dshsql-border);
}
.dshsql-tab {
  position: relative; padding: 0 12px; border: 0; background: transparent;
  color: var(--dshsql-secondary); font-size: 13px;
}
.dshsql-tab:hover { color: var(--dshsql-text); }
.dshsql-tab[data-active='true'] { color: var(--dshsql-text); font-weight: 600; }
.dshsql-tab[data-active='true']::after {
  content: ""; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px;
  background: var(--dshsql-accent);
}
.dshsql-main { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dshsql-container { width: 100%; max-width: 1480px; margin: 0 auto; padding: 20px; }
.dshsql-footer {
  min-height: 34px; flex: none; display: flex; align-items: center; gap: 18px;
  padding: 0 20px; border-top: 1px solid var(--dshsql-border);
  color: var(--dshsql-muted); font-size: var(--dshsql-small);
}
.dshsql-spacer { flex: 1 1 auto; }
.dshsql-muted { color: var(--dshsql-muted); }
.dshsql-secondary { color: var(--dshsql-secondary); }
.dshsql-error { color: var(--dshsql-danger); }
.dshsql-mono { font-family: var(--dshsql-mono); }
.dshsql-num { font-family: var(--dshsql-mono); font-variant-numeric: tabular-nums; }
.dshsql-wrap { overflow-wrap: anywhere; }
.dshsql-small { font-size: var(--dshsql-small); }

/* Buttons */
.dshsql-btn {
  min-height: 30px; padding: 4px 12px; border: 1px solid var(--dshsql-border);
  border-radius: var(--dshsql-radius); background: var(--dshsql-surface); color: inherit;
}
.dshsql-btn:hover:not(:disabled) { background: var(--dshsql-hover); }
.dshsql-btn[data-primary='true'] {
  color: #fff; border-color: var(--dshsql-accent-strong);
  background: var(--dshsql-accent-strong); filter: brightness(.92);
}
.dshsql-btn[data-primary='true']:hover:not(:disabled) { filter: brightness(1); }
.dshsql-btn-sm { min-height: 26px; padding: 2px 9px; font-size: var(--dshsql-small); }
/* Overview */
.dshsql-section-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.dshsql-section-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.dshsql-status { display: inline-flex; align-items: center; gap: 7px; color: var(--dshsql-secondary); }
.dshsql-dot { display: inline-block; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dshsql-success); }
.dshsql-dot[data-tone='warning'] { background: var(--dshsql-warning); }
.dshsql-dot[data-tone='danger'] { background: var(--dshsql-danger); }
.dshsql-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.dshsql-card {
  padding: 14px 16px; border: 1px solid var(--dshsql-border);
  border-radius: var(--dshsql-radius); background: var(--dshsql-surface);
}
.dshsql-card-label { color: var(--dshsql-secondary); }
.dshsql-card-value {
  margin-top: 5px; font-size: 24px; line-height: 32px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dshsql-card-note { margin-top: 2px; color: var(--dshsql-muted); font-size: var(--dshsql-small); }
.dshsql-overview-grid {
  display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(340px, .75fr); gap: 24px;
}
.dshsql-panel { min-width: 0; }
.dshsql-table-wrap { overflow: hidden; border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius); }
.dshsql-page table { width: 100%; border-collapse: collapse; font-size: var(--dshsql-small); line-height: 20px; }
.dshsql-page th, .dshsql-page td {
  padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--dshsql-border-soft);
  vertical-align: middle;
}
.dshsql-page th { color: var(--dshsql-muted); font-weight: 500; white-space: nowrap; }
.dshsql-page tbody tr:last-child td { border-bottom: none; }
.dshsql-page tbody tr[data-clickable='true'] { cursor: pointer; }
.dshsql-page tbody tr[data-clickable='true']:hover { background: var(--dshsql-hover); }
.dshsql-page tbody tr[data-selected='true'] { background: var(--dshsql-hover); }
.dshsql-usage-title {
  display: block; max-width: 330px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshsql-usage-track {
  width: 120px; height: 5px; overflow: hidden; border-radius: 3px;
  background: var(--dshsql-border);
}
.dshsql-usage-track > span { display: block; height: 100%; background: var(--dshsql-accent); }
.dshsql-kv { margin: 0; border-top: 1px solid var(--dshsql-border); }
.dshsql-kv-row {
  display: grid; grid-template-columns: 130px 1fr; gap: 16px; padding: 9px 0;
  border-bottom: 1px solid var(--dshsql-border-soft);
}
.dshsql-kv-row dt { color: var(--dshsql-muted); }
.dshsql-kv-row dd { margin: 0; overflow-wrap: anywhere; }
.dshsql-tech { margin-top: 8px; }
.dshsql-tech > summary {
  cursor: pointer; color: var(--dshsql-secondary); font-size: var(--dshsql-small);
  padding: 6px 0; list-style: none;
}
.dshsql-tech > summary::before { content: "▸ "; }
.dshsql-tech[open] > summary::before { content: "▾ "; }

/* Transfer */
.dshsql-transfer-top { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.dshsql-direction {
  display: inline-flex; padding: 3px; gap: 3px; background: var(--dshsql-surface-2);
  border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius);
}
.dshsql-direction button {
  border: 1px solid var(--dshsql-border); border-radius: 5px;
  background: var(--dshsql-surface); color: var(--dshsql-muted); padding: 5px 9px;
}
.dshsql-direction button[data-active='true'] {
  border-color: var(--dshsql-accent); background: var(--dshsql-surface-2); color: var(--dshsql-text);
}
.dshsql-input {
  min-height: 30px; padding: 4px 10px; border: 1px solid var(--dshsql-border);
  border-radius: var(--dshsql-radius); background: var(--dshsql-surface); color: var(--dshsql-text);
}
.dshsql-input::placeholder { color: var(--dshsql-muted); }
.dshsql-transfer-filter { width: 260px; }
.dshsql-check { width: 14px; height: 14px; accent-color: var(--dshsql-accent); }
.dshsql-transfer-title { font-weight: 600; }
.dshsql-badge {
  display: inline-block; margin-left: 8px; padding: 0 6px;
  border: 1px solid var(--dshsql-success); border-radius: 4px;
  color: var(--dshsql-success); font-size: 11px; font-weight: 400;
}
.dshsql-row-problem { color: var(--dshsql-danger); font-size: var(--dshsql-small); }
.dshsql-action-bar {
  display: flex; align-items: center; gap: 18px; margin-top: 14px; padding: 12px 14px;
  border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius);
  background: var(--dshsql-surface);
}
.dshsql-radio { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.dshsql-radio input { accent-color: var(--dshsql-accent); }
.dshsql-action-hint { color: var(--dshsql-muted); font-size: var(--dshsql-small); }
.dshsql-job { margin-top: 24px; }
.dshsql-job-status { display: flex; align-items: center; gap: 10px; }
.dshsql-progress {
  height: 5px; margin-top: 10px; overflow: hidden; border-radius: 3px;
  background: var(--dshsql-border);
}
.dshsql-progress span { display: block; height: 100%; background: var(--dshsql-success); }
.dshsql-progress[data-tone='danger'] span { background: var(--dshsql-danger); }

/* Latency */
.dshsql-metric-summary {
  display: flex; align-items: center; gap: 18px; margin-bottom: 16px;
  color: var(--dshsql-secondary); flex-wrap: wrap;
}
.dshsql-metric-summary strong { color: var(--dshsql-text); font-weight: 600; }
.dshsql-chart-panel {
  padding: 16px; border: 1px solid var(--dshsql-border);
  border-radius: var(--dshsql-radius); background: var(--dshsql-surface);
}
.dshsql-chart-head { display: flex; align-items: flex-start; gap: 16px; }
.dshsql-chart-title strong { display: block; font-size: 14px; }
.dshsql-chart-title span { color: var(--dshsql-muted); font-size: var(--dshsql-small); }
.dshsql-legend { display: flex; gap: 16px; color: var(--dshsql-secondary); font-size: var(--dshsql-small); }
.dshsql-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.dshsql-legend i { display: inline-block; width: 16px; height: 2px; background: var(--dshsql-accent); }
.dshsql-legend .p95 i { background: var(--dshsql-warning); }
.dshsql-legend .max i {
  height: 1px;
  background: repeating-linear-gradient(90deg, var(--dshsql-muted) 0 4px, transparent 4px 7px);
}
.dshsql-chart-stats { display: flex; gap: 24px; margin: 16px 0 4px 48px; flex-wrap: wrap; }
.dshsql-chart-stat span { display: block; color: var(--dshsql-muted); font-size: 11px; }
.dshsql-chart-stat strong {
  display: block; margin-top: 1px;
  font-family: var(--dshsql-mono); font-size: 16px; line-height: 24px; font-weight: 600;
}
.dshsql-chart { display: block; width: 100%; height: 260px; margin-top: 4px; }
.dshsql-chart text { fill: var(--dshsql-muted); font-family: var(--dshsql-mono); font-size: 11px; }
.dshsql-chart .grid { stroke: var(--dshsql-border-soft); stroke-width: 1; }
.dshsql-chart .axis { stroke: var(--dshsql-border); stroke-width: 1; }
.dshsql-chart .p50-line { fill: none; stroke: var(--dshsql-accent); stroke-width: 2; }
.dshsql-chart .p95-line { fill: none; stroke: var(--dshsql-warning); stroke-width: 1.5; }
.dshsql-chart .max-line { fill: none; stroke: var(--dshsql-muted); stroke-width: 1; stroke-dasharray: 4 4; }
.dshsql-chart .point { fill: var(--dshsql-surface); stroke: var(--dshsql-accent); stroke-width: 2; }
.dshsql-chart .hover-line { stroke: var(--dshsql-muted); stroke-width: 1; }
.dshsql-chart-tooltip {
  position: fixed; z-index: 10; min-width: 160px; padding: 8px 10px;
  border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius);
  background: var(--dshsql-surface-2); box-shadow: 0 4px 16px #0005;
  pointer-events: none; font-size: var(--dshsql-small); color: var(--dshsql-text);
}
.dshsql-chart-tooltip dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 4px 0 0; }
.dshsql-chart-tooltip dt { color: var(--dshsql-muted); }
.dshsql-chart-tooltip dd { margin: 0; font-family: var(--dshsql-mono); text-align: right; }
.dshsql-metrics-table { margin-top: 16px; }
.dshsql-metrics-table td:not(:first-child), .dshsql-metrics-table th:not(:first-child) { text-align: right; }
.dshsql-empty-note {
  padding: 40px; color: var(--dshsql-muted); text-align: center;
}
.dshsql-empty {
  padding: 24px; color: var(--dshsql-muted); text-align: center;
  border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius);
}

/* --- settings view -------------------------------------------------------- */
/* Narrower than the other views on purpose: a row of switches spread across a
   1400px panel reads as a form to fill in, while 920px reads as a settings page. */
.dshsql-settings { max-width: 920px; margin: 0 auto; }
.dshsql-settings-section {
  padding: 0 0 24px; margin-bottom: 24px;
  border-bottom: 1px solid var(--dshsql-border);
}
.dshsql-settings-section:last-child { padding-bottom: 0; margin-bottom: 0; border-bottom: 0; }
.dshsql-settings-section > h2 { margin: 0 0 14px; font-size: 14px; font-weight: 600; }
.dshsql-setting-label { margin: 0 0 10px; font-weight: 550; }
.dshsql-setting-label-inline { margin: 0; }
.dshsql-setting-row {
  display: flex; align-items: flex-start; gap: 24px; justify-content: space-between;
}
.dshsql-setting-row > div:first-child { flex: 1; min-width: 0; }
.dshsql-setting-row > p { margin: 0; }
.dshsql-setting-row p { margin: 0; color: var(--dshsql-muted); font-size: var(--dshsql-small); }
.dshsql-setting-row h2 { margin: 0 0 6px; }
.dshsql-format-options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.dshsql-format-option {
  display: block; padding: 14px 16px; text-align: left;
  border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius);
  background: var(--dshsql-surface); color: var(--dshsql-text);
  font: inherit; cursor: pointer;
}
.dshsql-format-option:hover { background: var(--dshsql-hover); }
.dshsql-format-option[data-active='true'] {
  border-color: var(--dshsql-accent); background: var(--dshsql-active);
}
.dshsql-format-option:disabled { cursor: default; opacity: 0.55; }
.dshsql-format-option:disabled:hover { background: var(--dshsql-surface); }
.dshsql-format-option[data-active='true']:disabled:hover { background: var(--dshsql-active); }
.dshsql-format-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 15px; font-weight: 600; margin-bottom: 6px;
}
.dshsql-default-badge {
  padding: 1px 5px; border: 1px solid var(--dshsql-border); border-radius: 4px;
  color: var(--dshsql-muted); font-size: 11px; font-weight: 400;
}
.dshsql-format-option p { margin: 0; font-size: var(--dshsql-small); color: var(--dshsql-secondary); }
.dshsql-format-option p.suitable { margin-top: 6px; color: var(--dshsql-muted); }
.dshsql-segmented { display: inline-flex; flex: none; gap: 6px; }
.dshsql-segmented button {
  min-width: 68px; padding: 6px 12px;
  border: 1px solid var(--dshsql-border); border-radius: var(--dshsql-radius);
  background: var(--dshsql-surface); color: var(--dshsql-secondary);
  font: inherit; font-size: var(--dshsql-small); cursor: pointer;
}
.dshsql-segmented button:hover { background: var(--dshsql-hover); }
.dshsql-segmented button[data-active='true'] {
  border-color: var(--dshsql-accent); background: var(--dshsql-active); color: var(--dshsql-text);
}
.dshsql-segmented button:disabled { cursor: default; opacity: 0.6; }
.dshsql-language-select { width: 160px; flex: none; }
.dshsql-performance-options { display: grid; gap: 12px; }
.dshsql-performance-option { display: flex; align-items: center; gap: 8px; width: fit-content; cursor: pointer; }
.dshsql-performance-option-secondary { margin-left: 24px; }
.dshsql-performance-option:has(input:disabled) { color: var(--dshsql-muted); cursor: default; }
.dshsql-performance-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.dshsql-performance-status { color: var(--dshsql-muted); font-size: var(--dshsql-small); }
.dshsql-performance-error { margin: 12px 0 0; overflow-wrap: anywhere; }
.dshsql-about-title { margin: 0 0 14px; font-size: 14px; font-weight: 600; }
.dshsql-about-list .dshsql-kv-row { grid-template-columns: 150px 1fr; min-height: 44px; align-items: center; }
.dshsql-about-list .dshsql-kv-row dd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshsql-about-links { display: flex; gap: 8px; flex-wrap: wrap; }
.dshsql-link-button {
  padding: 0; border: 0; background: transparent;
  color: var(--dshsql-accent); font: inherit; font-size: var(--dshsql-small);
  text-decoration: none; cursor: pointer;
}
.dshsql-link-button:hover { text-decoration: underline; }
.dshsql-update-status { color: var(--dshsql-muted); font-size: var(--dshsql-small); }
.dshsql-note {
  margin: 0 0 16px; padding: 8px 10px;
  border: 1px solid var(--dshsql-border); border-left-width: 3px; border-radius: var(--dshsql-radius);
  font-size: var(--dshsql-small);
}
.dshsql-note-warning { border-left-color: var(--dshsql-warning); color: var(--dshsql-warning); }

/* diagnostics view */
.dshsql-diagnostics { max-width: 920px; }
.dshsql-diagnostics h2 { margin: 0; font-size: 14px; font-weight: 600; }
.dshsql-diagnostics h3 { margin: 14px 0 6px; }
.dshsql-uninstall { margin-top: 12px; }
.dshsql-plain-list {
  margin: 0; padding: 0 0 0 18px;
  color: var(--dshsql-secondary); font-size: var(--dshsql-small);
  font-family: var(--dshsql-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  line-height: 22px;
}
.dshsql-diagnostics .dshsql-note { margin: 8px 0 0; }

@media (max-width: 1100px) {
  .dshsql-overview-grid { grid-template-columns: 1fr; }
  .dshsql-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshsql-card-value { font-size: 21px; }
  .dshsql-chart-stats { gap: 16px; }
}

@media (max-width: 700px) {
  .dshsql-format-options { grid-template-columns: 1fr; }
  .dshsql-setting-row { flex-direction: column; gap: 10px; }
  .dshsql-about-list .dshsql-kv-row { grid-template-columns: 110px 1fr; }
}
`

/** Inject the sheet once per document. */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
}
