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

All phases are **built and unit tested** (255 tests). Nothing has yet been exercised against the
real Slack workspace or a real Jira token — that needs credentials only the QA owner can create,
and it is the next step. See *What is not verified yet*.

| Phase | Scope | State |
|---|---|---|
| 0 | Skeleton, config, Jira client, DB, Docker/Fly, `npm run discover` | built |
| 1 | `/bug` modal → Jira issue in `Under Triage` + confirmation thread | built |
| 2 | Thread attachment sync, "Report as bug" message shortcut | built |
| 3 | Jira webhook, idempotency, routing matrix, `/triage` | built |
| 4 | `/mybugs`, App Home, status-change DMs | built |
| 5 | `/bugstats` digest | built |

### What is not verified yet

Everything below is covered by unit tests against recorded payloads, but has never spoken to the
live services. Expect to work through these one at a time:

- **No real Jira token has been used.** `npm run discover` has only been run with a deliberately
  invalid token, which proved the report's error handling but not the values.
- **No Slack app exists yet**, so no command, modal, shortcut, event or button has run for real.
- **Whether `Under Triage` → `To Do` exists as a transition is unknown.** The workflow is
  restricted, not global (see below), and the backlog route depends on that transition. If it is
  missing, routing labels the issue `needs-manual-move` and says so instead of failing silently.
- **Attachment upload to Jira is untested.** The multipart shape and the `X-Atlassian-Token`
  header follow the API docs; the Slack download side is unit tested with a fake fetch.
- The `reporter` field being settable is confirmed from the create screen, but
  `MODIFY_REPORTER` on the service account is not — `discover` reports it.

---

## The Jira environment, as verified

Checked live against `roarington.atlassian.net` on 2026-09-09. Several values differ from the
first draft of `SPEC.md` §2 — these are the real ones:

| Thing | Value | Note |
|---|---|---|
| Site | `roarington.atlassian.net` | Cloud |
| Cloud ID | `57de5553-0941-4346-821f-c46f7dde06cc` | Confirmed via `/_edge/tenant_info` |
| Project | `SUP` ("Support"), id `10396` | Company-managed (`style: classic`). **Not `SOFT`.** |
| Board | `468` "SUP board", **Kanban** | SUP's board. Board `303` belongs to `SOFT`. |
| Issue type | `Finding`, id `10481` | **SUP has no `Bug` type.** See the caveat below. |
| Priorities | `Highest`=1 `High`=2 `Medium`=3 `Low`=4 `Lowest`=5 | All five available; default `Medium` |
| Create fields | `summary` `description` `labels` `priority` `attachment` `assignee` | Enough for SPEC 5/6 with no custom fields |

Only SUP and board 468 are in scope. `SOFT`, `CARS` and `EMT` are untouched.

**The workflow is wired as designed.** Confirmed from the board on 2026-09-09. Board 468 has
these columns, in this order:

```
To Do | Under Triage | In Progress | Cannot Reproduce | Rejected | Duplicate | Ready for Validation | Done
```

So `Under Triage` is a real status with its own column, and every terminal status SPEC 7 routes
to exists. Intake (SPEC 5) and the exit-from-triage trigger (SPEC 7) work as written.

**Board 468 is a Kanban board, so it has no sprints — and routing goes Kanban-native.** SPEC 7
originally routed `High` and `Highest` into "the active sprint of the dev board", which is
impossible on a Kanban board. Decided in Phase 0: drop the sprint mechanics rather than reach for
a Scrum board in another project. `High` and `Highest` set the status to `To Do` and apply
`triaged:sprint` plus `needs-lead-review` or `escalated`; the leader DM and the `#soft-world`
post are unchanged. Only the Jira-side destination changed, and `triage_events.routed_to` still
records `backlog` vs `sprint` so the metrics keep distinguishing the two decisions.

The practical upshot: **BugBot needs no Agile API at all.** `src/jira/agile.ts` from the SPEC 10
layout is not needed, and neither are `POST /rest/agile/1.0/sprint/{id}/issue` or
`POST /rest/agile/1.0/backlog/issue`. `npm run discover` still reports boards and sprints,
because knowing the board is Kanban is exactly what made this decision.

**`Finding` renders as an ordinary card.** It sits at `hierarchyLevel: 1`, the same level as an
epic, which on some company-managed boards pushes issues into the Epics panel instead of the
columns. Checked with a real issue (`SUP-1`): it appears as a normal card in the `To Do` column,
with the full issue view — description, labels, priority, reporter, assignee, comments,
attachments. So the epic-level concern does not bite here. `JIRA_ISSUE_TYPE` is still config, so
switching types later remains a one-line change plus a re-run of `npm run discover`.

**The workflow has restricted transitions, not global ones.** Confirmed on `SUP-1`: from `To Do`
the only available transition is `id 2` → `Under Triage`, and `isGlobal: false`. That is unlike
the `SOFT` project, where every transition is global and any status can reach any other.

Two consequences:

- Intake works exactly as SPEC 5 describes — create lands in `To Do`, then one transition moves
  it to `Under Triage`.
