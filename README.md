# dsh-powertoys

**DSH PowerToys** — 模块化的 DeepSeek Harness 工作台小工具集，解决长任务跑起来之后最常见的五个痛点。所有模块均可在 **设置 → DSH PowerToys** 中独立开启或关闭，改动即时生效，无需刷新页面。

![会话头部](preview/01-header.png)

| 模块 | 入口 | 说明 |
|---|---|---|
| **会话耗时徽章** (`duration`) | 会话头部徽章 | 扣掉等你审批和回答的时间，只算 AI 实际干活的时长；点开看分项与工具明细 |
| **工作区目录按钮** (`explorer`) | 会话头部文件夹按钮 | 直接在系统文件管理器里打开当前会话所在目录 |
| **会话内查找** (`find`) | 头部放大镜按钮 / 快捷键 | 页内高亮、实时计数、上下跳转，默认只搜当前会话可见正文 |
| **刷新页面按钮** (`reload`) | 会话头部刷新按钮 | 一键重载界面，装卸或修改插件后不必重启 DSH |
| **需要确认时重复提醒** (`alert`) | 设置 → DSH PowerToys | 审批或提问弹窗出现后按间隔反复响铃，处理后自动停；支持自定义音效 |

## 界面预览

| 耗时分解 | 会话内查找 |
|---|---|
| ![耗时分解](preview/02-duration.png) | ![会话内查找](preview/03-find.png) |

| 模块开关与提醒设置 |
|---|
| ![模块开关与提醒设置](preview/04-alert.png) |

> 以上均为演示环境效果截图，仅用于展示界面与功能，实际数据与显示效果以安装后的客户端为准。

## 核心特性

### 0. PowerToys 风格模块化开关

在 **设置 → DSH PowerToys** 页面中，五个功能各自拥有独立开关与简要说明，支持一键「恢复默认」：

- 关闭任意模块后立即隐藏对应入口并释放后台资源（如停止 1s 计时器、清除查找高亮与 DOM 监听、释放 `Ctrl/Cmd+Shift+F` 透传、停止提醒定时器）。
- 所有切换即时生效，无需刷新页面。

### 1. 会话耗时徽章：看清 AI 到底忙了多久

跑长任务时去倒水、开会甚至睡一觉，回来发现任务停在审批或提问弹窗上。DSH 自带统计会把这段你不在电脑前的时间算进耗时——在一次实测会话里，提问等待占了 73.9 分钟，系统把整段算成 158.8 分钟；扣掉人工等待后，AI 实际只干了 84.9 分钟。

点开头部时长徽章可以看到完整分解：

- **主数值**：AI 实际工作时长（已扣除等待审批与等待回答）
- **分项耗时**：模型输出、工具执行、等待你审批、等待你回答、步骤总跨度
- **工具明细**：按工具统计调用次数与总耗时（提问等待单独列出，不混入工具列表）

### 2. 需要确认时重复提醒：别让弹窗卡一整晚

长任务最怕的正是上面那种情况：放着项目跑，人离开工位或切去忙别的，审批或提问弹窗弹出来时，常见提示音只响一声、错过不候，等想起回来看才发现早就停在半路。

本插件在弹窗出现时会立即响铃一次，之后按设定间隔持续响铃，直到你处理完弹窗自动停止；超过最长提醒时长也会自动停，不会一直吵。

在 **设置 → DSH PowerToys** 的「需要确认时重复提醒」模块中可调整：

| 设置项 | 说明 |
|---|---|
| **模块开关** | 独立开关（默认开启），关闭时自动停用下方参数并立即停止当前响铃 |
| **提醒间隔** | 3–600 秒，默认 15 秒 |
| **最长提醒** | 默认 600 秒，设为 0 表示不限 |
| **提示音** | 内置「清脆双音」「短促脉冲」「柔和铃音」，支持导入 4 MB 以内的本地音频并试听 |
| **音量** | 0–100%，默认 60%，内置音与自定义音频均生效 |

### 3. 会话内查找：长对话里直接翻到那一行

几十轮的长会话里想找回之前提到过的文件名或报错，默认查找容易把折叠的思考过程和输入框草稿一起搜出来。

