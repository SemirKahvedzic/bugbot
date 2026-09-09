# Roarington Bug Intake & Triage Bot ("BugBot") — requirements

> **Status of this document.** This is the original build specification, kept as written so the
> intent behind each decision stays visible. Several concrete values in §2 turned out to be wrong
> when checked against the live Jira site — the project is `SUP` (not `SOFT`), the board is `468`
> (not `303`), and the issue type is `Finding` (there is no `Bug` type in `SUP`). **`README.md`
> carries the verified environment and every deviation from this document, with reasons.** Where
> the two disagree, `README.md` describes what was built.

---

## 0. Working agreement

Production Slack + Jira bug intake and triage service for a small QA/dev team. The QA tester owns
and operates it.

1. **Build in the phases defined below, in order.** After each phase: stop, show what runs, how
   to test it manually, and wait for go-ahead before starting the next phase.
2. **Ask before assuming anything on the "Open decisions" list (§9).** Do not invent Jira field
   IDs, sprint IDs or channel IDs — read them from config/env, and provide a script that
   discovers them from the API.
3. Every phase ends with: passing tests, updated `README.md`, updated `.env.example`, one commit.
4. Prefer boring, readable code over clever code. This will be maintained by one person.
5. Never log request bodies containing user emails or tokens. Redact by default.

---

## 1. What we are building

Today a bug reaches us three ways: someone writes it in Jira, someone writes it in a Slack
channel, or someone tells the tester verbally. Slack reports are unusable — no device, no
viewport, no steps. Nothing is consistently triaged and reporters have no idea what happened to
their report.

BugBot fixes four things:

1. **Guided intake from Slack** — a slash command / message shortcut that opens a form forcing
   the structured fields QA actually needs (app, environment, device, browser, viewport, input
   method, steps, expected vs actual, severity, frequency), then creates a Jira Bug in the
   triage status.
2. **A single funnel** — every new bug, whether created in Slack or natively in Jira, lands in
   `Under Triage` with a normalised description and labels.
3. **Assisted triage routing** — when the tester triages an issue, the service moves it to the
   right place automatically: low/medium → backlog; above medium → active sprint + ping the team
   leader.
4. **Reporter self-service** — the person who reported a bug can ask the bot for the status of
   their bugs (`/mybugs`, plus an App Home tab), and gets a DM when their bug changes status.

Non-goal: replacing the official *Jira Cloud for Slack* app. That app stays installed for
`/jira <KEY>` previews and channel subscriptions. BugBot adds the QA-specific intake form,
the routing logic and the per-reporter view — things the official app can't do.

---

## 2. Environment (real values — verify, don't trust)

| Thing | Value | Note |
|---|---|---|
| Jira site | `roarington.atlassian.net` | Cloud |
| Jira project key | `SOFT` | Bug reports live here |
| Jira cloud ID | `57de5553-0941-4346-821f-c46f7dde06cc` | **Verify** via `/_edge/tenant_info` — two conflicting values on file |
| Board | id `303` | Verify whether this is the Kanban intake board or the Scrum board with sprints |
| Slack workspace | `roarington.slack.com` | |
| `#soft-world` | `C0AU6L9FPME` | Main reporting/announce channel |
| `#roarington-dev` | `C0AT37C7PFY` | Dev channel |
| `#monitoring` | `C0B7G6HV873` | Not used by this service |
| QA Slack user ID | `U08HVG0H2EL` | Default triager |

> Corrected during Phase 0: project `SUP` (id `10396`), board `468` — a **Kanban** board, so it
> has no sprints — and issue type `Finding` (id `10481`). See `README.md`.

Jira workflow statuses already designed for this project:
`To Do` → `Under Triage` → `In Progress` → `Ready for Validation` → `Done`,
plus terminal-ish `Rejected`, `Duplicate`, `Cannot Reproduce` (all mapped to the Done category),
with return transitions back to `Under Triage`.

> Confirmed during Phase 0: all of these exist and have columns on board 468. This part of §2
> was accurate.

**Add a discovery script** (`npm run discover`) that prints, for the configured site: cloud ID,
project ID, issue type IDs, priority IDs, status IDs + transition IDs per status, board IDs,
active sprint ID, and the custom field ID for Sprint. Do not hardcode any of these.

---

## 3. Stack

- **TypeScript**, Node 20+, ESM.
- **Slack**: `@slack/bolt` in **HTTP mode** behind Express (we need a public endpoint for the
  Jira webhook anyway). Socket Mode only as a dev convenience flag.
