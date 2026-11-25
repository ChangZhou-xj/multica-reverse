/**
 * Multica workspace tools for DeepSeek Harness.
 *
 * Talks to the Multica server over its REST API with the token that the
 * Multica desktop app already stored under ~/.multica/profiles/<profile>/.
 * Reads are plain tools; every write is gated by tools/pre-execute so the
 * user approves it in the Harness UI.
 */
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export const name = 'multica-reverse'
export const inject = ['tools']

// No personal defaults. Supply the profile / workspace via plugin config
// (cordis.patch.yml) or the MULTICA_* environment variables. See README.
let opts = {}

const WRITE_TOOLS = new Set([
  'multica_comment_add',
  'multica_issue_update',
  'multica_issue_create',
  'multica_comment_resolve',
])

function profileName() {
  const v = process.env.MULTICA_PROFILE || opts.profile
  if (!v) throw new Error('Multica profile not set: configure plugin config.profile or set MULTICA_PROFILE')
  return v
}

function workspaceId() {
  const v = process.env.MULTICA_WORKSPACE_ID || opts.workspaceId
  if (!v) throw new Error('Multica workspace id not set: configure plugin config.workspaceId or set MULTICA_WORKSPACE_ID')
  return v
}

function cliPath() {
  return process.env.MULTICA_CLI_PATH || opts.cliPath || 'multica'
}

function profileConfigPath() {
  const configured = process.env.MULTICA_CONFIG || opts.configPath
  if (configured) return configured
  return join(homedir(), '.multica', 'profiles', profileName(), 'config.json')
}

let cached = null

async function credentials() {
  if (cached) return cached
  const raw = await readFile(profileConfigPath(), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed.token || !parsed.server_url) {
    throw new Error(`No Multica token in ${profileConfigPath()}`)
  }
  cached = { token: parsed.token, base: String(parsed.server_url).replace(/\/+$/, '') }
  return cached
}

