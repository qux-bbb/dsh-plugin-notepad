# dsh-plugin-notepad

[![dsh-plugin topic](https://img.shields.io/badge/topics-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-plugin-notepad)](https://www.npmjs.com/package/dsh-plugin-notepad)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

一个简易的 DeepSeek Harness（DSH）插件：记录短笔记，并按「全局级 / 项目级」分开存放。

## 特性

- 三个模型可调用工具：`notepad_add`、`notepad_list`、`notepad_clear`
- 一个人类斜杠命令：`/note`（没有命令注册表的部署会自动跳过）
- 一个图形面板：侧边栏「速记」图标 → 中央主面板，增删改查 + 跟随当前会话
- 笔记以 JSON Lines 明文保存，可直接 `cat` / 搜索 / 纳入 git
- 零运行时依赖、零构建步骤：只用 Node 内置模块 + DSH 自带的 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`

## 安装

包声明了 `dsh.bundle`，所以它是一个**组合包**（bundle）：`dsh plugin add` 装进某个 profile 后，`cordis.patch.yml` 这一层会自动激活（按包名解析插件入口）。

```sh
# 从 npm
dsh plugin --profile desktop add dsh-plugin-notepad

# 或直接从 GitHub 源码装（纯 JS、无构建步骤，不会触发 pnpm 的构建授权）
dsh plugin --profile desktop add github:qux-bbb/dsh-plugin-notepad

# 只验证这一层、不启动
dsh --profile desktop --dump-config     # 应能看到 "# == dsh-plugin-notepad" 这一层

# 卸载
dsh plugin --profile desktop remove dsh-plugin-notepad
```

> 用 git 装请锁定 commit（`github:qux-bbb/dsh-plugin-notepad#<sha>`），避免后续推送悄悄改变实际运行的内容。

### 手动安装器

仓库自带 `scripts/install-notepad.mjs`，把包装进 `<profile>/plugins/notepad/` 并往 profile 的 `cordis.patch.yml` 写一个受标记包围的区块。它幂等、改动前备份、`--uninstall` 只删自己写入的区块，适合 `desktop` 这类 `dsh plugin` 不便处理的 profile：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

& $node scripts\install-notepad.mjs --profile desktop             # 装到当前 desktop profile
& $node scripts\install-notepad.mjs --scope home                  # 或装到全局（$DSH_HOME），对所有 profile 生效
& $node scripts\install-notepad.mjs --profile desktop --dry-run   # 先看看会改什么
& $node scripts\install-notepad.mjs --profile desktop --uninstall # 卸载
```

生效方式：DSH 的分层顺序是 `bundle 补丁 → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch`。补丁文件的改动会被热重载；但已变成 `inactive` 且配置未变的条目宿主不会重试，此时改一次配置值或重启应用。

## 使用

### 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `notepad_add` | `content`（必填）、`tags?`、`scope?` | 记一条，正文自动 trim，标签去重 |
| `notepad_list` | `scope?`、`query?`、`limit?` | 新的在前；省略 `scope` = 合并所有启用层级；`query` 对正文 / 标签 / id 做子串过滤 |
| `notepad_clear` | `scope`（必填）、`confirm: true`（必填） | 清空指定层级（破坏性） |

`notepad_add` 返回 `{ id, at, scope, tags, content, file, total }`：

```
Noted p-mv6ieauq-01fmiy at 2026-10-13T09:59:19.922Z in the project notepad (3 note(s) there).
File: D:\work\repo\.dsh\notepad\notes.jsonl
```

### `/note` 命令

- `/note 记一条内容` → 新增一条（走默认层级）
- `/note`（不带内容）→ 列出最近 5 条

### 图形面板

侧边栏底部的 **速记** 图标（`sidebar.panellist`，order 40）会在中央主面板（`main`）打开完整界面：

- **跟随当前会话**：点开就是当前会话所在项目的 notepad；下拉可临时切到别的项目，「跟随会话」按钮一键切回，切换会话后 1.5s 内自动跟随。
- **两个层级标签页**：`项目` / `全局`，各自独立列表。
- 每条笔记支持新增、编辑（保留 id 与创建时间）、删除、打标签；顶部有搜索、刷新、清空当前层级；底部显示实际文件路径。
- 面板与模型工具、`/note` 读写的是**同一批文件**，界面上改完 `notepad_list` 立刻可见。

配置 `level` 决定哪几个标签页可用（`global` / `project` / `both`），被禁用的那一页会置灰提示。

## 配置

写在补丁条目的 `config:` 下，或由设置界面编辑（`dsh --dump-config-schema` 能看到）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `level` | `global` \| `project` \| `both` | `both` | 本部署暴露哪些层级 |
| `defaultScope` | `global` \| `project` | `project` | 调用省略 `scope` 时的落点 |
| `dshHome` | string | `''` | 全局层根目录；空 = `$DSH_HOME`，再退到 `~/.dsh` |
| `globalDir` | string | `''` | 覆盖全局笔记目录（支持 `~`），空 = `<dshHome>/notepad` |
| `projectDir` | string | `''` | 覆盖项目笔记目录（支持 `~`），空 = `<项目根>/.dsh/notepad` |
| `fileName` | string | `notes.jsonl` | 笔记文件名（只接受纯文件名） |
| `projectRootMarkers` | string[] | `['.git','.hg','.svn']` | 向上查找项目根的标记；`[]` 表示工作目录即项目根 |
| `maxNotes` | integer | `1000` | 单文件上限，超出丢弃最旧；`0` = 不裁剪 |
| `maxContentLength` | integer | `4000` | 单条正文字符上限 |
| `defaultLimit` | integer | `20` | 列表默认条数 |
| `toolPrefix` | string | `notepad` | 工具名前缀（合法值才会被采纳） |
| `enableCommand` | boolean | `true` | 是否注册 `/note` |

```yaml
# 只要全局笔记（只改设置项的写法；已用 dsh plugin add 装好时不要 insert，按 - id: notepad 覆盖该行）
- insert:
    - id: notepad
      name: dsh-plugin-notepad
      config:
        level: global
        defaultScope: global
```

注意 patch 会替换整行的 `config`（不是深合并），所以要重述你需要的每一个键。

## 存储

| 层级 | 默认路径 | 含义 |
| --- | --- | --- |
| `global` | `<DSH_HOME>/notepad/notes.jsonl` | 跨项目共享，比如「我的偏好」「常用命令」 |
| `project` | `<项目根>/.dsh/notepad/notes.jsonl` | 只属于当前项目 |

项目根 = 从会话工作目录向上查找最近的 `.git` / `.hg` / `.svn`；找不到就用会话工作目录本身。默认**不把 `.dsh` 当项目根标记**——DSH home 本身就是 `<home>/.dsh`，否则用户主目录下任何路径都会判定为「项目根 = 主目录」，项目笔记会静默混进全局文件。

每行一条 JSON，追加写；单条解析失败的行会被跳过而不是让列表整体失败：

```json
{"id":"p-mv6ieauq-01fmiy","at":"2026-10-13T09:59:19.922Z","scope":"project","tags":["errand"],"content":"remember the milk"}
```

写入按**笔记文件**串行（而不是按 store 实例），两个 store 落到同一文件时也不会互相覆盖或写出半行；改写与 `maxNotes` 裁剪都先写临时文件再 rename。

## 项目结构

```
dsh-plugin-notepad/            # 仓库根就是插件包根（dsh plugin add github: 要求如此）
├─ package.json                # name / exports / dsh.bundle + dsh.client
├─ cordis.patch.yml            # 组合包贡献的配置层
├─ lib/index.js                # 宿主半入口：name / inject / Config / apply + HTTP 路由
├─ lib/store.js                # 存储层：路径解析、JSONL 读写、编辑/删除、裁剪、并发串行化
├─ lib/api.js                  # 面板用的 JSON API（纯处理函数，可单测）
├─ lib/client.js               # 浏览器半：手写的经典脚本，无需编译
├─ test/                       # node:test 单元测试
└─ scripts/                    # install-notepad.mjs / smoke-runtime.mjs / dev-link.ps1
```

宿主半按 DSH 内置插件的形状写，只用**具名导出**（`name` / `inject` / `Config` / `apply`），不提供 `export default`；`peerDependencies` 统一写成 `"*"`，避免被具体宿主运行时版本判定不兼容而拒绝挂载。

## 开发

```powershell
# 让本仓库的 bare import（@deepseek-ai/schemastery、@deepseek-ai/dsh-tools）能解析
powershell -File scripts\dev-link.ps1

# 单元测试 + 端到端冒烟
node --test
node scripts\smoke-runtime.mjs
```

`dev-link.ps1` 只在 `node_modules/@deepseek-ai` 建一个指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 的 junction，不复制、不安装任何包。插件装进 profile 后不依赖它。

新增浏览器半需要重启一次应用（`clientModules` 缓存包元数据）；之后只改 `lib/client.js` 会被 client-hmr 热重载。宿主半的新代码会命中 Node 模块缓存，需重启才加载。

## 发布

1. **加话题**：仓库页 About → Topics 加 `dsh-plugin`（或 `gh repo edit --add-topic dsh-plugin`），仓库会出现在 [github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin) 下。
2. **发 npm**：仓库根执行 `npm publish`。纯 JS、无构建步骤，`files` 已列出 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`。
3. **从 GitHub 装**：`dsh plugin --profile <name> add github:qux-bbb/dsh-plugin-notepad`。

## License

[MIT](LICENSE)