- **Jira**: plain REST calls via `undici`/`fetch` in a thin typed client (`src/jira/client.ts`).
  Auth = service account email + API token, Basic auth. No SDK.
  Relevant endpoints: `POST /rest/api/3/issue`, `POST /rest/api/3/issue/{key}/transitions`,
  `PUT /rest/api/3/issue/{key}`, `POST /rest/api/3/issue/{key}/attachments`,
  `POST /rest/api/3/search/jql`, `GET /rest/agile/1.0/board/{id}/sprint?state=active`,
  `POST /rest/agile/1.0/sprint/{id}/issue`, `POST /rest/agile/1.0/backlog/issue`.
- **Storage**: SQLite via `better-sqlite3`, schema in migrations. Small, single-node, backed up
  by copying a file. Keep all SQL in `src/db/` so Postgres is a drop-in later.
- **Validation**: `zod` for every inbound payload and for env config (fail fast on boot).
- **Logging**: `pino`, structured, with a redaction list.
- **Tests**: `vitest`. HTTP mocked with `msw` or `nock`. The triage routing matrix must be
  covered by table-driven unit tests.
- **Deploy**: Dockerfile + `docker-compose.yml`. Target a small VPS or Fly.io/Railway.
  `ngrok` documented for local development of both webhooks.

---

## 4. Data model

```
issue_reports(
  issue_key TEXT PRIMARY KEY,
  slack_user_id TEXT,          -- reporter, if known
  slack_channel_id TEXT,       -- where it was reported
  slack_thread_ts TEXT,        -- confirmation thread, used for attachment sync
  intake_source TEXT,          -- 'slack_modal' | 'slack_shortcut' | 'jira_native'
  created_at TEXT
)

user_map(
  slack_user_id TEXT PRIMARY KEY,
  jira_account_id TEXT,
  email TEXT,
  updated_at TEXT
)

notifications(          -- idempotency: Jira redelivers webhooks
  dedupe_key TEXT PRIMARY KEY,   -- issue_key + event + changelog_id
  sent_at TEXT
)

triage_events(          -- metrics
  id INTEGER PRIMARY KEY,
  issue_key TEXT, from_status TEXT, to_status TEXT,
  priority TEXT, routed_to TEXT,  -- 'backlog' | 'sprint'
  actor_account_id TEXT, at TEXT
)
```

**Identity mapping is the one genuinely tricky part.** Design:

- All issues are created by a single Jira **service account**. The human reporter is recorded in
  `issue_reports` and in the description footer.
- For bugs created natively in Jira, resolve the reporter's email → Slack user via
  `users.lookupByEmail`, cache in `user_map`, and backfill `issue_reports` on the
  `jira:issue_created` webhook. If lookup fails, the bug still funnels correctly; it just gets
  no DMs.
- Do **not** require per-user Jira OAuth (3LO) in v1. Note in the README what we'd gain if we
  add it later (true `reporter` field, per-user permissions).

---

## 5. Intake form (Slack modal)

Slash command `/bug`, plus a message shortcut **"Report as bug"** that prefills steps from the
selected message and keeps a permalink to it.

Fields (all required unless marked optional):

| Field | Type | Options / hint |
|---|---|---|
| Summary | plain text | one line, max 120 chars |
| Application | select | `world.roarington.com`, `dreamland.roarington.com`, Car Studio, Media/editorial, Other |
| Environment | select | Production, Staging, Local |
| Device | select + free text | Desktop, Laptop, Tablet, Phone, TV/console + model field |
| OS / OS version | plain text | e.g. `Android 15`, `iOS 18.2`, `Windows 11` |
| Browser + version | plain text | e.g. `Chrome 141` |
| Viewport size | plain text | hint: "window size in px, e.g. 1440x900 — not screen size" |
| Input method | multi-select | Mouse, Touch, Keyboard, Gamepad/joystick |
| Steps to reproduce | multiline | numbered |
| Expected result | multiline | |
| Actual result | multiline | |
| Frequency | select | Always, Sometimes, Happened once |
| Severity | select | Blocker, Major, Minor, Cosmetic |
| Extra notes / links | multiline, optional | stream session, console errors |

Behaviour:

- `ack()` the modal submission **within 3 seconds**, then do the Jira work asynchronously and
  report back with `chat.postMessage`. Use `response_action: "errors"` for field-level
  validation (e.g. viewport not matching `^\d{3,4}\s?[x×]\s?\d{3,4}$`).
