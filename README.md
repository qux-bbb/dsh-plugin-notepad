# dsh-plugin-notepad

[![dsh-plugin topic](https://img.shields.io/badge/topics-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-plugin-notepad)](https://www.npmjs.com/package/dsh-plugin-notepad)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

一个简易的 DeepSeek Harness（DSH）插件：**记录短笔记，并把笔记按「全局级 / 项目级」分开存放**。

- 三个模型可调用工具：`notepad_add`、`notepad_list`、`notepad_clear`
- 一个人类斜杠命令：`/note`（没有命令注册表的部署会自动跳过）
- 一个图形面板：侧边栏「速记」图标 → 中央主面板，增删改查 + 跟随当前会话
- 笔记以 JSON Lines 明文保存，可直接 `cat` / 搜索 / 纳入 git
- 零运行时依赖、零构建步骤：只用 Node 内置模块 + DSH 自带的 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`

```
dsh-plugin-notepad/            # 仓库根就是插件包根（dsh plugin add github: 要求如此）
├─ package.json                # name / exports / dsh.bundle（组合包声明）+ dsh.client（浏览器半声明）
├─ cordis.patch.yml            # 组合包贡献的配置层：按「包名」插入 notepad 行
├─ lib/index.js                # 宿主半入口：name / inject / Config / apply + HTTP 路由
├─ lib/store.js                # 存储层：路径解析、JSONL 读写、编辑/删除、裁剪、并发串行化
├─ lib/api.js                  # 面板用的 JSON API（纯处理函数，可单测）
├─ lib/client.js               # 浏览器半：手写的经典脚本，无需编译
├─ test/                       # node:test 单元测试（60 个）
├─ scripts/
│  ├─ install-notepad.mjs      # 手动安装/更新/卸载（profile 级 或 全局级）
│  ├─ smoke-runtime.mjs        # 真 Cordis + 真 tool registry 的端到端冒烟测试
│  └─ dev-link.ps1             # 开发期把 DSH 的 @deepseek-ai/* 链接到本仓库
├─ LICENSE                     # MIT
└─ node_modules/@deepseek-ai   # dev-link.ps1 生成的 junction（仅本地跑测试用，已 gitignore）
```

## 安装

包声明了 `dsh.bundle`，所以它是一个**组合包**（bundle）：`dsh plugin add` 装进某个 profile 后，`cordis.patch.yml` 这一层会被自动激活（按包名解析插件入口，无需手写路径）。

```sh
# 从 npm（发布后的常规方式；pnpm 在 git 安装下不会运行任何构建脚本，本包也不需要）
dsh plugin --profile desktop add dsh-plugin-notepad

# 或直接从 GitHub 源码装：本包是纯 JS、没有构建步骤，因此不需要 prepare 脚本，
# 也就不会触发 pnpm 的 allowBuilds 构建授权
dsh plugin --profile desktop add github:<你的用户名>/dsh-plugin-notepad

# 只验证这一层、不启动
dsh --profile desktop --dump-config     # 应能看到 "# == dsh-plugin-notepad" 这一层

# 卸载
dsh plugin --profile desktop remove dsh-plugin-notepad
```

> 用 git 装请锁定 commit（`github:<用户>/dsh-plugin-notepad#<sha>`），避免后续推送悄悄改变实际运行的内容。

### 不想走 `dsh plugin`：手动安装器

仓库自带的安装器把包装进 `<profile>/plugins/notepad/`，直接往 profile 的 `cordis.patch.yml` 写一个受标记包围的区块，`name` 用相对路径。它幂等（重复执行只更新）、改动前备份补丁文件、`--uninstall` 只删自己写入的区块，适合装进 `desktop` 这类 `dsh plugin` 不便处理的 profile：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 1) 装到当前 desktop profile（Electron 桌面端用的就是这个）
& $node scripts\install-notepad.mjs --profile desktop

# 2) 或装到「全局」：$DSH_HOME/cordis.patch.yml，对所有 profile 生效
& $node scripts\install-notepad.mjs --scope home

# 3) 先看看会改什么（不写盘）
& $node scripts\install-notepad.mjs --profile desktop --dry-run

# 4) 卸载
& $node scripts\install-notepad.mjs --profile desktop --uninstall
```

生效方式：

- DSH 的分层顺序是 `bundle 补丁 → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch`。`dsh plugin add` 改的是第一层里的 `dsh.profile.bundles` 列表，`--scope profile` 改的是第二层，`--scope home` 改的是第三层。
- 桌面端组合里 `hmr` 行是 `disabled: !!js '!ctx.get(''profileContext'')'`，而桌面宿主会提供 `profileContext`，所以**补丁文件的改动会被热重载**（实测：新插入的条目会立即挂载，无需重启）。
- 但**已经变成 `inactive` 的条目如果配置没变，宿主不会重试**。所以若安装时宿主正好先看到补丁、后看到文件（旧版安装器就是这个顺序），条目会一直卡在 `inactive`；此时改一次任意配置值，或重启应用。

## 实测发现的两个坑（重要）

这两条是在真机（桌面端运行时 `0.2.0-rc.2`、`$DSH_HOME/profiles/node_modules` 里的包为 `0.1.7-rc.2`）上定位出来的，插件里已经规避：

1. **`package.json` 里声明的 DSH `peerDependencies` 会在挂载前被宿主按自己的运行时版本强制校验。** 声明 `"@deepseek-ai/dsh-tools": "0.1.7-rc.2"` 时，桌面宿主（运行时 `0.2.0-rc.2`）判定不兼容，直接**拒绝挂载**：条目在 Loader 树里存在，但永远没有 fiber，模块连 import 都不会执行，`--dump-config` 也看不出任何错误（实测 `listConfigs` 里只有 `status: "inactive"`）。本包因此把三个 peer 写成 `"*"`：依赖语义保留，但不会被某个具体宿主版本的版本号卡死。若你的 profile 是用 `dsh plugin add` 装进 `node_modules` 的，按常规写精确范围也可以。
2. **安装顺序必须是「先拷文件，再写补丁」。** 宿主监听补丁文件，写了补丁就会立刻尝试导入；此时文件还没拷完就导入失败，而失败的条目在配置不变时不会被重试。`install-notepad.mjs` 已按此顺序执行。

排查这类问题的手段（本插件就是这么定位的）：`Config.listConfigs` 只读查询能看到实时 Loader 树的条目状态——条目 id 在实时树里带 `include:` 前缀（如 `include:notepad`）；`status: "schema"` 表示 fiber 已挂载且 Config schema 可投影，`"inactive"` 表示没有 fiber（被禁用、被拒挂载或已销毁）。再加一个临时探针插件（`apply` 里写文件）就能区分「模块没被 import」「apply 抛错」「根本没挂载」。


## 图形界面（侧边栏图标 → 中央主面板）

除了给模型用的工具，插件还带一个可以直接编辑的界面：

- 左侧边栏底部多一个 **速记** 图标（`sidebar.panellist`，order 40），点开在中央主面板（`main`，key 与图标 id 相同为 `notepad`）里整块编辑。
- **和项目关联：点开就是当前会话所在项目的 notepad。**
  - 顶栏左侧会写明「跟随当前会话 / 手动选择 / 默认（最近使用的项目）」+ 实际项目根路径。
  - 项目页的下拉可以临时切到别的项目（切了就变成「手动选择」），旁边出现「跟随会话」按钮一键回到跟随；面板开着时切换会话，1.5s 内自动跟随到新项目。选回「当前会话」那一项会自动恢复跟随。
  - 下拉里**始终包含当前项目**：如果它不在已注册工作空间里（比如会话 cwd 是个未注册目录），会以 `名字（当前会话）` 的形式排在第一位。踩过的坑：`<select>` 的 `value` 若不在任何 `<option>` 里，浏览器会**静默显示第一个 option**——于是状态行写着 `跟随当前会话：D:\files\projects\trusted_data`，下拉框却显示另一个项目名（`dsh_plugin_notepad`）；`projectOptions()` 就是为这个修的，并有回归测试。
  - 底层用的是一个**会话作用域**的隐藏桥接（`conversation.session.header.utilities` 里 id 为 `notepad-session`、渲染 0 尺寸 `<span>` 的条目）：会话作用域的 occupant 能拿到 `sessionId` 与标准 prop `useSessions`，于是它读 `SessionSummary.cwd`（**和模型工具用的是同一个值**）并发布给根作用域的中央面板；面板始终把该路径作为 `project=` 传给宿主路由，所以解析结果与 `notepad_add` 等工具完全一致。
  - 兜底顺序：手动选择 → 会话 cwd → 上次响应里的项目 → 最近更新的已注册工作空间。宿主路由另外也接受 `session=<id>`（由宿主用 `agents.get(id).session.header.cwd` 解析；本次改动之前已加载的宿主模块会在下次重启后生效，面板不依赖它）。
- **两个层级标签页**：`项目` / `全局`，各自独立列表。
- 每条笔记支持 **新增、编辑（原地保存，保留 id 与创建时间）、删除、打标签**；顶部有搜索框、刷新、「清空该层级」（带确认弹窗）；底部显示当前层级的实际文件路径。
- 面板和模型工具、`/note` 命令读写的是**同一批文件**：在界面上改完，模型 `notepad_list` 立刻能看到。

### 它是怎么接起来的（都是实测确认的）

| 环节 | 事实 |
| --- | --- |
| 浏览器半的启动 | `lib/client.js` 是**普通经典脚本**（不是 ES module，也不需要打包）：`window.__ModuleLoader__.load({ id: 'dsh-plugin-notepad', factory })`，`factory(require)` 返回 `{ apply, inject }`，由客户端 Cordis 当插件挂载。`require('react')` 走 shell 的冻结模块表。 |
| 模块 id 与包目录 | 浏览器模块 id = 该包 `package.json` 的 `name`；宿主从 Loader 条目的 `name` 路径**向上找最近的 package.json**（不要求装在 node_modules 里）。 |
| 样式 | `factory` 里同步插入带 `data-plugin` / `data-plugin-css` 的 `<style>`，模块系统会在 factory 返回时认领并在热重载/停用时清理。CSS 用 `var(--dsw-alias-*, fallback)` 主题变量。 |
| 数据通道 | 宿主半注册 `webServer` 的 `prefix` 路由 `/api/notepad`（`{state, notes, clear}`），浏览器半用 `fetch('api/notepad/...')`（文档相对写法）调用。 |
| 鉴权 | 该路由会遮蔽 API gateway 的 `/api` 前缀，所以插件自己调用 `connection.requestRejection({ headers })` 复用宿主的 **Host/Origin 栅栏 + 浏览器会话 Cookie** 校验；另外要求自定义头 `x-notepad-client: 1`，跨站请求无法在不触发 CORS 预检的情况下带上它。GUI 页面本身带着会话 Cookie，所以面板的 `fetch` 开箱即用。 |
| 为什么需要那个桥接 | 根作用域面板拿不到「当前会话」：`PanelInfo` 只有 `activePanelId`，文档也写明「current-session selection lives with the runtime sessions service」，而 `SessionListState` 里没有 active/selected 字段。会话作用域的槽位则明确把 `sessionId` 放进标准 props，这就是唯一可靠的入口。 |
| 生效方式 | **新增浏览器半需要重启一次应用**（`clientModules` 把每个 Loader specifier 的包元数据缓存到进程重启）；之后**只改 `lib/client.js` 会被 client-hmr 热重载（500ms 轮询该文件），无需重启**——本次「跟随会话」就是热更生效的（页面里立刻出现 `notepad-session` occupant，graph rev 变成新值）。宿主半的新代码仍会命中 Node 模块缓存，需要重启才加载。 |

配置里 `level` 决定界面里哪几个标签页可用（`global` / `project` / `both`），被禁用的那一页会置灰并给出提示。

## 「全局级、项目级」的两层含义

### 一、笔记存放层级（工具调用时可选，也可用配置固定）

| 层级 | 默认路径 | 含义 |
| --- | --- | --- |
| `global` | `<DSH_HOME>/notepad/notes.jsonl` | 跨项目共享，比如「我的偏好」「常用命令」 |
| `project` | `<项目根>/.dsh/notepad/notes.jsonl` | 只属于当前项目 |

- 项目根 = 从会话工作目录向上查找最近的 `.git` / `.hg` / `.svn`；找不到就用会话工作目录本身。
- 默认**不把 `.dsh` 当项目根标记**：DSH home 本身就是 `<home>/.dsh`，若把它当标记，用户主目录下的任何路径都会被判定为「项目根 = 主目录」，项目笔记会静默混进全局文件（这正是开发期单测抓到的一个真实缺陷，并已加回归测试）。
- 配置 `level` 可以把部署固定成只有全局、只有项目、或两者都有；`defaultScope` 决定调用时省略 `scope` 落在哪一层。

### 二、安装层级（插件对谁可见）

| 安装方式 | 文件位置 | 补丁文件 | 可见范围 |
| --- | --- | --- | --- |
| `dsh plugin add`（组合包） | pnpm 管理的 `node_modules`（npm 源）或 git 检出 | profile 的 `package.json` → `dsh.profile.bundles`；层内容来自本包自带的 `cordis.patch.yml`，`name` 按**包名** `dsh-plugin-notepad` 解析 | 仅该 profile |
| `--scope profile`（安装器默认） | `<profile>/plugins/notepad/` | `<profile>/cordis.patch.yml`，`name` 用相对路径 `./plugins/notepad/lib/index.js`（loader 以 profile 目录为 baseUrl 解析） | 仅该 profile |
| `--scope home` | `$DSH_HOME/plugins/notepad/` | `$DSH_HOME/cordis.patch.yml`，`name` 用绝对 `file:///...` URL（该层在每个 profile 的 baseUrl 下组合，不能用相对路径） | 所有 profile |

## 插件包契约

按 DSH 内置插件的形状写，只用**具名导出**：

```js
export const name = 'notepad'     // loader 条目名
export const inject = ['tools']   // 硬依赖：工具注册表
export const Config = z.object({ /* schemastery 配置 schema */ })
export function apply(ctx, config = {}) { /* 注册工具、/note 命令与 HTTP 路由 */ }
```

两个刻意的选择：

- 不提供 `export default` —— loader 会把模块解成 `exports.default ?? exports`，多一个 default 对象就是多一个互相竞争的插件形状。
- `peerDependencies` 写成 `"*"` —— 原因见下面「实测发现的两个坑」第 1 条。

## 工具

### `notepad_add` — 记一条

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `content` | 是 | 笔记正文，自动 trim，不能为空白 |
| `tags` | 否 | 标签数组，会去重、去空白 |
| `scope` | 否 | `global` / `project`，省略则用 `defaultScope` |

返回 `{ id, at, scope, tags, content, file, total }`，例如：

```
Noted p-mv6ieauq-01fmiy at 2026-10-13T09:59:19.922Z in the project notepad (3 note(s) there).
File: D:\work\repo\.dsh\notepad\notes.jsonl
```

### `notepad_list` — 读回来（新的在前）

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `scope` | 否 | 省略 = 读所有启用的层级并合并 |
| `query` | 否 | 对正文 / 标签 / id 做大小写不敏感的子串过滤 |
| `limit` | 否 | 最多返回几条；`0` = 全部；省略 = `defaultLimit` |

### `notepad_clear` — 清空某一层（破坏性）

必须显式传 `scope` 且 `confirm: true`，否则拒绝执行。只删指定的那一层文件。

### `/note` 命令

- `/note 记一条内容` → 新增一条（走默认层级）
- `/note`（不带内容）→ 列出最近 5 条

## 配置项（`Config`）

写在补丁条目的 `config:` 下，或由设置界面编辑（schema 已随插件导出，`dsh --dump-config-schema` 能看到）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `level` | `global` \| `project` \| `both` | `both` | 本部署暴露哪些层级 |
| `defaultScope` | `global` \| `project` | `project` | 调用省略 `scope` 时的落点 |
| `dshHome` | string | `''` | 全局层根目录；空 = `$DSH_HOME`，再退到 `~/.dsh` |
| `globalDir` | string | `''` | 覆盖全局笔记目录（支持 `~`），空 = `<dshHome>/notepad` |
| `projectDir` | string | `''` | 覆盖项目笔记目录（支持 `~`），空 = `<项目根>/.dsh/notepad` |
| `fileName` | string | `notes.jsonl` | 笔记文件名（只接受纯文件名） |
| `projectRootMarkers` | string[] | `['.git','.hg','.svn']` | 向上查找项目根的标记；显式给 `[]` 表示「工作目录就是项目根」 |
| `maxNotes` | integer | `1000` | 单文件上限，超出丢弃最旧；`0` = 不裁剪 |
| `maxContentLength` | integer | `4000` | 单条正文字符上限 |
| `defaultLimit` | integer | `20` | 列表默认条数 |
| `toolPrefix` | string | `notepad` | 工具名前缀（合法值才会被采纳） |
| `enableCommand` | boolean | `true` | 是否注册 `/note` |

两种典型部署：

```yaml
# 只要全局笔记
- insert:
    - id: notepad
      name: dsh-plugin-notepad
      config:
        level: global
        defaultScope: global
```

```yaml
# 只要项目笔记（默认行为，显式写出来更清楚）
- insert:
    - id: notepad
      name: dsh-plugin-notepad
      config:
        level: project
        defaultScope: project
        projectRootMarkers: ['.git']
```

如果已经用 `dsh plugin add` 装成本组合包，就不要再 `insert` 了：在 profile 自己的 `cordis.patch.yml` 里按 `- id: notepad` **覆盖**该行即可。注意 patch 会替换整行的 `config`（不是深合并），所以要重述你需要的每一个键；本包自带的 `cordis.patch.yml` 就是这种可被覆盖的默认值。

## 存储格式

每行一条 JSON，追加写；单条解析失败的行会被跳过而不是让列表整体失败：

```json
{"id":"p-mv6ieauq-01fmiy","at":"2026-10-13T09:59:19.922Z","scope":"project","tags":["errand"],"content":"remember the milk"}
```

同一个 store 实例内的写入通过 promise 队列串行，并发调用不会写出半行；`maxNotes` 裁剪时先写 `.tmp` 再 rename。

## 验证

已跑过并通过的验证（本机 DSH `0.1.7-rc.2` / Node 24.21.0）：

```powershell
# 1) 60 个单元测试：路径/作用域解析、JSONL 读写、并发、裁剪、参数校验、命令注册（在仓库根跑）
& $node --test

# 2) 端到端冒烟：真 Cordis Context + 真 dsh-tools 注册表，走 ctx.tools.execute
& $node scripts\smoke-runtime.mjs

# 3) 真实 loader：把插件装进一个 profile，dump 组合结果与 Config schema
& $node scripts\install-notepad.mjs --profile <某profile> --verify
& $node <dsh>\lib\bin.js --profile <某profile> --dump-config-schema
```

结果摘要：

- `node --test`：**60/60 通过**，覆盖三类：存储层（路径/作用域、JSONL 读写、编辑、删除、裁剪、并发串行化）、`lib/api.js`（会话栅栏 401/403、标记头 403、状态形状、项目解析优先级 = 手动 > 会话 > 最近项目、增删改查、逐项目隔离、错误码）、`lib/client.js`（bundle 注册与 id、样式同步认领、`main` + `panellist` + 会话桥接三处注册、桥接把 `sessionId` 映射成 `SessionSummary.cwd`、下拉选项必含当前项目、面板跟随会话时请求 `project=<会话 cwd>`、与宿主 API 的路由契约一致），以及宿主半的 `listProjects`（按工作空间 `updatedAt` 倒序、无注册表或抛错时降级为空列表）。
- `smoke-runtime.mjs`：三个工具注册成功；`notepad_add`/`list`/`clear` 往返正确（含只在 project 层删除、global 不受影响）；`confirm: false` 被拒；非法 `scope` 在派发前被注册表按参数 schema 拒绝（`INVALID_ARGS`）。
- 真实 loader（新建临时 profile，与 desktop 相同的 bundle 栈）：`--dump-config` 组合出 notepad 条目；`--dump-config-schema` 报告 `"status": "schema"` 并投影出完整 Config schema，说明插件模块确实在真实 app 进程里被导入成功。
- 全局级安装：在隔离的 `DSH_HOME` 下验证 home 补丁层插入条目、绝对 `file://` 名称可解析、schema 正常。
- **装进正在运行的桌面应用**：热重载后 `Config.listConfigs` 查到 `include:notepad`，`status: "schema"`，`acceptsMissing: true`、`limitations: []` —— 条目已挂载、`apply` 已完成（`apply` 抛错或模块未 import 都会是 `inactive`），三个工具与 `/note` 命令注册在同一个实时 registry 上（曾用探针插件读出 `notepad_add` / `notepad_list` / `notepad_clear` 三个名字）。
- **图形界面（重启后在正在运行的应用里实测）**：
  - 客户端图里有我的行（读 `/plugins/events` 的 SSE graph 帧）：`{"id":"dsh-plugin-notepad","url":"plugins/??dsh-plugin-notepad/client.js&rev=<rev>"}`。
  - bundle 被服务：`GET /plugins/??dsh-plugin-notepad/client.js&rev=<rev>` → **200**，内容 = 安装的 `lib/client.js` + 一行 source-map trailer。注意单个 bundle 的 URL 就是这种 `??`/`&rev=` 的 combo 形式，直接请求 `/plugins/dsh-plugin-notepad/client.js` 会 404（我曾被这个假阴性误导过一次）。
  - 页面里的注册是活的（客户端 Slots inspect）：`sidebar.panellist` occupants = `plugins` + **`notepad`**（order 40, active）；`main` occupants = **`notepad`** + `plugins` + `conversation`。
  - **跟随会话热更生效（未重启）**：改完 `lib/client.js` 后 client-hmr 轮询到新文件 → graph 行 rev 变为 `10d81a132a27`、`GET /plugins/??...&rev=10d81a132a27` 返回 **200 / 22211 bytes** 且内容包含 `NotepadSessionBridge` / `activeSession` / `conversation.session.header.utilities`；页面里 `conversation.session.header.utilities` 的 occupants 立刻多了 **`notepad-session`**（order 900, active）。
  - 宿主路由活着且复用了宿主栅栏：无 Cookie 的 `GET /api/notepad/state` → **401** + `content-type: application/json` + 插件自己的文案 `{"error":"unauthenticated: open the notepad panel from the GUI (its browser session cookie is required)"}`；对照网关自己的 `/api/zzz-unknown` 返回**无 content-type** 的 `unauthorized`，两者可区分。
  - 模型工具同时实时可用：本会话 `notepad_add` 成功写入 `D:\recent\tmp\dsh_plugin_notepad\.dsh\notepad\notes.jsonl`。

## 开发

```powershell
# 让本仓库的 bare import（@deepseek-ai/schemastery、@deepseek-ai/dsh-tools）能解析
powershell -File scripts\dev-link.ps1
```

该脚本只在 `node_modules/@deepseek-ai` 建一个指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 的 junction，不复制、不安装任何包。插件装进 profile 后不依赖它：那时 Node 会从 `<profile>/plugins/notepad/lib/`（安装器路径）或 profile 自己的 `node_modules/dsh-plugin-notepad/lib/`（`dsh plugin add` 路径）逐级向上找到 `<profiles>/node_modules`。

## 发布与分发

1. **加话题**：在 GitHub 仓库页 About → Topics 加 `dsh-plugin`（或 `gh repo edit --add-topic dsh-plugin`），仓库就会出现在 [github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin) 下。这是官方 README「社区与支持」给出的被发现方式；`package.json` 的 `keywords` 只影响 npm 搜索。
2. **发 npm**：在仓库根执行 `npm publish`。纯 JS、无构建步骤，所以不需要 `prepare`/`prepublishOnly`；`files` 已列出 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`。
3. **从 GitHub 装**：`dsh plugin --profile <name> add github:<用户>/dsh-plugin-notepad`。因为本包没有构建脚本，pnpm 不会要求 `allowBuilds` 授权。

许可证：[MIT](LICENSE)。

## 卸载

```powershell
& $node scripts\install-notepad.mjs --profile desktop --uninstall   # 或 --scope home --uninstall
```

删除 `<...>/plugins/notepad/` 与补丁文件中被标记包围的那段；原有的注释和其他条目原样保留（补丁文件在首次修改前也有时间戳备份）。
