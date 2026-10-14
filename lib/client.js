/**
 * Notepad browser half.
 *
 * This is a hand-written DSH client bundle: a classic script (not a module, no
 * build step) that only registers a factory. The module system runs the factory
 * on first use, claims the stylesheet it inserts synchronously, and treats the
 * returned `{ apply, inject }` as a Cordis client plugin.
 *
 * The panel is a pair of registrations coupled by one string: an icon in
 * `sidebar.panellist` (id `notepad`) and the center page in the keyed `main`
 * slot (key `notepad`). All data lives behind the host half's own HTTP route
 * under `api/notepad` (document-relative on purpose, matching the shipped
 * client-hmr half).
 *
 * @see module:dsh-plugin-notepad
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-notepad',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Panel key shared by the sidebar icon and the center page. */
    const PANEL_ID = 'notepad'
    /** Host route prefix, document-relative so a non-root mount still works. */
    const API = 'api/notepad'
    /** Marker header the host API requires; a cross-site request cannot set it. */
    const CLIENT_HEADER = 'x-notepad-client'

    const CSS = `
.notepadPage{box-sizing:border-box;height:100%;overflow:auto;padding:18px 22px 28px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:20px}
.notepadHead{display:flex;flex-direction:column;gap:10px}
.notepadTitleRow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.notepadTitle{font-size:15px;font-weight:600}
.notepadMeta{color:var(--dsw-alias-label-caption,#8b949e);font-size:11px;line-height:16px}
.notepadToolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.notepadTabs{display:inline-flex;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;overflow:hidden}
.notepadTab{border:0;background:0 0;color:var(--dsw-alias-label-secondary,#57606a);font:inherit;padding:5px 12px;cursor:pointer}
.notepadTab[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2328);font-weight:500}
.notepadInput,.notepadTextarea,.notepadSelect{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));color:inherit;font:inherit;padding:6px 9px;outline:none;min-width:0}
.notepadInput:focus,.notepadTextarea:focus{border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.6))}
.notepadTextarea{resize:vertical;min-height:60px;width:100%}
.notepadGrow{flex:1}
.notepadButton{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;background:0 0;color:inherit;font:inherit;padding:5px 12px;cursor:pointer;white-space:nowrap}
.notepadButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.notepadButton:disabled{opacity:.5;cursor:default}
.notepadButton[data-danger=true]:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,rgba(207,34,46,.12))}
.notepadComposer{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:10px;padding:10px}
.notepadList{display:flex;flex-direction:column;gap:8px}
.notepadNote{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.notepadNoteText{white-space:pre-wrap;word-break:break-word}
.notepadNoteFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.notepadTag{border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}
.notepadActions{display:flex;gap:6px;margin-left:auto}
.notepadState{color:var(--dsw-alias-label-caption,#8b949e);font-size:12px}
.notepadError{color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12px;white-space:pre-wrap}
.notepadPath{color:var(--dsw-alias-label-caption,#8b949e);font-size:11px;word-break:break-all}
`

    // Styles must be inserted synchronously while the factory runs: the module
    // system claims any untagged <style> present when it returns, and removes it
    // again on hot reload or disable.
    const CSS_TAG = 'dsh-plugin-notepad/client.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-notepad'
      style.dataset.pluginCss = CSS_TAG
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * Call one host API route.
     * @param {string} method - HTTP method.
     * @param {string} path - route path below the API prefix.
     * @param {object} [body] - JSON request body.
     * @returns {Promise<object>} the parsed response payload.
     */
    async function call(method, path, body) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) throw new Error(payload?.error ?? `${method} ${path} failed with ${response.status}`)
      return payload
    }

    /** Merge one level's fresh payload into the panel state. */
    function mergeLevel(state, payload) {
      return { ...state, levels: { ...state.levels, [payload.scope]: payload } }
    }

    /** One note count for a level, tolerating a disabled level. */
    function totalOf(state, scope) {
      return state?.levels?.[scope]?.enabled === true ? state.levels[scope].total : 0
    }

    /**
     * The project dropdown's entries: every registered workspace, plus the project
     * the panel is actually addressing when it is not registered. A `<select>`
     * whose `value` matches no option silently displays the first option instead,
     * which would name a different project than the one being edited.
     * @param {Array<{ path: string, title?: string }>} projects - registered workspaces.
     * @param {string | null} current - the project this panel is addressing.
     * @returns {Array<{ path: string, title: string, followed: boolean }>} dropdown entries.
     */
    function projectOptions(projects, current) {
      const entries = projects.map((entry) => ({ path: entry.path, title: entry.title || entry.path, followed: false }))
      if (current !== null && current !== undefined && current !== '' && !entries.some((entry) => entry.path === current)) {
        const name = current.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || current
        entries.unshift({ path: current, title: `${name}（当前会话）`, followed: true })
      }
      return entries
    }

    /** The sidebar panel icon (receives `{ size, active }`). */
    function NotepadIcon({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { opacity: active ? 1 : 0.75 },
      },
      h('rect', { x: 4.5, y: 3, width: 15, height: 18, rx: 2.5 }),
      h('path', { d: 'M8 8.5h8M8 12h8M8 15.5h4.5' }))
    }

    /**
     * The session the page last showed, reported by the session-scoped bridge
     * below. Root-scoped panels receive no session id (neither `PanelInfo` nor
     * the sessions service exposes a "current" selection), so the bridge is how
     * the center page learns which project to open. `cwd` is the session's own
     * working directory — the same value the model tools resolve against.
     */
    const activeSession = { id: null, cwd: null }

    /** Stand-in selector hook for a host that supplies no `useSessions`. */
    const useNoSessions = (selector) => selector({ byId: {} })

    /**
     * A zero-size registration in a session-scoped header slot whose only job is
     * to remember the current session and its working directory. It keeps the
     * last value after it unmounts (selecting the notepad panel hides the
     * conversation), which is exactly the session the user was just looking at.
     */
    function NotepadSessionBridge(props) {
      const sessionId = props?.sessionId ?? null
      const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : useNoSessions
      const cwd = useSessions((state) => (sessionId === null ? null : state?.byId?.[sessionId]?.cwd ?? null))
      React.useEffect(() => {
        activeSession.id = sessionId
        activeSession.cwd = cwd ?? null
      }, [sessionId, cwd])
      return h('span', { style: { display: 'none' }, 'aria-hidden': 'true' })
    }

    /** The `/note` command and model tools write into the same files this page edits. */
    function NotepadPage() {
      const [state, setState] = React.useState(null)
      const [scope, setScope] = React.useState('project')
      const [manual, setManual] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [draftTags, setDraftTags] = React.useState('')
      const [editing, setEditing] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      /** Last state payload, readable from callbacks without re-creating them. */
      const stateFromRef = React.useRef(null)

      /**
       * The project this page addresses: the user's manual pick, else the
       * session's own cwd, else whatever the last state reported, else the most
       * recently updated registered workspace. Only `project` goes on the wire:
       * the route resolves it exactly like a tool call does.
       */
      const targetOf = React.useCallback((override) => {
        const chosen = override === undefined ? manual : override
        if (chosen !== null && chosen !== undefined && chosen !== '') return chosen
        if (activeSession.cwd !== null && activeSession.cwd !== '') return activeSession.cwd
        const known = stateFromRef.current
        if (known?.current?.path) return known.current.path
        return known?.projects?.[0]?.path ?? null
      }, [manual])

      const load = React.useCallback(async (override) => {
        setBusy(true)
        try {
          const target = targetOf(override)
          const hint = activeSession.id === null ? {} : { session: activeSession.id }
          const params = new URLSearchParams({ limit: '0', ...hint, ...(target === null ? {} : { project: target }) })
          const next = await call('GET', `/state?${params.toString()}`)
          stateFromRef.current = next
          setState(next)
          setScope((current) => (next.levels[current]?.enabled === true ? current : next.defaultScope))
          setError(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [targetOf])

      React.useEffect(() => { void load() }, [load])

      // Follow the session even while the page stays open: a session switch (or
      // the first report from the bridge) reloads against the new project.
      const observedSession = React.useRef(null)
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (manual !== null) return
          if (activeSession.id === observedSession.current) return
          observedSession.current = activeSession.id
          void load()
        }, 1500)
        return () => clearInterval(timer)
      }, [load, manual])

      const projects = state?.projects ?? []
      const options = projectOptions(projects, state?.current?.path ?? null)
      // The panel always sends an explicit `project`, so the host reports
      // `manual`; whether the page is actually following the session is the
      // client's own state.
      const mode = manual !== null
        ? '手动选择'
        : activeSession.cwd !== null && activeSession.cwd !== ''
          ? '跟随当前会话'
          : state?.current?.source === 'default' ? '默认（最近使用的项目）' : '跟随当前会话'

      const mutate = async (method, path, body) => {
        setBusy(true)
        try {
          const target = targetOf()
          const payload = await call(method, path, { ...(target === null ? {} : { project: target }), ...body })
          setState((current) => (current === null ? current : mergeLevel(current, payload)))
          setError(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const level = state?.levels?.[scope] ?? null
      const notes = (level?.notes ?? []).filter((note) => {
        if (query.trim() === '') return true
        const needle = query.trim().toLowerCase()
        return note.content.toLowerCase().includes(needle)
          || note.id.toLowerCase().includes(needle)
          || (note.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      })

      const addNote = async () => {
        if (draft.trim() === '') return
        await mutate('POST', '/notes', {
          scope,
          content: draft,
          tags: draftTags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
        })
        setDraft('')
        setDraftTags('')
      }

      const saveEdit = async () => {
        if (editing === null) return
        await mutate('PUT', '/notes', {
          scope,
          id: editing.id,
          content: editing.content,
          tags: editing.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
        })
        setEditing(null)
      }

      const children = []

      children.push(h('div', { className: 'notepadHead', key: 'head' },
        h('div', { className: 'notepadTitleRow' },
          h('span', { className: 'notepadTitle' }, '速记 Notepad'),
          state === null
            ? null
            : h('span', { className: 'notepadMeta' }, `全局 ${totalOf(state, 'global')} 条 · 项目 ${totalOf(state, 'project')} 条`)),
        h('div', { className: 'notepadToolbar' },
          h('div', { className: 'notepadTabs' },
            ['project', 'global'].map((candidate) => {
              const enabled = state?.levels?.[candidate]?.enabled === true
              return h('button', {
                key: candidate,
                type: 'button',
                className: 'notepadTab',
                'data-active': String(scope === candidate),
                disabled: !enabled,
                title: enabled ? undefined : '该层级在当前配置下被禁用',
                onClick: () => { setScope(candidate); setEditing(null) },
              }, candidate === 'project' ? '项目' : '全局')
            })),
          options.length > 0 && scope === 'project'
            ? h('select', {
              className: 'notepadSelect',
              value: manual ?? state?.current?.path ?? '',
              title: state?.projectRoot === undefined ? undefined : `项目目录：${state.projectRoot}`,
              onChange: (event) => {
                const chosen = event.target.value
                // Choosing the session's own project means "follow it" again.
                setManual(activeSession.cwd !== null && chosen === activeSession.cwd ? null : chosen)
                setEditing(null)
              },
            }, options.map((entry) => h('option', { key: entry.path, value: entry.path, title: entry.path }, entry.title)))
            : null,
          scope === 'project' && options.length === 0
            ? h('input', {
              className: 'notepadInput notepadGrow',
              placeholder: '项目目录（绝对路径）',
              value: manual ?? '',
              onChange: (event) => { setManual(event.target.value); setEditing(null) },
            })
            : null,
          scope === 'project' && manual !== null
            ? h('button', {
              className: 'notepadButton',
              type: 'button',
              title: '回到跟随当前会话的项目',
              onClick: () => { setManual(null); setEditing(null) },
            }, '跟随会话')
            : null,
          h('input', {
            className: 'notepadInput',
            placeholder: '搜索…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', {
            className: 'notepadButton',
            type: 'button',
            disabled: busy,
            onClick: () => void load(),
          }, busy ? '…' : '刷新'),
          h('button', {
            className: 'notepadButton',
            type: 'button',
            'data-danger': 'true',
            disabled: busy || level?.enabled !== true || totalOf(state, scope) === 0,
            onClick: () => {
              if (typeof window !== 'undefined' && !window.confirm(`确定要清空${scope === 'project' ? '项目' : '全局'}层的全部笔记吗？`)) return
              void mutate('POST', '/clear', { scope })
            },
          }, '清空')),
        state === null
          ? null
          : h('div', { className: 'notepadMeta' },
            scope === 'project'
              ? `${mode}：${state.projectRoot}`
              : '全局：所有项目共用')))

      children.push(h('div', { className: 'notepadComposer', key: 'composer' },
        h('textarea', {
          className: 'notepadTextarea',
          placeholder: '记一条…（Ctrl+Enter 或点击「添加」）',
          value: draft,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void addNote()
          },
        }),
        h('div', { className: 'notepadToolbar' },
          h('input', {
            className: 'notepadInput notepadGrow',
            placeholder: '标签，用逗号分隔（可选）',
            value: draftTags,
            onChange: (event) => setDraftTags(event.target.value),
          }),
          h('button', {
            className: 'notepadButton',
            type: 'button',
            disabled: busy || draft.trim() === '' || level?.enabled !== true,
            onClick: () => void addNote(),
          }, `添加到${scope === 'project' ? '项目' : '全局'}`))))

      if (error !== null) children.push(h('div', { className: 'notepadError', key: 'error' }, error))
      if (level !== null && level.enabled !== true) {
        children.push(h('div', { className: 'notepadState', key: 'disabled' }, '该层级在当前插件配置下被禁用（config.level）。'))
      } else if (notes.length === 0) {
        children.push(h('div', { className: 'notepadState', key: 'empty' }, query.trim() === '' ? '还没有笔记。' : '没有匹配的笔记。'))
      }

      children.push(h('div', { className: 'notepadList', key: 'list' },
        notes.map((note) => {
          const isEditing = editing !== null && editing.id === note.id
          const rowActions = isEditing
            ? [
              h('button', { key: 'save', className: 'notepadButton', type: 'button', disabled: busy, onClick: () => void saveEdit() }, '保存'),
              h('button', { key: 'cancel', className: 'notepadButton', type: 'button', onClick: () => setEditing(null) }, '取消'),
            ]
            : [
              h('button', {
                key: 'edit',
                className: 'notepadButton',
                type: 'button',
                onClick: () => setEditing({
                  id: note.id,
                  content: note.content,
                  tags: (note.tags ?? []).join(', '),
                }),
              }, '编辑'),
              h('button', {
                key: 'delete',
                className: 'notepadButton',
                type: 'button',
                'data-danger': 'true',
                disabled: busy,
                onClick: () => void mutate('DELETE', '/notes', { scope, id: note.id }),
              }, '删除'),
            ]
          return h('div', { className: 'notepadNote', key: `${note.scope}:${note.id}` },
            isEditing
              ? h('textarea', {
                className: 'notepadTextarea',
                value: editing.content,
                autoFocus: true,
                onChange: (event) => setEditing({ ...editing, content: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void saveEdit()
                  if (event.key === 'Escape') setEditing(null)
                },
              })
              : h('div', { className: 'notepadNoteText' }, note.content),
            isEditing
              ? h('input', {
                className: 'notepadInput',
                placeholder: '标签，用逗号分隔',
                value: editing.tags,
                onChange: (event) => setEditing({ ...editing, tags: event.target.value }),
              })
              : null,
            h('div', { className: 'notepadNoteFoot' },
              h('span', { className: 'notepadMeta' }, `${note.id} · ${new Date(note.at).toLocaleString()}${note.editedAt ? '（已编辑）' : ''}`),
              ...(note.tags ?? []).map((tag) => h('span', { className: 'notepadTag', key: tag }, tag)),
              h('span', { className: 'notepadActions' }, rowActions)))
        })))

      if (level?.file !== undefined) {
        children.push(h('div', { className: 'notepadPath', key: 'path' }, `文件：${level.file}`))
      }

      return h('div', { className: 'notepadPage' }, ...children)
    }

    /** Client services this plugin waits for. */
    const inject = ['slots']

    /**
     * Register the session bridge, the sidebar icon, and the center page.
     * @param {object} ctx - client plugin context.
     */
    function apply(ctx) {
      // The `main` slot is keyed by the active sidebar panel id, so both
      // registrations must use the same PANEL_ID.
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, NotepadPage))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: '速记',
      }, NotepadIcon))
      // Session-scoped: renders nothing, reports the current session to the
      // root-scoped page above so it opens that session's project.
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'notepad-session',
        order: 900,
      }, NotepadSessionBridge))
    }

    exports.apply = apply
    exports.inject = inject
    exports.NotepadPage = NotepadPage
    exports.NotepadIcon = NotepadIcon
    exports.NotepadSessionBridge = NotepadSessionBridge
    // Exported for tests.
    exports.projectOptions = projectOptions
    // The bridge's report, exported so the follow behavior is testable.
    exports.activeSession = activeSession
    return module.exports
  },
})
