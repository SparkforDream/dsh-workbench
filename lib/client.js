/**
 * dsh-workbench — browser half.
 *
 * Four independent cells, one package:
 *   1. 会话耗时徽章 (header utilities) — reads the host `workbenchStats` projection,
 *      with a window fold as fallback.
 *   2. 资源管理器按钮 (header utilities) — POSTs the Session's absolute cwd to
 *      the shipped open-in-app route; no native code, no privileges.
 *   3. 会话内查找 (shell.overlay + a rebindable shortcut) — highlights matches
 *      with the CSS Custom Highlight API (no DOM mutation, so React re-renders
 *      cannot corrupt the page) and jumps between them.
 *   4. 刷新页面按钮 (header utilities) — re-fetches the document, which is the
 *      only way to pick up a changed plugin manifest.
 *
 * Nothing here imports anything: the shipped client bundle runs each plugin
 * inside `window.__ModuleLoader__.load`, where only `require` for a fixed set
 * of host modules is available.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbench',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const BADGE_ID = 'workbench:duration'
    const EXPLORER_ID = 'workbench:explorer'
    const FIND_ID = 'workbench:find'
    const RELOAD_ID = 'workbench:reload'
    const STYLE_ID = 'dsh-workbench-style'
    const PANEL_ID = 'dsh-workbench-panel'
    const FIND_OPEN_EVENT = 'dsh-workbench:find-open'
    const HIGHLIGHT_ALL = 'dsh-workbench-find'
    const HIGHLIGHT_CURRENT = 'dsh-workbench-find-current'

    /* ---------------- formatting ---------------- */

    /** Compact duration; always carries a unit. */
    function span(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0s'
      const s = Math.round(ms / 1000)
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      const rs = s % 60
      if (m < 60) return rs === 0 ? `${m}m` : `${m}m${String(rs).padStart(2, '0')}s`
      const h = Math.floor(m / 60)
      const rm = m % 60
      return rm === 0 ? `${h}h` : `${h}h${String(rm).padStart(2, '0')}m`
    }

    /** `h:mm:ss` / `m:ss`, for numbers that must read as clock time. */
    function precise(ms) {
      const total = Math.round((ms ?? 0) / 1000)
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      return `${m}:${String(s).padStart(2, '0')}`
    }

    /* ---------------- styles ---------------- */

    const CSS = `
.dsh-workbench-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8a8a8f);
  font: 11px/1 var(--dsh-font-ui, system-ui, sans-serif);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  white-space: nowrap;
  transition: color .12s, border-color .12s, background .12s;
}
.dsh-workbench-badge:hover {
  color: var(--dsw-alias-label-primary, #e9e9ec);
  border-color: var(--dsw-alias-border-primary, rgba(128,128,128,.5));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08));
}
.dsh-workbench-badge[data-live="true"] { color: var(--dsw-alias-brand-primary, #4f8cff); }
.dsh-workbench-badge[data-live="true"] .dsh-workbench-dot { animation: dsh-workbench-pulse 1.4s ease-in-out infinite; }
@keyframes dsh-workbench-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
.dsh-workbench-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .45; }
.dsh-workbench-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 24px; padding: 0;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #8a8a8f);
  cursor: pointer;
  transition: color .12s, border-color .12s, background .12s;
}
.dsh-workbench-icon:hover {
  color: var(--dsw-alias-label-primary, #e9e9ec);
  border-color: var(--dsw-alias-border-secondary, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08));
}
.dsh-workbench-icon[data-busy="true"] { opacity: .5; cursor: default; }
.dsh-workbench-icon[data-state="error"] { color: #ff7d6b; }
.dsh-workbench-panel {
  pointer-events: auto;
  position: fixed;
  z-index: 70;
  min-width: 320px;
  max-width: 440px;
  max-height: 70vh;
  overflow: auto;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-layer-1, #1c1c1f);
  color: var(--dsw-alias-label-primary, #e9e9ec);
  box-shadow: 0 12px 32px rgba(0,0,0,.34);
  font: 12px/1.5 var(--dsh-font-ui, system-ui, sans-serif);
  backdrop-filter: blur(10px);
}
.dsh-workbench-title {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; margin-bottom: 10px;
  font-size: 12px; font-weight: 600; letter-spacing: .02em;
}
.dsh-workbench-title small { font-weight: 400; opacity: .55; font-variant-numeric: tabular-nums; }
.dsh-workbench-hero {
  margin-bottom: 12px; padding: 10px 12px; border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.09));
}
.dsh-workbench-hero b {
  display: block; font-size: 24px; line-height: 1.15;
  font-variant-numeric: tabular-nums; letter-spacing: -.01em;
}
.dsh-workbench-hero span { display: block; margin-top: 3px; font-size: 11px; opacity: .6; }
.dsh-workbench-rows { display: grid; grid-template-columns: 1fr auto; gap: 3px 14px; }
.dsh-workbench-rows dt { opacity: .68; }
.dsh-workbench-rows dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.dsh-workbench-rows dd[data-zero="true"] { opacity: .4; }
.dsh-workbench-sec {
  margin: 12px 0 5px; padding-top: 9px; font-size: 10px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; opacity: .5;
  border-top: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.22));
}
.dsh-workbench-tools { display: grid; grid-template-columns: 1fr auto auto; gap: 2px 10px; }
.dsh-workbench-tools .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-workbench-tools .c { opacity: .5; text-align: right; font-variant-numeric: tabular-nums; }
.dsh-workbench-tools .t { text-align: right; font-variant-numeric: tabular-nums; }
.dsh-workbench-note { margin-top: 10px; font-size: 10.5px; line-height: 1.45; opacity: .45; }
.dsh-workbench-wait {
  margin-top: 10px; padding: 7px 10px; border-radius: 8px; font-size: 11px;
  background: rgba(255, 171, 46, .12); color: #ffab2e;
}
.dsh-workbench-bar {
  pointer-events: auto;
  position: fixed;
  top: 56px;
  right: 26px;
  z-index: 72;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-layer-1, rgba(28,28,31,.96));
  color: var(--dsw-alias-label-primary, #e9e9ec);
  box-shadow: 0 10px 28px rgba(0,0,0,.32);
  font: 13px/1.35 var(--dsh-font-ui, system-ui, sans-serif);
  backdrop-filter: blur(8px);
}
.dsh-workbench-bar input {
  width: 220px; padding: 4px 6px;
  border: none; outline: none; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
  color: inherit; font: inherit;
}
.dsh-workbench-bar input::placeholder { color: var(--dsw-alias-label-secondary, rgba(233,233,236,.45)); }
.dsh-workbench-count {
  min-width: 56px; text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, rgba(233,233,236,.7));
}
.dsh-workbench-count[data-empty="true"] { color: #ff9f7a; }
.dsh-workbench-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: inherit; cursor: pointer; font: inherit;
}
.dsh-workbench-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.2)); }
.dsh-workbench-btn[disabled] { opacity: .35; cursor: default; }
.dsh-workbench-scope {
  padding: 2px 6px; border-radius: 5px; border: none; cursor: pointer;
  background: transparent; color: inherit; opacity: .55; font: inherit; font-size: 11px;
}
.dsh-workbench-scope:hover { opacity: .9; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
::highlight(dsh-workbench-find) { background-color: rgba(250, 204, 21, .34); color: inherit; }
::highlight(dsh-workbench-find-current) { background-color: #ffab2e; color: #101014; }

/* ---------------- settings page ---------------- */
.dsh-workbench-settings {
  display: flex; flex-direction: column; gap: 0;
  max-width: 640px;
  color: var(--dsw-alias-label-primary, #e9e9ec);
  font: 13px/1.45 var(--dsh-font-ui, system-ui, sans-serif);
}
.dsh-workbench-settings-title { font-size: 15px; font-weight: 600; margin-bottom: 2px; }
.dsh-workbench-settings-lead {
  color: var(--dsw-alias-label-secondary, rgba(233,233,236,.62));
  font-size: 12px; margin-bottom: 14px;
}
.dsh-workbench-field {
  display: flex; align-items: flex-start; gap: 14px;
  padding: 11px 0;
  border-top: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.18));
}
.dsh-workbench-field:first-of-type { border-top: none; }
.dsh-workbench-field-label { flex: 0 0 168px; padding-top: 3px; }
.dsh-workbench-field-label b { display: block; font-weight: 500; }
.dsh-workbench-field-label small {
  display: block; margin-top: 3px;
  color: var(--dsw-alias-label-secondary, rgba(233,233,236,.5));
  font-size: 11px; line-height: 1.4;
}
.dsh-workbench-field-body { flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-workbench-settings select,
.dsh-workbench-settings input[type="number"] {
  padding: 4px 7px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3));
  background: var(--dsw-alias-bg-layer-1, rgba(28,28,31,.9));
  color: inherit; font: inherit;
}
.dsh-workbench-settings input[type="number"] { width: 74px; font-variant-numeric: tabular-nums; }
.dsh-workbench-settings input[type="range"] { width: 150px; accent-color: var(--dsw-alias-brand-primary, #4f8cff); }
.dsh-workbench-settings button {
  padding: 4px 10px; border-radius: 6px; cursor: pointer; font: inherit;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
  color: inherit;
}
.dsh-workbench-settings button:hover { background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,.2)); }
.dsh-workbench-settings button[data-primary="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, #4f8cff);
  color: #fff;
}
.dsh-workbench-settings button[data-primary="true"]:hover { filter: brightness(1.08); }
.dsh-workbench-num { min-width: 42px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, rgba(233,233,236,.7)); }
.dsh-workbench-file { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(233,233,236,.62)); word-break: break-all; }
.dsh-workbench-warn { color: #ff9f7a; font-size: 12px; }
.dsh-workbench-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.dsh-workbench-check input { accent-color: var(--dsw-alias-brand-primary, #4f8cff); }
`

    function ensureStyle() {
      if (typeof document === 'undefined' || document.head === null) return
      const existing = document.getElementById(STYLE_ID)
      // Client plugins hot-reload without a page reload, so a <style> from a
      // previous module instance must be kept in sync, not trusted blindly.
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ---------------- icons ---------------- */

    function FolderIcon() {
      return React.createElement('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': 'true',
      },
        React.createElement('path', { d: 'M1.8 4.2c0-.6.5-1 1-1h3l1.3 1.6h6.1c.6 0 1 .5 1 1v6.4c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1V4.2Z' }),
      )
    }

    function SearchIcon() {
      return React.createElement('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true',
      },
        React.createElement('circle', { cx: 6.9, cy: 6.9, r: 4.6 }),
        React.createElement('path', { d: 'M10.4 10.4 14.2 14.2' }),
      )
    }

    /** A circular arrow, the conventional "reload" glyph. */
    function ReloadIcon() {
      return React.createElement('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
        // Three-quarter arc closing at the top, then the corner arrowhead that
        // sits on the open end — the shape everyone reads as "reload".
        React.createElement('path', { d: 'M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33' }),
        React.createElement('path', { d: 'M14 2v3.33h-3.33' }),
      )
    }

    /* ---------------- ① workspace explorer ---------------- */

    /**
     * Open the Session's absolute workspace directory in the OS file manager.
     *
     * The shipped `open-in-app` host plugin already owns this: it registers the
     * `explorer` launcher (a `shell-open` handoff, because spawning
     * `explorer.exe <dir>` directly does not reliably raise a window) and fences
     * the route with the connection's Host/Origin check plus the login cookie.
     * So this button posts to that route rather than reimplementing it.
     *
     * @param root0 - standard Session props.
     * @param root0.useSessions - Session list snapshot (holds each row's cwd).
     * @param root0.sessionId - the Session this header belongs to.
     */
    let fileManagerAppPromise = null
    function resolveFileManagerApp() {
      if (fileManagerAppPromise === null) {
        const preferred = ['explorer', 'finder', 'files']
        fileManagerAppPromise = fetch('open-in-app/apps')
          .then(res => (res.ok ? res.json() : null))
          .then(data => {
            const apps = Array.isArray(data?.apps) ? data.apps : []
            return preferred.find(id => apps.includes(id)) ?? 'explorer'
          })
          .catch(() => 'explorer')
      }
      return fileManagerAppPromise
    }

    function ExplorerButton({ useSessions, sessionId }) {
      const cwd = useSessions(s => s.byId[sessionId]?.cwd)
      const [state, setState] = useState('idle')
      const title = cwd === undefined
        ? '工作区路径未知，暂不能打开'
        : `在资源管理器中打开：${cwd}`

      const open = useCallback(() => {
        if (cwd === undefined || state === 'busy') return
        setState('busy')
        // Relative route: the browser half must stay same-origin so the Host's
        // trust fence accepts the request.
        resolveFileManagerApp().then(app => fetch('open-in-app/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app, path: cwd }),
        })).then(
          response => setState(response.ok ? 'idle' : 'error'),
          () => setState('error'),
        ).then(() => {
          // Clear a transient failure mark so one bad click is not permanent.
          setTimeout(() => setState(current => (current === 'error' ? 'idle' : current)), 2600)
        })
      }, [cwd, state])

      return React.createElement('button', {
        type: 'button',
        className: 'dsh-workbench-icon',
        title,
        'aria-label': title,
        'data-busy': state === 'busy' ? 'true' : 'false',
        'data-state': state,
        disabled: cwd === undefined,
        onClick: open,
      }, React.createElement(FolderIcon))
    }

    /* ---------------- ② reload the page ---------------- */

    /**
     * Re-fetch the whole document.
     *
     * A client plugin hot-reloads, but the boot manifest that decides WHICH
     * plugin bundles to fetch is baked into the served HTML. After a plugin
     * rename that manifest still names the old bundle, so the page keeps asking
     * for a route that no longer resolves until the document is reloaded. The
     * reload button is the shortest way back to a working UI from here.
     */
    function ReloadButton() {
      const [busy, setBusy] = useState(false)

      const reload = useCallback(() => {
        setBusy(true)
        // `cache: 'reload'` would need a fetch first; location.reload() already
        // revalidates the document, which is the part that carries the manifest.
        window.location.reload()
      }, [])

      return React.createElement('button', {
        type: 'button',
        className: 'dsh-workbench-icon',
        title: '刷新页面（重新加载插件清单）',
        'aria-label': '刷新页面',
        'data-busy': busy ? 'true' : 'false',
        onClick: reload,
      }, React.createElement(ReloadIcon))
    }

    /* ---------------- in-conversation find ---------------- */

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'svg'])

    /**
     * The chat's own scrollport, used for SCROLLING only.
     *
     * It is NOT a valid search root: the composer seat is a sibling of the chat
     * column inside this same scroll body, so walking its text also matches
     * whatever the user is currently typing (measured: 1 of 23 hits landed in
     * the composer). Search uses {@link findChatColumn} instead.
     * @returns the scrollable chat container, or null.
     */
    function findScroller() {
      const column = document.querySelector('[data-chat-flow]')
      if (column === null) return null
      let el = column.parentElement
      while (el !== null && el !== document.documentElement) {
        const style = getComputedStyle(el)
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8) {
          return el
        }
        el = el.parentElement
      }
      return null
    }

    /**
     * The chat column itself — the only element whose text is conversation
     * content. The composer, the sidebar and the shell chrome are all outside it.
     * @returns the chat column, or null while no conversation is mounted.
     */
    function findChatColumn() {
      return document.querySelector('[data-chat-flow]:not([data-step-process-content])')
        ?? document.querySelector('[data-chat-flow]')
    }

    /**
     * Whether a text node is actually visible to the reader.
     *
     * `getClientRects()` is NOT enough: a collapsed reasoning block clips its
     * body with an ancestor's overflow/max-height, and the text still reports
     * two client rects. Measured on a real collapsed think row:
     * `rects: 2, height: 17, checkVisibility: false`. Searching that text made
     * the counter promise hits the reader could never see, and navigation then
     * "did nothing" for several presses.
     *
     * `checkVisibility` is the authority when present; the rect check stays as
     * the fallback for older engines.
     * @param node - candidate text node.
     * @returns whether at least part of it is rendered and visible.
     */
    function isVisibleText(node) {
      const parent = node.parentElement
      if (parent === null) return false
      if (typeof parent.checkVisibility === 'function') {
        if (!parent.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false
      }
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = range.getClientRects()
      for (const rect of rects) {
        if (rect.height > 0 && rect.width > 0) return true
      }
      return false
    }

    /**
     * Collect every painted match of `query` inside `root`, in document order.
     * @param root - scope element.
     * @param query - literal needle (case-insensitive).
     * @param limit - hard cap so a one-letter query cannot freeze the tab.
     * @returns ranges, ready for the CSS Custom Highlight API.
     */
    function collectRanges(root, query, limit) {
      const ranges = []
      if (root === null || query === '') return ranges
      const needle = query.toLowerCase()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (parent === null) return NodeFilter.FILTER_REJECT
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT
          if (parent.closest('.dsh-workbench-bar') !== null) return NodeFilter.FILTER_REJECT
          if ((node.nodeValue ?? '').trim() === '') return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      let node = walker.nextNode()
      while (node !== null && ranges.length < limit) {
        const haystack = (node.nodeValue ?? '').toLowerCase()
        if (haystack.includes(needle) && isVisibleText(node)) {
          let from = haystack.indexOf(needle)
          while (from !== -1 && ranges.length < limit) {
            const range = document.createRange()
            range.setStart(node, from)
            range.setEnd(node, from + needle.length)
            ranges.push(range)
            from = haystack.indexOf(needle, from + needle.length)
          }
        }
        node = walker.nextNode()
      }
      return ranges
    }

    /**
     * Painter for the matches; `current` also gets its own later-registered
     * highlight so it can be styled differently.
     *
     * The API is read off `window` explicitly, never as a bare `CSS`: inside the
     * plugin module scope a bare `CSS` resolves to something other than the
     * `window.CSS` namespace (verified — `CSS.highlights` read as undefined there
     * while `window.CSS.highlights` worked in the same document).
     * @param ranges - match ranges in document order.
     * @param current - index of the focused match.
     * @returns whether the runtime can paint at all.
     */
    function paint(ranges, current) {
      const api = typeof window !== 'undefined' ? window.CSS : undefined
      const HighlightCtor = typeof window !== 'undefined' ? window.Highlight : undefined
      if (api === undefined || api === null || api.highlights === undefined || typeof HighlightCtor !== 'function') {
        return false
      }
      if (ranges.length === 0) {
        api.highlights.delete(HIGHLIGHT_ALL)
        api.highlights.delete(HIGHLIGHT_CURRENT)
        return true
      }
      // A runtime can expose the API and still refuse a range (a detached node
      // between re-renders). Paint is decoration: swallowing that keeps the
      // counter and navigation working instead of blanking the bar.
      try {
        api.highlights.set(HIGHLIGHT_ALL, new HighlightCtor(...ranges))
        const one = ranges[current]
        if (one === undefined) api.highlights.delete(HIGHLIGHT_CURRENT)
        else api.highlights.set(HIGHLIGHT_CURRENT, new HighlightCtor(one))
      } catch {
        return false
      }
      return true
    }

    /** Nearest scrollable ancestor of `node` that is not `stopAt`. */
    function innerScroller(node, stopAt) {
      let el = node instanceof Element ? node : node?.parentElement ?? null
      while (el !== null && el !== stopAt && el !== document.documentElement) {
        const style = getComputedStyle(el)
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
          return el
        }
        el = el.parentElement
      }
      return null
    }

    /**
     * Centre `range` inside one scrollport.
     * @param scroller - the scrollport to move.
     * @param range - match to centre.
     * @param smooth - animate.
     */
    function centreIn(scroller, range, smooth) {
      const rect = range.getBoundingClientRect()
      const box = scroller.getBoundingClientRect()
      if (rect.height === 0 && rect.width === 0) return
      // Release the app's follow pin. Its reading policy only needs the gesture
      // to have happened; `deltaY: 0` carries no scrolling of its own.
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, bubbles: true, cancelable: true }))
      const desired = scroller.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const clamped = Math.max(0, Math.min(desired, max))
      if (smooth) scroller.scrollTo({ top: clamped, behavior: 'smooth' })
      else scroller.scrollTop = clamped
    }

    /**
     * Bring one range into view, handling BOTH scrollports it can sit in.
     *
     * The chat has its own scrollport, and a match can also be buried inside a
     * nested one — a Markdown table gets `overflow: auto` and its own scroll
     * box, so centring the chat alone leaves the hit clipped inside the table.
     * Innermost first, then the chat, because moving the inner box changes what
     * the outer measurement should centre on.
     *
     * A bare `scrollTop` write does not survive a frame in this shell: the chat
     * restores its pinned position unless its reading policy saw a reader
     * gesture. `centreIn` dispatches one before writing.
     *
     * `scrollIntoView` is not used: it walks every scrollable ancestor and the
     * shell nests several, so it would drag the outer panel along.
     *
     * @param container - the chat scrollport.
     * @param range - the match to reveal.
     * @param smooth - animate (pointer navigation animates; a re-scan
     * correction does not).
     * @returns whether the chat scrollport was repositioned.
     */
    function reveal(container, range, smooth) {
      if (container === null || range === null) return false
      const inner = innerScroller(range.startContainer, container)
      if (inner !== null) centreIn(inner, range, smooth)
      centreIn(container, range, smooth)
      return true
    }

    function FindBar() {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [index, setIndex] = useState(0)
      const [count, setCount] = useState(0)
      const [wholePage, setWholePage] = useState(false)
      const [paintable, setPaintable] = useState(true)
      const [revision, setRevision] = useState(0)
      // Bumped only by an explicit navigation (step, new query, opening a bar
      // with a seed). Scrolling is driven by this counter alone, so a re-scan
      // caused by the reader's own scrolling cannot pull the view back.
      const [navigation, setNavigation] = useState(0)
      const inputRef = useRef(null)
      const rangesRef = useRef([])

      // The shortcut and the header button both publish this event; a seed
      // carries the text the user already had selected, so opening the bar over
      // a highlighted phrase searches for it immediately.
      useEffect(() => {
        const onOpen = event => {
          const seed = typeof event.detail?.seed === 'string' ? event.detail.seed : ''
          setOpen(true)
          if (seed !== '') {
            setQuery(seed)
            setIndex(0)
          }
          // Opening is a navigation: centre the first (or seeded) hit once.
          setNavigation(value => value + 1)
        }
        window.addEventListener(FIND_OPEN_EVENT, onOpen)
        return () => window.removeEventListener(FIND_OPEN_EVENT, onOpen)
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const el = inputRef.current
        if (el !== null) {
          el.focus()
          el.select()
        }
        return undefined
      }, [open])

      // Re-collect whenever the flow mutates (a streaming reply, a new turn) so
      // the count never describes a stale DOM. Debounced: a token stream fires
      // mutations far faster than anyone can read a counter.
      useEffect(() => {
        if (!open) return undefined
        let timer
        const observer = new MutationObserver(() => {
          clearTimeout(timer)
          timer = setTimeout(() => setRevision(value => value + 1), 220)
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        return () => {
          clearTimeout(timer)
          observer.disconnect()
        }
      }, [open])

      // Collect, paint, and reveal in ONE effect.
      //
      // Splitting them (collect on [query, revision], reveal on [index]) breaks
      // as soon as the flow mutates: scrolling itself lazy-loads more history,
      // which changes the match list while `index` stays put, so the reveal
      // would run against the previous array and leave the focused hit
      // thousands of pixels off screen (measured: -2576 px).
      useEffect(() => {
        if (!open) {
          rangesRef.current = []
          paint([], 0)
          return
        }
        // Search scope is the CHAT COLUMN, never its scroll body: the composer
        // lives in the same scroll body, so using it matched the user's draft.
        const root = wholePage ? document.body : (findChatColumn() ?? document.body)
        const ranges = collectRanges(root, query, 2000)
        rangesRef.current = ranges
        setCount(ranges.length)
        const next = ranges.length === 0 ? 0 : Math.min(index, ranges.length - 1)
        if (next !== index) {
          setIndex(next)
          return
        }
        setPaintable(paint(ranges, next))
        // Deliberately NO reveal here. `revision` bumps on every DOM mutation —
        // including the paging that scrolling itself triggers — so revealing on
        // it re-centres the hit continuously and the reader cannot scroll away.
        // Only `navigation` (an explicit step, a new query, or the bar opening)
        // is allowed to move the viewport.
      }, [open, query, wholePage, revision, index])

      const close = useCallback(() => {
        setOpen(false)
        paint([], 0)
        rangesRef.current = []
      }, [])

      const totalRef = useRef(0)

      const step = useCallback(direction => {
        setIndex(current => {
          const total = rangesRef.current.length
          if (total === 0) {
            totalRef.current = 0
            return 0
          }
          // The match list GROWS underneath us as scrolling lazily loads older
          // history. Wrapping there is wrong: the reader pressed "next" at hit
          // 4 of 4 because that was the end a moment ago, and wrapping to 0
          // teleports them to the bottom of a list they never saw. Only wrap
          // around a list that did not change since the previous step.
          const grew = total > totalRef.current
          totalRef.current = total
          const next = current + direction
          if (next < 0) return total - 1
          if (next >= total) return grew ? total - 1 : 0
          return next
        })
        setNavigation(value => value + 1)
      }, [])

      // The one place that scrolls. Runs on an explicit navigation only, never on
      // a re-scan, so the reader's own scrolling is never fought.
      //
      // One corrective re-check follows, because a query change can force the
      // chat to lazily load history, which shifts everything the first reveal
      // measured. The correction is abandoned the moment the reader scrolls, so
      // it can never pull the viewport back out from under them.
      const readerMovedRef = useRef(false)
      const indexRef = useRef(index)
      indexRef.current = index
      useEffect(() => {
        if (!open || navigation === 0) return undefined
        const container = wholePage ? document.scrollingElement : (findScroller() ?? findChatColumn())
        reveal(container, rangesRef.current[indexRef.current] ?? null, true)
        if (container === null) return undefined
        const generation = navigation
        readerMovedRef.current = false
        const markMoved = () => { readerMovedRef.current = true }
        container.addEventListener('wheel', markMoved, { passive: true })
        container.addEventListener('touchstart', markMoved, { passive: true })
        const timer = setTimeout(() => {
          if (readerMovedRef.current) return
          if (generation !== navigation) return
          const target = rangesRef.current[indexRef.current] ?? null
          if (target === null) return
          const rect = target.getBoundingClientRect()
          const box = container.getBoundingClientRect()
          if (rect.bottom >= box.top && rect.top <= box.bottom) return
          reveal(container, target, false)
        }, 420)
        return () => {
          clearTimeout(timer)
          container.removeEventListener('wheel', markMoved)
          container.removeEventListener('touchstart', markMoved)
        }
      }, [navigation])

      if (!open) return null

      const onKeyDown = event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          step(event.shiftKey ? -1 : 1)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'F3') {
          event.preventDefault()
          step(1)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          step(-1)
        }
      }

      return React.createElement('div', {
        className: 'dsh-workbench-bar',
        role: 'search',
        'aria-label': '在会话中查找',
        onKeyDown,
      },
        React.createElement('input', {
          ref: inputRef,
          type: 'text',
          value: query,
          placeholder: wholePage ? '在当前页面查找…' : '在当前会话中查找…',
          'aria-label': '查找内容',
          onChange: event => {
            setQuery(event.target.value)
            setIndex(0)
            setNavigation(value => value + 1)
          },
        }),
        React.createElement('span', {
          className: 'dsh-workbench-count',
          'data-empty': query !== '' && count === 0 ? 'true' : 'false',
          title: paintable ? undefined : '当前运行时没有 CSS Custom Highlight API：计数与跳转可用，高亮不可用',
        }, query === '' ? '' : `${count === 0 ? 0 : index + 1}/${count}`),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-workbench-btn',
          title: '上一处（Shift+Enter / ↑）',
          disabled: count === 0,
          onClick: () => step(-1),
        }, '↑'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-workbench-btn',
          title: '下一处（Enter / ↓）',
          disabled: count === 0,
          onClick: () => step(1),
        }, '↓'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-workbench-scope',
          title: wholePage ? '只搜当前会话' : '搜整个页面',
          onClick: () => {
            setWholePage(value => !value)
            setIndex(0)
            setNavigation(value => value + 1)
          },
        }, wholePage ? '整页' : '会话'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-workbench-btn',
          title: '关闭（Esc）',
          onClick: close,
        }, '✕'),
      )
    }

    /* ---------------- ② duration badge (unchanged contract) ---------------- */

    /**
     * Fallback fold over the loaded chat nodes, used only until the host
     * projection arrives.
     * @param nodes - loaded chat nodes of the current Session.
     * @returns figures shaped like the projection's view.
     */
    function foldNodes(nodes) {
      let llmMs = 0
      let toolMs = 0
      let askMs = 0
      let asks = 0
      let toolCalls = 0
      let steps = 0
      const tools = {}
      const turns = new Set()
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue
        if (node.kind === 'tool-result') {
          if (node.callTime === null || node.callTime === undefined) continue
          const ms = Math.max(0, node.time - node.callTime)
          toolCalls += 1
          const name = node.name || node.call?.name || '(unnamed)'
          if (name === 'ask_user_question') {
            askMs += ms
            asks += 1
            continue
          }
          toolMs += ms
          const row = tools[name] ?? { calls: 0, ms: 0, maxMs: 0, errors: 0 }
          tools[name] = {
            calls: row.calls + 1,
            ms: row.ms + ms,
            maxMs: Math.max(row.maxMs, ms),
            errors: row.errors + (node.isError === true ? 1 : 0),
          }
          continue
        }
        if (node.kind !== 'assistant') continue
        steps += 1
        if (typeof node.turn === 'number') turns.add(node.turn)
        const timing = node.timing
        if (timing === undefined || timing === null) continue
        if (timing.stepStartTime !== null && timing.stepStartTime !== undefined) {
          llmMs += Math.max(0, timing.completedTime - timing.stepStartTime)
        }
      }
      // The window carries no step/end event, so a closed step is recovered as
      // its model span plus the tool spans (and question waits excluded from
      // aiWorkingMs, matching the host projection).
      const aiWorkingMs = llmMs + toolMs
      const busyMs = aiWorkingMs + askMs
      return {
        aiWorkingMs,
        busyMs,
        llmMs,
        toolMs,
        askMs,
        asks,
        toolCalls,
        steps,
        turns: turns.size,
        tools,
        approvals: 0,
        approvalMs: 0,
        approvalByTool: {},
        openStep: null,
      }
    }

    function WorkbenchBadge({ useProjection, useChat }) {
      const stats = useProjection('workbenchStats')
      const nodes = useChat(s => s.legacy.nodes)
      const fallback = useMemo(
        () => (stats === undefined || stats === null) && nodes !== undefined
          ? foldNodes(nodes.values())
          : null,
        [stats, nodes],
      )
      const source = stats ?? fallback
      const openStep = source?.openStep ?? null

      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        if (openStep === null) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [openStep === null ? null : openStep.start])

      const [open, setOpen] = useState(false)
      const anchorRef = useRef(null)
      const panelRef = useRef(null)
      const [pos, setPos] = useState(null)

      const liveStepMs = openStep === null ? 0 : Math.max(0, now - openStep.start)
      const workingMs = (source?.aiWorkingMs ?? 0) + liveStepMs

      useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const anchor = anchorRef.current
          const panel = panelRef.current
          if (anchor === null || panel === null) return
          const box = anchor.getBoundingClientRect()
          const width = panel.offsetWidth
          const height = panel.offsetHeight
          const left = Math.min(Math.max(8, box.right - width), window.innerWidth - width - 8)
          const below = box.bottom + 8
          const top = below + height > window.innerHeight - 8
            ? Math.max(8, box.top - height - 8)
            : below
          setPos({ left, top })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        const onDown = event => {
          const inPanel = panelRef.current?.contains(event.target) === true
          const inAnchor = anchorRef.current?.contains(event.target) === true
          if (!inPanel && !inAnchor) setOpen(false)
        }
        const onKey = event => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const tools = useMemo(() => {
        const approvalByTool = source?.approvalByTool ?? {}
        const rows = Object.entries(source?.tools ?? {}).map(([tool, value]) => {
          const waitMs = approvalByTool[tool]?.ms ?? 0
          return {
            tool,
            calls: value.calls ?? 0,
            rawMs: value.ms ?? 0,
            waitMs,
            execMs: Math.max(0, (value.ms ?? 0) - waitMs),
          }
        })
        rows.sort((a, b) => (b.execMs - a.execMs) || (b.calls - a.calls))
        return rows
      }, [source?.tools, source?.approvalByTool])

      const toolCallsShown = useMemo(
        () => tools.reduce((sum, item) => sum + item.calls, 0),
        [tools],
      )

      if (source === undefined || source === null) {
        // Neither the projection nor the window fold has data yet. Show a
        // placeholder instead of vanishing, so a missing number is visible.
        return React.createElement('button', {
          type: 'button',
          className: 'dsh-workbench-badge',
          'data-live': 'false',
          title: '会话耗时：正在读取…',
          disabled: true,
        },
          React.createElement('span', { className: 'dsh-workbench-dot' }),
          React.createElement('span', null, '—'),
        )
      }

      const badge = React.createElement('button', {
        ref: anchorRef,
        type: 'button',
        className: 'dsh-workbench-badge',
        'data-live': openStep === null ? 'false' : 'true',
        title: '本会话 AI 实际工作时长（不含等待你审批和回答的时间）',
        'aria-expanded': open,
        'aria-controls': open ? PANEL_ID : undefined,
        onClick: () => setOpen(value => !value),
      },
        React.createElement('span', { className: 'dsh-workbench-dot' }),
        React.createElement('span', null, span(workingMs)),
      )

      if (!open) return badge

      const approvalMs = source.approvalMs ?? 0
      const askMs = source.askMs ?? 0
      const toolMs = source.toolMs ?? 0
      const modelMs = source.llmMs ?? 0

      const row = (label, ms, hint) => [
        React.createElement('dt', { key: `l:${label}`, title: hint }, label),
        React.createElement('dd', { key: `v:${label}`, 'data-zero': ms === 0 ? 'true' : 'false' }, precise(ms)),
      ]

      const panel = React.createElement('div', {
        ref: panelRef,
        id: PANEL_ID,
        className: 'dsh-workbench-panel',
        role: 'dialog',
        'aria-label': '会话耗时分解',
        style: pos === null ? { right: 26, top: 56 } : { left: pos.left, top: pos.top },
      },
        React.createElement('div', { className: 'dsh-workbench-title' },
          React.createElement('span', null, 'AI 工作时长'),
          React.createElement('small', null, `${source.turns ?? 0} 轮 · ${source.steps ?? 0} 步`),
        ),
        React.createElement('div', { className: 'dsh-workbench-hero' },
          React.createElement('b', null, precise(workingMs)),
          React.createElement('span', null,
            openStep === null
              ? '已结束的全部步骤之和，不含等待你审批和回答的时间'
              : '进行中：已计入当前步骤'),
        ),
        React.createElement('dl', { className: 'dsh-workbench-rows' },
          [
            row('模型输出', modelMs, 'step/start → assistant/message'),
            row('工具执行', toolMs, 'tool/call → tool/result，已减去审批和提问等待'),
            row('等待你审批', approvalMs, 'approval/asked → approval/decided'),
            askMs > 0 ? row('等待你回答', askMs, 'ask_user_question 的 tool/call → tool/result') : null,
            row('步骤总跨度', source.busyMs ?? 0, 'step/start → step/end，含等待'),
          ].filter(part => part !== null).flat(),
        ),
        (approvalMs > 0 || askMs > 0)
          ? React.createElement('div', { className: 'dsh-workbench-wait' },
            `其中 ${precise(approvalMs + askMs)} 是在等你（审批 ${precise(approvalMs)} + 回答 ${precise(askMs)}），已从「工具执行」和「AI 工作时长」里扣除。`)
          : null,
        tools.length > 0
          ? React.createElement('div', null,
            React.createElement('div', { className: 'dsh-workbench-sec' }, `工具明细 · ${toolCallsShown} 次`),
            React.createElement('div', { className: 'dsh-workbench-tools' },
              React.createElement('span', { className: 'n', style: { opacity: .5 } }, '名称'),
              React.createElement('span', { className: 'c' }, '次数'),
              React.createElement('span', { className: 't', style: { opacity: .5 } }, '总耗时'),
              ...tools.slice(0, 14).flatMap(({ tool, calls, rawMs, waitMs, execMs }) => [
                React.createElement('span', {
                  key: `n:${tool}`,
                  className: 'n',
                  title: waitMs > 0
                    ? `${tool}（原始 ${precise(rawMs)}，已扣审批 ${precise(waitMs)}）`
                    : tool,
                }, tool),
                React.createElement('span', { key: `c:${tool}`, className: 'c' }, String(calls)),
                React.createElement('span', { key: `t:${tool}`, className: 't' }, precise(execMs)),
              ]),
            ),
          )
          : null,
        React.createElement('div', { className: 'dsh-workbench-note' },
          '数字来自宿主对会话日志的整体折叠，翻页、刷新都不改变它。'
          + '各工具耗时已扣除审批等待。'),
      )

      return React.createElement(React.Fragment, null, badge, panel)
    }

    /** Header magnifier that opens the find bar by pointer. */
    function FindButton() {
      return React.createElement('button', {
        type: 'button',
        className: 'dsh-workbench-icon',
        title: '在会话中查找（Ctrl+Alt+Shift+F，或 Ctrl+Shift+F）',
        'aria-label': '在会话中查找',
        // Seed from the current selection so a highlighted phrase becomes the
        // query. The bar picks it up and selects the field for replacement.
        onClick: openFindBar,
      }, React.createElement(SearchIcon))
    }

    /* ---------------- pending-interaction alert ---------------- */

    /**
     * The alert system exists because a one-shot sound is the wrong instrument
     * for this problem: the user is away from the keyboard precisely when a
     * prompt appears, so a single chime is heard by nobody. This repeats until
     * the prompt is answered.
     *
     * The signal is `useSessionStatus(...).pendingInteraction`, which is a
     * PERSISTENT state projected by `uiSession` from the domains that publish
     * pending interactions (`ui-approval` for approval prompts,
     * `ui-user-questions` for question cards). It stays truthy for as long as
     * the prompt is on screen, which is exactly the lifetime we need — no
     * guessing from transient events.
     */
    const NOTIFY_KEY = 'dsh-workbench:notify'
    const AUDIO_DB = 'dsh-workbench-audio'
    const AUDIO_STORE = 'clips'
    const CUSTOM_CLIP = 'custom'

    const BUILTIN_SOUNDS = [
      { id: 'chime', label: '清脆双音（默认）' },
      { id: 'pulse', label: '短促脉冲' },
      { id: 'bell', label: '柔和铃音' },
      { id: 'file', label: '自定义音效…' },
    ]

    const DEFAULT_NOTIFY = {
      enabled: true,
      intervalSec: 15,
      volume: 0.6,
      sound: 'chime',
      fileName: '',
      maxSeconds: 600,
    }

    function sanitizeNotify(raw) {
      const out = { ...DEFAULT_NOTIFY }
      if (typeof raw !== 'object' || raw === null) return out
      if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
      if (Number.isFinite(raw.intervalSec)) {
        out.intervalSec = Math.min(600, Math.max(3, Math.round(raw.intervalSec)))
      }
      if (Number.isFinite(raw.volume)) out.volume = Math.min(1, Math.max(0, raw.volume))
      if (typeof raw.sound === 'string' && BUILTIN_SOUNDS.some(entry => entry.id === raw.sound)) {
        out.sound = raw.sound
      }
      if (typeof raw.fileName === 'string') out.fileName = raw.fileName
      if (Number.isFinite(raw.maxSeconds)) {
        out.maxSeconds = Math.min(7200, Math.max(0, Math.round(raw.maxSeconds)))
      }
      return out
    }

    /**
     * One config store shared by the settings page and the alert runtime.
     * localStorage is the right home: this is a UI preference, not session
     * data, and it must survive a restart without a host round-trip.
     */
    function createNotifyStore() {
      let snapshot = { status: 'ready', value: DEFAULT_NOTIFY }
      const listeners = new Set()
      const read = () => {
        try {
          const raw = window.localStorage.getItem(NOTIFY_KEY)
          return raw === null ? null : JSON.parse(raw)
        } catch (error) {
          return null
        }
      }
      const commit = next => {
        snapshot = { status: 'ready', value: next }
        try {
          window.localStorage.setItem(NOTIFY_KEY, JSON.stringify(next))
        } catch (error) {
          // Quota or a locked-down profile: the value still lives in memory.
        }
        for (const listener of [...listeners]) listener()
      }
      snapshot = { status: 'ready', value: sanitizeNotify(read()) }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(patch) {
          commit(sanitizeNotify({ ...snapshot.value, ...patch }))
        },
        reset() {
          commit({ ...DEFAULT_NOTIFY })
        },
      }
    }

    const notifyStore = createNotifyStore()

    /** Subscribe a component to the shared store. */
    function useNotifyConfig() {
      const [snapshot, setSnapshot] = useState(() => notifyStore.getSnapshot())
      useEffect(() => notifyStore.subscribe(() => setSnapshot(notifyStore.getSnapshot())), [])
      return snapshot.value
    }

    /* --- IndexedDB: the chosen clip is a data URL, too big for localStorage --- */

    let audioDbPromise = null
    function openAudioDb() {
      if (typeof window.indexedDB === 'undefined') return Promise.resolve(null)
      return new Promise(resolve => {
        let request
        try {
          request = window.indexedDB.open(AUDIO_DB, 1)
        } catch (error) {
          resolve(null)
          return
        }
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      })
    }

    function audioDb() {
      if (audioDbPromise === null) audioDbPromise = openAudioDb()
      return audioDbPromise
    }

    async function clipPut(dataUrl) {
      const db = await audioDb()
      if (db === null) return false
      return new Promise(resolve => {
        try {
          const tx = db.transaction(AUDIO_STORE, 'readwrite')
          tx.objectStore(AUDIO_STORE).put(dataUrl, CUSTOM_CLIP)
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => resolve(false)
        } catch (error) {
          resolve(false)
        }
      })
    }

    async function clipGet() {
      const db = await audioDb()
      if (db === null) return null
      return new Promise(resolve => {
        try {
          const tx = db.transaction(AUDIO_STORE, 'readonly')
          const request = tx.objectStore(AUDIO_STORE).get(CUSTOM_CLIP)
          request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
          request.onerror = () => resolve(null)
        } catch (error) {
          resolve(null)
        }
      })
    }

    async function clipDel() {
      const db = await audioDb()
      if (db === null) return
      try {
        const tx = db.transaction(AUDIO_STORE, 'readwrite')
        tx.objectStore(AUDIO_STORE).delete(CUSTOM_CLIP)
      } catch (error) {
        // Nothing to remove.
      }
    }

    /* --- playback --- */

    let audioContext = null

    /**
     * An AudioContext starts suspended until a user gesture unlocks it, and a
     * prompt can appear before the user has ever clicked. So the first gesture
     * anywhere unlocks it once, and every later chime reuses the same context.
     */
    function ensureAudio() {
      if (audioContext === null) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (Ctor === undefined) return null
        try {
          audioContext = new Ctor()
        } catch (error) {
          return null
        }
        const detach = () => {
          window.removeEventListener('pointerdown', unlock, true)
          window.removeEventListener('keydown', unlock, true)
        }
        const unlock = () => {
          if (audioContext === null || audioContext.state === 'running') {
            detach()
            return
          }
          if (audioContext.state === 'suspended') {
            audioContext.resume().then(detach, () => {})
          }
        }
        window.addEventListener('pointerdown', unlock, true)
        window.addEventListener('keydown', unlock, true)
      }
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
      return audioContext
    }

    /** One shaped tone: envelope in, silence out. */
    function tone(ctx, { freq, at, dur, type, peak }) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(freq, at)
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + dur + 0.02)
    }

    function synth(kind, volume) {
      const ctx = ensureAudio()
      if (ctx === null) return
      const v = Math.min(1, Math.max(0, volume))
      const now = ctx.currentTime + 0.01
      if (kind === 'pulse') {
        tone(ctx, { freq: 1180, at: now, dur: 0.09, type: 'square', peak: 0.16 * v })
        tone(ctx, { freq: 1180, at: now + 0.16, dur: 0.09, type: 'square', peak: 0.16 * v })
        return
      }
      if (kind === 'bell') {
        tone(ctx, { freq: 660, at: now, dur: 0.9, type: 'triangle', peak: 0.3 * v })
        tone(ctx, { freq: 1320, at: now, dur: 0.6, type: 'sine', peak: 0.12 * v })
        return
      }
      // chime: a rising two-note figure, bright but not shrill
      tone(ctx, { freq: 880, at: now, dur: 0.3, type: 'sine', peak: 0.28 * v })
      tone(ctx, { freq: 1320, at: now + 0.17, dur: 0.42, type: 'sine', peak: 0.22 * v })
    }

    async function playAlert(config) {
      if (config.sound === 'file') {
        const dataUrl = await clipGet()
        if (dataUrl !== null) {
          try {
            const audio = new window.Audio(dataUrl)
            audio.volume = Math.min(1, Math.max(0, config.volume))
            await audio.play()
            return
          } catch (error) {
            // Fall through to the synthesised chime so a broken clip is still
            // audible rather than silently doing nothing.
          }
        }
      }
      synth(config.sound === 'file' ? 'chime' : config.sound, config.volume)
    }

    /**
     * Repeat the alert while any session has a prompt open.
     *
     * Mounted in `shell.overlay`, so it exists regardless of which session view
     * is showing. The timer restarts whenever the interval setting changes and
     * stops the moment the prompt is answered — that stop is the whole point of
     * reading `pendingInteraction` instead of a one-shot event.
     */
    function AlertRuntime({ useSessionStatus }) {
      const config = useNotifyConfig()
      const pending = useSessionStatus(snapshot => {
        for (const status of snapshot.values()) {
          if (status.pendingInteraction !== undefined) return true
        }
        return false
      })

      const startedAtRef = useRef(0)

      useEffect(() => {
        if (!config.enabled || pending !== true) {
          startedAtRef.current = 0
          return undefined
        }
        startedAtRef.current = Date.now()
        // Fire immediately, then every `intervalSec`. Waiting a full interval
        // first would miss the case where the user is still at the keyboard.
        playAlert(config)
        if (config.intervalSec <= 0) return undefined
        const timer = setInterval(() => {
          if (config.maxSeconds > 0 && Date.now() - startedAtRef.current > config.maxSeconds * 1000) {
            clearInterval(timer)
            return
          }
          playAlert(config)
        }, config.intervalSec * 1000)
        return () => clearInterval(timer)
        // Re-arm when the interval, clip, or volume changes mid-wait.
      }, [config.enabled, config.intervalSec, config.sound, config.volume, config.maxSeconds, pending])

      return null
    }

    /**
     * Settings → 会话工作台。
     *
     * Deliberately its own `settings.section` entry rather than a
     * `settings.general.item` row: a row has no props and no label seat, while
     * this page needs a heading, several controls, and an explanation of what
     * the numbers mean.
     */
    function WorkbenchSettings() {
      const config = useNotifyConfig()
      const [clipName, setClipName] = useState('')
      const [clipWarning, setClipWarning] = useState('')
      const inputRef = useRef(null)

      // The clip itself lives in IndexedDB (a data URL is far past the
      // localStorage quota); only its name is in the config.
      useEffect(() => {
        let alive = true
        clipGet().then(dataUrl => {
          if (alive) setClipName(dataUrl === null ? '' : config.fileName)
        })
        return () => { alive = false }
      }, [config.fileName])

      const set = patch => notifyStore.set(patch)

      const onPick = event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return
        if (file.size > 4 * 1024 * 1024) {
          setClipWarning('文件超过 4 MB，选择短一点的提示音更合适。')
          return
        }
        setClipWarning('')
        const reader = new FileReader()
        reader.onload = async () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : ''
          if (dataUrl === '') {
            setClipWarning('读不出这个文件，换一个试试。')
            return
          }
          const saved = await clipPut(dataUrl)
          if (!saved) {
            setClipWarning('浏览器拒绝了存储（可能是隐私模式），只有本次会话有效。')
          }
          setClipName(file.name)
          set({ sound: 'file', fileName: file.name })
          // Preview right away so the user knows what they picked.
          playAlert({ ...config, sound: 'file', fileName: file.name })
        }
        reader.onerror = () => setClipWarning('读取文件失败。')
        reader.readAsDataURL(file)
      }

      const clearClip = async () => {
        await clipDel()
        setClipName('')
        setClipWarning('')
        set({ sound: 'chime', fileName: '' })
      }

      const preview = () => playAlert(config)

      return React.createElement('div', { className: 'dsh-workbench-settings' },
        React.createElement('div', { className: 'dsh-workbench-settings-title' }, '会话工作台'),
        React.createElement('div', { className: 'dsh-workbench-settings-lead' },
          '顶部徽章统计本会话 AI 的实际工作时长，并扣除等待你批准、等待你回答问题的时间。'),
        React.createElement('div', { className: 'dsh-workbench-settings-lead' },
          '下面的提醒用于「需要你点一下」的场景：审批弹窗和提问弹窗出现后，按设定的间隔反复响，直到你处理为止——不会像一次性提示那样错过。'),

        React.createElement('div', { className: 'dsh-workbench-field' },
          React.createElement('div', { className: 'dsh-workbench-field-label' },
            React.createElement('b', null, '需要确认时提醒'),
            React.createElement('small', null, '审批或提问弹窗出现时播放'),
          ),
          React.createElement('label', { className: 'dsh-workbench-check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: config.enabled,
              onChange: event => set({ enabled: event.target.checked }),
            }),
            React.createElement('span', null, config.enabled ? '已开启' : '已关闭'),
          ),
        ),

        React.createElement('div', { className: 'dsh-workbench-field' },
          React.createElement('div', { className: 'dsh-workbench-field-label' },
            React.createElement('b', null, '提醒间隔'),
            React.createElement('small', null, '弹窗还开着就每这么多秒响一次'),
          ),
          React.createElement('div', { className: 'dsh-workbench-field-body' },
            React.createElement('input', {
              type: 'number', min: 3, max: 600, step: 1,
              value: config.intervalSec,
              disabled: !config.enabled,
              onChange: event => {
                const value = Number(event.target.value)
                if (Number.isFinite(value)) set({ intervalSec: value })
              },
            }),
            React.createElement('span', { className: 'dsh-workbench-num' }, '秒'),
          ),
        ),

        React.createElement('div', { className: 'dsh-workbench-field' },
          React.createElement('div', { className: 'dsh-workbench-field-label' },
            React.createElement('b', null, '最长提醒'),
            React.createElement('small', null, '超过这个时长就停，0 表示不限'),
          ),
          React.createElement('div', { className: 'dsh-workbench-field-body' },
            React.createElement('input', {
              type: 'number', min: 0, max: 7200, step: 30,
              value: config.maxSeconds,
              disabled: !config.enabled,
              onChange: event => {
                const value = Number(event.target.value)
                if (Number.isFinite(value)) set({ maxSeconds: value })
              },
            }),
            React.createElement('span', { className: 'dsh-workbench-num' }, '秒'),
          ),
        ),

        React.createElement('div', { className: 'dsh-workbench-field' },
          React.createElement('div', { className: 'dsh-workbench-field-label' },
            React.createElement('b', null, '提示音'),
            React.createElement('small', null, '内置三种，也可以导入自己的'),
          ),
          React.createElement('div', { className: 'dsh-workbench-field-body' },
            React.createElement('select', {
              value: config.sound,
              disabled: !config.enabled,
              onChange: event => {
                const value = event.target.value
                if (value === 'file' && clipName === '') {
                  inputRef.current?.click()
                  return
                }
                set({ sound: value })
                playAlert({ ...config, sound: value === 'file' ? 'file' : value })
              },
            }, BUILTIN_SOUNDS.map(sound => React.createElement('option', {
              key: sound.id, value: sound.id,
            }, sound.id === 'file' && clipName !== '' ? `自定义：${clipName}` : sound.label))),
            React.createElement('button', {
              type: 'button',
              disabled: !config.enabled,
              onClick: preview,
            }, '试听'),
            React.createElement('input', {
              ref: inputRef, type: 'file', accept: 'audio/*',
              style: { display: 'none' },
              onChange: onPick,
            }),
            React.createElement('button', {
              type: 'button',
              disabled: !config.enabled,
              onClick: () => inputRef.current?.click(),
            }, clipName === '' ? '导入音效' : '更换'),
            clipName === ''
              ? null
              : React.createElement('button', { type: 'button', onClick: clearClip }, '移除'),
          ),
        ),

        clipName === ''
          ? null
          : React.createElement('div', { className: 'dsh-workbench-field' },
            React.createElement('div', { className: 'dsh-workbench-field-label' }, ''),
            React.createElement('div', { className: 'dsh-workbench-field-body' },
              React.createElement('span', { className: 'dsh-workbench-file' }, `当前音效：${clipName}`),
            ),
          ),

        clipWarning === ''
          ? null
          : React.createElement('div', { className: 'dsh-workbench-field' },
            React.createElement('div', { className: 'dsh-workbench-field-label' }, ''),
            React.createElement('div', { className: 'dsh-workbench-field-body' },
              React.createElement('span', { className: 'dsh-workbench-warn' }, clipWarning),
            ),
          ),

        React.createElement('div', { className: 'dsh-workbench-field' },
          React.createElement('div', { className: 'dsh-workbench-field-label' },
            React.createElement('b', null, '音量'),
            React.createElement('small', null, '对内置音和导入音都生效'),
          ),
          React.createElement('div', { className: 'dsh-workbench-field-body' },
            React.createElement('input', {
              type: 'range', min: 0, max: 1, step: 0.05,
              value: config.volume,
              disabled: !config.enabled,
              onChange: event => set({ volume: Number(event.target.value) }),
              onPointerUp: preview,
            }),
            React.createElement('span', { className: 'dsh-workbench-num' }, `${Math.round(config.volume * 100)}%`),
          ),
        ),

        React.createElement('div', { className: 'dsh-workbench-field' },
          React.createElement('div', { className: 'dsh-workbench-field-label' }, ''),
          React.createElement('div', { className: 'dsh-workbench-field-body' },
            React.createElement('button', {
              type: 'button',
              onClick: () => notifyStore.reset(),
            }, '恢复默认'),
          ),
        ),
      )
    }

    /* ---------------- plugin body ---------------- */

    /** Publish the find-open event, seeding from the current selection. */
    function openFindBar() {
      const seed = window.getSelection()?.toString() ?? ''
      window.dispatchEvent(new CustomEvent(FIND_OPEN_EVENT, { detail: { seed } }))
    }

    /**
     * Document-level Ctrl/Cmd+Shift+F fallback.
     *
     * Deliberately NOT routed through the shortcut registry: this listener needs
     * no registration, so the feature keeps working when a default binding is
     * refused, when the profile is web:linux (whose allowlist admits only three
     * combinations), or when another plugin claims the same chord later.
     * @param ctx - client root context, used for the effect's lifetime.
     */
    function scope_onKeydown(ctx) {
      ctx.effect(() => {
        const onKeyDown = event => {
          if (event.defaultPrevented) return
          if (event.isComposing || event.repeat) return
          const primary = event.ctrlKey || event.metaKey
          if (!primary || !event.shiftKey || event.altKey) return
          if (event.code !== 'KeyF') return
          event.preventDefault()
          event.stopPropagation()
          openFindBar()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, 'workbench: find fallback binding')
    }

    /**
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('conversation.session.header.utilities', function* () {
        // A fresh id per entry adds a cell beside the shipped utilities rather
        // than replacing one. Ascending order puts explorer left of the badge.
        yield ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: EXPLORER_ID, order: 50 },
          ExplorerButton,
        )
        yield ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: BADGE_ID, order: 60 },
          WorkbenchBadge,
        )
        yield ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: FIND_ID, order: 70 },
          FindButton,
        )
        // Last in the row, so it reads as "and one more thing" rather than
        // competing with the three feature buttons.
        yield ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: RELOAD_ID, order: 80 },
          ReloadButton,
        )
      })
      // Two overlay entries in ONE activation: `slots.inject` is a one-shot
      // activation per slot, so two separate calls would race for the same slot
      // instead of adding a second cell to it.
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          { name: 'shell.overlay', id: 'workbench:find-bar' },
          FindBar,
        )
        // Renders nothing; its job is to keep the alert timer alive frame-wide
        // rather than inside one session view.
        yield ctx.slots.register(
          { name: 'shell.overlay', id: 'workbench:alert' },
          AlertRuntime,
        )
      })

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'workbench', order: 88, label: () => '会话工作台' },
        WorkbenchSettings,
      ))

      // A rebindable command instead of a raw DOM listener, so the combination
      // shows up in Settings → Shortcuts and is the user's to change.
      //
      // The binding MUST avoid everything already claimed, and it must avoid it
      // on EVERY runtime/platform profile, not just this one: `register()`
      // walks all six combinations and THROWS on an overlapping default. Taken
      // already: `deja.search-session` (desktop primary+KeyF),
      // `session.fork` (web primary+shift+KeyF), `session.new` (web primary+alt+
      // KeyN). Three modifiers is the one shape that is both web-admissible
      // (>=3 modifiers on macOS/Windows) and unclaimed.
      //
      // `web:linux` is omitted on purpose: the Web allowlist there admits only
      // three exact combinations, so any other default would throw.
      //
      // Even so, the call is guarded: a throw here used to take down
      // `dsh-client-ui-workspace` and blank the whole UI, because registration
      // runs inside that plugin's fiber. A refused shortcut must cost the
      // shortcut, nothing more.
      ctx.inject(['shortcuts'], scope => {
        try {
          scope.effect(() => scope.shortcuts.register({
            id: 'workbench.find',
            label: () => '在会话中查找',
            aliases: ['find in conversation', 'search conversation'],
            defaults: {
              'desktop:windows': { code: 'KeyF', modifiers: ['primary', 'alt', 'shift'] },
              'desktop:macos': { code: 'KeyF', modifiers: ['primary', 'alt', 'shift'] },
              'desktop:linux': { code: 'KeyF', modifiers: ['primary', 'alt', 'shift'] },
              'web:windows': { code: 'KeyF', modifiers: ['primary', 'alt', 'shift'] },
              'web:macos': { code: 'KeyF', modifiers: ['primary', 'alt', 'shift'] },
            },
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => ({ status: 'handled', run() { openFindBar() } }),
          }), 'workbench: find shortcut')
        } catch (error) {
          console.warn('[workbench] find shortcut refused; the header button and Ctrl+Shift+F still work:', error)
        }
      })

      // Belt and braces: a document-level listener for Ctrl/Cmd+Shift+F. It
      // needs no registration, so the feature survives a refused shortcut, a
      // web:linux profile, or a future collision with another plugin. Capture
      // phase so it runs before the shell's own handlers, and stopPropagation
      // so the same gesture cannot also reach the command registry.
      scope_onKeydown(ctx)
    }

    // `useSessionStatus` arrives through the slot's standardProps, so the alert
    // needs no service of its own — `slots` is the whole dependency.
    return { apply, inject: ['slots'] }
  },
})
