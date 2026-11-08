import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cli, Item, Section } from '../types'

const PANE = 'cli-accounts'
const clis = atom({ plugin: 'cli-accounts', key: 'clis' } as const, [] as Cli[])
const projects = atom({ plugin: 'cli-accounts', key: 'projects' } as const, [] as Item[])
const busy = atom({ plugin: 'cli-accounts', key: 'busy' } as const, '')
const branch = atom({ plugin: 'cli-accounts', key: 'branch' } as const, '')
const isBandHidden = atom({ plugin: 'cli-accounts', key: 'isBandHidden' } as const, false)

type Run = { code: number; out: string; err: string }

async function sh($: EngineInterface, argv: string[], timeoutMs = 25000): Promise<Run> {
  try {
    const r = await $.process.run(argv, { timeoutMs })

    return { code: r.exitCode, out: r.stdout, err: r.stderr }
  } catch (error) {
    const missing = String(error).includes('ENOENT') || String(error).includes('cannot start')

    return { code: missing ? 127 : 1, out: '', err: String(error) }
  }
}

// gcloud prints a Python deprecation notice before its JSON; keep from the first bracket.
function json(text: string): unknown {
  const at = text.search(/[[{]/)

  return at < 0 ? undefined : JSON.parse(text.slice(at))
}

const isAuthError = (run: Run) =>
  run.code !== 0 && /reauth|invalid_grant|auth login|expired|not authenticated|credentials/i.test(run.err)

const missing = (id: string, label: string): Cli => ({ id, label, status: 'missing', sections: [] })
const failed = (id: string, label: string, run: Run): Cli => ({
  id,
  label,
  status: 'error',
  error: run.err.trim().split('\n').pop()?.slice(0, 120) ?? 'failed',
  sections: [],
})

async function loadGcloud($: EngineInterface): Promise<Cli> {
  const configs = await sh($, ['gcloud', 'config', 'configurations', 'list', '--format=json'])
  if (configs.code === 127) return missing('gcloud', 'gcloud')
  if (configs.code !== 0) return failed('gcloud', 'gcloud', configs)
  const auth = await sh($, ['gcloud', 'auth', 'list', '--format=json'])
  // The token itself is discarded: only whether gcloud can still mint one matters.
  const probe = await sh($, ['gcloud', 'auth', 'print-access-token'])
  const rows = (json(configs.out) ?? []) as {
    name: string
    is_active: boolean
    properties?: { core?: { account?: string; project?: string } }
  }[]
  const accounts = ((auth.code === 0 && json(auth.out)) || []) as { account: string; status: string }[]
  const active = rows.find(c => c.is_active)?.properties?.core
  const sections: Section[] = [
    {
      title: 'Configurations',
      items: rows.map(c => ({
        id: c.name,
        title: c.name,
        detail: [c.properties?.core?.account, c.properties?.core?.project].filter(Boolean).join(' · '),
        isActive: c.is_active,
        argv: c.is_active ? undefined : ['gcloud', 'config', 'configurations', 'activate', c.name],
      })),
    },
    {
      title: 'Accounts',
      items: accounts.map(a => ({
        id: a.account,
        title: a.account,
        isActive: a.status === 'ACTIVE',
        argv: a.status === 'ACTIVE' ? undefined : ['gcloud', 'config', 'set', 'account', a.account],
      })),
    },
  ]
  sections.push({
    title: `Project: ${active?.project ?? 'none'}`,
    items: [],
    note: 'press “Load projects” to list the ones this account can reach',
  })

  const needsAuth = isAuthError(probe)
  const account = sections[1].items.find(i => i.isActive)?.id

  return {
    id: 'gcloud',
    label: 'gcloud',
    status: 'ok',
    sections,
    needsAuth,
    signIn: needsAuth ? ['gcloud', 'auth', 'login', ...(account ? [account] : [])] : undefined,
  }
}

async function loadGh($: EngineInterface): Promise<Cli> {
  const r = await sh($, ['gh', 'auth', 'status', '--json', 'hosts'])
  if (r.code === 127) return missing('gh', 'gh')
  if (r.code !== 0 && !r.out) return failed('gh', 'gh', r)
  const hosts = ((json(r.out) as { hosts?: Record<string, { login: string; active: boolean; host: string }[]> })?.hosts ??
    {}) as Record<string, { login: string; active: boolean; host: string }[]>
  const sections: Section[] = Object.entries(hosts).map(([host, users]) => ({
    title: host,
    items: users.map(u => ({
      id: `${host}/${u.login}`,
      title: u.login,
      isActive: u.active,
      argv: u.active ? undefined : ['gh', 'auth', 'switch', '--hostname', host, '--user', u.login],
    })),
  }))

  return { id: 'gh', label: 'gh', status: 'ok', sections }
}

async function loadKubectl($: EngineInterface): Promise<Cli> {
  const r = await sh($, ['kubectl', 'config', 'view', '-o', 'json'])
  if (r.code === 127) return missing('kubectl', 'kubectl')
  if (r.code !== 0) return failed('kubectl', 'kubectl', r)
  const view = (json(r.out) ?? {}) as {
    'current-context'?: string
    contexts?: { name: string; context: { cluster?: string; user?: string; namespace?: string } }[]
  }
  const items: Item[] = (view.contexts ?? []).map(c => ({
    id: c.name,
    title: c.name,
    detail: [c.context.user, c.context.namespace].filter(Boolean).join(' · '),
    isActive: c.name === view['current-context'],
    argv: c.name === view['current-context'] ? undefined : ['kubectl', 'config', 'use-context', c.name],
  }))

  return {
    id: 'kubectl',
    label: 'kubectl',
    status: 'ok',
    sections: [{ title: 'Contexts', items, note: items.length === 0 ? 'no contexts configured' : undefined }],
  }
}

async function loadDocker($: EngineInterface): Promise<Cli> {
  const r = await sh($, ['docker', 'context', 'ls', '--format', 'json'])
  if (r.code === 127) return missing('docker', 'docker')
  if (r.code !== 0) return failed('docker', 'docker', r)
  const rows = r.out
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { Name: string; Description: string; Current: boolean })
  const items: Item[] = rows.map(c => ({
    id: c.Name,
    title: c.Name,
    detail: c.Description,
    isActive: c.Current,
    argv: c.Current ? undefined : ['docker', 'context', 'use', c.Name],
  }))

  return { id: 'docker', label: 'docker', status: 'ok', sections: [{ title: 'Contexts', items }] }
}

async function envOf($: EngineInterface, name: string) {
  const r = await sh($, ['printenv', name])

  return r.code === 0 ? r.out.trim() : ''
}

async function loadAz($: EngineInterface): Promise<Cli> {
  const r = await sh($, ['az', 'account', 'list', '--output', 'json'])
  if (r.code === 127) return missing('az', 'az')
  const signIn = ['az', 'login']
  if (r.code !== 0) {
    return /az login|AADSTS|expired/i.test(r.err) ? { id: 'az', label: 'az', status: 'ok', sections: [], needsAuth: true, signIn } : failed('az', 'az', r)
  }
  const rows = (json(r.out) ?? []) as { id: string; name: string; isDefault: boolean; user?: { name?: string } }[]
  const items: Item[] = rows.map(a => ({
    id: a.id,
    title: a.name,
    detail: a.user?.name,
    isActive: a.isDefault,
    argv: a.isDefault ? undefined : ['az', 'account', 'set', '--subscription', a.id],
  }))

  return {
    id: 'az',
    label: 'az',
    status: 'ok',
    sections: [{ title: 'Subscriptions', items }],
    needsAuth: rows.length === 0,
    signIn: rows.length === 0 ? signIn : undefined,
  }
}

// aws and databricks keep no global "active" profile: the shell's variable picks it,
// so the button hands over the export line instead of switching anything.
async function loadAws($: EngineInterface): Promise<Cli> {
  const r = await sh($, ['aws', 'configure', 'list-profiles'])
  if (r.code === 127) return missing('aws', 'aws')
  if (r.code !== 0) return failed('aws', 'aws', r)
  const names = r.out.split('\n').map(l => l.trim()).filter(Boolean)
  const chosen = (await envOf($, 'AWS_PROFILE')) || 'default'
  const items: Item[] = names.map(n => ({ id: n, title: n, isActive: n === chosen, copy: `export AWS_PROFILE=${n}` }))

  return {
    id: 'aws',
    label: 'aws',
    status: 'ok',
    sections: [{ title: 'Profiles · press to copy the export line', items }],
  }
}

async function loadDatabricks($: EngineInterface): Promise<Cli> {
  const r = await sh($, ['databricks', 'auth', 'profiles', '--output', 'json'])
  if (r.code === 127) return missing('databricks', 'databricks')
  if (r.code !== 0) return failed('databricks', 'databricks', r)
  const rows = ((json(r.out) as { profiles?: { name: string; host?: string; valid?: boolean }[] })?.profiles ?? [])
  const chosen = (await envOf($, 'DATABRICKS_CONFIG_PROFILE')) || 'DEFAULT'
  const items: Item[] = rows.map(p => ({
    id: p.name,
    title: p.name,
    detail: [p.host?.replace(/^https?:\/\//, ''), p.valid === false ? 'not valid' : ''].filter(Boolean).join(' · '),
    isActive: p.name === chosen,
    copy: `export DATABRICKS_CONFIG_PROFILE=${p.name}`,
  }))
  const expired = rows.find(p => p.name === chosen && p.valid === false)

  return {
    id: 'databricks',
    label: 'databricks',
    status: 'ok',
    sections: [{ title: 'Profiles · press to copy the export line', items }],
    needsAuth: Boolean(expired),
    signIn: expired ? ['databricks', 'auth', 'login', '--profile', expired.name] : undefined,
  }
}

async function loadBranch($: EngineInterface) {
  const r = await sh($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  await update($, branch, () => (r.code === 0 ? r.out.trim() : ''))
}

// What the band shows for a CLI: the one active identity, short.
function activeOf(cli: Cli | undefined, section?: string) {
  const sections = cli?.sections.filter(s => !section || s.title === section) ?? []

  return sections.flatMap(s => s.items).find(i => i.isActive)?.title
}

async function reload($: EngineInterface) {
  await update($, busy, () => 'refreshing…')
  const list = await Promise.all([loadGcloud($), loadGh($), loadKubectl($), loadDocker($), loadAz($), loadAws($), loadDatabricks($)]).catch(() => [] as Cli[])
  await update($, clis, () => list)
  await loadBranch($)
  await update($, busy, () => '')
}

async function switchTo($: EngineInterface, label: string, argv: string[]) {
  await update($, busy, () => `switching ${label}…`)
  const r = await sh($, argv)
  if (isAuthError(r) && argv[0] === 'gcloud') {
    $.ui.toast('gcloud: session expired, press “sign in again”')
  } else {
    $.ui.toast(r.code === 0 ? `${argv[0]}: switched to ${label}` : `${argv[0]} failed: ${r.err.trim().split('\n').pop()}`)
  }
  await update($, projects, () => [])
  await reload($)
}

async function markAuth($: EngineInterface, id: string) {
  await reload($)
  await update($, clis, list => list.map(c => (c.id === id ? { ...c, needsAuth: true, signIn: c.signIn ?? ['gcloud', 'auth', 'login'] } : c)))
}

// The CLI's own browser sign-in: it waits for the callback, so give it minutes, not seconds.
async function signIn($: EngineInterface, label: string, argv: string[]) {
  await update($, busy, () => 'sign in in the browser…')
  $.ui.toast(`${label}: finish the sign-in in your browser`)
  const r = await sh($, argv, 300000)
  $.ui.toast(r.code === 0 ? `${label}: signed in again` : `${label}: sign-in failed or cancelled`)
  await reload($)
}

async function loadProjects($: EngineInterface) {
  await update($, busy, () => 'loading projects…')
  const r = await sh($, ['gcloud', 'projects', 'list', '--format=json', '--limit=25', '--sort-by=projectId'])
  const rows = ((r.code === 0 && json(r.out)) || []) as { projectId: string; name: string }[]
  const active = (await sh($, ['gcloud', 'config', 'get', 'project'])).out.trim()
  await update($, projects, () =>
    rows.map(p => ({
      id: p.projectId,
      title: p.projectId,
      detail: p.name,
      isActive: p.projectId === active,
      argv: p.projectId === active ? undefined : ['gcloud', 'config', 'set', 'project', p.projectId],
    })),
  )
  if (isAuthError(r)) {
    await markAuth($, 'gcloud')
    $.ui.toast('gcloud: session expired, press “sign in again”')
  } else if (r.code !== 0) $.ui.toast('gcloud: could not list projects')
  await update($, busy, () => '')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clis',
      description: 'Show and switch the accounts and projects of gcloud, gh, kubectl and docker',
    })
    void $.ui.open({ id: PANE, title: 'CLI accounts' })
    $.clock.after(1000, () => reload($).catch(() => {}))
    $.clock.every(60000, () => reload($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'clis' }, async $ => {
    await update($, isBandHidden, () => false)
    await $.ui.open({ id: PANE, title: 'CLI accounts' })
    void reload($).catch(() => {})

    return { text: 'CLI accounts pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    void loadBranch($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, clis)
    const name = await read($, branch)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isBandHidden))) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const by = (id: string) => list.find(c => c.id === id && c.status === 'ok')
    const gcloud = by('gcloud')
    const project = gcloud?.sections.find(s => s.title.startsWith('Project:'))?.title.slice(9).trim()
    const chips: { label: string; value?: string; color: string }[] = [
      { label: '⎇', value: name || undefined, color: 'success' },
      { label: 'gh', value: activeOf(by('gh')), color: 'text' },
      { label: 'gcloud', value: project && project !== 'none' ? project : activeOf(gcloud, 'Accounts'), color: 'suggestion' },
      { label: 'k8s', value: activeOf(by('kubectl')), color: 'warning' },
      { label: 'docker', value: activeOf(by('docker')), color: 'permission' },
      { label: 'az', value: activeOf(by('az')), color: 'ide' },
      { label: 'aws', value: activeOf(by('aws')), color: 'warning' },
      { label: 'dbx', value: activeOf(by('databricks')), color: 'error' },
    ]

    return (
      <Box>
        {chips
          .filter(c => c.value)
          .map(c => (
            <Box marginRight={2}>
              <Text dimColor>{c.label} </Text>
              <Text bold color={c.color}>
                {c.value}
              </Text>
            </Box>
          ))}
        <Button key="open" plain dimColor onPress={() => void $.ui.open({ id: PANE, title: 'CLI accounts' })}>
          switch
        </Button>
        <Text dimColor> · </Text>
        <Button key="hide" plain dimColor onPress={() => void update($, isBandHidden, () => true)}>
          hide
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, clis)
    const found = await read($, projects)
    const status = await read($, busy)
    const name = await read($, branch)
    // Every line is sized to this: nothing may be wider than the pane body.
    const width = Math.max(20, (e.props?.bodyColumns ?? 40) - 3)

    const row = (cli: string, section: string, item: Item) => (
      <Box flexDirection="column" width={width}>
        <Box>
          <Box width={2}>
            <Text color={item.isActive ? 'success' : 'inactive'}>{item.isActive ? '●' : '○'}</Text>
          </Box>
          {item.argv ? (
            <Button key={`${cli}:${section}:${item.id}`} plain onPress={() => void switchTo($, item.title, item.argv!)}>
              {item.title}
            </Button>
          ) : item.copy ? (
            <Button
              key={`${cli}:${section}:${item.id}`}
              plain
              onPress={press => void $.ui.copy({ text: item.copy!, surface: press.surface }).then(() => $.ui.toast(`copied: ${item.copy}`))}
            >
              {item.title}
            </Button>
          ) : (
            <Text bold color="success" wrap="truncate-end">
              {item.title}
            </Text>
          )}
        </Box>
        {item.detail ? (
          <Text dimColor wrap="truncate-end">
            {'  ' + item.detail}
          </Text>
        ) : null}
      </Box>
    )

    const card = (cli: Cli, index: number) => {
      const current = cli.sections.flatMap(s => s.items).find(i => i.isActive)?.title ?? ''
      const shown = current.length > 22 ? current.slice(0, 21) + '…' : current
      const fill = Math.max(1, width - cli.label.length - shown.length - 3)
      const loadable = cli.id === 'gcloud'

      return (
        <Box flexDirection="column" marginTop={index === 0 ? 1 : 2} width={width}>
          <Box>
            <Text bold color="permission">
              {cli.label}
            </Text>
            <Text dimColor>{' ' + '─'.repeat(fill) + ' '}</Text>
            {cli.status === 'ok' && <Text color="success">{shown}</Text>}
            {cli.status === 'missing' && <Text dimColor>not installed</Text>}
            {cli.status === 'error' && <Text color="error">error</Text>}
          </Box>
          {cli.status === 'error' && <Text color="error" wrap="truncate-end">{cli.error}</Text>}
          {cli.needsAuth && cli.signIn && (
            <Box flexDirection="column" marginTop={1} width={width}>
              <Text color="warning">⚠ not signed in or session expired</Text>
              <Button
                key={`${cli.id}:signin`}
                plain
                onPress={() => void signIn($, cli.label, cli.signIn ?? [])}
              >
                {'  🔑 sign in again'}
              </Button>
            </Box>
          )}
          {cli.sections.map((sec, at) => (
            <Box flexDirection="column" marginTop={at === 0 ? 0 : 1} width={width}>
              <Text dimColor italic wrap="truncate-end">
                {sec.title}
              </Text>
              {sec.items.map(item => row(cli.id, sec.title, item))}
              {sec.items.length === 0 && sec.note && !loadable && <Text dimColor>{'  ' + sec.note}</Text>}
              {loadable && sec.title.startsWith('Project') && (
                <Box flexDirection="column" width={width}>
                  {found.map(p => row('gcloud', 'projects', p))}
                  {found.length === 0 && (
                    <Button key="load-projects" plain onPress={() => void loadProjects($)}>
                      {'  ⤓ list my projects'}
                    </Button>
                  )}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        <Box>
          <Button key="refresh" plain onPress={() => void reload($)}>
            ↻ refresh
          </Button>
          <Text dimColor wrap="truncate-end">
            {'   ' + (status || (name ? '⎇ ' + name : ''))}
          </Text>
        </Box>
        {list.length === 0 && <Text dimColor italic>loading…</Text>}
        {list.filter(c => c.status !== 'missing').map(card)}
        {list.some(c => c.status === 'missing') && (
          <Box marginTop={2} width={width}>
            <Text dimColor wrap="truncate-end">
              {'not installed: ' + list.filter(c => c.status === 'missing').map(c => c.label).join(', ')}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
