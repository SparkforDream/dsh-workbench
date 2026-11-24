/**
 * Build the preview cards.
 *
 * One small HTML page per feature rather than one tall page: each card answers a
 * single question, which is what a reader scanning a README actually wants.
 *
 * The CSS is read out of lib/client.js at build time so a card can never drift
 * from the shipped component; only the surrounding stage chrome is defined here.
 *
 * Usage: node scripts/build-preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'preview')
mkdirSync(outDir, { recursive: true })

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
const cssStart = source.indexOf('const CSS = `')
if (cssStart < 0) {
  console.error('CSS template literal not found in lib/client.js')
  process.exit(1)
}
const css = source.slice(cssStart + 'const CSS = `'.length, source.indexOf('\n`', cssStart))

/* ---- formatters, copied verbatim from lib/client.js so text cannot drift ---- */
const precise = ms => {
  const total = Math.round((ms ?? 0) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
const span = ms => {
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

/* ---- neutral figures: a plain 12-turn session, no personal content ---- */
const view = {
  aiWorkingMs: 4312000,
  busyMs: 4378000,
  llmMs: 3120000,
  toolRawMs: 1210000,
  approvalMs: 48000,
  askMs: 18000,
  toolMs: 1144000,
  turns: 12,
  steps: 384,
  toolCalls: 512,
}

const tools = [
  ['pwsh', 168, 742000],
  ['read', 96, 198000],
  ['edit', 54, 121000],
  ['grep', 41, 74000],
  ['write', 19, 32000],
  ['glob', 12, 21000],
]

const icons = {
  folder: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.8 4.2c0-.6.5-1 1-1h3l1.3 1.6h6.1c.6 0 1 .5 1 1v6.4c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1V4.2Z"/></svg>`,
  search: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6.9" cy="6.9" r="4.6"/><path d="M10.4 10.4 14.2 14.2"/></svg>`,
  reload: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33"/><path d="M14 2v3.33h-3.33"/></svg>`,
}

const baseStyle = `
:root {
  --dsw-alias-bg-layer-1: #1c1c1f;
  --dsw-alias-bg-layer-2: rgba(128,128,128,.09);
  --dsw-alias-bg-layer-3: rgba(128,128,128,.20);
  --dsw-alias-label-primary: #e9e9ec;
  --dsw-alias-label-secondary: #8a8a8f;
  --dsw-alias-border-primary: rgba(128,128,128,.5);
  --dsw-alias-border-secondary: rgba(128,128,128,.28);
  --dsw-alias-brand-primary: #4f8cff;
  --dsh-font-ui: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #16171a;
  color: var(--dsw-alias-label-primary);
  font: 13px/1.55 var(--dsh-font-ui);
}
.card {
  padding: 18px 20px 20px;
  background: #191a1d;
}
.bar {
  display: flex; align-items: center; gap: 6px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary);
  background: #1c1d21;
  border-radius: 10px 10px 0 0;
}
.bar .grow { flex: 1; }
.bar .title { font-size: 12.5px; font-weight: 600; opacity: .85; }
.flow { padding: 14px 16px 4px; font-size: 13px; line-height: 1.7; }
.flow p { margin: 0 0 10px; }
.flow mark { background: rgba(250, 204, 21, .34); color: inherit; border-radius: 2px; }
.flow mark.cur { background: #ffab2e; color: #101014; }
.frame {
  border: 1px solid var(--dsw-alias-border-secondary);
  border-radius: 10px;
  overflow: hidden;
  background: #191a1d;
}
.inset { padding: 14px 16px 16px; }
.note { margin-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
${css}
/* The panel and the find bar are position:fixed in the real product (they float
   over the chat). In a card they sit in normal flow, so drop the positioning but
   keep every other declaration. */
.card .dsh-workbench-panel,
.card .dsh-workbench-bar { position: static; }
`

/** Wrap a body fragment in a card page sized for one screenshot. */
function page(name, body, width) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${name}</title>
<style>${baseStyle}</style>
</head>
<body>${body}</body>
</html>
`
  writeFileSync(join(outDir, `${name}.html`), html)
  return { name, width, html }
}

/* ---------------- card 1: the three header cells ---------------- */
const cardHeader = page('01-header', `
<div class="card" style="width:560px;padding:0">
  <div class="bar">
    <span class="title">会话工作台</span>
    <span class="grow"></span>
    <button type="button" class="dsh-workbench-icon" title="在资源管理器中打开">${icons.folder}</button>
    <button type="button" class="dsh-workbench-badge" title="AI 实际工作时长" data-live="false">
      <span class="dsh-workbench-dot"></span><span>${span(view.aiWorkingMs)}</span>
    </button>
    <button type="button" class="dsh-workbench-icon" title="在会话中查找">${icons.search}</button>
    <button type="button" class="dsh-workbench-icon" title="刷新页面">${icons.reload}</button>
  </div>
  <div class="flow">
    <p>四个入口依次排在会话头部：<b>打开工作区目录</b>、<b>AI 工作时长</b>、<b>会话内查找</b>、<b>刷新页面</b>。</p>
  </div>
</div>
`, 560)

/* ---------------- card 2: the duration panel ---------------- */
const row = (label, ms, hint) =>
  `<dt title="${hint}">${label}</dt><dd data-zero="${ms === 0}">${precise(ms)}</dd>`

const toolRows = tools.map(([name, calls, ms]) =>
  `<span class="n" title="${name}">${name}</span><span class="c">${calls}</span><span class="t">${precise(ms)}</span>`,
).join('')

const cardPanel = page('02-duration', `
<div class="card" style="width:380px;padding:0">
  <div class="inset">
    <div class="dsh-workbench-panel" role="dialog" aria-label="会话耗时分解">
      <div class="dsh-workbench-title">
        <span>AI 工作时长</span>
        <small>${view.turns} 轮 · ${view.steps} 步</small>
      </div>
      <div class="dsh-workbench-hero">
        <b>${precise(view.aiWorkingMs)}</b>
        <span>不含等待你审批和回答的时间</span>
      </div>
      <dl class="dsh-workbench-rows">
        ${row('模型输出', view.llmMs, 'step/start → assistant/message')}
        ${row('工具执行', view.toolMs, '已减去审批与提问等待')}
        ${row('等待你审批', view.approvalMs, 'approval/asked → approval/decided')}
        ${row('等待你回答', view.askMs, 'ask_user_question 的调用跨度')}
        ${row('步骤总跨度', view.busyMs, 'step/start → step/end')}
      </dl>
      <div class="dsh-workbench-wait">其中 ${precise(view.approvalMs + view.askMs)} 在等你，已从主数值扣除。</div>
      <div>
        <div class="dsh-workbench-sec">工具明细 · ${view.toolCalls} 次</div>
        <div class="dsh-workbench-tools">
          <span class="n" style="opacity:.5">名称</span><span class="c">次数</span><span class="t" style="opacity:.5">总耗时</span>
          ${toolRows}
        </div>
      </div>
    </div>
  </div>
</div>
`, 380)

/* ---------------- card 3: the find bar ---------------- */
const cardFind = page('03-find', `
<div class="card" style="width:560px;padding:0">
  <div class="flow">
    <p>把「审批」两处命中高亮出来，<mark class="cur">当前项</mark>用橙色，其余用黄色。</p>
    <p>「审批」的第三处也在这里：<mark>审批</mark>弹窗出现后会重复提醒。</p>
  </div>
  <div class="inset" style="padding-top:0">
    <div class="dsh-workbench-bar" role="search" aria-label="在会话中查找">
      <input type="text" value="审批" aria-label="查找内容">
      <span class="dsh-workbench-count" data-empty="false">1/3</span>
      <button type="button" class="dsh-workbench-btn" title="上一处">↑</button>
      <button type="button" class="dsh-workbench-btn" title="下一处">↓</button>
      <button type="button" class="dsh-workbench-scope" title="搜索范围">会话</button>
      <button type="button" class="dsh-workbench-btn" title="关闭">✕</button>
    </div>
  </div>
</div>
`, 560)

/* ---------------- card 4: the settings section ---------------- */
const cardSettings = page('04-alert', `
<div class="card" style="width:520px;padding:0">
  <div class="inset">
    <div class="dsh-workbench-settings">
      <div class="dsh-workbench-settings-title">需要确认时提醒</div>
      <div class="dsh-workbench-settings-lead">审批或提问弹窗出现后，按间隔反复响铃，直到你处理为止。</div>

      <div class="dsh-workbench-field">
        <div class="dsh-workbench-field-label"><b>开启</b><small>关掉后不再播放</small></div>
        <label class="dsh-workbench-check"><input type="checkbox" checked><span>已开启</span></label>
      </div>

      <div class="dsh-workbench-field">
        <div class="dsh-workbench-field-label"><b>提醒间隔</b><small>弹窗还开着就每这么多秒响一次</small></div>
        <div class="dsh-workbench-field-body"><input type="number" value="15"><span class="dsh-workbench-num">秒</span></div>
      </div>

      <div class="dsh-workbench-field">
        <div class="dsh-workbench-field-label"><b>最长提醒</b><small>0 表示不限</small></div>
        <div class="dsh-workbench-field-body"><input type="number" value="600"><span class="dsh-workbench-num">秒</span></div>
      </div>

      <div class="dsh-workbench-field">
        <div class="dsh-workbench-field-label"><b>提示音</b><small>内置三种，也可导入</small></div>
        <div class="dsh-workbench-field-body">
          <select><option>清脆双音（默认）</option><option>短促脉冲</option><option>柔和铃音</option><option>自定义音效…</option></select>
          <button type="button">试听</button>
        </div>
      </div>

      <div class="dsh-workbench-field">
        <div class="dsh-workbench-field-label"><b>音量</b><small>内置音与导入音都生效</small></div>
        <div class="dsh-workbench-field-body"><input type="range" min="0" max="100" value="60" style="width:150px"><span class="dsh-workbench-num">60%</span></div>
      </div>
    </div>
  </div>
</div>
`, 520)

const cards = [cardHeader, cardPanel, cardFind, cardSettings]
for (const card of cards) {
  console.log(`preview/${card.name}.html  (${card.width}px)`)
}

writeFileSync(join(outDir, 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-workbench — 预览</title>
<style>${baseStyle}
body { background: #131316; padding: 28px 0 40px; }
.gallery { max-width: 900px; margin: 0 auto; padding: 0 24px; display: flex; flex-direction: column; gap: 26px; }
.gallery figure { margin: 0; }
.gallery img { display: block; border-radius: 10px; border: 1px solid var(--dsw-alias-border-secondary); }
.gallery figcaption { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gallery h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
.gallery .lead { color: var(--dsw-alias-label-secondary); font-size: 12.5px; margin-bottom: 6px; }
</style>
</head>
<body>
<div class="gallery">
  <div>
    <h1>dsh-workbench</h1>
    <div class="lead">四个功能各自的界面，用 <code>lib/client.js</code> 里同一份 CSS 渲染。</div>
  </div>
  <figure><img src="01-header.png" alt="会话头部四个入口"><figcaption>① 会话头部：打开工作区目录 · AI 工作时长 · 会话内查找 · 刷新页面</figcaption></figure>
  <figure><img src="02-duration.png" alt="工作时长分解"><figcaption>② 点开徽章：耗时分解，审批与提问等待单独扣除</figcaption></figure>
  <figure><img src="03-find.png" alt="会话内查找"><figcaption>③ 查找条：高亮命中、计数、上下跳转</figcaption></figure>
  <figure><img src="04-alert.png" alt="需要确认时提醒"><figcaption>④ 设置：弹窗出现后按间隔重复响铃</figcaption></figure>
</div>
</body>
</html>
`)
console.log('preview/index.html')
console.log(`CSS ${css.length} chars · badge ${span(view.aiWorkingMs)} · hero ${precise(view.aiWorkingMs)}`)
