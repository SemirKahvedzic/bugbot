# BugBot

Guided bug intake and assisted triage for Roarington QA: Slack in, Jira out.

Today a bug reaches QA three ways — someone writes it in Jira, someone writes it in a Slack
channel, or someone says it out loud. The Slack ones arrive without a device, a viewport or
steps to reproduce, nothing is consistently triaged, and the person who reported it never finds
out what happened. BugBot fixes four things:

1. **Guided intake** — `/bug` opens a form that requires the fields QA actually needs.
2. **One funnel** — every bug, however it arrives, lands in `Under Triage` with a normalised
   description and labels.
3. **Assisted routing** — on leaving triage, low/medium go to the backlog; higher is labelled for
   the work lane and pings the team leader.
4. **Reporter self-service** — `/mybugs`, an App Home tab, and a DM when a bug changes status.

**Non-goal:** replacing the official *Jira Cloud for Slack* app. That stays installed for
`/jira <KEY>` previews and channel subscriptions. BugBot adds the QA-specific intake form, the
routing rules and the per-reporter view, which the official app cannot do.

Full requirements live in `SPEC.md`. Section references below (`SPEC 7`) point there.

---

## Status

All phases are **built and tested** — 281 unit tests plus 13 integration tests against the real
Neon database — and **deployed and verified on Vercel**. The Jira side works end to end. What is
left is Slack: the app does not exist yet, so nothing Slack-facing has run for real.

| Phase | Scope | State |
|---|---|---|
| 0 | Skeleton, config, Jira client, DB, Docker, `npm run discover` | built |
| 1 | `/bug` modal → Jira issue in `Under Triage` + confirmation thread | built |
| 2 | Thread attachment sync, "Report as bug" message shortcut | built |
| 3 | Jira webhook, idempotency, routing matrix, `/triage` | built |
| 4 | `/mybugs`, App Home, status-change DMs | built |
| 5 | `/bugstats` digest | built |

### Verified in production

Deployed at `https://bugbot-eight.vercel.app`. Confirmed against the live deployment, not
locally:

- **The whole app boots on Vercel**: `bugbot ready`, `serverless: true`.
- **Jira credentials work**, and the metadata resolves — `SUP (10396)`, `Finding (10481)`.
- **All eight statuses exist on the `Finding` workflow**: `To Do`, `Under Triage`,
  `In Progress`, `Ready for Validation`, `Rejected`, `Duplicate`, `Cannot Reproduce`, `Done`.
  `assertStatusesExist` passing at boot is what proves it, so every status SPEC 7 routes on is
  real. This was the last open question from Phase 0.
- **Postgres works from Vercel**: `/readyz` returns `{"database":true,"jira":true}`.
- **All three webhook guards, with logs to match**: a one-character-wrong secret gives 404
  ("bad secret - rejected"), a payload for another project gives 200 then
  "webhook for another project - rejected", and an unparseable body gives 400.
- **Routing**: `/` returns the service description, `/healthz` and `/readyz` return 200,
  unknown paths return 404 from the express app, and `/slack/events` returns 404 until Slack
  credentials are set.

### Changing an environment variable needs a redeploy

Vercel bakes environment variables into a deployment when it is built. Editing one in the
dashboard does nothing to deployments that already exist, so the change appears to be ignored
until the next build.

This is worth knowing before it wastes an hour: after adding `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET`, the app will keep logging *"Slack is not configured"* and `/slack/events`
will keep returning 404 until you redeploy. It looks exactly like the tokens being wrong.

Dashboard → Deployments → `⋯` on the latest → **Redeploy**, or `vercel redeploy <url>`.

### Why the compile script is called `compile`, not `build`

This matters, and it is not a style choice.

This service is one function with no static output, so there is nothing for a build step to
produce. But Vercel's zero-config detection runs `npm run build` **whenever a script by that name
exists**, and then demands a static output directory afterwards. That failed the whole deployment
with *"No Output Directory named `public` found after the Build completed"*, and — while the
build was still being tolerated — it also gave Vercel's static-serving layer ownership of `/`,
which is what made the bare root return `FUNCTION_INVOCATION_FAILED` while every other path
worked.