async function api(method, path, body) {
  const { token, base } = await credentials()
  const url = `${base}${path}`
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Multica ${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 400)}`)
  }
  return text.trim() ? JSON.parse(text) : null
}

const q = (extra = '') => `?workspace_id=${encodeURIComponent(workspaceId())}${extra}`

/** Resolve a workspace UUID / name / slug / prefix to its UUID. */
async function resolveWorkspace(value) {
  if (!value) return workspaceId()
  const v = String(value).trim()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return v
  const list = await api('GET', '/api/workspaces')
  const hit = (Array.isArray(list) ? list : []).find(
    (w) =>
      w.id === v ||
      w.slug === v ||
      w.name === v ||
      (w.issue_prefix || '').toLowerCase() === v.toLowerCase(),
  )
  if (!hit) throw new Error(`Unknown Multica workspace: ${value}`)
  return hit.id
}

/** Resolve a project UUID or title to its UUID within a workspace. */
async function resolveProjectId(value, ws) {
  const v = String(value).trim()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return v
  const data = await api('GET', `/api/projects?${new URLSearchParams({ workspace_id: ws, limit: '100' })}`)
  const hit = (data.projects || []).find(
    (p) => p.id === v || p.title === v || (p.title || '').toLowerCase() === v.toLowerCase(),
  )
  if (!hit) throw new Error(`Unknown Multica project: ${value}`)
  return hit.id
}

/** Resolve an agent UUID or name to its UUID. */
async function resolveAgentId(value) {
  const v = String(value).trim()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return v
  const list = await api('GET', '/api/agents')
  const hit = (Array.isArray(list) ? list : []).find(
    (a) => a.id === v || a.name === v || (a.name || '').toLowerCase() === v.toLowerCase(),
  )
  if (!hit) throw new Error(`Unknown Multica agent: ${value}`)
  return hit.id
}

/** Accept a UUID or a human key such as `ABC-8`; the API resolves both. */
function issueRef(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) throw new Error('issue is required (UUID or key like `ABC-8`)')
  return trimmed
}

function text(value) {
  return [{ type: 'text', text: value }]
}

function table(rows, columns) {
  if (!rows.length) return '(no rows)'
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c])))].join('\n')
}

const issueSummary = (i) => ({
  key: i.identifier,
  status: i.status,
  assignee: i.assignee_type ? `${i.assignee_type}:${String(i.assignee_id).slice(0, 8)}` : '',
  priority: i.priority || '',
  due: String(i.due_date || '').slice(0, 10),
  title: i.title,
})

const tools = [
  {
    name: 'multica_list_issues',
    description:
      'List issues in a Multica workspace. Filter by status, free-text query, project, assignee, priority or due date. Accepts a workspace UUID/name/slug/prefix; defaults to the configured workspace. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Status key to filter on, e.g. in_review.' },
        query: { type: 'string', description: 'Free-text search across issue titles.' },
        workspace: { type: 'string', description: 'Workspace UUID, name, slug or prefix. Defaults to configured workspace.' },
        project: { type: 'string', description: 'Project UUID or title to filter on.' },
        assignee: { type: 'string', description: 'Agent UUID or name to filter on.' },
        priority: { type: 'string', description: 'Priority key: low, medium, high, urgent.' },
        due_before: { type: 'string', description: 'Keep issues due on or before YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Maximum rows to return; defaults to 20.' },
        offset: { type: 'number', description: 'Rows to skip; defaults to 0.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(`Multica issues (${value.total} matched)\n\n${table(value.issues, ['key', 'status', 'priority', 'due', 'assignee', 'title'])}`),
    },
    async execute(args = {}) {
      const ws = await resolveWorkspace(args.workspace)
      const params = new URLSearchParams({ workspace_id: ws })
      if (args.status) params.set('status', String(args.status))
      if (args.query) params.set('q', String(args.query))
      if (args.project) params.set('project_id', await resolveProjectId(args.project, ws))
      if (args.assignee) params.set('assignee_id', await resolveAgentId(args.assignee))
      if (args.priority) params.set('priority', String(args.priority))
      params.set('limit', String(Math.min(Math.max(Number(args.limit) || 20, 1), 100)))
      if (args.offset) params.set('offset', String(Number(args.offset) || 0))
      const data = await api('GET', `/api/issues?${params}`)
      let issues = (data.issues || []).map(issueSummary)
      if (args.due_before) {
        const before = String(args.due_before).slice(0, 10)
        issues = issues.filter((i) => i.due && i.due.slice(0, 10) <= before)
      }
      return { total: data.total ?? issues.length, issues }
    },
  },
  {
    name: 'multica_get_issue',
    description:
      'Read one Multica issue by UUID or key (for example `ABC-8`), including its description, status, assignee, and metadata. Read-only.',
    parameters: {
      type: 'object',
      properties: { issue: { type: 'string', description: 'Issue UUID or key such as `ABC-8`.' } },
      required: ['issue'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          [
            `${value.key}  ${value.status}  ${value.title}`,
            `id: ${value.id}`,
            `assignee: ${value.assignee || '(unassigned)'}`,
            `updated: ${value.updated_at}`,
            '',
            value.description || '(no description)',
          ].join('\n'),
        ),
    },
    async execute(args = {}) {
      const data = await api('GET', `/api/issues/${encodeURIComponent(issueRef(args.issue))}${q()}`)
      return {
        id: data.id,
        key: data.identifier,
        title: data.title,
        status: data.status,
        status_category: data.status_category,
        assignee: data.assignee_type ? `${data.assignee_type}:${data.assignee_id}` : null,
        description: data.description || '',
        priority: data.priority,
        updated_at: data.updated_at,
        revision: data.revision,
      }
    },
  },
  {
    name: 'multica_list_comments',
    description:
      'List the comment threads on a Multica issue, oldest first, with resolved state and parent thread. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'Issue UUID or key.' },
        limit: { type: 'number', description: 'Maximum comments to return; defaults to 20 (most recent kept).' },
      },
      required: ['issue'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          value.comments.length
            ? value.comments
                .map(
                  (c) =>
                    `[${c.id}] ${c.author} ${c.resolved ? '(resolved)' : ''}${
                      c.parent ? ` (reply to ${c.parent})` : ''
                    } ${c.created_at}\n${c.content}`,
                )
                .join('\n\n')
            : '(no comments)',
        ),
    },
    async execute(args = {}) {
      const data = await api('GET', `/api/issues/${encodeURIComponent(issueRef(args.issue))}/comments${q()}`)
      const rows = (Array.isArray(data) ? data : data.comments || []).slice(-(Number(args.limit) || 20))
      return {
        comments: rows.map((c) => ({
          id: c.id,
          author: `${c.author_type || 'member'}:${String(c.author_id || '').slice(0, 8)}`,
          parent: c.parent_id || null,
          resolved: Boolean(c.resolved_at || c.resolved),
          created_at: c.created_at,
          content: c.content || '',
        })),
      }
    },
  },
  {
    name: 'multica_issue_timeline',
    description: 'Read the activity timeline of a Multica issue (status changes, assignments, edits). Read-only.',
    parameters: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'Issue UUID or key.' },
        limit: { type: 'number', description: 'Maximum events to return; defaults to 30.' },
      },
      required: ['issue'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(table(value.events, ['time', 'type', 'actor', 'detail'])),
    },
    async execute(args = {}) {
      const data = await api('GET', `/api/issues/${encodeURIComponent(issueRef(args.issue))}/timeline${q()}`)
      const rows = (Array.isArray(data) ? data : data.events || []).slice(-(Number(args.limit) || 30))
      return {
        events: rows.map((e) => ({
          time: e.created_at,
          type: e.action || e.type,
          actor: `${e.actor_type || ''}:${String(e.actor_id || '').slice(0, 8)}`,
          detail: e.detail || e.metadata ? JSON.stringify(e.detail ?? e.metadata).slice(0, 120) : '',
        })),
      }
    },
  },
  {
    name: 'multica_list_agents',
    description: 'List the agents configured in the Multica workspace with their runtime binding and model. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          value.agents.length
            ? value.agents.map((a) => `${a.name}  ${a.id}  model=${a.model || '(default)'}  bound=${a.bound}`).join('\n')
            : '(no agents)',
        ),
    },
    async execute() {
      const data = await api('GET', `/api/agents${q()}`)
      return {
        agents: (Array.isArray(data) ? data : data.agents || []).map((a) => ({
          id: a.id,
          name: a.name,
          model: a.model || '',
          bound: Boolean(a.runtime_bound),
          runtime_id: a.runtime_id,
        })),
      }
    },
  },
  {
    name: 'multica_list_runtimes',
    description: 'List the agent runtimes registered with the Multica workspace and whether each is online. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(value.runtimes.map((r) => `${r.name}  ${r.id}  status=${r.status || 'unknown'}`).join('\n') || '(no runtimes)'),
    },
    async execute() {
      const data = await api('GET', `/api/runtimes${q()}`)
      return {
        runtimes: (Array.isArray(data) ? data : data.runtimes || []).map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status || '',
          daemon_id: r.daemon_id,
        })),
      }
    },
  },
  {
    name: 'multica_list_runs',
    description:
      'List agent runs for a Multica issue (status, agent, attempt, timestamps). Multica exposes runs only through its CLI, so this shells out to the desktop app binary. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'Issue UUID or key.' },
        active: { type: 'boolean', description: 'Only return runs that are still queued or running.' },
      },
      required: ['issue'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          value.runs.length
            ? value.runs.map((r) => `${r.id.slice(0, 8)}  ${r.status}  agent=${r.agent_id.slice(0, 8)}  ${r.created_at || ''}`).join('\n')
            : '(no runs)',
        ),
    },
    async execute(args = {}) {
      const argv = ['issue', 'runs', issueRef(args.issue), '--output', 'json', '--profile', profileName(), '--workspace-id', workspaceId()]
      if (args.active) argv.splice(3, 0, '--active')
      const stdout = await new Promise((resolve, reject) => {
        execFile(cliPath(), argv, { timeout: 30000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
          if (err) reject(new Error(`multica issue runs failed: ${(errOut || err.message).slice(0, 300)}`))
          else resolve(out)
        })
      })
      const parsed = stdout.trim() ? JSON.parse(stdout) : []
      return {
        runs: (Array.isArray(parsed) ? parsed : parsed.runs || []).map((r) => ({
          id: r.id,
          status: r.status,
          agent_id: r.agent_id || '',
          attempt: r.attempt,
          created_at: r.created_at,
        })),
      }
    },
  },
  {
    name: 'multica_comment_add',
    description:
      'Post a comment on a Multica issue. Writing here wakes the agents mentioned in the body: use [@Name](mention://agent/<id>) to trigger one, or [@all](mention://all/all) to broadcast without assigning. Gated by the Harness approval prompt when the session allows one.',
    parameters: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'Issue UUID or key.' },
        content: { type: 'string', description: 'Markdown comment body.' },
        parent_id: { type: 'string', description: 'Comment id to reply inside that thread.' },
        mention_agent_id: {
          type: 'string',
          description: 'Optional agent UUID; a proper mention link is appended to the body, which starts that agent.',
        },
        suppress_agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent UUIDs whose mention should not start a run. Required when the body mentions a busy agent.',
        },
      },
      required: ['issue', 'content'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(`Comment ${value.id} added to ${value.key}.${value.mentioned ? ` Mentioned ${value.mentioned}.` : ''}`),
    },
    async execute(args = {}) {
      const ref = issueRef(args.issue)
      let body = String(args.content || '')
      let mentioned = ''
      if (args.mention_agent_id) {
        mentioned = String(args.mention_agent_id)
        body += `\n\n[@agent](mention://agent/${mentioned})`
      }
      const payload = { content: body }
      if (args.parent_id) payload.parent_id = String(args.parent_id)
      if (Array.isArray(args.suppress_agent_ids) && args.suppress_agent_ids.length) {
        payload.suppress_agent_ids = args.suppress_agent_ids.map(String)
      }
      const created = await api('POST', `/api/issues/${encodeURIComponent(ref)}/comments${q()}`, payload)
      return { id: created.id, key: created.issue_id || ref, mentioned }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Comment on Multica issue',
      kind: 'edit',
      rawInput: `${args.issue}: ${String(args.content || '').slice(0, 80)}`,
    }),
  },
  {
    name: 'multica_issue_update',
    description:
      'Update a Multica issue: status, assignee, title, description, or priority. Status and assignee changes normally start the assigned agent, which costs tokens; suppress_run defaults to true so nothing starts unless explicitly requested. Gated by the Harness approval prompt when the session allows one.',
    parameters: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'Issue UUID or key.' },
        status: { type: 'string', description: 'Status key, e.g. in_review, todo, done.' },
        assignee_id: { type: 'string', description: 'Agent or member UUID to assign.' },
        assignee_type: { type: 'string', enum: ['agent', 'member'], description: 'Kind of the assignee id.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description (markdown).' },
        priority: { type: 'string', description: 'Priority value, e.g. low, medium, high, urgent.' },
        suppress_run: {
          type: 'boolean',
          description: 'Do not start an agent run for this change. Defaults to true; set false only when the user wants the agent to start working now.',
        },
      },
      required: ['issue'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(`${value.key} updated: ${value.changed.join(', ') || 'nothing'}${value.run_started ? ' (agent run started)' : ' (no run started)'}`),
    },
    async execute(args = {}) {
      const ref = issueRef(args.issue)
      const payload = {}
      for (const key of ['status', 'assignee_id', 'assignee_type', 'title', 'description', 'priority']) {
        if (args[key] !== undefined && args[key] !== '') payload[key] = args[key]
      }
      if (!Object.keys(payload).length) throw new Error('Nothing to update: pass at least one field.')
      const suppress = args.suppress_run !== false
      if (suppress) payload.suppress_run = true
      const updated = await api('PUT', `/api/issues/${encodeURIComponent(ref)}${q()}`, payload)
      return {
        id: updated.id,
        key: updated.identifier,
        changed: Object.keys(payload).filter((k) => k !== 'suppress_run'),
        run_started: !suppress && (payload.status !== undefined || payload.assignee_id !== undefined),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Update Multica issue',
      kind: 'edit',
      rawInput: `${args.issue}: ${Object.entries(args)
        .filter(([k, v]) => k !== 'issue' && v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
        .join(', ')}`,
    }),
  },
  {
    name: 'multica_issue_create',
    description:
      'Create a new issue in the Multica workspace. Creating in todo or in_progress can start an agent when an assignee is set; suppress_run defaults to true. Gated by the Harness approval prompt when the session allows one.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title.' },
        description: { type: 'string', description: 'Issue description (markdown).' },
        status: { type: 'string', description: 'Initial status key; defaults to todo.' },
        assignee_id: { type: 'string', description: 'Agent or member UUID to assign.' },
        assignee_type: { type: 'string', enum: ['agent', 'member'], description: 'Kind of the assignee id.' },
        priority: { type: 'string', description: 'Priority value.' },
        suppress_run: { type: 'boolean', description: 'Do not start an agent run on creation. Defaults to true.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(`Created ${value.key} (${value.status}) — ${value.title}`),
    },
    async execute(args = {}) {
      const payload = {
        title: String(args.title),
        description: String(args.description || ''),
        status: String(args.status || 'todo'),
      }
      if (args.assignee_id) {
        payload.assignee_id = String(args.assignee_id)
        payload.assignee_type = String(args.assignee_type || 'agent')
      }
      if (args.priority) payload.priority = String(args.priority)
      if (args.suppress_run !== false) payload.suppress_run = true
      const created = await api('POST', `/api/issues${q()}`, payload)
      return { id: created.id, key: created.identifier, title: created.title, status: created.status }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create Multica issue', kind: 'edit', rawInput: args.title }),
  },
  {
    name: 'multica_comment_resolve',
    description: 'Mark a Multica comment thread resolved or unresolved. Gated by the Harness approval prompt when the session allows one.',
    parameters: {
      type: 'object',
      properties: {
        comment_id: { type: 'string', description: 'Comment UUID from multica_list_comments.' },
        resolved: { type: 'boolean', description: 'true to resolve, false to reopen; defaults to true.' },
      },
      required: ['comment_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => text(`Comment ${value.id} ${value.resolved ? 'resolved' : 'reopened'}.`),
    },
    async execute(args = {}) {
      const resolved = args.resolved !== false
      const id = String(args.comment_id)
      const path = resolved ? `/api/comments/${encodeURIComponent(id)}/resolve${q()}` : `/api/comments/${encodeURIComponent(id)}/unresolve${q()}`
      const out = await api('POST', path, {})
      return { id, resolved }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Resolve Multica comment', kind: 'edit', rawInput: args.comment_id }),
  },
  {
    name: 'multica_list_workspaces',
    description:
      'List all Multica workspaces visible to the configured account, with id, name, slug and issue prefix. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(`Multica workspaces (${value.total})\n\n${table(value.workspaces, ['name', 'slug', 'prefix', 'id'])}`),
    },
    async execute() {
      const list = await api('GET', '/api/workspaces')
      const workspaces = (Array.isArray(list) ? list : []).map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        prefix: w.issue_prefix || '',
      }))
      return { total: workspaces.length, workspaces }
    },
  },
  {
    name: 'multica_list_projects',
    description:
      'List projects in a Multica workspace. Accepts a workspace UUID, name, slug or issue prefix; defaults to the configured workspace. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace UUID, name, slug or prefix. Defaults to configured workspace.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(`Multica projects in ${value.workspace} (${value.total})\n\n${table(value.projects, ['title', 'status', 'issues', 'done', 'id'])}`),
    },
    async execute(args = {}) {
      const ws = await resolveWorkspace(args.workspace)
      const data = await api('GET', `/api/projects?${new URLSearchParams({ workspace_id: ws, limit: '100' })}`)
      const projects = (data.projects || []).map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description || '',
        status: p.status,
        issues: p.issue_count ?? 0,
        done: p.done_count ?? 0,
      }))
      return { workspace: ws, total: projects.length, projects }
    },
  },
  {
    name: 'multica_get_project',
    description:
      'Read one Multica project by UUID or title, including description, status, lead and issue counts. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project UUID or exact title.' },
        workspace: { type: 'string', description: 'Workspace UUID, name, slug or prefix. Defaults to configured workspace.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          [
            `${value.title}  ${value.status}  ${value.id}`,
            `workspace: ${value.workspace_id}`,
            `description: ${value.description || '(none)'}`,
            `issues: ${value.issue_count}  done: ${value.done_count}`,
            `lead: ${value.lead || '(unassigned)'}`,
          ].join('\n'),
        ),
    },
    async execute(args = {}) {
      const ref = String(args.project || '').trim()
      if (!ref) throw new Error('project is required (UUID or title)')
      const ws = await resolveWorkspace(args.workspace)
      let id = ref
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ref)) {
        const data = await api('GET', `/api/projects?${new URLSearchParams({ workspace_id: ws, limit: '100' })}`)
        const hit = (data.projects || []).find(
          (p) => p.id === ref || p.title === ref || (p.title || '').toLowerCase() === ref.toLowerCase(),
        )
        if (!hit) throw new Error(`Project not found: ${ref}`)
        id = hit.id
      }
      const p = await api('GET', `/api/projects/${encodeURIComponent(id)}?${new URLSearchParams({ workspace_id: ws })}`)
      return {
        id: p.id,
        title: p.title,
        description: p.description || '',
        status: p.status,
        workspace_id: p.workspace_id,
        issue_count: p.issue_count ?? 0,
        done_count: p.done_count ?? 0,
        lead: p.lead_type ? `${p.lead_type}:${p.lead_id}` : '',
      }
    },
  },
  {
    name: 'multica_issue_stats',
    description:
      'Aggregate Multica issues into counts by status, priority and assignee, plus overdue and due-soon lists. Read-only; supports workspace/project/assignee/priority/status filters.',
    parameters: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace UUID, name, slug or prefix.' },
        project: { type: 'string', description: 'Project UUID or title to restrict stats.' },
        assignee: { type: 'string', description: 'Agent UUID or name to restrict stats.' },
        priority: { type: 'string', description: 'Priority key: low, medium, high, urgent.' },
        status: { type: 'string', description: 'Status key to restrict stats.' },
        within_days: { type: 'number', description: 'Due-soon window in days; defaults to 7.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        text(
          [
            `Multica issue stats — ${value.scope}`,
            `Total: ${value.total}`,
            '',
            'By status:', table(value.by_status, ['status', 'count']),
            '',
            'By priority:', table(value.by_priority, ['priority', 'count']),
            '',
            `Overdue (${value.overdue.length}):`,
            table(value.overdue, ['key', 'due', 'title']),
            '',
            `Due within ${value.within_days}d (${value.due_soon.length}):`,
            table(value.due_soon, ['key', 'due', 'title']),
          ].join('\n'),
        ),
    },
    async execute(args = {}) {
      const ws = await resolveWorkspace(args.workspace)
      const params = new URLSearchParams({ workspace_id: ws, limit: '100' })
      const parts = []
      if (args.project) {
        params.set('project_id', await resolveProjectId(args.project, ws))
        parts.push(`project=${args.project}`)
      }
      if (args.assignee) {
        params.set('assignee_id', await resolveAgentId(args.assignee))
        parts.push(`assignee=${args.assignee}`)
      }
      if (args.priority) { params.set('priority', String(args.priority)); parts.push(`priority=${args.priority}`) }
      if (args.status) { params.set('status', String(args.status)); parts.push(`status=${args.status}`) }
      const within = Math.min(Math.max(Number(args.within_days) || 7, 1), 365)
      const data = await api('GET', `/api/issues?${params}`)
      const issues = data.issues || []
      const count = (key) => {
        const m = new Map()
        for (const i of issues) {
          const k = String(i[key] ?? '(none)')
          m.set(k, (m.get(k) || 0) + 1)
        }
        return [...m.entries()]
          .map(([k, v]) => ({ [key]: k, count: v }))
          .sort((a, b) => b.count - a.count)
      }
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const soon = new Date(today.getTime() + within * 86400000)
      const terminal = new Set(['done', 'cancelled', 'completed'])
      const dueRow = (i) => ({ key: i.identifier, due: String(i.due_date || '').slice(0, 10), title: i.title })
      const overdue = []
      const dueSoon = []
      for (const i of issues) {
        if (!i.due_date || terminal.has(i.status)) continue
        const d = new Date(String(i.due_date).slice(0, 10))
        if (Number.isNaN(d.getTime())) continue
        if (d < today) overdue.push(dueRow(i))
        else if (d <= soon) dueSoon.push(dueRow(i))
      }
      overdue.sort((a, b) => a.due.localeCompare(b.due))
      dueSoon.sort((a, b) => a.due.localeCompare(b.due))
      return {
        scope: parts.length ? parts.join(', ') : `workspace ${ws}`,
        total: data.total ?? issues.length,
        by_status: count('status'),
        by_priority: count('priority'),
        overdue,
        due_soon: dueSoon,
        within_days: within,
      }
    },
  },
]

