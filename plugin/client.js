/**
 * Multica panel — the browser half of @local/multica-reverse.
 *
 * Registers a sidebar icon and a center-column page. Every read and write goes
 * through the Host's /api/multica-reverse routes, so the Multica token never
 * reaches the page.
 */
window.__ModuleLoader__.load({
  id: '@local/multica-reverse',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'multica'
    const API = '/api/multica-reverse'

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const STATUS_TONE = {
      backlog: C.idle,
      todo: C.dim,
      in_progress: C.accent,
      in_review: C.warn,
      blocked: C.danger,
      done: C.ok,
      cancelled: C.idle,
    }

    async function callJson(path, init) {
      const res = await fetch(path, init)
      let body
      try {
        body = await res.json()
      } catch {
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    function post(path, payload) {
      return callJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
    }

    function Chip({ label, active, onClick, dot }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            fontSize: 12,
            cursor: 'pointer',
            border: `1px solid ${active ? C.accent : C.border}`,
            background: active ? C.surface2 : 'transparent',
            color: active ? C.text : C.dim,
            lineHeight: 1.4,
          },
        },
        dot ? h('span', { style: { width: 6, height: 6, borderRadius: 6, background: dot } }) : null,
        label,
      )
    }

    function Pill({ text, tone }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 11,
            color: tone || C.dim,
            border: `1px solid ${tone || C.border}`,
            whiteSpace: 'nowrap',
          },
        },
        text,
      )
    }

    function MulticaPanel() {
      const [meta, setMeta] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [list, setList] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [mention, setMention] = React.useState(null) // { start, query } while an @-mention is being typed
      const [mentionIndex, setMentionIndex] = React.useState(0)
      const textareaRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const agents = meta?.agents || []

      const loadList = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const params = new URLSearchParams()
          if (status) params.set('status', status)
          if (query.trim()) params.set('query', query.trim())
          const data = await callJson(`${API}/issues?${params}`)
          setList(data.issues || [])
          setTotal(data.total || 0)
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }, [status, query])

      const openIssue = React.useCallback(async (key) => {
        setSelected(key)
        setDetail(null)
        setError('')
        try {
          const data = await callJson(`${API}/issue?ref=${encodeURIComponent(key)}`)
          setDetail({ issue: data.issue, comments: data.comments || [] })
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        callJson(`${API}/bootstrap`)
          .then((data) => {
            if (alive) setMeta(data)
          })
          .catch((err) => {
            if (alive) setError(String(err.message || err))
          })
        return () => {
          alive = false
        }
      }, [])

      React.useEffect(() => {
        loadList()
      }, [loadList])

      const changeStatus = async (next) => {
        if (!detail || !next) return
        setBusy(true)
        try {
          await post(`${API}/update`, { ref: detail.issue.key, status: next })
          await openIssue(detail.issue.key)
          await loadList()
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      // Detect an @-mention being typed: the last "@" before the caret with no
      // whitespace after it becomes the query. e.g. "帮我 @dee" -> query "dee".
      const updateMention = React.useCallback((value, caret) => {
        const before = value.slice(0, caret)
        const at = before.lastIndexOf('@')
        if (at < 0) {
          setMention(null)
          return
        }
        const query = before.slice(at + 1)
        if (/\s/.test(query)) {
          setMention(null)
          return
        }
        setMention({ start: at, query })
        setMentionIndex(0)
      }, [])

      const mentionCandidates = React.useMemo(() => {
        if (!mention) return []
        const q = mention.query.toLowerCase()
        return agents.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      }, [mention, agents])

      const insertMention = React.useCallback((agent) => {
        if (!mention) return
        // Replace from the "@" to the caret with a proper mention link.
        const caret = mention.start + 1 + mention.query.length
        const link = `[@${agent.name}](mention://agent/${agent.id}) `
        const next = draft.slice(0, mention.start) + link + draft.slice(caret)
        setDraft(next)
        setMention(null)
        // Put the caret just after the inserted link.
        const pos = mention.start + link.length
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (el) {
            el.focus()
            el.setSelectionRange(pos, pos)
          }
        })
      }, [mention, draft])

      const onDraftChange = (e) => {
        const value = e.target.value
        setDraft(value)
        updateMention(value, e.target.selectionStart)
      }

      const onDraftKeyDown = (e) => {
        if (mention && mentionCandidates.length) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setMentionIndex((i) => (i + 1) % mentionCandidates.length)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
            return
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            insertMention(mentionCandidates[mentionIndex] || mentionCandidates[0])
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setMention(null)
            return
          }
        }
        // Ctrl/Cmd+Enter sends the comment.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          submitComment()
        }
      }

      const submitComment = async () => {
        if (!detail || !draft.trim()) return
        setBusy(true)
        try {
          await post(`${API}/comment`, { ref: detail.issue.key, content: draft })
          setDraft('')
          setMention(null)
          await openIssue(detail.issue.key)
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      const statuses = meta?.statuses || []

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px',
            borderBottom: `1px solid ${C.border}`,
            flexWrap: 'wrap',
          },
        },
        h('div', { style: { fontSize: 15, fontWeight: 600, color: C.text } }, 'Multica'),
        h('div', { style: { fontSize: 12, color: C.dim } }, `${total} 条`),
        h('div', { style: { flex: 1 } }),
        h('input', {
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') loadList()
          },
          placeholder: '搜索标题…',
          style: {
            width: 200,
            padding: '6px 10px',
            fontSize: 12,
            color: C.text,
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            outline: 'none',
          },
        }),
        h(
          'button',
          {
            type: 'button',
            onClick: loadList,
            disabled: busy,
            style: {
              padding: '6px 12px',
              fontSize: 12,
              color: C.text,
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          busy ? '刷新中…' : '刷新',
        ),
      )

      const filters = h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 6,
            padding: '10px 20px',
            borderBottom: `1px solid ${C.border}`,
            flexWrap: 'wrap',
          },
        },
        h(Chip, { label: '全部', active: status === '', onClick: () => setStatus('') }),
        statuses.map((s) =>
          h(Chip, {
            key: s.key,
            label: s.name,
            active: status === s.key,
            dot: STATUS_TONE[s.key],
            onClick: () => setStatus(s.key),
          }),
        ),
      )

      const rows = list.map((issue) =>
        h(
          'button',
          {
            key: issue.key,
            type: 'button',
            onClick: () => openIssue(issue.key),
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '10px 14px',
              border: 'none',
              borderBottom: `1px solid ${C.border}`,
              borderLeft: `2px solid ${selected === issue.key ? C.accent : 'transparent'}`,
              background: selected === issue.key ? C.surface2 : 'transparent',
              cursor: 'pointer',
              color: C.text,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
            h('span', { style: { fontSize: 11, fontFamily: 'ui-monospace, monospace', color: C.dim } }, issue.key),
            h(Pill, { text: issue.status, tone: STATUS_TONE[issue.status] }),
            issue.priority && issue.priority !== 'none' ? h(Pill, { text: issue.priority }) : null,
            issue.due ? h('span', { style: { fontSize: 11, color: C.dim, marginLeft: 'auto' } }, issue.due) : null,
          ),
          h(
            'div',
            {
              style: {
                fontSize: 13,
                lineHeight: 1.4,
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              },
            },
            issue.title,
          ),
        ),
      )

      const listPane = h(
        'div',
        {
          style: {
            width: 340,
            minWidth: 260,
            borderRight: `1px solid ${C.border}`,
            overflowY: 'auto',
            flex: '0 0 auto',
          },
        },
        rows.length ? rows : h('div', { style: { padding: 20, fontSize: 13, color: C.dim } }, busy ? '加载中…' : '没有匹配的工单'),
      )

      let detailPane
      if (!detail) {
        detailPane = h(
          'div',
          { style: { flex: 1, padding: 28, fontSize: 13, color: C.dim } },
          selected ? '加载中…' : '从左侧选一条工单，查看详情、改状态或评论。',
        )
      } else {
        const issue = detail.issue
        const comments = detail.comments
        detailPane = h(
          'div',
          { style: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 22px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
            h('span', { style: { fontSize: 12, fontFamily: 'ui-monospace, monospace', color: C.dim } }, issue.key),
            h(Pill, { text: issue.status, tone: STATUS_TONE[issue.status] }),
            issue.assignee ? h(Pill, { text: issue.assignee }) : h(Pill, { text: '未指派' }),
            issue.due ? h('span', { style: { fontSize: 11, color: C.dim } }, `截止 ${issue.due}`) : null,
          ),
          h('h2', { style: { fontSize: 16, lineHeight: 1.45, margin: '0 0 14px', color: C.text } }, issue.title),

          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, color: C.dim } }, '状态'),
            statuses.map((s) =>
              h(Chip, {
                key: s.key,
                label: s.name,
                active: issue.status === s.key,
                dot: STATUS_TONE[s.key],
                onClick: () => changeStatus(s.key),
              }),
            ),
          ),

          h(
            'div',
            { style: { fontSize: 12, color: C.dim, marginBottom: 6 } },
            `描述`,
          ),
          h(
            'pre',
            {
              style: {
                margin: '0 0 18px',
                padding: 12,
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: C.text,
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                maxHeight: 320,
                overflowY: 'auto',
                fontFamily: 'inherit',
              },
            },
            issue.description || '（无描述）',
          ),

          h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 8 } }, `评论 ${comments.length}`),
          comments.length
            ? comments.map((c) =>
                h(
                  'div',
                  {
                    key: c.id,
                    style: {
                      padding: '9px 12px',
                      marginBottom: 8,
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, fontSize: 11, color: C.dim, marginBottom: 5 } },
                    h('span', null, c.author),
                    c.resolved ? h('span', { style: { color: C.ok } }, '已解决') : null,
                    h('span', null, (c.created || '').replace('T', ' ').slice(0, 16)),
                  ),
                  h(
                    'div',
                    { style: { fontSize: 12.5, lineHeight: 1.6, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                    c.content,
                  ),
                ),
              )
            : h('div', { style: { fontSize: 12, color: C.dim, marginBottom: 12 } }, '（暂无评论）'),

          h(
            'div',
            { style: { position: 'relative', marginTop: 6 } },
            mention && mentionCandidates.length
              ? h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      bottom: '100%',
                      left: 0,
                      marginBottom: 4,
                      minWidth: 220,
                      maxWidth: '100%',
                      background: C.surface2,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      boxShadow: '0 6px 20px rgba(0,0,0,.25)',
                      padding: 4,
                      zIndex: 20,
                    },
                  },
                  h(
                    'div',
                    { style: { fontSize: 10, color: C.dim, padding: '4px 8px' } },
                    '↑↓ 选择 · Enter/Tab 插入 · 发送后 @ 的 agent 会被唤起',
                  ),
                  mentionCandidates.map((a, idx) =>
                    h(
                      'button',
                      {
                        key: a.id,
                        type: 'button',
                        onMouseDown: (e) => {
                          e.preventDefault()
                          insertMention(a)
                        },
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 8px',
                          borderRadius: 6,
                          border: 'none',
                          cursor: 'pointer',
                          background: idx === mentionIndex ? C.accent : 'transparent',
                          color: idx === mentionIndex ? '#fff' : C.text,
                          fontSize: 12,
                        },
                      },
                      h('span', null, `@${a.name}`),
                      a.bound
                        ? null
                        : h('span', { style: { fontSize: 10, opacity: 0.7 } }, '(未绑定运行时)'),
                    ),
                  ),
                )
              : null,
            h('textarea', {
              ref: textareaRef,
              value: draft,
              onChange: onDraftChange,
              onKeyDown: onDraftKeyDown,
              placeholder: '写一条评论…（输入 @ 提及 agent 并唤起它，Ctrl+Enter 发送）',
              rows: 3,
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: 10,
                fontSize: 12.5,
                lineHeight: 1.6,
                color: C.text,
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit',
              },
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
            h(
              'button',
              {
                type: 'button',
                disabled: busy || !draft.trim(),
                onClick: submitComment,
                style: {
                  padding: '7px 16px',
                  fontSize: 12.5,
                  borderRadius: 6,
                  border: 'none',
                  cursor: busy || !draft.trim() ? 'default' : 'pointer',
                  background: busy || !draft.trim() ? C.surface2 : C.accent,
                  color: busy || !draft.trim() ? C.dim : '#fff',
                },
              },
              '发送',
            ),
          ),

          agents.length
            ? h(
                'div',
                { style: { marginTop: 16, fontSize: 11, color: C.dim } },
                `可派活的 agent：${agents.map((a) => a.name).join('、')}（在对话里让我指派）`,
              )
            : null,
        )
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            background: C.bg,
            color: C.text,
          },
        },
        header,
        filters,
        error
          ? h(
              'div',
              {
                style: {
                  padding: '8px 20px',
                  fontSize: 12,
                  color: C.danger,
                  borderBottom: `1px solid ${C.border}`,
                },
              },
              error,
            )
          : null,
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } }, listPane, detailPane),
      )
    }

    /** Owner props: `size` is the requested square edge, `active` marks the selected panel. */
    function MulticaIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('path', {
          d: 'M5 17.5V7.2l7 4.4 7-4.4v10.3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 12, cy: 19, r: 1.6, fill: 'currentColor' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => 'Multica',
            },
            MulticaIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, MulticaPanel),
        )
      },
    }
  },
})
