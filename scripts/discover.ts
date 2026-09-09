/**
 * `npm run discover` - dump every Jira ID the later phases need (SPEC 2).
 *
 * Nothing in this repo hardcodes a Jira ID. Run this against the real site,
 * read the report, and paste the confirmed values into .env.
 *
 * Every section is independently guarded: one failing endpoint (a missing
 * permission, a Kanban board with no sprints) never aborts the rest of the
 * report, because the failures are themselves the interesting output.
 *
 * Usage:
 *   npm run discover
 *   npm run discover -- --issue=SUP-1     # also dump that issue's transitions
 *   npm run discover -- --json            # machine-readable only
 */
import { writeFileSync } from 'node:fs';
import 'dotenv/config';
import { z } from 'zod';
import {
  JiraClient,
  JiraError,
  type AgileBoard,
  type AgileSprint,
  type JiraField,
  type JiraIssueTypeStatuses,
  type JiraMyself,
  type JiraPriority,
  type JiraProject,
  type JiraTransition,
  type JiraUser,
} from '../src/jira/client.js';

/**
 * A deliberately minimal schema: discover must run with only the Jira block of
 * .env filled in, before Slack even exists as an app.
 */
const envSchema = z.object({
  JIRA_BASE_URL: z.string().url().transform((u) => u.replace(/\/+$/, '')),
  JIRA_CLOUD_ID: z.string().optional(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PROJECT_KEY: z.string().min(1).default('SUP'),
  JIRA_ISSUE_TYPE: z.string().min(1).default('Finding'),
  JIRA_BOARD_ID: z.coerce.number().int().positive().optional(),
});

const PERMISSIONS = [
  'BROWSE_PROJECTS',
  'CREATE_ISSUES',
  'EDIT_ISSUES',
  'TRANSITION_ISSUES',
  'MODIFY_REPORTER',
  'CREATE_ATTACHMENTS',
  'ADD_COMMENTS',
  'SCHEDULE_ISSUES',
] as const;

type Report = Record<string, unknown>;

const report: Report = {};
const findings: string[] = [];
const notes: string[] = [];

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const issueArg = args.find((a) => a.startsWith('--issue='))?.split('=')[1];

function out(line = ''): void {
  if (!jsonOnly) process.stdout.write(`${line}\n`);
}

function heading(title: string): void {
  out();
  out(`── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

function describeError(error: unknown): string {
  if (error instanceof JiraError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Run one section, recording failure instead of propagating it. */
async function section<T>(key: string, title: string, fn: () => Promise<T>): Promise<T | undefined> {
  heading(title);
  try {
    const value = await fn();
    report[key] = value;
    return value;
  } catch (error) {
    const message = describeError(error);
    report[key] = { error: message };
    out(`  FAILED: ${message}`);
    findings.push(`${title}: ${message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write('Cannot run discover - the Jira block of .env is incomplete:\n');
    for (const issue of parsed.error.issues) {
      process.stderr.write(`  ${issue.path.join('.')}: ${issue.message}\n`);
    }
    process.stderr.write('\nCopy .env.example to .env and fill JIRA_EMAIL + JIRA_API_TOKEN.\n');
    process.exit(1);
  }
  const env = parsed.data;
  const jira = new JiraClient({
    baseUrl: env.JIRA_BASE_URL,
    email: env.JIRA_EMAIL,
    apiToken: env.JIRA_API_TOKEN,
  });

  out(`BugBot Jira discovery`);
  out(`site:    ${env.JIRA_BASE_URL}`);
  out(`project: ${env.JIRA_PROJECT_KEY}`);
  out(`type:    ${env.JIRA_ISSUE_TYPE}`);
  out(`run at:  ${new Date().toISOString()}`);

  // 1. Cloud ID -----------------------------------------------------------
  await section('tenant', 'Cloud ID (/_edge/tenant_info)', async () => {
    const info = await jira.tenantInfo();
    out(`  cloudId: ${info.cloudId}`);
    if (env.JIRA_CLOUD_ID && env.JIRA_CLOUD_ID !== info.cloudId) {
      out(`  MISMATCH: .env has JIRA_CLOUD_ID=${env.JIRA_CLOUD_ID}`);
      findings.push(
        `JIRA_CLOUD_ID in .env (${env.JIRA_CLOUD_ID}) does not match the site (${info.cloudId}). Fix .env.`,
      );
    } else if (env.JIRA_CLOUD_ID) {
      out(`  matches .env`);
    }
    return info;
  });

  // 2. Service account ----------------------------------------------------
  const me = await section('myself', 'Service account (/rest/api/3/myself)', async () => {
    const user = await jira.get<JiraMyself>('/rest/api/3/myself');
    out(`  accountId:   ${user.accountId}`);
    out(`  displayName: ${user.displayName}`);
    out(`  active:      ${user.active}`);
    notes.push(
      `Loop guard (SPEC 7): ignore webhooks whose actor accountId is ${user.accountId}.`,
    );
    return user;
  });

  // 3. Permissions --------------------------------------------------------
  await section('permissions', `Permissions on ${env.JIRA_PROJECT_KEY}`, async () => {
    const response = await jira.get<{
      permissions: Record<string, { havePermission: boolean }>;
    }>('/rest/api/3/mypermissions', {
      projectKey: env.JIRA_PROJECT_KEY,
      permissions: PERMISSIONS.join(','),
    });
    const result: Record<string, boolean> = {};
    for (const name of PERMISSIONS) {
      const have = response.permissions?.[name]?.havePermission ?? false;
      result[name] = have;
      out(`  ${have ? 'yes' : 'NO '}  ${name}`);
    }
    const missing = PERMISSIONS.filter((name) => !result[name]);
    if (missing.length > 0) {
      findings.push(`Service account is missing: ${missing.join(', ')}.`);
    }
    if (!result.MODIFY_REPORTER) {
      findings.push(
        'MODIFY_REPORTER is absent, so JIRA_SET_REAL_REPORTER=true cannot work. ' +
          'Either grant it in the SUP permission scheme or set JIRA_SET_REAL_REPORTER=false.',
      );
    }
    return result;
  });

  // 4. Project ------------------------------------------------------------
  await section('project', `Project ${env.JIRA_PROJECT_KEY}`, async () => {
    const project = await jira.get<JiraProject>(
      `/rest/api/3/project/${encodeURIComponent(env.JIRA_PROJECT_KEY)}`,
    );
    out(`  id:        ${project.id}`);
    out(`  key:       ${project.key}`);
    out(`  name:      ${project.name}`);
    out(`  style:     ${project.style ?? '(unknown)'} (simplified=${project.simplified})`);
    return project;
  });

  // 5. Statuses per issue type - settles whether Under Triage is wired ----
  const issueTypes = await section(
    'issueTypeStatuses',
    'Issue types and their workflow statuses',
    async () => {
      const types = await jira.get<JiraIssueTypeStatuses[]>(
        `/rest/api/3/project/${encodeURIComponent(env.JIRA_PROJECT_KEY)}/statuses`,
      );
      for (const type of types) {
        out(`  ${type.name} (id ${type.id})${type.subtask ? ' [subtask]' : ''}`);
        for (const status of type.statuses) {
          const category = status.statusCategory?.name ?? '?';
          out(`      ${status.name} (id ${status.id}) [${category}]`);
        }
      }
      const configured = types.find(
        (t) => t.name.toLowerCase() === env.JIRA_ISSUE_TYPE.toLowerCase(),
      );
      if (!configured) {
        findings.push(
          `JIRA_ISSUE_TYPE="${env.JIRA_ISSUE_TYPE}" is not in ${env.JIRA_PROJECT_KEY}. ` +
            `Available: ${types.map((t) => t.name).join(', ')}.`,
        );
      } else {
        const names = configured.statuses.map((s) => s.name.toLowerCase());
        const required = [
          'Under Triage',
          'To Do',
          'Rejected',
          'Duplicate',
          'Cannot Reproduce',
        ];
        const missing = required.filter((name) => !names.includes(name.toLowerCase()));
        if (missing.length > 0) {
          findings.push(
            `The ${configured.name} workflow is missing these statuses BugBot routes on: ` +
              `${missing.join(', ')}. Either add them to the workflow or repoint the ` +
              `JIRA_STATUS_* variables at statuses that exist.`,
          );
        } else {
          notes.push(`All routing statuses exist on ${configured.name}. SPEC 5/7 work as written.`);
        }
      }
      return types;
    },
  );

  const issueTypeId = issueTypes?.find(
    (t) => t.name.toLowerCase() === env.JIRA_ISSUE_TYPE.toLowerCase(),
  )?.id;

  // 6. Create screen fields ----------------------------------------------
  if (issueTypeId) {
    await section('createMeta', `Create screen fields for ${env.JIRA_ISSUE_TYPE}`, async () => {
      const meta = await jira.get<{
        fields: Array<{
          fieldId: string;
          name: string;
          required: boolean;
          schema?: { type?: string; custom?: string };
          allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
        }>;
      }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(env.JIRA_PROJECT_KEY)}` +
          `/issuetypes/${issueTypeId}`,
        { maxResults: 200 },
      );
      for (const field of meta.fields ?? []) {
        const flag = field.required ? 'required' : 'optional';
        out(`  ${field.fieldId.padEnd(22)} ${field.name} (${flag}, ${field.schema?.type ?? '?'})`);
        if (field.fieldId === 'priority' && field.allowedValues) {
          for (const value of field.allowedValues) {
            out(`      priority ${value.id} = ${value.name}`);
          }
        }
      }
      const ids = new Set((meta.fields ?? []).map((f) => f.fieldId));
      for (const needed of ['summary', 'description', 'labels', 'priority']) {
        if (!ids.has(needed)) {
          findings.push(
            `Field "${needed}" is not on the ${env.JIRA_ISSUE_TYPE} create screen. ` +
              `Intake (SPEC 5) depends on it.`,
          );
        }
      }
      return meta;
    });
  }

  // 7. Custom fields (Sprint) --------------------------------------------
  await section('sprintField', 'Sprint custom field', async () => {
    const fields = await jira.get<JiraField[]>('/rest/api/3/field');
    const sprint = fields.filter(
      (f) => f.schema?.custom?.endsWith(':gh-sprint') || f.name.toLowerCase() === 'sprint',
    );
    if (sprint.length === 0) {
      out('  none found');
      findings.push('No Sprint custom field on this site - SPEC 7 sprint routing has nothing to set.');
    }
    for (const field of sprint) {
      out(`  ${field.id}  ${field.name}  (${field.schema?.custom ?? '?'})`);
    }
    const interesting = fields.filter(
      (f) => f.custom && /team|environment|severity|frequency|device|viewport/i.test(f.name),
    );
    if (interesting.length > 0) {
      out('  other custom fields that may be useful (SPEC 9.3 keeps these optional):');
      for (const field of interesting) out(`      ${field.id}  ${field.name}`);
    }
    return { sprint, interesting };
  });

  // 8. Boards -------------------------------------------------------------
  const boards = await section('boards', `Agile boards for ${env.JIRA_PROJECT_KEY}`, async () => {
    const response = await jira.get<{ values: AgileBoard[] }>('/rest/agile/1.0/board', {
      projectKeyOrId: env.JIRA_PROJECT_KEY,
      maxResults: 50,
    });
    for (const board of response.values ?? []) {
      const marker = env.JIRA_BOARD_ID === board.id ? '  <- JIRA_BOARD_ID' : '';
      out(`  id ${String(board.id).padEnd(6)} ${board.type.padEnd(8)} ${board.name}${marker}`);
    }
    if (env.JIRA_BOARD_ID && !(response.values ?? []).some((b) => b.id === env.JIRA_BOARD_ID)) {
      findings.push(
        `JIRA_BOARD_ID=${env.JIRA_BOARD_ID} is not a board of ${env.JIRA_PROJECT_KEY}.`,
      );
    }
    return response.values ?? [];
  });

  // 9. Active sprint ------------------------------------------------------
  const boardId = env.JIRA_BOARD_ID ?? boards?.[0]?.id;
  if (boardId) {
    const board = boards?.find((b) => b.id === boardId);
    await section('activeSprint', `Active sprint on board ${boardId}`, async () => {
      try {
        const response = await jira.get<{ values: AgileSprint[] }>(
          `/rest/agile/1.0/board/${boardId}/sprint`,
          { state: 'active' },
        );
        const sprints = response.values ?? [];
        if (sprints.length === 0) {
          out('  no active sprint');
          findings.push(
            `Board ${boardId} has no active sprint right now. SPEC 7 routing for High/Highest ` +
              `will fall back to the backlog with a needs-sprint label until one is started.`,
          );
        }
        for (const sprint of sprints) {
          out(`  id ${sprint.id}  ${sprint.name}  (${sprint.startDate ?? '?'} -> ${sprint.endDate ?? '?'})`);
        }
        return sprints;
      } catch (error) {
        if (error instanceof JiraError && error.status === 400) {
          out(`  board ${boardId} does not support sprints (type=${board?.type ?? 'unknown'})`);
          findings.push(
            `Board ${boardId} is ${board?.type ?? 'not a scrum board'}, so it has no sprints at ` +
              `all. SPEC 7's "add to active sprint" for High/Highest is impossible as written - ` +
              `decide before Phase 3 whether to use a scrum board or replace sprint routing with ` +
              `a board column / label.`,
          );
          return { unsupported: true, boardType: board?.type ?? null };
        }
        throw error;
      }
    });
  }

  // 10. Email visibility - SPEC 4 identity mapping depends on this --------
  await section('emailVisibility', 'User email visibility (SPEC 4 identity mapping)', async () => {
    const probe = env.JIRA_EMAIL;
    const users = await jira.get<JiraUser[]>('/rest/api/3/user/search', { query: probe });
    const withEmail = users.filter((u) => Boolean(u.emailAddress)).length;
    out(`  searched for the service account address: ${users.length} match(es)`);
    out(`  of which expose emailAddress: ${withEmail}`);
    if (users.length > 0 && withEmail === 0) {
      findings.push(
        'The API does not expose user email addresses, so Slack email -> Jira accountId ' +
          'mapping (SPEC 4) will fail. Reporters will still get bugs filed, just no DMs. ' +
          'An org admin can relax the profile visibility setting.',
      );
    }
    return { matches: users.length, withEmail };
  });

  // 11. Transitions (needs an existing issue) ----------------------------
  if (issueArg) {
    await section('transitions', `Transitions available on ${issueArg}`, async () => {
      const response = await jira.get<{ transitions: JiraTransition[] }>(
        `/rest/api/3/issue/${encodeURIComponent(issueArg)}/transitions`,
      );
      for (const transition of response.transitions ?? []) {
        out(
          `  transition ${transition.id.padEnd(4)} "${transition.name}" -> ` +
            `${transition.to.name} (status ${transition.to.id})`,
        );
      }
      return response.transitions ?? [];
    });
  } else {
    heading('Transitions');
    out('  skipped - pass --issue=KEY once one issue exists in the project.');
    out('  BugBot resolves transitions by target status name at call time, so these');
    out('  IDs are informational only; nothing needs to be pasted into .env.');
  }

  // Summary ---------------------------------------------------------------
  heading('Findings');
  if (findings.length === 0) {
    out('  none - every value BugBot needs is present.');
  } else {
    findings.forEach((finding, index) => out(`  ${index + 1}. ${finding}`));
  }

  if (notes.length > 0) {
    heading('Notes');
    notes.forEach((note) => out(`  - ${note}`));
  }

  report.findings = findings;
  report.notes = notes;
  report.generatedAt = new Date().toISOString();
  report.site = env.JIRA_BASE_URL;

  writeFileSync('discovery.json', `${JSON.stringify(report, null, 2)}\n`);
  out();
  out('Full report written to discovery.json (gitignored).');

  if (jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // A non-zero exit makes this usable as a deploy pre-flight check.
  if (findings.length > 0) process.exitCode = 1;
  if (!me) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`discover failed: ${describeError(error)}\n`);
  process.exit(1);
});