- Create the Jira Bug with:
  - status `Under Triage` (transition immediately after create if the create screen lands in `To Do`),
  - a **normalised ADF description** rendered from a single template module
    (`src/format/description.ts`) so Slack-created and Jira-created bugs look identical,
  - labels: `src:slack`, `app:<slug>`, `env:<slug>`, `dev:<class>`, `sev:<slug>`, `freq:<slug>`,
  - **suggested priority** computed from severity × frequency (§6), set as the initial priority
    and stated explicitly in the description as a suggestion the triager can override.
- Post a confirmation **in the channel where `/bug` was run** (or as a thread reply for the
  shortcut): issue key + link + a compact summary + a line asking the reporter to
  *"reply in this thread with screenshots or a video"*. Store the `thread_ts`.
- **Attachment sync (Phase 2)**: subscribe to `message.channels`/`file_shared`; when a file is
  posted in a stored `slack_thread_ts`, download it with the bot token and attach it to the
  Jira issue, then react ✅ on the Slack message.

---

## 6. Suggested priority matrix

Compute a suggestion; never treat it as final. Table-driven, in `src/triage/suggest.ts`, unit
tested.

| Severity ↓ / Frequency → | Always | Sometimes | Once |
|---|---|---|---|
| Blocker | Highest | Highest | High |
| Major | High | High | Medium |
| Minor | Medium | Low | Low |
| Cosmetic | Low | Low | Lowest |

---

## 7. Triage routing (the core rule)

Trigger: Jira webhook `jira:issue_updated` where the issue leaves `Under Triage`, in the
configured project, of the configured bug issue type. Ignore updates made by the service account
itself (loop guard).

Read the **priority at the moment of exit** and route:

| Priority | Destination | Slack action |
|---|---|---|
| Lowest, Low, Medium | Backlog: `POST /rest/agile/1.0/backlog/issue`, ensure status `To Do`, label `triaged:backlog` | Thread reply to the reporter: "triaged, in backlog, priority X" |
| High | Active sprint of the dev board, label `triaged:sprint` + `needs-lead-review` | DM the team leader with issue summary + Approve/Reassign buttons; short note in `#soft-world` |
| Highest | Active sprint, label `triaged:sprint` + `escalated` | DM team leader **and** post in `#soft-world` with the reporter tagged; no `@here` unless `ESCALATION_MENTION=here` |

Also:

- If the issue exits to `Rejected` / `Duplicate` / `Cannot Reproduce`, skip routing and instead
  DM the reporter with the resolution and the triager's last comment, asking for more info where
  the status implies it.
- Write a row to `triage_events` for every routing decision.
- If there is no active sprint, fall back to backlog + label `needs-sprint` and tell the triager
  in the DM. Never fail silently.
- Make all of this **idempotent** — Jira retries webhooks, and duplicate DMs destroy trust in
  the bot faster than anything else.

**Triage helper (nice-to-have inside Phase 3):** `/triage` posts an ephemeral list of all
`Under Triage` bugs, each with buttons `Backlog`, `Sprint`, `Need info`, `Duplicate`. Buttons set
the priority + transition through the same routing code path, so there is exactly one
implementation of the rules.

---

## 8. Reporter self-service

- `/mybugs` → ephemeral message: my bugs grouped by status bucket
  (Under Triage / In Progress / Ready for Validation / Closed), newest first, max 20 with a
  "view all in Jira" link. JQL: `project = <KEY> AND issuekey IN (...)` from `issue_reports`,
  unioned with `reporter = <accountId>` when we have a mapping.
- **App Home tab** — the same view, always available, with a Refresh button. This is the better
  UX; build the slash command first because it's simpler.
- **Status-change DMs** — on `jira:issue_updated` status changes for issues with a known
  reporter: one short DM, deduped via `notifications`. Digest rather than spam: if an issue
  changes twice within 5 minutes, send once.
- `/bugstats` (optional, last) → weekly digest to `#soft-world`: intake count by app, median
  time in `Under Triage`, backlog vs sprint split, top 3 reporters.

---

## 9. Open decisions

1. **One board or two?** Does the sprint we route "High and above" into belong to the same
   project, or a separate dev project? If separate, we need to decide between moving the issue
   (heavy, loses history) or keeping it in place and adding it to a board whose filter spans both
   projects. Leaning towards the latter.
   → *Partly resolved: only `SUP` and board `468` are in scope; other projects untouched. But
   board 468 is Kanban and has no sprints, so the "active sprint" destination in §7 still needs
   a decision — a Scrum board elsewhere, or a Kanban-native replacement. Open, Phase 3.*
