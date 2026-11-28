# 开发文档

本文记录 `dsh-powertoys` 的内部实现口径、本地验证与测试脚本，供维护与二次开发参考。面向用户的功能介绍见 [README.md](../README.md)。

## 一、工作时长口径与源码依据

宿主半身 `lib/index.js`（`export const name = 'powertoys'`）注册投影 `powertoysStats`（`stateVersion: 3`），浏览器半身 `lib/client.js` 在投影未随会话列表下发时通过 `useChat` 折叠已加载节点作为回退。

| 字段 | 折叠规则 | 语义 |
|---|---|---|
| `busyMs` | Σ `step/start` → `step/end` | 每个步骤的完整跨度 |
| `llmMs` | Σ `step/start` → 首条 `assistant/message` | 模型耗时（含重试） |
| `toolRawMs` | Σ `tool/call` → `tool/result` | 工具原始跨度 |
| `approvalMs` | Σ `approval/asked` → `approval/decided` | 等待审批耗时 |
| `askMs` | Σ `ask_user_question` 的 `tool/call` → `tool/result` | 等待回答耗时 |
| `toolMs` | `toolRawMs − approvalMs − askMs` | 工具真实执行耗时 |
| **`aiWorkingMs`** | **`busyMs − approvalMs − askMs`** | **主数值** |

扣除依据：

- `dsh-tools/src/batch.ts` 中 `settlement.start()`（写 `tool/call`）先于 `pipeline.prepare()`（内部调用 `serviceAsk()` → `approval.request()`），因此工具跨度天然包含用户审批等待。
- `ask_user_question` 作为普通工具执行，其 `tool/call` → `tool/result` 整段跨度均为等待用户回答，不计入 `tools` 明细表。
- 明细结构还包含 `tools[<name>]`（次数 / 总耗时 / 最大值 / 错误数）、`approvalByTool[<name>]` 与 `askByTool[<name>]`。

## 二、客户端实现要点

### 1. 模块化架构与无损配置迁移

- `lib/client.js` 以 `id: 'dsh-powertoys'` 加载，通过声明式 `MODULES` 注册表定义五个可独立开关的模块：`duration`、`explorer`、`find`、`reload`、`alert`。
- 设置页注册于 `settings.section`（`id: 'powertoys'`，标签 `'DSH PowerToys'`），所有模块开关即时生效，无需刷新页面。
- 存储键名与迁移策略：
  - 模块开关：`localStorage['dsh-powertoys:features']`（首次加载若不存在则自动从旧键 `dsh-workbench:features` 迁移并落盘）。
  - 提醒参数：`localStorage['dsh-powertoys:notify']`（首次加载若不存在则自动从旧键 `dsh-workbench:notify` 迁移，并与 `features.alert` 保持双向同步）。
  - 自定义音频：IndexedDB 数据库 `dsh-powertoys-audio`（store `clips`，key `custom`）；仅在已配置自定义音效时按需回退读取旧库 `dsh-workbench-audio` 并复制到新库，全新安装不会创建空旧库。

### 2. 打开工作区目录

复用宿主 `dsh-host-open-in-app` 注册的文件管理器，首次点击时探测 `GET open-in-app/apps` 并按 `['explorer', 'finder', 'files']` 择优缓存：

```text
GET  open-in-app/apps         -> {apps:["explorer","gitbash"]}
POST open-in-app/open         -> {app,path} -> {"ok":true}
```

路径取自 `useSessions(s => s.byId[sessionId].cwd)`，向相对路由发起 POST，复用宿主的 Host/Origin 校验与登录 cookie。

### 3. 会话内查找与快捷键

- 高亮基于 **CSS Custom Highlight API**（显式读取 `window.CSS.highlights` / `window.Highlight`，名称 `dsh-powertoys-find` / `dsh-powertoys-find-current`），不改写 DOM；DOM 变化监听防抖 220ms。
- 默认搜索范围为会话正文列 `[data-chat-flow]`，可通过「会话 / 整页」切换。
- 关闭 `find` 模块时：`FindButton` / `FindBar` 立即隐藏，高亮清除、`MutationObserver` 断开、`powertoys.find` 快捷键返回 `{ status: 'unhandled' }`，`Ctrl/Cmd+Shift+F` 兜底监听直接返回而不调用 `preventDefault()`/`stopPropagation()`。
- 键位分配：

