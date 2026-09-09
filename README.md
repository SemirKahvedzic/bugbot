# BugBot

Guided bug intake and assisted triage for Roarington QA: Slack in, Jira out.

Today a bug reaches QA three ways — someone writes it in Jira, someone writes it in a Slack
channel, or someone says it out loud. The Slack ones arrive without a device, a viewport or
steps to reproduce, nothing is consistently triaged, and the person who reported it never finds
out what happened. BugBot fixes four things:

1. **Guided intake** — `/bug` opens a form that requires the fields QA actually needs.
2. **One funnel** — every bug, however it arrives, lands in `Under Triage` with a normalised
   description and labels.
3. **Assisted routing** — on leaving triage, low/medium go to the backlog, higher goes to the
   active sprint and pings the team leader.
4. **Reporter self-service** — `/mybugs`, an App Home tab, and a DM when a bug changes status.

**Non-goal:** replacing the official *Jira Cloud for Slack* app. That stays installed for
`/jira <KEY>` previews and channel subscriptions. BugBot adds the QA-specific intake form, the
routing rules and the per-reporter view, which the official app cannot do.

Full requirements live in `SPEC.md`. Section references below (`SPEC 7`) point there.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Skeleton, config, Jira client, DB, Docker/Fly, `npm run discover` | **done** |
| 1 | `/bug` modal → Jira issue in `Under Triage` + confirmation thread | not started |
| 2 | Thread attachment sync, "Report as bug" message shortcut | not started |
| 3 | Jira webhook, idempotency, routing matrix, `/triage` | not started |
| 4 | `/mybugs`, App Home, status-change DMs | not started |
| 5 | Weekly metrics digest | not started |

---

## The Jira environment, as verified

Checked live against `roarington.atlassian.net` on 2026-09-09. Several values differ from the
first draft of `SPEC.md` §2 — these are the real ones:

| Thing | Value | Note |
|---|---|---|
| Site | `roarington.atlassian.net` | Cloud |
| Cloud ID | `57de5553-0941-4346-821f-c46f7dde06cc` | Confirmed via `/_edge/tenant_info` |
| Project | `SUP` ("Support"), id `10396` | Company-managed (`style: classic`). **Not `SOFT`.** |
| Board | `468` | SUP's board. Board `303` belongs to `SOFT`. |
| Issue type | `Finding`, id `10481` | **SUP has no `Bug` type.** See the caveat below. |
| Priorities | `Highest`=1 `High`=2 `Medium`=3 `Low`=4 `Lowest`=5 | All five available; default `Medium` |
| Create fields | `summary` `description` `labels` `priority` `attachment` `assignee` | Enough for SPEC 5/6 with no custom fields |

Only SUP and board 468 are in scope. `SOFT`, `CARS` and `EMT` are untouched.

**Caveat on `Finding`:** it sits at `hierarchyLevel: 1`, the same level as an epic. On a
company-managed board, epic-level issues render in the Epics panel rather than as cards in the
columns, so board 468 will not look like a conventional bug board. This was a deliberate choice
to avoid needing a Jira admin. `JIRA_ISSUE_TYPE` is config, so switching to a standard-level
type later is a one-line change plus a re-run of `npm run discover`.

**Still to confirm:** whether the `Under Triage` / `Ready for Validation` / `Rejected` /
`Duplicate` / `Cannot Reproduce` statuses are wired into SUP's `Finding` workflow. All five exist
as statuses on the site, but SUP is empty so the workflow could not be read from an issue.
`npm run discover` answers this — see *Reading the discovery report*.

---

## Prerequisites

- **Node 24 or newer.** Required, not a preference: the database layer uses the built-in
  `node:sqlite` module, which is only available from Node 22 (behind a flag) and stable from
  Node 24. `.nvmrc` pins 24; the Docker image is `node:24-bookworm-slim`.
- Docker, if you want to run it the way it is deployed.
- A Jira API token for the service account (below).
- `flyctl`, for deploying.

## Setup

```bash
cp .env.example .env      # then fill in JIRA_EMAIL and JIRA_API_TOKEN
npm ci
npm test
```

### The Jira service account

Every issue BugBot files is created by one Jira account, not by the human reporter (SPEC 4).
Create the token at **id.atlassian.com → Security → Create and manage API tokens**, using the
account whose email goes in `JIRA_EMAIL`.

Give that account **project-scoped permissions on SUP only** — never site admin (SPEC 11). It
needs: `BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`, `TRANSITION_ISSUES`,
`CREATE_ATTACHMENTS`, `ADD_COMMENTS`, and — because `JIRA_SET_REAL_REPORTER=true` — `MODIFY_REPORTER`.
`npm run discover` checks each one and tells you which are missing.

### Reporters and identity

`JIRA_SET_REAL_REPORTER=true` makes BugBot set the actual human as the Jira `reporter`, resolved
by looking their Slack email up against Jira. When the lookup fails, the issue is still filed —
it falls back to the service account and records the human in the description footer and in the
local database, so nothing is lost except the native `reporter` field. Set it to `false` to
always file as the service account.