2. **Who is "team leader"** per application? Config shape for
   `app → leader Slack ID + Jira accountId`. → *`config/leaders.example.json`, values pending.*
3. **Can we create Jira custom fields**, or should everything live in labels + description?
   Assume labels + description for v1 (no admin needed) and make custom fields optional config.
   → *Resolved: labels + description. Verified sufficient.*
4. **Which channels may run `/bug`** — anywhere, or an allowlist?
   → *Defaulting to an allowlist of `#soft-world` + `#roarington-dev`; confirm before Phase 1.*
5. **Hosting** — VPS or a PaaS? Affects secrets handling and the SQLite backup story.
   → *Resolved: Fly.io.*
6. Should triage stay fully manual (tester sets priority, bot only moves things), or is there
   also an auto-route for `Blocker + Always` straight to sprint? → *Open, Phase 3.*

---

## 10. Repo layout

```
bugbot/
  src/
    index.ts                 # express + bolt bootstrap, health endpoint
    config.ts                # zod-validated env
    slack/
      commands/bug.ts        # /bug -> views.open
      commands/mybugs.ts
      commands/triage.ts
      shortcuts/reportBug.ts
      views/bugModal.ts      # block kit builder, pure function -> testable
      home.ts                # App Home
      notify.ts              # all outbound Slack messages in one place
      files.ts               # thread attachment sync
    jira/
      client.ts              # typed REST wrapper, retries, rate-limit backoff
      issues.ts              # create / transition / update / attach
      agile.ts               # sprints, backlog
      webhook.ts             # signature/secret check, parse, dispatch
    triage/
      suggest.ts             # severity x frequency -> priority
      route.ts               # THE routing rules, pure where possible
      leaders.ts
    format/
      description.ts         # ADF template, shared by both intake paths
      slackBlocks.ts
    db/
      index.ts, migrations/
  scripts/
    discover.ts              # dump Jira IDs (see §2)
    manifest.json            # Slack app manifest, ready to paste
  test/
  Dockerfile
  docker-compose.yml
  .env.example
  README.md
```

`scripts/manifest.json` must be a complete Slack app manifest with exactly the scopes we need
(`commands`, `chat:write`, `users:read`, `users:read.email`, `files:read`, `reactions:write`,
`im:write`, `channels:history` scoped as narrowly as possible), the slash commands, the message
shortcut and the App Home + event subscriptions. Explain each scope in the README so it can be
justified to the workspace admin.

---

## 11. Security requirements

- Verify **Slack request signatures** on every request (Bolt does this — confirm it's enabled and
  that we're not behind a proxy that breaks the raw body).
- Jira webhooks have no signing: protect the endpoint with a long random secret in the path plus
  an IP allowlist of Atlassian's published ranges, and reject payloads whose `issue.key` doesn't
  match the configured project.
- Secrets from env only, never committed. `.env.example` with empty values.
- Redact `email`, `token`, `authorization`, `text` (of DMs) in pino output.
- The Jira service account gets project-scoped permissions only, not site admin.

---

## 12. Phases and acceptance criteria

**Phase 0 — Skeleton & discovery.** Repo, config validation, health endpoint, Docker, Jira client
with auth, `npm run discover` printing all IDs from §2. Done when: `discover` runs against the
real site and returns correct IDs, and `docker compose up` serves `/healthz`.

**Phase 1 — Slack intake.** `/bug` modal → Jira Bug in `Under Triage` with normalised
description, labels and suggested priority → confirmation message with thread. Done when: a real
bug filed from `#soft-world` produces a Jira issue complete enough to triage without asking the
reporter anything.

**Phase 2 — Attachments + message shortcut.** Thread files sync to Jira; "Report as bug" shortcut
prefills from a message. Done when: screenshots posted in the confirmation thread appear on the
issue within seconds.

**Phase 3 — Triage routing.** Jira webhook receiver, idempotency, routing matrix, leader
notifications, `triage_events` logging, `/triage` buttons. Done when: exiting `Under Triage` with
each of the five priorities produces exactly the §7 behaviour, and replaying the same webhook
twice sends nothing twice. Unit tests cover all five priority paths plus the no-active-sprint
fallback.

**Phase 4 — Reporter self-service.** `/mybugs`, App Home, status-change DMs with dedupe/digest.
Done when: a colleague who reported bugs both via Slack and directly in Jira sees all of them in
one list.

**Phase 5 — Metrics digest.** Weekly `#soft-world` summary. Optional.