| 键位 | 归属 |
|---|---|
| `Ctrl+F` | `dsh-deja` 的 `deja.search-session`（desktop） |
| `Ctrl+Shift+F` | `session.fork`（web），不可占用注册表默认值 |
| `Ctrl+Alt+Shift+F` | 本插件向快捷键注册表登记的三修饰键默认值（`powertoys.find`） |
| `Ctrl+Shift+F` | 本插件的 DOM 兜底监听额外接受该组合 |

`registry.register()` 会遍历 6 种 runtime/platform 组合检查默认值重叠，重叠即抛错并拖垮宿主 fiber。因此注册调用外层包裹 `try/catch`；`web:linux` 白名单仅放行三种组合，该 profile 不登记默认值，走 DOM 监听。

### 4. 刷新页面

插件 client bundle 支持热更新，但决定加载哪些 bundle 的清单内嵌于 HTML。插件改名或增删后需整页重载以拉取新清单。

### 5. 需要确认时重复提醒

- 挂载在 `shell.overlay` 的 `AlertRuntime`（`powertoys:alert`）读取 `useSessionStatus(...).pendingInteraction`（由 `ui-approval` 与 `ui-user-questions` 投影出的持续状态）：为真时立即响一次并按 `intervalSec` 定时重响，转假、关闭模块或超过 `maxSeconds` 后立即停止。
- 自定义音频以 data URL 存入 IndexedDB（上限 4 MB），配置中仅记录文件名；内置音（`chime` / `pulse` / `bell`）由 `AudioContext` 合成，首次用户手势时自动解锁。

## 三、本地安装与隔离验证

桌面 `desktop` profile 由 Electron 独占管理，`dsh plugin --profile desktop` 会被拒绝，因此使用 junction 挂载并修改 `cordis.patch.yml`（必须使用 `- insert:`，裸 `- id:` 为覆盖已有行）。

当 PATH 上的 `dsh` CLI 与桌面运行时版本不一致时，隔离验证直接调用桌面运行时内置的 `bin.js`：

```pwsh
node "<DSH安装目录>\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile powertoystest --port 6333 --no-open
```

## 四、测试脚本与预览构建

| 脚本 | 作用 |
|---|---|
| `test/replay.mjs <jsonl>` | 插件折叠 vs 独立重算，逐字段对账 |
| `test/verify.mjs [jsonl]` | 审批扣除、未决审批不泄漏与中止清理（传入日志与 `$DSH_SESSION_STATS` 时可与官方 `sessionStats` 逐字段对齐） |
| `test/ask-fold.mjs` | 合成 8 分钟提问等待，8 项断言 |
| `test/ask-real.mjs <log>` | 真实日志双路对账，打印算法差值 |
| `test/client-registration.mjs` | vm 桩，断言 7 条槽位注册、无重复 id、每个 slot 只 inject 一次及 `powertoys.find` 快捷键契约 |
| `test/client-render.mjs` | 多根迷你 React + 假定时器 + 假 Web Audio + 假 IndexedDB，覆盖 5 项模块实时开关、快捷键透传、配置持久化、一键重置与旧版 `dsh-workbench` 无损迁移 |
| `test/live-watch.mjs [秒]` | 每 2 秒采样当前会话，等待期间逐帧观察 |
| `test/fold-growth.mjs <基线>` | 折叠增量 vs 独立 step 跨度对账 |

常用命令：

```pwsh
# 预览卡片（从 lib/client.js 抽取 CSS 生成 preview/*.html）
npm run preview
python -m http.server 8899 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8899/preview/index.html

# 离线检查与测试
node --check lib/index.js
node --check lib/client.js
node test/client-registration.mjs
node test/client-render.mjs
node test/ask-fold.mjs
node test/verify.mjs

# 日志对账
node test/replay.mjs "<session>.jsonl"
node test/verify.mjs "<session>.jsonl"
```

会话日志为 zstd 压缩格式，测试脚本会自动解压；手工解压示例：

```pwsh
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs'; import zlib from 'node:zlib'
writeFileSync('out.jsonl', zlib.zstdDecompressSync(readFileSync(process.argv[1])))" "$HOME\.dsh\sessions\...\session.v4.jsonl.zstd"
```

## 五、已知内部边界

- `toolMs` 含 `tool/call` → `approval/asked` 之间的毫秒级调度开销。
- `step/end` 是原子事件：跨基线的步骤会把基线之前那段一起结算，分窗口对账时需单独扣（见 `test/fold-growth.mjs` 的 `straddlerMs`）。
- 子代理工时不计入父会话，父侧只记 `subagent` 这一次调用的跨度。
- 查找只覆盖已加载到 DOM 的消息，更早的历史需先向上滚动加载。