/**
 * Whether this session has no approval channel at all.
 *
 * The approval service rejects every ask under the `never` policy, so a gated
 * write could never run. We only consult it to decide *not* to ask; when a
 * channel does exist the ask (and therefore the user's decision) still wins.
 */
function approvalUnavailable(ctx, exec) {
  try {
    const approval = ctx.get('approval')
    const session = exec?.agent?.session
    if (!approval || !session || typeof approval.overrideOf !== 'function') return false
    return approval.overrideOf(session) === 'never'
  } catch {
    return false
  }
}

/**
 * HTTP routes behind the Multica panel.
 *
 * The browser half never sees the Multica token: it asks these routes, and they
 * add the bearer header server-side. They only answer requests arriving on the
 * loopback interface from a same-origin page.
 */
const PANEL_PREFIX = '/api/multica-reverse'

// Same-site reverse proxy: the Multica web UI authenticates with host-only
// cookies. A cross-origin iframe (Multica host vs the Harness origin) is a
// third-party context, so those cookies are blocked and login fails with
// "missing authorization". Serving the native UI through a 127.0.0.1 port
// makes it same-site with the Harness page, so the browser keeps the cookies.
// API calls are auto-authenticated with the Host-side bearer token, so the
// embedded page passes the /api/me login check without any manual login.
// Multica HTML uses root-relative /_next/... paths, which hit this proxy
// directly because it is its own port.
const PROXY_PORT = Number(process.env.MULTICA_PROXY_PORT || 18080)
let proxyBaseUrl = ''
let proxyReady = null
let proxyServer = null

function createProxyServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      ;(async () => {
        try {
          const cred = await credentials()
          const upstream = new URL(cred.base)
          const secure = upstream.protocol === 'https:'
          const transport = secure ? httpsRequest : httpRequest
          const upstreamOrigin = `${upstream.protocol}//${upstream.host}`
          const headers = { ...req.headers, host: upstream.host }
          // Make proxied requests look like they originate from Multica itself.
          if (headers.origin) headers.origin = upstreamOrigin
          if (headers.referer) {
            headers.referer = String(headers.referer).replace(proxyBaseUrl, upstreamOrigin)
          }
          // Auto-authenticate API calls with the Host-side bearer token so the
          // embedded page passes /api/me without a separate browser login.
          if (req.url && req.url.startsWith('/api/')) {
            headers.authorization = `Bearer ${cred.token}`
          }
          delete headers['accept-encoding']
          const uReq = transport(
            {
              hostname: upstream.hostname,
              port: upstream.port || (secure ? 443 : 80),
              method: req.method,
              path: req.url,
              headers,
            },
            (uRes) => {
              const out = { ...uRes.headers }
              if (out.location) {
                out.location = String(out.location).replace(
                  `${upstream.protocol}//${upstream.host}`,
                  proxyBaseUrl,
                )
              }
              if (out['set-cookie']) {
                out['set-cookie'] = (Array.isArray(out['set-cookie'])
                  ? out['set-cookie']
                  : [out['set-cookie']]
                ).map((c) => c.replace(/;\s*Domain=[^;]+/i, ''))
              }
              res.writeHead(uRes.statusCode || 502, out)
              uRes.pipe(res)
            },
          )
          uReq.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            }
            res.end('Multica proxy: upstream error')
          })
          req.pipe(uReq)
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          }
          res.end(`Multica proxy: ${err.message || err}`)
        }
      })()
    })
    server.on('error', reject)
    server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server))
  })
}

