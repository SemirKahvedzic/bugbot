/**
 * Wires every Slack handler onto the Bolt app.
 *
 * One place to see what BugBot listens to, and one place a handler can be
 * commented out when something misbehaves.
 */
import type { App } from '@slack/bolt';
import { registerBugCommand } from './commands/bug.js';
import { registerBugStatsCommand } from './commands/bugstats.js';
import { registerMyBugsCommand } from './commands/mybugs.js';
import { registerTriageCommand } from './commands/triage.js';
import { registerFileSync } from './files.js';
import { registerHome } from './home.js';
import { registerReportBugShortcut } from './shortcuts/reportBug.js';
import type { BugbotContext } from '../context.js';

export function registerSlackHandlers(app: App, context: BugbotContext): void {
  // Phase 1
  registerBugCommand(app, context);
  // Phase 2
  registerReportBugShortcut(app, context);
  registerFileSync(app, context);
  // Phase 3
  registerTriageCommand(app, context);
  // Phase 4
  registerMyBugsCommand(app, context);
  registerHome(app, context);
  // Phase 5
  registerBugStatsCommand(app, context);

  // A handler that throws must not take the process down.
  app.error(async (error) => {
    context.log.error({ err: error.message }, 'unhandled Slack handler error');
  });

  context.log.info('Slack handlers registered');
}