- **SPEC 7's backlog route needs an `Under Triage` → `To Do` transition to exist.** Whether it
  does is not yet known: reading it requires an issue that is actually in `Under Triage`. Run
  `npm run discover -- --issue=<key>` on such an issue to find out. BugBot resolves every
  transition by target status name at call time and degrades loudly when one is unavailable
  (it labels the issue and tells the triager rather than silently doing nothing), so this cannot
  cause a wrong-status bug — but if the transition is missing, a Jira admin needs to add it
  before Phase 3 backlog routing can move anything.

**Column order is worth a second look.** The three terminal statuses (`Cannot Reproduce`,
`Rejected`, `Duplicate`) currently sit *between* `In Progress` and `Ready for Validation`. For a
QA flow, `Ready for Validation` immediately after `In Progress` with the terminal columns at the
far right reads better on a wall. Cosmetic, no code depends on column order — BugBot routes on
status names, never on board position.

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
  wired into SUP after all. Either a Jira admin adds them to the workflow, or the `JIRA_STATUS_*`
  variables get repointed at statuses that do exist. Not expected: the board confirms they are
  there. If this one appears, something changed in Jira.
- **"Board 468 is kanban, so it has no sprints at all"** — **expected, already known.** See
  *The Jira environment, as verified* above for the options. Not a regression.
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

## Jira webhook setup

Without this, nothing is triaged automatically — intake works but the routing rules never fire.

1. Generate a secret and put it in `.env`:

   ```bash
   openssl rand -hex 32     # -> JIRA_WEBHOOK_SECRET
   ```

   The route is not mounted at all until this is set, and the service says so at startup.

2. In Jira: **Settings → System → WebHooks → Create a WebHook**.

   - **URL**: `https://bugbot.fly.dev/jira/webhook/<the secret>`
   - **JQL scope**: `project = SUP` — belt and braces; BugBot rejects other projects anyway.
   - **Events**: *Issue created* and *Issue updated*. Nothing else.

3. Optionally fill `JIRA_WEBHOOK_IP_ALLOWLIST` from <https://ip-ranges.atlassian.com/> (IPv4
   CIDRs, comma-separated). Empty leaves the secret path as the only gate, which is a reasonable
   first deploy.

To check it end to end: move a bug out of `Under Triage` in Jira and watch the logs for a
`routed` line. Moving it twice with no change in between should produce one `routed` and one
`ignored_duplicate`.

## Security

- **Slack request signatures** are verified by Bolt's `ExpressReceiver` on every request. This
  depends on the raw request body surviving to the receiver, so `express.json()` is never mounted
  globally ahead of it — only per-route. That failure mode is silent, which is why it is called
  out here and in a comment in `src/index.ts`.
- **Jira webhooks are unsigned.** The endpoint is protected by a long random secret in the URL
  path (`JIRA_WEBHOOK_SECRET`, compared with `timingSafeEqual`), an optional IP allowlist of
  Atlassian's published ranges, and rejection of any payload whose issue is not in the configured
  project. A bad secret returns 404, not 403, so the path cannot be probed. On top of that, a
  loop guard drops any change made by the service account itself — without it BugBot would
  respond to its own writes.
- **Secrets come from the environment only.** `.env` is gitignored; `.env.example` carries empty
  values. On Fly they are `fly secrets`.
- **Logs are redacted by default.** `src/logger.ts` censors tokens, `authorization` headers,
  email addresses and message/DM text, at the top level and one level deep. `test/logger.test.ts`
  asserts a token and an email cannot reach the output.
- The service account holds project-scoped permissions on SUP, never site admin.

---

## What it does, end to end

**Filing a bug.** `/bug` in `#soft-world` opens a form that requires application, environment,
device and model, OS, browser, viewport, input method, numbered steps, expected vs actual,
frequency and severity. The submission is acknowledged inside Slack's three-second window; the
Jira work happens after. The issue is created, moved to `Under Triage`, given a normalised ADF
description, labelled, and assigned a suggested priority from severity × frequency. A
confirmation lands in the channel with the issue key and an invitation to post screenshots in the
thread. If Jira fails, the reporter gets a DM saying so and the whole report is in the log.

The message shortcut **"Report as bug"** does the same thing starting from an existing message:
its first line prefills the summary, its text prefills the steps, a permalink to it goes on the
issue, and the confirmation is posted in that message's thread.

**Screenshots.** Any file posted in a bug's confirmation thread is downloaded with the bot token,
attached to the issue, and the Slack message gets a ✅. Files over 10MB are refused out loud
rather than dropped. Each file is claimed once, so a redelivered event cannot attach it twice.

**Triage.** When a bug leaves `Under Triage`, the Jira webhook fires and BugBot reads the priority
*at that moment*:

| Priority | Jira | Slack |
|---|---|---|
| Lowest, Low, Medium | status `To Do`, label `triaged:backlog` | thread reply to the reporter |
| High | status `To Do`, labels `triaged:sprint` + `needs-lead-review` | reporter reply, leader DM with Approve/Reassign, note in `#soft-world` |
| Highest | status `To Do`, labels `triaged:sprint` + `escalated` | same, plus the reporter tagged in `#soft-world` |
| → `Rejected` / `Duplicate` / `Cannot Reproduce` | nothing moved, nothing labelled | reporter DM with the resolution and the triager's last comment; `Cannot Reproduce` also asks for a recording |

Every decision writes a `triage_events` row. Every message is claimed against the
`notifications` table first, so replaying a webhook sends nothing twice.

`/triage` gives QA the same rules as buttons: **Backlog**, **Sprint**, **Need info**,
**Duplicate**. They set the priority and then call the identical `decideRoute`/`applyRoute` pair
the webhook uses — the buttons cannot drift from the automatic path because there is only one
implementation. They have to call it directly rather than waiting for the webhook their own
change causes, because the loop guard correctly ignores anything the service account did.

**Bugs filed in Jira, not Slack.** `jira:issue_created` funnels them the same way: recorded,
labelled `src:jira`, moved into `Under Triage`, and the reporter's email resolved to a Slack user
so they get the same notifications. If that lookup fails the bug still funnels; it just gets no
DMs.

**Reporter self-service.** `/mybugs` and the App Home tab show a reporter's own bugs grouped into
Under Triage / In Progress / Ready for Validation / Closed. Both union the issue keys BugBot
recorded with `reporter = <accountId>` in Jira, so bugs filed both ways appear in one list. Any
other status change sends one short DM, rate-limited to one per issue per five minutes.

**`/bugstats`** prints intake by application and severity, the backlog/sprint/closed split, the
median time in triage and the top three reporters. `/bugstats post` shares it in `#soft-world`.

## Layout

```
src/
  index.ts                    Bootstrap: config, DB, HTTP, then Jira preflight and wiring
  config.ts                   zod-validated env; exits on invalid config
  context.ts                  the dependency bundle every handler receives
  logger.ts                   pino with the redaction list
  identity.ts                 Slack <-> Jira identity mapping, cached in user_map
  types.ts                    BugReport, the option lists, the label builder
  jira/
    client.ts                 typed REST wrapper: Basic auth, retry, rate-limit backoff
    meta.ts                   resolves configured names to live Jira IDs
    issues.ts                 create, transition, label, attach, search
    webhook.ts                secret path, IP allowlist, parse, dispatch
  slack/
    register.ts               every handler, mounted in one place
    notify.ts                 every outbound Slack call, in one place
    actions.ts                interaction ids
    files.ts                  thread attachment sync
    home.ts                   App Home
    commands/bug.ts           /bug and the form submission
    commands/mybugs.ts        /mybugs and the shared query
    commands/triage.ts        /triage, its buttons, the leader buttons
    commands/bugstats.ts      /bugstats
    shortcuts/reportBug.ts    "Report as bug" message shortcut
    views/bugModal.ts         the form: pure builder + parser
  triage/
    suggest.ts                severity x frequency -> priority (SPEC 6)
    route.ts                  THE routing rules, pure
    apply.ts                  the effects of a routing decision
    leaders.ts                per-application team leader lookup
  format/
    adf.ts                    Atlassian Document Format builders
    description.ts            the one description template, shared by both paths
    slackBlocks.ts            Block Kit builders, pure
  db/
    index.ts, repo.ts, migrations/
scripts/
  discover.ts                 dump every Jira ID (npm run discover)
  manifest.json               Slack app manifest, ready to paste
config/
  leaders.example.json        per-application team leader map (SPEC 9.2)
test/                         vitest; HTTP mocked with msw, effects via a recording harness
```

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

255 tests. The ones worth knowing about:

- **`suggest.test.ts`** transcribes the SPEC 6 matrix independently of the implementation and
  checks all twelve cells, plus that the table is monotonic in both directions — a rarer or less
  severe bug can never come out more urgent.
- **`route.test.ts`** covers all five priority paths, all three terminal statuses, the
  missing-priority fallback, and that renaming a status in config actually moves the rule.
- **`webhook.test.ts`** is the Phase 3 acceptance criterion: each of the five priorities produces
  exactly the SPEC 7 behaviour, and **replaying the same payload twice sends nothing twice**. It
  also covers the three security guards, the loop guard, the no-transition fallback and
  Jira-native intake.
- **`triageButtons.test.ts`** proves the buttons produce the same Jira calls, Slack messages and
  audit rows as the webhook path, and that a double click is one action.
- **`repo.test.ts`** covers the idempotency ledger and the five-minute digest window directly.

Two real bugs were found by these tests rather than in production:

1. The viewport pattern rejected `800 X 600` — a capital X is something people type.
2. Jira's changelog has a field literally named `toString`, which collides with
   `Object.prototype.toString`. When an item arrived without it, a plain property read returned
   the inherited *function*, zod rejected it as "expected string, received function", and the
   entire webhook payload was dropped. `src/jira/webhook.ts` now rebuilds each changelog item on
   a null prototype.