Setting `"buildCommand": null` in `vercel.json` does **not** stop this: null means "no override",
which lands right back in zero-config detection. Renaming the script does stop it, because there
is then nothing for Vercel to detect.

So: `npm run compile` (tsc, for the Docker image and local use), and `vercel.json` pins
`"framework": null` and `"buildCommand": null` in the repo rather than the dashboard so there is
one source of truth. Vercel compiles `api/index.ts` and traces `src/**` by itself.

The trade-off is that a type error no longer fails a deployment. `npm run typecheck` and
`npm test` are the guard, and a CI workflow is the place to enforce them if that becomes worth
doing.

### What is still not verified

Covered by unit tests, but never exercised against the live services:

- **No Slack app exists yet**, so no command, modal, shortcut, event or button has run for real.
  `/slack/events` correctly 404s until `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are set.
- **Whether `Under Triage` → `To Do` exists as a *transition***. The statuses all exist, but the
  workflow is restricted rather than global, so reaching `To Do` from `Under Triage` still needs
  checking with `npm run discover -- --issue=<key>` on an issue actually in triage. If it is
  missing, routing labels the issue `needs-manual-move` and says so instead of failing silently.
- **Attachment upload to Jira.** The multipart shape and the `X-Atlassian-Token` header follow
  the API docs; the Slack download side is unit tested with a fake fetch.
- `MODIFY_REPORTER` on the service account — `discover` reports it. Note the service account is
  currently a personal one, so every issue will show that person as `Reporter`.

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

- **Node 24 or newer.** `.nvmrc` pins 24; the Docker image is `node:24-bookworm-slim`.
- **A Postgres database.** Neon is what this is running on; Vercel Postgres and Supabase work
  too. On Vercel you must use the **pooled** connection string.
- A Jira API token for the service account (below).
- Docker, only if you want to run the whole thing locally without Vercel.

## Setup

```bash
cp .env.example .env      # fill in DATABASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
npm ci
npm run migrate           # create the tables
npm test
```

`npm run migrate` is a deliberate step, not something the app does on boot: on Vercel several
cold starts can begin at once, and a serverless function is the wrong place to be altering a
schema. It takes a Postgres advisory lock, so running it twice at once is safe.

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
by looking their Slack email up against Jira. Set it to `false` to always file as the service
account.

### What if the reporter has no Jira account?

This is the common case — most people who hit a bug are not Jira users — so it is worth being
precise about it.

Jira's **`Reporter` field will show the service account (BugBot)**. BugBot only sets a real
reporter when it found a matching Jira `accountId`; with no account it omits the field entirely
and Jira defaults it to whoever authenticated. The same fallback happens if the service account
lacks `MODIFY_REPORTER`: the create call is retried without the field rather than failing.

The actual human is recorded in four places instead:

1. **The description footer** — `Reported by: Margherita Turrin <margherita@roarington.com> - via
   the Slack /bug form`. Name and email come from their Slack profile; the email is included
   because a name alone is ambiguous and is what lets a reader actually find them.
2. **A link to the Slack thread**, added to the description right after the confirmation is
   posted: *"Slack thread (reply here to reach the reporter)"*. Replying there reaches them, and
   any file posted there is attached to the issue automatically. This is the part that makes a
   reporter with no Jira account workable — a developer triaging in Jira has somewhere to click.
3. **`issue_reports.slack_user_id`** in the local database.
4. **The confirmation message in Slack**, which says `Filed by @them`.

**Notifications are unaffected.** Thread replies and DMs key off the Slack user id, not the Jira
account, so someone with no Jira account still gets "triaged, in the backlog", the rejection
reason, and status changes. The only thing they lose is their name in Jira's `Reporter` column.

If the Slack profile has no real name, the footer degrades to the email, then to
`Slack user U08HVG0H2EL` — ugly but traceable, never blank.

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

This brings up a Postgres alongside the app and points the app at it, so the local stack is
self-contained and needs no Neon. The container runs as the non-root `node` user and has its own
`HEALTHCHECK`. It exists for local end-to-end runs and as a non-Vercel escape hatch — the
deployment target is a Vercel function.

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

## Deploying to Vercel

The whole service is one function. `vercel.json` rewrites every path to it, so `/slack/events`,
`/jira/webhook/:secret`, `/healthz` and `/readyz` all arrive at `api/index.ts`.

```bash
vercel link                       # first time only
vercel env add DATABASE_URL       # the POOLED connection string
vercel env add JIRA_EMAIL
vercel env add JIRA_API_TOKEN
vercel env add JIRA_WEBHOOK_SECRET
vercel env add SLACK_BOT_TOKEN
vercel env add SLACK_SIGNING_SECRET
vercel env add SLACK_DEFAULT_TRIAGER
vercel env add SLACK_ANNOUNCE_CHANNEL
vercel env add SLACK_DEV_CHANNEL
npm run migrate                   # against the same DATABASE_URL, once
vercel deploy --prod
```

### What serverless changes, and why the code looks the way it does

Three things about Vercel shaped the design, and all three are places where a plausible-looking
change would quietly break the service:

**A function stops the moment its response is sent.** But Slack demands an acknowledgement inside
three seconds, and filing a Jira issue takes longer than that. So every handler acks first and
then hands the slow part to `keepAlive` (`src/runtime.ts`), which wraps Vercel's `waitUntil`. On a
normal server the same call just lets the promise run. If you add a handler that does work after
`ack()` without `keepAlive`, it will appear to work locally and silently do nothing in
production.

**The filesystem is ephemeral and per-instance**, which is why the database is Postgres rather
than SQLite. The `notifications` table is what guarantees a redelivered webhook sends nothing
twice; on a disappearing disk that guarantee disappears with it, and duplicate DMs are the one
failure mode SPEC 7 singles out as trust-destroying.

**Connections are the scarce resource.** Every warm instance holds a pool, so `DATABASE_URL` must
be the pooled (`-pooler`) Neon host and `DATABASE_POOL_MAX` stays small. A direct connection
string will work fine in testing and exhaust the limit under real load.

The Jira preflight runs once per cold start, at module load, via a top-level `await` in
`api/index.ts` — so no request is ever handled by a half-configured app. Warm invocations reuse
it along with the pool. If it fails, the function serves 503 with the reason (not 500: Slack backs
off on a 503 and stops trusting an endpoint that 500s), and the next cold start tries again.

`maxDuration` is 60s in `vercel.json`. Background work registered with `waitUntil` is still
bounded by it.

### Two things the first deploy taught us

Both are fixed, and both are the kind of thing that looks fine locally and fails only in a
function:

**A zod `.default()` only fires on `undefined`, not on an empty string.** Vercel's "import from
.env.example" set all thirty variables to blank, which defeated every default at once and made
fourteen of them invalid. `withoutBlanks` in `src/config.ts` now strips blanks before
validation, because every way these get set produces empty strings freely.

**The entry point must export a function, not an awaited value.** `api/index.ts` originally used
a top-level await and exported the resolved express app; Vercel resolved the entry to a traced
dependency instead and failed with "Invalid export found in module /var/task/src/app.js". It now
exports an async handler and caches the bootstrap in a module-scope promise — same behaviour, in
the shape Vercel expects.

The NodeNext `.js`-for-`.ts` import convention turned out to be fine: Vercel resolved
`../src/app.js` from `api/index.ts` without help.

### Use sslmode=verify-full in the connection string

`pg` warns on every cold start that `sslmode=require` is currently treated as `verify-full` and
will adopt weaker libpq semantics in a future major version. Writing `sslmode=verify-full`
explicitly keeps today's behaviour, silences the warning, and means a `pg` upgrade cannot
quietly downgrade the connection.

### Backups

Neon takes care of this: point-in-time restore is on by default, and a branch is a cheap
snapshot. Nothing in this repo needs a backup script.

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
- **The webhook secret appears in Vercel's request logs**, because Vercel logs the full request
  path and the secret is a path segment. Jira Cloud webhooks cannot send custom headers, so the
  path is the only place a shared secret can go. In practice log access and deploy access are
  the same people, so this is tolerable — but it is the reason `JIRA_WEBHOOK_IP_ALLOWLIST`
  exists, and the reason to rotate the secret if log access ever widens.
- **Secrets come from the environment only.** `.env` is gitignored; `.env.example` carries empty
  values. On Vercel they are project environment variables (`vercel env add`).
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
api/
  index.ts                    Vercel entry point: exports the express app, no listen()
src/
  app.ts                      bootstrap(): builds everything without starting a server
  index.ts                    Standalone server for local development and Docker
  runtime.ts                  keepAlive(): waitUntil on Vercel, plain promise elsewhere
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
    index.ts                  the Db interface, the pg pool, toCount
    migrate.ts                migration runner, with the advisory lock
    repo.ts                   every SQL statement
    migrations/
scripts/
  discover.ts                 dump every Jira ID (npm run discover)
  migrate.ts                  npm run migrate
  manifest.json               Slack app manifest, ready to paste
config/
  leaders.example.json        per-application team leader map (SPEC 9.2)
test/                         vitest; HTTP mocked with msw, effects via a recording harness
  integration/                against real Postgres; npm run test:integration
vercel.json                   rewrites every path to the one function
```