- **打开方式**：点击头部放大镜按钮，或按 `Ctrl+Alt+Shift+F` / `Ctrl+Shift+F`（避开 DSH 默认的 `Ctrl+F`）
- **快捷操作**：`Enter` / `↓` 下一处，`Shift+Enter` / `↑` 上一处，`Esc` 关闭；选中文字后打开会自动填入搜索词
- **搜索范围**：默认只搜当前会话可见正文，点击查找条上的「会话 / 整页」可切换全页搜索
- **浏览体验**：高亮不影响页面排版，AI 流式输出时计数自动更新，手动滚动不会被拉回；关闭该模块时自动清除高亮并停止拦截 `Ctrl/Cmd+Shift+F`

### 4. 工作区目录按钮：一步拿到产出文件

AI 刚生成了截图、构建产物或日志，想直接拖给别人或用外部软件打开，不必一层层翻路径——点会话头部的文件夹按钮，直接在系统文件管理器里打开当前项目目录。

### 5. 刷新页面按钮：改完插件不用重启客户端

新增、卸载或改名插件后，页面里缓存的插件清单还是旧的。点会话头部最右侧的圆形箭头即可重载界面，不必关掉重开整个 DSH。

## 安装

本插件为纯 JavaScript、零外部依赖、无构建步骤，按使用方式任选一种即可。

### 方式一：DSH 桌面端直接安装（推荐）

1. 打开 DeepSeek Harness 桌面端，进入 **设置 → 插件 → 添加插件**（或左侧栏「插件」）。
2. 在「包名或地址」中输入：

```text
dsh-powertoys
```

或使用 GitHub 地址安装：

```text
github:SparkforDream/dsh-powertoys
```

3. 安装完成后按提示刷新页面或重启桌面端即可生效。

> 桌面端内置插件管理器会自动处理 `desktop` profile 的挂载，无需手动编辑 `cordis.patch.yml`。

### 方式二：Web 端 / CLI 安装

适用于 `dsh web` 或自定义 profile（需要本机 PATH 上有 `pnpm`）：

```sh
# 从 npm 安装
dsh plugin --profile web add dsh-powertoys

# 或从 GitHub 安装
dsh plugin --profile web add github:SparkforDream/dsh-powertoys

# 或从本地克隆目录安装
dsh plugin --profile web add ./dsh-powertoys
```

安装或更新后重启 `dsh web` 生效。卸载命令：

```sh
dsh plugin --profile web remove dsh-powertoys
```

> `dsh plugin --profile web` 只写入 `web` profile，不修改桌面端 `desktop` profile；桌面端请使用方式一。

### 方式三：本地开发直连桌面端（Windows PowerShell）

<details>
<summary>展开查看本地目录链接步骤（适合修改源码调试，普通用户请用方式一）</summary>

将本地仓库目录链接到 `desktop` profile：

```pwsh
New-Item -ItemType Junction `
  -Path "$HOME\.dsh\profiles\desktop\node_modules\dsh-powertoys" `
  -Target "<你的仓库本地路径>"
```

在 `$HOME\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加（用 `insert:` 新增条目，不要与方式一重复挂载）：

```yaml
- insert:
    - id: ui-powertoys
      name: dsh-powertoys
```

保存后重启 DSH 生效。

</details>

## 从旧版 `dsh-workbench` 升级

本插件原名 `SparkforDream/dsh-workbench`，现已正式更名为 `SparkforDream/dsh-powertoys`（npm 包名 `dsh-powertoys`）：

1. 先卸载旧版 `dsh-workbench`（桌面端插件页点击卸载，或移除旧版 junction 与 `cordis.patch.yml` 中的 `ui-workbench` 行，避免同时挂载两份）。
2. 安装 `dsh-powertoys` 并刷新/重启 DSH。
3. **配置无损自动迁移**：首次加载时会自动从旧版 `localStorage`（`dsh-workbench:features` / `dsh-workbench:notify`）和 IndexedDB（`dsh-workbench-audio` 自定义提示音）迁移至新键名，原有设置与导入音频不会丢失。

## 使用说明与限制

- 会话内查找只覆盖当前已加载到页面的消息；查找更早历史时，先向上滚动加载。
- 子代理内部的耗时不并入父会话统计，父会话仅计入该次调用跨度。

## 开发文档

统计口径、源码依据与测试脚本见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

MIT
