# multica-reverse

在 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）会话里操作 [Multica](https://www.multica.ai/) 工作区。

这个插件包提供两种使用方式：

1. **侧边栏面板** —— 不用离开 Harness 界面，就能浏览、筛选、修改 Multica 工单。
2. **11 个 agent 工具**（`multica_*`）—— 让 agent 代你读取和更新工单、评论、状态。

Multica 的 token 不会传到浏览器：面板调用本地的 `/api/multica-reverse/*` 路由，由 Host 端用 Multica 桌面应用已经保存好的凭证代为请求。

## 运行环境要求

- 支持插件 / bundle 的 DeepSeek Harness（web 或 desktop profile 均可）。
- 已安装 Multica 桌面应用，因此 `~/.multica/profiles/` 下有一个包含 `token` 和 `server_url` 的 `config.json`。
- `multica` CLI 在 `PATH` 里（只有 `multica_list_runs` 这个工具需要；否则请设置 `MULTICA_CLI_PATH`）。

## 安装

把 `plugin/` 目录作为本地 bundle 放进你的 DSH profile，或直接安装：

```bash
plugin_manager install_bundle target=/你的绝对路径/multica-reverse/plugin
```

如果已经装过，改完代码后热重载即可：

```bash
plugin_manager set_plugin target=include:multica-reverse enabled=false
plugin_manager set_plugin target=include:multica-reverse enabled=true
```

输出 `application: applied` 表示重载成功，无需重启 DSH。

## 配置

编辑 `plugin/cordis.patch.yml`：

```yaml
- insert:
    - id: multica-reverse
      name: '@local/multica-reverse'
      config:
        profile: my-multica-profile        # ~/.multica/profiles/ 下的文件夹名
        workspaceId: 00000000-0000-0000-0000-000000000000
        cliPath: /path/to/multica          # 可选；默认用 PATH 里的 multica
        # configPath: /path/to/config.json # 可选；默认 ~/.multica/profiles/<profile>/config.json
        requireApproval: true              # 可选；默认 true
```

环境变量优先级高于插件配置：

| 变量 | 含义 |
| --- | --- |
| `MULTICA_PROFILE` | `~/.multica/profiles/` 下的 profile 文件夹名 |
| `MULTICA_WORKSPACE_ID` | 工作区 UUID |
| `MULTICA_CLI_PATH` | `multica` CLI 可执行文件路径 |
| `MULTICA_CONFIG` | 显式指定 profile 的 `config.json` 路径 |

profile 名可在 `~/.multica/profiles/` 里查看；工作区 id 从 Multica 应用或 CLI（`multica workspace list`）获取。

## Agent 工具

| 工具 | 作用 | 写操作 |
| --- | --- | --- |
| `multica_list_workspaces` | 列出所有工作区（id/名称/slug/前缀） | |
| `multica_list_projects` | 列出工作区的项目，支持 `workspace` 参数 | |
| `multica_get_project` | 按 UUID 或标题读取单个项目详情 | |
| `multica_issue_stats` | 按状态/优先级统计，列出过期与快到期工单 | |
| `multica_list_issues` | 列出工单，支持 `status` / `query` / `limit` | |
| `multica_get_issue` | 取单个工单（UUID 或人类可读的编号都行） | |
| `multica_list_comments` | 读评论，可指定 `limit` | |
| `multica_issue_timeline` | 读活动时间线 | |
| `multica_list_agents` | 列出 agent 及其 runtime 绑定 | |
| `multica_list_runtimes` | 列出 runtime 及在线状态 | |
| `multica_list_runs` | 列出 run（走 CLI；REST 没有这个端点） | |
| `multica_comment_add` | 发评论；`mention_agent_id` 可派活给 agent | 是 |
| `multica_issue_update` | 修改状态/标题/描述/优先级；**默认 `suppress_run: true`（不排队 run）** | 是 |
| `multica_issue_create` | 新建工单 | 是 |
| `multica_comment_resolve` | 标记评论线程已解决 / 重新打开 | 是 |

要点：

- `multica_issue_update` 默认**不会触发 agent**（`suppress_run` 默认 true）。要派活请显式传 `suppress_run: false`。
- `multica_list_issues` 支持 `project` / `assignee` / `priority` / `due_before` 筛选，以及 `workspace` 参数（传 UUID/名称/slug/前缀）；不传则用默认工作区。
- `multica_issue_stats` 的 `within_days` 默认 7 天；过期/快到期清单会自动排除 done/cancelled 状态。
- 想在评论里触发 agent，先用 `multica_list_agents` 拿到准确的 UUID，再传给 `mention_agent_id`；工具会在正文末尾自动补上 `[@名字](mention://agent/<uuid>)`。**只有 agent / squad 会入队 run**，member 只会渲染链接。
- 4 个写工具受 Harness 审批策略管辖：策略是 `ask` 时弹确认框；策略是 `never`（"不问，直接做"）时自动放行。插件通过 `approval.overrideOf(session)` 判断策略，不会出现"问了必被拒导致工具全废"的死锁。

## 侧边栏面板

**Multica** 面板按状态筛选、搜索列出工单。点开工单可阅读描述和评论、修改状态、发表评论。评论框里输入 `@` 会弹出可选 agent 列表，选中后插入精确的 mention 链接；发送后 Multica 会原生解析该链接并唤起对应 agent。

## Mention 格式

**只有 mention 才会入队 run**，且格式必须精确：`[@Label](mention://<type>/<id>)`。

| type | id 来源 | 效果 |
| --- | --- | --- |
| `agent` | `agent list` 里的 `id` | 入队 run |
| `squad` | `squad list` 里的 `id` | 给 leader 入队 |
| `member` | 工作区成员的 `user_id` | 只渲染，不触发 |
| `issue` | 工单的 `id` | 只渲染，始终安全 |
| `all` | 字面量 `all` | 广播，并抑制 assignee 的自动触发 |

代码块里的 mention 是惰性的，不会触发；裸写 `@名字` 也没用，一定要用完整链接形式。

## CLI 速查

所有 CLI 命令都要带 `--profile` 和 `--workspace-id`（token 存在 profile 里，环境变量拿不到）。`mc.sh` 是一个薄包装，从环境变量读取 `MULTICA_BIN`、`MULTICA_PROFILE_NAME`、`MULTICA_WS`。

```bash
./mc.sh issue list --status todo --output table
./mc.sh issue get ABC-8 --output json
./mc.sh issue search "关键字" --output table
./mc.sh issue status ABC-8 in_progress --no-start   # --no-start = 不启动 agent run
./mc.sh issue comment add ABC-8 --content-file ./note.md
./mc.sh issue runs ABC-8 --active --output json
```

解析输出注意：`issue list --output json` 返回的是 `{issues:[], total, ...}`，不是裸数组；`--output json` 走 stdout，警告走 stderr，**不要用 `2>&1` 混流**。

## 内嵌原生页面（多工作区）

面板顶部可在 **原生页面** 与 **精简面板** 之间切换：

- **精简面板**：轻量的工单列表 + 详情，支持状态筛选、搜索、改状态、发评论、@ agent。
- **原生页面**：在面板里直接嵌入 Multica 官方的工单看板，你的所有工作区都出现在下拉框里，切换即可浏览对应工作区。

原生页面通过插件内置的本地同站反向代理访问 Multica（默认 `127.0.0.1:18080`，可用 `MULTICA_PROXY_PORT` 修改）。代理会在 Host 侧给 `/api/*` 请求自动加上已配置的 Bearer token，因此内嵌页面无需单独登录、也无需输入验证码，打开即是登录态。

> 说明：这是为解决跨域 iframe 被视为第三方、登录 cookie 被拦截而设计的。代理仅监听本机 loopback，Multica 凭证仍只留在 Host 侧，不会暴露给浏览器或代理客户端以外。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