This works without per-user Jira OAuth (3LO), which v1 deliberately avoids. Adding 3LO later
would buy a genuinely per-user `reporter` field and per-user permission checks, at the cost of an
authorisation dance for every colleague before they can file their first bug.

---

## `npm run discover`

The Phase 0 deliverable. It reads every ID the later phases need straight from the API, so that
nothing is hardcoded and nothing is guessed:

```bash
npm run discover                  # human-readable report + discovery.json
npm run discover -- --issue=SUP-1  # also dump that issue's transitions
npm run discover -- --json         # machine-readable only
```

It prints: the cloud ID (compared against `.env`), the service account's `accountId`, permission
results, the project id, **every status per issue type with its id**, the create-screen fields
with allowed priorities, the Sprint custom field id, the boards with their `type`, the active
sprint, and whether the API exposes user emails at all.

Each section is guarded independently — a missing permission or a Kanban board with no sprints
records a finding and the report carries on, because those failures *are* the output. It exits
non-zero when there is at least one finding, so it doubles as a deploy pre-flight check.

### Reading the discovery report

Three findings matter more than the rest:

- **"The `Finding` workflow is missing these statuses…"** — the designed triage statuses are not
  actually wired into SUP. Either a Jira admin adds them to the workflow, or the `JIRA_STATUS_*`
  variables get repointed at statuses that do exist. Phase 1 cannot be accepted until one of
  those is true.
- **"Board 468 is kanban, so it has no sprints at all"** — SPEC 7 routes High and Highest into
  the active sprint. On a Kanban board that is impossible as written, and the choice becomes: use
  a Scrum board, or replace sprint routing with a board column or a label. Decide before Phase 3.
- **"MODIFY_REPORTER is absent"** — set `JIRA_SET_REAL_REPORTER=false` or grant the permission.

`discovery.json` is gitignored: it names accounts and project internals.

---

## Running it

### Locally

```bash
npm run dev     # tsx watch, pretty logs when NODE_ENV=development
curl localhost:3000/healthz
curl localhost:3000/readyz
```

- `/healthz` is pure liveness — no I/O, always 200 while the process is up.
- `/readyz` actually checks Jira and the database, and returns 503 with a per-check breakdown
  when either is down.

The HTTP listener comes up *before* the Jira preflight runs. A Jira outage or a bad token
therefore leaves a running service that reports itself unready, rather than a service that
refuses to boot — for a webhook receiver, the second is worse. The one exception is a
configuration *mismatch* (a status name in `.env` that Jira does not have): that cannot be fixed
by waiting and would file bugs into the wrong status, so the process logs it and exits.

### With Docker

```bash
docker compose up --build
curl localhost:3000/healthz
```

The database lands on the `bugbot_data` volume at `/data/bugbot.db`. The container runs as the
non-root `node` user and has its own `HEALTHCHECK`.

### Webhooks in local development

Both Slack and Jira need to reach you over HTTPS:

```bash
ngrok http 3000
```

Then set the ngrok URL in two places: the Slack app manifest's four `request_url` fields (see
below), and the Jira webhook URL in **Jira Settings → System → WebHooks** (Phase 3).

Socket Mode is available as a development convenience — set `SLACK_SOCKET_MODE=true` and supply
`SLACK_APP_TOKEN`, and Slack no longer needs a public URL. The Jira webhook still does, so ngrok
is usually simpler than maintaining both paths.

---

## Deploying to Fly.io

```bash
fly launch --no-deploy          # first time only; app name is in fly.toml
fly volumes create bugbot_data --size 1 --region fra
fly secrets set JIRA_EMAIL=... JIRA_API_TOKEN=... JIRA_WEBHOOK_SECRET=... \
                SLACK_BOT_TOKEN=... SLACK_SIGNING_SECRET=...
fly deploy
```

**Exactly one machine.** SQLite is a single file on a single volume, so never
`fly scale count 2`. Two machines would each get their own database, and the `notifications`
idempotency ledger would stop working — producing precisely the duplicate DMs it exists to
prevent. `fly.toml` sets `min_machines_running = 1` and `auto_stop_machines = false`, because a
stopped machine would miss Slack's three-second acknowledgement window and drop Jira deliveries
outright.

Backup is copying a file:

```bash
fly ssh console -C "sqlite3 /data/bugbot.db '.backup /data/backup.db'"   # consistent snapshot
fly ssh sftp get /data/backup.db ./backups/bugbot-$(date +%F).db
```

Prefer `.backup` over copying `bugbot.db` directly — with WAL enabled, a plain copy can catch a
torn write.

---

## Slack app setup

`scripts/manifest.json` is a complete app manifest. At <https://api.slack.com/apps> choose
**Create New App → From an app manifest**, paste it, then replace every
`REPLACE_WITH_PUBLIC_HOST` with the real host (`bugbot.fly.dev`, or the ngrok host locally).

### Why each scope

