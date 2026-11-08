export type Item = {
  id: string
  title: string
  detail?: string
  isActive: boolean
  /** The command that makes this item the active one; absent when it already is. */
  argv?: string[]
  /** For a CLI with no global switch: the line a press copies to the clipboard. */
  copy?: string
}

export type Section = { title: string; items: Item[]; note?: string }

export type Cli = {
  id: string
  label: string
  status: 'ok' | 'missing' | 'error'
  error?: string
  sections: Section[]
  /** The CLI cannot mint a token: the person has to sign in again. */
  needsAuth?: boolean
  /** The command that signs the person in again. */
  signIn?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'cli-accounts': { clis: Cli[]; projects: Item[]; busy: string; branch: string; isBandHidden: boolean }
  }
}
