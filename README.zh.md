# dsh-context-control

会话级的 MCP / 技能可见性门控：新会话默认精简（官方条目开、用户自配的关），对话中通过 `context_control` 工具或输入框左侧的「上下文」胶囊按需开启；开关状态按项目持久化。**自带在线安装与升级通道**：能从它被安装的那个渠道查新版本，并在面板里一键升级、自动重启。

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

装完重启一次 `dsh web`（第一次加载需要重启；之后的升级由插件自己处理，见下）。

> 想手动换到某个具体版本，用带 tag 的地址：`.../releases/download/v0.4.3/dsh-context-control.tgz`。重复安装**同一个** `releases/latest/download/...` 地址会被 pnpm 视为 spec 未变而跳过（面板里的一键升级不受影响，它每次都用 channel.json 给出的 tag 地址）。

## 升级

### 在哪里点

打开任一会话输入框左侧的「上下文」胶囊 → 面板底部有一行版本信息：

- 平时：`v0.4.0 · 已是最新 · [检查更新]`
- 有新版本：胶囊上出现 `↑` 角标，面板里显示 `v0.4.0 → v0.4.1 · [一键升级]`
- 升级中：`[升级中…]` + `[详情]`（展开是 pnpm 的实时输出）
- 完成后：`[重启服务]`（宿主不等 HMR）或 `[刷新页面]`（新代码已生效）

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
4. **重启**：宿主退出，一个脱离的 helper 等旧进程退出、端口释放，再用**同一条命令行**把宿主拉起来（`respawn.cjs`）。没有 systemd / pm2 / Windows 服务的机器也不会因为一次升级变成一个死掉的 GUI。

   有 HMR 时也可能不需要重启：插件会对比「模块加载时的版本」和「磁盘上的版本」，只有确实换了代码才要求重启——否则只提示刷新页面。

### 结果在重启后仍然可见

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

在 `~/.dsh/profiles/web/cordis.patch.yml` 里：

```yaml
- id: context-control
  name: dsh-context-control
  config:
    defaultOn: [hivemem]
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
      restart:
        mode: respawn      # respawn | exit（交给 systemd 等）| none
        port: 10550        # 等待端口释放；默认取命令行里的 --port
        logFile: C:\Users\you\.dsh\logs\dsh-web-respawn.log
```

`link:` / `file:` 安装**默认不允许原地升级**（会覆盖你的工作目录），面板会显示「升级不可用」；显式配了 `manifestUrl` / `github` / `registry` 才解除这个保护。

## 回滚与排障

| 现象 | 原因与处理 |
|---|---|
| `检查失败` / `cannot tell which channel` | 渠道不可达，或安装来源是 git 分支。面板报错而不会说「已是最新」。修渠道，或显式配 `update.manifestUrl`。 |
| `升级不可用` | 当前是 `link:` / `file:` 安装。按需发布并 `add <tarball URL>`，或配 `update.manifestUrl`。 |
| 升级后仍是旧版本 | `[详情]` 里看 pnpm 输出；`minimumReleaseAge` 会暂缓刚发布的版本，等一会儿或显式指定版本。 |
| 重启没回来 | 看 `restart.logFile`。需要的话把 `restart.mode` 改成 `exit` 交给自己的守护进程。 |
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
npm run check        # 清单守卫 + node --check + 20 项宿主测试 + 28 项客户端离线回归
npm test             # 只跑两套测试
```

客户端回归是离线的：`test/client-harness.cjs` 自带一个 mini React、假网关和假 DOM，把面板、键盘导航、多面板隔离、以及升级按钮的每个阶段（当前 → 不可用 → 可升级 → 升级中 → 重启 → 等宿主回来）都走一遍。
