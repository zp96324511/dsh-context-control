# dsh-context-control

MCP / 技能 / 内置工具可见性门控：新会话默认精简（官方条目开、用户自配的关），对话中通过 `context_control` 工具或输入框左侧的「组件上下文」胶囊按需开关；每个条目都带一行说明，胶囊显示三类合计的启用数量。**每个条目两个圆点**（蓝＝会话级、紫＝工作区级，含义见底栏「?」里的使用说明）：会话级只改当前会话，不影响同项目的其它会话；工作区级写入项目默认值，本会话立即生效，之后在该项目里新开的会话继承它（会话自己的选择始终优先）。**自带在线安装与升级通道**：能从它被安装的那个渠道查新版本，并在面板里一键升级；装完只提示你重启 `dsh web`——宿主的启动参数可能只有你知道，插件不会替你重启。

[English](README.md) | 中文

## 目录

- [安装](#安装)
- [升级](#升级)
- [发布（把 dist 变成在线渠道）](#发布把-dist-变成在线渠道)
- [配置](#配置)
- [回滚与排障](#回滚与排障)
- [本地开发](#本地开发)

-----

## 安装

三种在线方式，装完都是同样的 profile 依赖，区别只在「以后从哪查新版本」。

### 1. npm registry

```pwsh
dsh plugin --profile web add dsh-context-control
```

之后升级走 `https://registry.npmjs.org/` 的 `dist-tags.latest`。

### 2. GitHub Release 压缩包（不需要 npm 账号）

```pwsh
dsh plugin --profile web add https://github.com/zp96324511/dsh-context-control/releases/latest/download/dsh-context-control.tgz
```

发布工作流给每个 release 附了一份**版本无关**的 `dsh-context-control.tgz`，所以这个 URL 永远指向最新版，不用每次改。升级检查读 GitHub Releases API 的 `tag_name`。

### 3. 自建静态渠道（内网、对象存储、任意静态站）

```pwsh
npm run channel                 # 生成 dist/：tarball + channel.json
npm run channel:serve           # 本地试跑：http://127.0.0.1:10600/channel.json
dsh plugin --profile web add http://<你的站>/dsh-context-control/dsh-context-control-0.4.0.tgz
```

插件**不需要额外配置就能找到升级渠道**：它取自己依赖的那条 tarball URL 的目录，去读同目录的 `channel.json`。把 `dist/` 整个丢到任何静态服务器上，安装和升级就都通了。

装完重启一次 `dsh web`（第一次加载需要重启）。之后的升级由插件安装好文件，面板会提示你重启 `dsh web`。

> 想手动换到某个具体版本，用带 tag 的地址：`.../releases/download/v0.4.3/dsh-context-control.tgz`。重复安装**同一个** `releases/latest/download/...` 地址会被 pnpm 视为 spec 未变而跳过（面板里的一键升级不受影响，它每次都用 channel.json 给出的 tag 地址）。

## 升级

### 在哪里点

打开任一会话输入框左侧的「组件上下文」胶囊 → 面板底部有一行版本信息：

- 平时：`v0.4.0 · 已是最新 · [检查更新]`
- 有新版本：胶囊上出现 `↑` 角标，面板里显示 `v0.4.0 → v0.4.1 · [一键升级]`
- 升级中：`[升级中…]` + `[详情]`（展开是 pnpm 的实时输出）
- 完成后：`已升级，重启 dsh web 后生效`（新代码已被 HMR 接上时改为 `[刷新页面]`）

插件**不会**提供「重启服务」按钮：宿主可能是你用任意参数、任意守护方式拉起来的，插件重猜一条命令行去重启它，轻则参数不对，重则把 GUI 弄没。重启这一步留给在终端里启动它的你。

同一台机器上的多个面板共用这一份状态：装的是哪个版本是宿主的事实，不是某个会话的。

### 一键升级做了什么

按钮不会去「卸载再安装」——那会在失败的瞬间留下一个没有插件的 profile，而失败往往就发生在网络或构建上。它做的是：

1. **查**：问渠道最新版本（宿主缓存 6 小时；点「升级」会强制重查，避免刚发布就被旧缓存挡住）。
2. **装**：在 profile 目录里跑一条和你在终端里敲的完全相同的命令：

   ```pwsh
   dsh plugin --profile web add <spec>
   ```

   `<spec>` 由渠道决定：registry 是 `名字@版本`，tarball 渠道是新的 tarball URL。这样它就自动继承了 DSH 包管理器的全部保证：profile 写锁、`engines.dsh` 兼容性预检、失败时把 `package.json` 与 `pnpm-lock.yaml` 回滚到快照。

3. **验**：读 `node_modules/<包名>/package.json` 的实际版本。pnpm 的退出码 0 不等于装到了你要的版本（`minimumReleaseAge` 这类供应链策略会装成更旧的版本），所以版本不符会如实报出来。
4. **提示重启**：到这里就结束。宿主没有退出，也没有被插件重新拉起；面板显示「已升级，重启 dsh web 后生效」，你按原来的启动方式重启即可。

   有 HMR 时通常连重启都不需要：插件会对比「模块加载时的版本」和「磁盘上的版本」，代码确实已经换了才提示重启——否则只提供 `[刷新页面]`。

### 升级结果在插件重载后仍然可见

一次升级常常会导致插件自己被替换。为了不让「升级完成了」这个结论随之蒸发，任务结果写在 `$DSH_HOME/storages/dsh-context-control-update.json`，插件重新加载后会读回它；记录里如果还是 `running`（说明安装被重载打断），会如实报告为失败而不是永远转圈。

## 发布（把 dist 变成在线渠道）

```pwsh
npm run check                       # 清单守卫 + 两套测试
npm run channel                     # dist/：tarball + channel.json（累积版本）
npm run channel -- --prune 5        # 只保留最近 5 个版本
```

`channel.json` 形如：

```json
{
  "name": "dsh-context-control",
  "channel": "stable",
  "latest": "0.4.0",
  "versions": {
    "0.4.0": {
      "url": "dsh-context-control-0.4.0.tgz",
      "sha256": "…",
      "engines": { "dsh": ">=0.2.0-rc.2" }
    }
  }
}
```

- **npm**：打 tag（`v0.4.0`）触发 `.github/workflows/publish.yml`；有 `NPM_TOKEN` 就发布到 npm，没有就只产出 release。
- **GitHub Release**：同一工作流会把 `dsh-context-control.tgz`（稳定名）、`dsh-context-control-0.4.0.tgz`（版本名）、`channel.json` 一起附上。
- **自建站**：把 `dist/` 上传即可；只要 `channel.json` 与 tarball 同目录，已安装的机器就能自己找到升级。

`scripts/check-manifest.mjs` 是发布前的守卫：`files` 漏了某个文件、`exports` 指向了没发布的东西、宿主与客户端的路由前缀写岔了、两半的插件 id 与包名不一致——都在 `npm publish` 之前失败，而不是在别人的机器上。

### 推到 GitHub 并出 release（本仓库的实际流程）

```pwsh
# 用专用部署密钥推送（本机没有 PAT；密钥已加到账号 ~/.ssh/id_ed25519_dsh，
# 对应的公钥在 GitHub → Settings → SSH keys。仓库本地已设 user.name/email。）
$key = ($env:USERPROFILE -replace '\\','/') + '/.ssh/id_ed25519_dsh'
$env:GIT_SSH_COMMAND = "ssh -i $key -o IdentitiesOnly=yes -o BatchMode=yes"

npm run check                                  # 清单守卫 + 两套测试
# 改 package.json 的 version 与 CHANGELOG.md
git add -A
git commit -m "0.4.5: …"
git tag -a v0.4.5 -m "dsh-context-control 0.4.5"   # tag 必须等于 version，工作流会校验
git push origin main
git push origin v0.4.5
```

`Publish` 工作流在 tag 推送后自动跑：校验 `tag == version` → `npm run check` →（配了 `NPM_TOKEN` 才发 npm）→ `npm pack` → 生成 `channel.json` → 建 release 并附上 `dsh-context-control.tgz`（稳定名）、`dsh-context-control-<版本>.tgz`、`channel.json`，约十秒出结果。已安装的机器下一次检查就会看到它：`https://github.com/<owner>/<repo>/releases/latest/download/channel.json`。

## 配置

### 会话级与工作区级

面板里每个条目后面有两个圆点状开关（radio：空环＝关，环中有实心点＝开；蓝＝会话级，紫＝工作区级），`context_control` 工具也接受 `scope` 参数：

| `scope` | 写到哪里 | 影响范围 |
|---|---|---|
| `session`（默认） | `context_control` 域的 `sessions` 表，按会话 id 存（连同当时的 `cwd`） | 只改当前会话；重新打开这个会话（包括重启宿主后）仍是这个状态（归档过的会话恢复时重新跟随工作区） |
| `workspace` | 项目记录里的显式选择（同一域的 `projects` 表，按 `cwd` 存） | 本会话立即生效；之后在同一目录新开的会话继承它 |

- 工作区的有效状态 = 配置里的默认值（`defaultOn` / `defaultOff` / `officialServers` / `defaultOnSkills` / `defaultOffTools` 等）**叠加**项目记录里的显式选择；记录里没有的条目仍走配置默认值，所以改配置能影响从未被手动开关过的条目。
- 新会话在打开时把工作区状态复制一份作为自己的起点，再叠加它自己的会话记录（如果这个会话以前改过）。已经打开的会话不会被别人的「工作区」写入拽动——这正是把两个开关分开的原因。
- 「工作区」写入的是**你点过的那个条目**，不是整个会话状态：只是把 `read` 关掉，不会顺手把 `bash` 的默认值一起钉死。
- 两个开关允许给出不同答案，**会话级优先级更高**：点「工作区」只改项目默认值，不会覆盖本会话已有的会话级选择；只有当这个条目在本会话里没有自己的选择时，新默认才立刻反映到本会话。面板里蓝色圆点显示本会话实际生效的状态，紫色圆点显示项目默认。
- 工作区记录按 `cwd`（项目目录）区分；会话记录按会话 id 存，并记住它当时的 `cwd`，换了目录的会话不会继承旧覆盖。没有工作目录的会话只能用「会话」开关。
- 归档会话会**立刻删掉它的会话记录**：DSH 没有「会话已删除」事件，归档是它给出的唯一「这个会话用完了」的信号（`workspace` 域根记录里的 `archivedSessionIds`，经 `domain/changed` 事件到达宿主）。归档本身可撤销，所以恢复出来的会话按**当时**的工作区默认重新开始，而不是复活已经作废的选择。
- 没被归档的会话记录在每次写入时剪枝：超过 180 天没动、或总数超过 1000 条时按最旧先删。
- 两张表都在 `context_control` 域里（JSON 后端即 `$DSH_HOME/storages/context_control.json`，表名 `projects` 与 `sessions`）：删掉这个文件等于把工作区默认和所有会话选择一起清空。

### 门控覆盖哪些技能根

DSH 的技能是分层的：随 DSH 发布的 `bundled` 技能与宿主注册的 `runtime` 技能在全局层，其余由 agent 预设里的文件系统 provider 提供。本插件按**当前会话的 agent 视角**读取，所以下列根里的技能都会出现在面板里、都能开关（默认关）：

| 根 | `source` |
|---|---|
| `<DSH 内置技能目录>` | `bundled`（默认开） |
| `<项目根>/.dsh/skills` | `project-dsh` |
| `<项目根>/.agents/skills` | `project-agents` |
| `$DSH_HOME/skills`（默认 `~/.dsh/skills`） | `user-dsh` |
| `~/.agents/skills` | `user-agents` |
| 预设里配置的 `customSkillDirs` | `custom` |

`user-dsh` 这一根以 `$DSH_HOME` 为准，默认才是 `~/.dsh`；`~/.agents` 是多个 agent
共用的配置根，不随 `DSH_HOME` 移动。

如果某个技能在模型上下文里存在、面板里却没有，先确认它放在上面某个根里；再看宿主日志里有没有 `skill discovery failed`。

### 门控覆盖哪些工具

面板把每个**可门控的内置工具**单独列成一行，和 MCP 服务器、技能一样可开关——每行两个圆点开关（蓝＝会话、紫＝工作区，见上）。三类条目（MCP / 技能 / 工具）用 tab 切换而不是竖向堆三组；每个 tab 自带 `开/总`，胶囊则把三类合在一起——`组件上下文 3/5`。每行还带一行说明，取资源自己的描述：工具用 schema 的 `description`，技能用目录里的 `description`，MCP 服务器用它发布的 `instructions`（直接读 `mcp:<server>` 提示段注册的文本，宿主刚启动、还没发过模型请求时也能显示；没发布说明的服务器只显示工具数）。悬停看完整描述与来源，屏幕阅读器通过 `aria-description` 读取同一段文本。

- 关掉的工具从模型视图里移除（和 MCP 工具共用同一次 `tools.restrict`），并在 `system-prompt/assemble` 时删掉对应的 `tool:<名字>` 引导段；只 restrict 是不够的，那段文本不属于 schema。
- 内置工具**默认全开**，这样升级不会改变现有行为；想默认关掉某几个，用 `defaultOffTools`（见下）。
- `run_code`、`context_control`、`structured_output` 受保护，永远不出现在列表里，也不能被关——`context_control` 本身就是把门控打开的入口，关掉它等于把自己锁在门外。
- MCP 工具不单独列出（它们跟着服务器开关走）；`list_mcp_resources` 等资源工具同样由服务器开关控制。
- 底部版本行从左到右依次是版本号、状态文字（「检查中…」「已是最新」）、「检查更新」按钮，全部左对齐；最右侧是一个「?」按钮，使用说明折叠在它后面，点开才占位。点击「检查更新」立刻变成「检查中…」并转圈（同步进入 busy，不等响应），宿主从缓存里毫秒级回答也不会看起来像没点到。
- 每行的第二行永远有内容：资源自己有描述就显示描述，没有就显示条目自身的说明（MCP 服务器显示工具数、技能显示来源）。MCP 服务器只有在 `initialize` 里发布了 `instructions` 才有描述可显示——`chrome-devtools-mcp` 没有这个字段，所以它那一行显示的是工具数。这段文本取自 `mcp:<server>` 提示段注册的提供者，不依赖是否装配过一次系统提示；`dsh-mcp-client` 加在开头的 `### MCP server: <name>` 标题会被去掉。

在 `$DSH_HOME/profiles/web/cordis.patch.yml`（默认
`~/.dsh/profiles/web/cordis.patch.yml`）里：

```yaml
- id: context-control
  name: dsh-context-control
  config:
    defaultOn: [hivemem]
    defaultOffTools: []        # 例：[bash, chrome-main 之类]；内置工具默认全开
    update:
      # 可选：渠道由安装来源自动推导，下面几项用于覆盖
      manifestUrl: https://<你的站>/dsh-context-control/channel.json
      # github: zp96324511/dsh-context-control
      # registry: https://registry.npmmirror.com/
      # packageName: dsh-context-control
      # checkIntervalMs: 21600000
      # upgradeTimeoutMs: 900000
      # launcher: <dsh 的可执行入口，默认自动发现>
      # runtimeVersion: 0.2.1-rc.2   # 自动发现失败时用于 engines.dsh 判断
```

`link:` / `file:` 安装**默认不允许原地升级**（会覆盖你的工作目录），面板会显示「升级不可用」；显式配了 `manifestUrl` / `github` / `registry` 才解除这个保护。

## 回滚与排障

| 现象 | 原因与处理 |
|---|---|
| `检查失败` / `cannot tell which channel` | 渠道不可达，或安装来源是 git 分支。面板报错而不会说「已是最新」。修渠道，或显式配 `update.manifestUrl`。 |
| `升级不可用` | 当前是 `link:` / `file:` 安装。按需发布并 `add <tarball URL>`，或配 `update.manifestUrl`。 |
| 升级后仍是旧版本 | `[详情]` 里看 pnpm 输出；`minimumReleaseAge` 会暂缓刚发布的版本，等一会儿或显式指定版本。 |
| 升级后仍提示重启 | 宿主还在跑旧代码：按你**原来的启动方式**重启 `dsh web`。插件故意不代劳——它重猜的命令行可能少了你的 `--profile` / `--port` / 环境变量。 |
| 想钉回旧版本 | `dsh plugin --profile web add http://<站>/dsh-context-control/dsh-context-control-0.3.5.tgz`（`channel.json` 累积版本就是为了这个）。 |
| 想回到本地开发态 | `dsh plugin --profile web add link:C:/data/projects/dsh-context-control`，再重建插件的 `node_modules` junction（见下）。 |

## 本地开发

工作区根目录就是包根，profile 里用 `link:` 指向它。`link:` 会把模块解析成真实路径、逃出 DSH 的 `@deepseek-ai/*` 解析路由，所以本地目录需要一个指向 DSH 安装的 junction：

```pwsh
mklink /J "C:\data\projects\dsh-context-control\node_modules" "C:\Users\<you>\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\node_modules"
```

（nvm 切 Node 版本后要重建。）

测试：

```pwsh
npm run check        # 清单守卫 + node --check + 25 项升级测试 + 9 项宿主门控回归 + 46 项客户端离线回归
npm test             # 只跑两套测试
```

客户端回归是离线的：`test/client-harness.cjs` 自带一个 mini React、假网关和假 DOM，把面板（含每个条目的两个 scope 开关与独立状态）、键盘导航、多面板隔离、以及升级按钮的每个阶段（当前 → 不可用 → 可升级 → 升级中 → 重启提示）都走一遍。
