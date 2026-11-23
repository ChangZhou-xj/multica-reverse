# multica-reverse

Operate a [Multica](https://www.multica.ai/) workspace from inside a
[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) session.

This bundle gives you two ways in:

1. **A sidebar panel** — browse, filter, and update Multica issues without leaving the Harness UI.
2. **11 agent tools** (`multica_*`) — let the agent read and update issues, comments, and statuses on your behalf.

The Multica token never reaches the browser: the panel calls local
`/api/multica-reverse/*` routes that the Host proxies with the credential already
stored by the Multica desktop app.

## Requirements

- DeepSeek Harness with plugin/bundle support (web or desktop profile).
- The Multica desktop app installed, so a profile under `~/.multica/profiles/`
  contains a `config.json` with `token` and `server_url`.
- `multica` CLI available on `PATH` (only needed for the `multica_list_runs`
  tool); otherwise set `MULTICA_CLI_PATH`.

## Install

Copy `plugin/` into your DSH profile as a local bundle, or install it directly:

```bash
plugin_manager install_bundle target=/absolute/path/to/multica-reverse/plugin
```

If it is already installed, hot-reload after any code change:

```bash
plugin_manager set_plugin target=include:multica-reverse enabled=false
plugin_manager set_plugin target=include:multica-reverse enabled=true
```

`application: applied` means the reload succeeded — no DSH restart needed.

## Configure

Edit `plugin/cordis.patch.yml`:

```yaml
- insert:
    - id: multica-reverse
      name: '@local/multica-reverse'
      config:
        profile: my-multica-profile        # folder name under ~/.multica/profiles/
        workspaceId: 00000000-0000-0000-0000-000000000000
        cliPath: /path/to/multica          # optional; default: multica on PATH
        # configPath: /path/to/config.json # optional; default ~/.multica/profiles/<profile>/config.json
        requireApproval: true              # optional; default true
```

Environment variables take precedence over plugin config:

| Variable | Meaning |
| --- | --- |
| `MULTICA_PROFILE` | Profile folder name under `~/.multica/profiles/` |
| `MULTICA_WORKSPACE_ID` | Workspace UUID |
| `MULTICA_CLI_PATH` | Path to the `multica` CLI binary |
| `MULTICA_CONFIG` | Explicit path to a profile `config.json` |

Find the profile name in `~/.multica/profiles/`, and the workspace id from the
Multica app or CLI (`multica workspace list`).

## Agent tools

| Tool | Purpose | Write |
| --- | --- | --- |
| `multica_list_issues` | List issues; `status` / `query` / `limit` | |
| `multica_get_issue` | Get one issue (UUID or human key) | |
| `multica_list_comments` | Read comments, optional `limit` | |
| `multica_issue_timeline` | Read the activity timeline | |
| `multica_list_agents` | List agents and runtime bindings | |
| `multica_list_runtimes` | List runtimes and online status | |
| `multica_list_runs` | List runs (via CLI; REST has no such endpoint) | |
| `multica_comment_add` | Post a comment; `mention_agent_id` dispatches an agent | yes |
| `multica_issue_update` | Update status/title/description/priority; **`suppress_run: true` by default** | yes |
| `multica_issue_create` | Create an issue | yes |
| `multica_comment_resolve` | Resolve / reopen a comment thread | yes |

Notes:

- `multica_issue_update` does **not** trigger an agent by default
  (`suppress_run` defaults to true). Pass `suppress_run: false` to dispatch.
- To trigger an agent from a comment, get its exact UUID with
  `multica_list_agents` and pass `mention_agent_id`; the tool appends
  `[@name](mention://agent/<uuid>)` to the body. Only agents/squads enqueue a
  run; members only render a link.
- The four write tools respect the Harness approval policy: `ask` shows a
  confirmation prompt, `never` ("just do it") allows them automatically. The
  bundle detects the policy via `approval.overrideOf(session)` so writes never
  deadlock with "asked but always rejected".

## Sidebar panel

The **Multica** panel lists issues with status filters and search. Open an issue
to read its description and comments, change its status, or post a comment.
Typing `@` in the comment box pops up the available agents — selecting one
inserts a precise mention link, which Multica natively resolves into a run when
you send the comment.

## Mention format

Only a mention enqueues a run, and the shape must be exact:
`[@Label](mention://<type>/<id>)`.

| type | id source | Effect |
| --- | --- | --- |
| `agent` | `id` from `agent list` | enqueues a run |
| `squad` | `id` from `squad list` | enqueues the leader |
| `member` | `user_id` from workspace members | renders only, no run |
| `issue` | the issue `id` | renders only, always safe |
| `all` | literal `all` | broadcast; suppresses the assignee auto-trigger |

A mention inside a code block is inert. Bare `@name` does nothing — always use
the full link form.

## CLI quick reference

All CLI commands need `--profile` and `--workspace-id` (the token lives in the
profile, not in an environment variable). `mc.sh` is a thin wrapper that reads
`MULTICA_BIN`, `MULTICA_PROFILE_NAME`, and `MULTICA_WS` from the environment.

```bash
./mc.sh issue list --status todo --output table
./mc.sh issue get ABC-8 --output json
./mc.sh issue search "keyword" --output table
./mc.sh issue status ABC-8 in_progress --no-start   # --no-start = no agent run
./mc.sh issue comment add ABC-8 --content-file ./note.md
./mc.sh issue runs ABC-8 --active --output json
```

Output gotchas: `issue list --output json` returns `{issues:[], total, ...}`,
not a bare array. `--output json` goes to stdout and warnings to stderr — do not
merge them with `2>&1`.

## License

MIT — see [LICENSE](LICENSE).