### Choices worth knowing about

- **Postgres, not SQLite.** `SPEC.md` §3 asked for `better-sqlite3`, on the assumption of a
  single long-lived node. Two things moved it: `better-sqlite3` is a native module with no
  prebuilt binary for the Node on the dev machine, so it needed a node-gyp toolchain that was not
  there; and then the deployment target became Vercel, where the filesystem is ephemeral and
  per-instance, which makes any local file useless for the `notifications` ledger. What the spec
  actually wanted is unchanged: all SQL confined to `src/db/`, which is exactly what made this
  swap a contained one.
- **The `Db` interface in `src/db/index.ts`.** Three methods — `query`, `transaction`, `close`.
  The repository layer knows nothing about `pg`, which is what lets the tests hand it pg-mem and
  exercise the shipping implementation rather than a lookalike.
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
npm test              # 273 unit tests, offline, in-memory Postgres
npm run test:integration   # 13 tests against the real database
npm run typecheck
```

The unit suite runs against **pg-mem**, an in-memory Postgres, so it needs no database, no Docker
and no network. The integration suite runs against whatever `TEST_DATABASE_URL` (or
`DATABASE_URL`) points at, serially, and deletes every row it writes — safe to point at the same
database the app uses.

The split is not arbitrary. pg-mem does not implement everything, and two of its gaps sit exactly
on top of the guarantees that matter most here, so those are verified against real Postgres
instead:

- **It does not honour ROLLBACK** through the pool adapter — a row inserted in a transaction
  survives a rollback. Migration atomicity depends on rollback, so that is an integration test.
- **It reports `rowCount: 1` for a targeted `ON CONFLICT (col) DO NOTHING`** even when nothing
  was inserted. That is the exact mechanism behind "a redelivered webhook sends nothing twice".
  The code now uses the untargeted `ON CONFLICT DO NOTHING` — identical behaviour on Postgres for
  a table whose only constraint is its primary key, and it makes the offline suite able to check
  the guarantee at all. The integration suite then proves it properly: **twelve concurrent claims,
  exactly one winner.**

Where pg-mem's limits are worked around, the comment says so and names the integration test that
covers it — rather than leaving a test that passes for the wrong reason.

The ones worth knowing about:

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
- **`integration/postgres.test.ts`** covers rollback, the idempotency claim under genuine
  concurrency, the digest window, and that `COUNT(*)` comes back as a number rather than the
  string Postgres actually sends.

Three real bugs were found by these tests rather than in production:

1. The viewport pattern rejected `800 X 600` — a capital X is something people type.
2. Jira's changelog has a field literally named `toString`, which collides with
   `Object.prototype.toString`. When an item arrived without it, a plain property read returned
   the inherited *function*, zod rejected it as "expected string, received function", and the
   entire webhook payload was dropped. `src/jira/webhook.ts` now rebuilds each changelog item on
   a null prototype.
3. `claimDigest` was written as a conditional upsert (`ON CONFLICT DO UPDATE ... WHERE`). Correct
   on Postgres, but untestable on pg-mem, which ignores the `WHERE`. Rewritten as two statements
   that are each atomic on their own — portable, and provably correct under concurrency.