Bring this table to whoever approves apps in the workspace.

| Scope | Why BugBot needs it | Without it |
|---|---|---|
| `commands` | Registers `/bug`, `/mybugs`, `/triage`, `/bugstats` | No slash commands at all |
| `chat:write` | Post the confirmation message, the escalation note, DMs | Bugs get filed silently |
| `users:read` | Resolve a Slack user ID to a profile when rendering lists | Reports show raw `U…` IDs |
| `users:read.email` | Map a Jira reporter's email to a Slack user, so bugs filed *in Jira* still reach their reporter (SPEC 4) | Native Jira bugs get no DMs and no `/mybugs` entry |
| `files:read` | Download screenshots posted in the confirmation thread, to attach to the issue | Screenshots stay in Slack, invisible to whoever fixes the bug |
| `reactions:write` | React ✅ on a file once it is attached, so the reporter sees it worked | No feedback that a screenshot was picked up |
| `im:write` | Open a DM channel to notify a reporter or the team leader | No status-change notifications |
| `channels:history` | Detect files posted in a stored confirmation thread | Attachment sync cannot work |

`channels:history` is the broadest of these. It is limited to public channels, the bot only
receives events for channels it has been invited to, and BugBot ignores every message whose
thread is not one it created — the check happens before anything is read or stored. Message text
is never logged (see *Security*).

Nothing here needs `chat:write.public`, `groups:history`, `channels:read` or any user token.

---

## Security

- **Slack request signatures** are verified by Bolt's `ExpressReceiver` on every request. This
  depends on the raw request body surviving to the receiver, so `express.json()` is never mounted
  globally ahead of it — only per-route. That failure mode is silent, which is why it is called
  out here and in a comment in `src/index.ts`.
- **Jira webhooks are unsigned.** Phase 3 protects the endpoint with a long random secret in the
  URL path (`JIRA_WEBHOOK_SECRET`), an IP allowlist of Atlassian's published ranges, and a
  rejection of any payload whose `issue.key` is not in the configured project.
- **Secrets come from the environment only.** `.env` is gitignored; `.env.example` carries empty
  values. On Fly they are `fly secrets`.
- **Logs are redacted by default.** `src/logger.ts` censors tokens, `authorization` headers,
  email addresses and message/DM text, at the top level and one level deep. `test/logger.test.ts`
  asserts a token and an email cannot reach the output.
- The service account holds project-scoped permissions on SUP, never site admin.

---

## Layout

```
src/
  index.ts              Express + Bolt bootstrap, health endpoints, Jira preflight
  config.ts             zod-validated env; exits on invalid config
  logger.ts             pino with the redaction list
  jira/
    client.ts           typed REST wrapper: Basic auth, retry, rate-limit backoff
    meta.ts             resolves configured names to live Jira IDs
  db/
    index.ts            open, migrate, ping
    migrations/         schema, applied in order
scripts/
  discover.ts           dump every Jira ID (npm run discover)
  manifest.json         Slack app manifest, ready to paste
config/
  leaders.example.json  per-application team leader map (SPEC 9.2)
test/                   vitest; HTTP mocked with msw
```

`src/slack/`, `src/triage/` and `src/format/` are created empty for Phases 1–3.

### Choices worth knowing about

- **`node:sqlite`, not `better-sqlite3`.** `SPEC.md` §3 asked for `better-sqlite3`. It is a
  native module with no prebuilt binary for the Node version on the dev machine, so installing it
  required a node-gyp toolchain (Python plus Visual Studio build tools) that was not present and
  is a poor thing to require of a one-person project. `node:sqlite` is the same embedded SQLite,
  built into Node, with no compile step — which also removed the build toolchain from the Docker
  image. What the spec actually wanted is unchanged: one small file, backed up by copying, all
  SQL confined to `src/db/`.
- **Global `fetch`, not `undici.request`.** Node's `fetch` *is* undici. `undici.request` bypasses
  the interceptors msw installs, so it cannot be mocked in tests without a second HTTP mocking
  library.
- **No transition IDs anywhere.** Transitions are resolved per issue at call time by matching the
  target status name (`JiraMeta.findTransitionId`). This survives workflow edits and works on an
  empty project, where no transition ID has ever been observable.
- **Migrations are TypeScript modules, not loose `.sql` files.** The SQL is still SQL, in
  `src/db/migrations/`, but shipping it as modules means the compiled image needs no asset-copy
  step and no runtime path resolution — the usual way this breaks inside Docker.
- **Express 5.** `@slack/bolt` 4 requires it.

---

## Tests

```bash
npm test          # vitest run
npm run typecheck
```

51 tests covering: config validation and its error message, Slack-credential gating, log
redaction, the Jira client's auth header, retry and backoff behaviour, `JiraError` never carrying
the token, name-to-ID resolution and its error messages, migrations and their idempotency, and
the schema constraints that make deduplication work.

The SPEC 6 priority matrix and the SPEC 7 routing table get table-driven tests in Phases 1 and 3.