async function ensureProxy() {
  if (!proxyBaseUrl) proxyBaseUrl = `http://127.0.0.1:${PROXY_PORT}`
  if (!proxyReady) {
    proxyReady = createProxyServer()
      .then((server) => {
        proxyServer = server
        return proxyBaseUrl
      })
      .catch((err) => {
        // Another DSH profile (web/desktop) may already own this port. Both
        // profiles talk to the same Multica server, so reuse that proxy.
        if (err && err.code === 'EADDRINUSE') {
          return proxyBaseUrl
        }
        proxyReady = null
        throw err
      })
  }
  return proxyReady
}

function reply(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1 << 20) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || ''
  const loopback =
    address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
  return loopback && req.headers['sec-fetch-site'] !== 'cross-site'
}

function issuePayload(row) {
  return {
    key: row.identifier,
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority || '',
    due: row.due_date || '',
    assignee: row.assignee_type ? `${row.assignee_type}:${String(row.assignee_id).slice(0, 8)}` : '',
    updated: row.updated_at || '',
    description: row.description || '',
  }
}

function registerPanelRoutes(ctx) {
  // `webServer` may activate after this plugin, so wait for the service instead
  // of silently returning when it is not there yet.
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    if (!server || typeof server.register !== 'function') return

    const guard = (req, res) => {
      if (isLocalRequest(req)) return true
      reply(res, 403, { ok: false, error: 'forbidden' })
      return false
    }

    const routes = [
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/bootstrap`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const [statuses, agents, runtimes] = await Promise.all([
            api('GET', `/api/issue-statuses${q()}`),
            api('GET', `/api/agents${q()}`),
            api('GET', `/api/runtimes${q()}`),
          ])
          reply(res, 200, {
            ok: true,
            workspace: workspaceId(),
            statuses: (statuses?.statuses || []).map((s) => ({ key: s.key, name: s.name || s.key })),
            agents: (Array.isArray(agents) ? agents : []).map((a) => ({
              id: a.id, name: a.name, model: a.model || '', bound: Boolean(a.runtime_bound),
            })),
            runtimes: (Array.isArray(runtimes) ? runtimes : []).map((r) => ({
              id: r.id, name: r.name, status: r.status || '',
            })),
          })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/workspaces`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const [list] = await Promise.all([api('GET', `/api/workspaces`)])
          const base = await ensureProxy()
          reply(res, 200, {
            ok: true,
            base,
            current: workspaceId(),
            workspaces: (Array.isArray(list) ? list : []).map((w) => ({
              id: w.id,
              name: w.name,
              slug: w.slug,
              prefix: w.issue_prefix || '',
            })),
          })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/issues`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url, 'http://localhost')
          const params = new URLSearchParams({ workspace_id: workspaceId() })
          const status = url.searchParams.get('status')
          const query = url.searchParams.get('query')
          if (status) params.set('status', status)
          if (query) params.set('q', query)
          params.set('limit', String(Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 100)))
          const data = await api('GET', `/api/issues?${params}`)
          reply(res, 200, {
            ok: true,
            total: data.total ?? 0,
            issues: (data.issues || []).map(issuePayload),
          })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/issue`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const url = new URL(req.url, 'http://localhost')
          const ref = issueRef(url.searchParams.get('ref'))
          const [issue, comments] = await Promise.all([
            api('GET', `/api/issues/${encodeURIComponent(ref)}${q()}`),
            api('GET', `/api/issues/${encodeURIComponent(ref)}/comments${q()}`),
          ])
          reply(res, 200, {
            ok: true,
            issue: issuePayload(issue),
            comments: (Array.isArray(comments) ? comments : []).map((c) => ({
              id: c.id,
              author: `${c.author_type || 'member'}:${String(c.author_id || '').slice(0, 8)}`,
              parent: c.parent_id || null,
              resolved: Boolean(c.resolved_at || c.resolved),
              created: c.created_at || '',
              content: c.content || '',
            })),
          })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/comment`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        try {
          const body = await readJsonBody(req)
          const ref = issueRef(body.ref)
          const payload = { content: String(body.content || '') }
          if (body.parent_id) payload.parent_id = String(body.parent_id)
          const created = await api('POST', `/api/issues/${encodeURIComponent(ref)}/comments${q()}`, payload)
          reply(res, 200, { ok: true, id: created.id })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/update`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        try {
          const body = await readJsonBody(req)
          const ref = issueRef(body.ref)
          const payload = { suppress_run: true }
          for (const key of ['status', 'title', 'description', 'priority']) {
            if (body[key] !== undefined && body[key] !== '') payload[key] = body[key]
          }
          if (Object.keys(payload).length === 1) {
            return reply(res, 400, { ok: false, error: 'nothing to update' })
          }
          const updated = await api('PUT', `/api/issues/${encodeURIComponent(ref)}${q()}`, payload)
          reply(res, 200, { ok: true, issue: issuePayload(updated) })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${PANEL_PREFIX}/resolve`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        if (!guard(req, res)) return
        try {
          const body = await readJsonBody(req)
          const id = String(body.comment_id || '')
          if (!id) return reply(res, 400, { ok: false, error: 'comment_id is required' })
          const resolved = body.resolved !== false
          const verb = resolved ? 'resolve' : 'unresolve'
          await api('POST', `/api/comments/${encodeURIComponent(id)}/${verb}${q()}`, {})
          reply(res, 200, { ok: true })
        } catch (err) {
          reply(res, 502, { ok: false, error: String(err.message || err) })
        }
      },
    },
    ]

    scope.effect(() => {
      const disposers = routes.map((route) => server.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'multica-reverse panel routes')
  })
}

export function apply(ctx, config = {}) {
  opts = config || {}
  const requireApproval = config?.requireApproval !== false

  // The same-site proxy is started lazily by the /workspaces route. Close it
  // when this plugin is disabled/reloaded so the port can be rebound.
  ctx.effect(
    () => () => {
      if (proxyServer) {
        try { proxyServer.close() } catch {}
        proxyServer = null
      }
      proxyReady = null
      proxyBaseUrl = ''
    },
    'multica-reverse proxy cleanup',
  )

  for (const definition of tools) {
    ctx.effect(
      () => ctx.tools.register(definition),
      `multica-reverse ${definition.name} tool`,
    )
  }

  ctx.effect(
    () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        if (!WRITE_TOOLS.has(exec?.name)) return next()
        if (!requireApproval) return next()
        if (approvalUnavailable(ctx, exec)) return next()
        const argumentsText = exec?.arguments || {}
        const subject =
          argumentsText.issue || argumentsText.comment_id || argumentsText.title || ''
        return {
          kind: 'ask',
          reason: `Multica will be modified: ${exec.name} ${String(subject).slice(0, 80)}`,
          displayReason: {
            en: `Write to the Multica workspace (${exec.name})`,
            zh: `将修改 Multica 工作区（${exec.name}）`,
          },
        }
      }),
    'multica-reverse write approval',
  )

  registerPanelRoutes(ctx)

  const prompt = ctx.get('systemPrompt')
  if (prompt && typeof prompt.section === 'function') {
    ctx.effect(
      () =>
        prompt.section({
          name: 'multica-reverse',
          order: 200,
          text: [
            'Multica workspace tools are available (multica_*): list workspaces and projects, read/list/filter issues (by project, assignee, priority, due date), get issue stats with overdue/due-soon lists, plus comments, timeline, agents and runtimes. Workspace arguments accept a UUID, name, slug or issue prefix; default is the configured workspace.',
            'Prefer them over shelling out to the multica CLI. Status and assignee changes start the assigned agent and cost tokens, so leave suppress_run at its default true unless the user explicitly wants the agent to start now.',
            'A comment body only triggers an agent through the exact link form [@Name](mention://agent/<uuid>); plain text or @Name does nothing.',
          ].join(' '),
        }),
      'multica-reverse prompt section',
    )
  }
}
