# cli-accounts

A Claude Code mod that shows which account and project your command-line tools are
signed in with, and lets you switch between them without leaving the session.

- A **pane** (`/clis`) with one section per CLI: the active account, project or context,
  and the others you can switch to by pressing them.
- A **band above the prompt**, like a git branch indicator, with the active identity of each CLI:
  `⎇ main  gh octocat  gcloud my-project  docker desktop-linux`.
- A **sign-in again** button when a session has expired (gcloud, az, databricks).

| CLI | What it shows | Switching |
| --- | --- | --- |
| `gcloud` | configurations, signed-in accounts, active project, projects you can reach (on demand) | yes |
| `gh` | accounts per host | yes (`gh auth switch`) |
| `kubectl` | contexts | yes (`kubectl config use-context`) |
| `docker` | contexts | yes (`docker context use`) |
| `az` | subscriptions | yes (`az account set`) |
| `aws` | profiles | no global switch: a press copies `export AWS_PROFILE=<name>` |
| `databricks` | profiles | no global switch: a press copies `export DATABRICKS_CONFIG_PROFILE=<name>` |

CLIs that are not installed are skipped and listed in one dim line at the bottom of the pane.
The mod only reads account names, projects and contexts. It never displays tokens.

## Install

In a Claude Code terminal session:

```
/plugin install cli-accounts --marketplace RiccardoRubini93/cli-accounts
```

Answer `y` to "Add marketplace?", then pick a scope (user scope keeps it for every session).
When you see `Installed cli-accounts. Plugin is now active.`, type `/clis` to open the pane.

From a shell instead:

```
claude plugin install cli-accounts --marketplace RiccardoRubini93/cli-accounts
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box,
then **Plugins**, **Add marketplace** with `RiccardoRubini93/cli-accounts`, then **Add plugin**.

## Good to know

- Switching changes the CLI's **global** configuration (`gcloud config`, `gh auth switch`,
  `kubectl config use-context`, `docker context use`, `az account set`), so it affects every terminal
  on your machine, and any command Claude runs for you uses the new identity right away.
- `aws` and `databricks` have no global "active profile": the shell's environment variable decides,
  so the mod cannot change it for you and hands you the `export` line to paste.
- `az`, `aws` and `databricks` support is written from the CLIs' documented output and has had
  little real-world testing. Issues and pull requests are welcome.

## Try it from a local checkout

```
claude --plugin-dir /path/to/cli-accounts
```
