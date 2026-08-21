import type { ProjectConfig } from '../config/types.js';
import type { CopilotPermissionRequest } from '../copilot/events.js';
import type { ActionType, RiskLevel } from './models.js';

/**
 * Classifies a Copilot action so that destructive ones get louder treatment
 * than routine ones (§27).
 *
 * ACP hands us `git status` and `git push --force` through the identical
 * `session/request_permission` shape, so if the Bridge did not classify them
 * itself, every action would look the same in Discord and "explicit approval
 * for destructive operations" would be meaningless.
 */

export interface RiskAssessment {
  readonly actionType: ActionType;
  readonly riskLevel: RiskLevel;
  /** Why, when it is worth telling the user. */
  readonly reason: string | null;
}

interface DangerRule {
  readonly pattern: RegExp;
  readonly reason: string;
  readonly actionType?: ActionType;
}

/**
 * Commands that destroy work or reach outside the project.
 *
 * These raise the risk level; they do not block. A human retains the authority
 * to say yes — blocking outright is reserved for a project's own
 * `security.deny_patterns`, which is an explicit decision by whoever configured
 * the Bridge.
 */
const HIGH_RISK_RULES: readonly DangerRule[] = [
  // Git operations named as destructive in §27
  { pattern: /\bgit\s+reset\s+.*--hard/i, reason: 'discards committed and staged work irreversibly', actionType: 'git_operation' },
  { pattern: /\bgit\s+clean\s+-[a-z]*[fd]/i, reason: 'deletes untracked files', actionType: 'git_operation' },
  // `\bgit\s+push\b` rather than `push\s+`: consuming the separator here would
  // leave the `-f` alternative unable to match its own leading space.
  { pattern: /\bgit\s+push\b.*?(--force\b(?!-with-lease)|\s-f(?=\s|$))/i, reason: 'overwrites remote history', actionType: 'git_operation' },
  { pattern: /\bgit\s+branch\s+.*-D\b/i, reason: 'force-deletes a branch', actionType: 'git_operation' },
  { pattern: /\bgit\s+checkout\s+.*(--force|(?:^|\s)-f\b)/i, reason: 'discards local changes', actionType: 'git_operation' },
  { pattern: /\bgit\s+(rebase|filter-branch|filter-repo)\b/i, reason: 'rewrites history', actionType: 'git_operation' },
  { pattern: /\bgit\s+update-ref\s+-d/i, reason: 'deletes a ref', actionType: 'git_operation' },

  // Filesystem destruction
  { pattern: /\brm\s+-[a-z]*[rf]/i, reason: 'recursive or forced delete', actionType: 'file_delete' },
  { pattern: /\b(rmdir|rd)\s+\/s/i, reason: 'recursive directory delete', actionType: 'file_delete' },
  { pattern: /\bdel\s+\/[a-z]*[sq]/i, reason: 'forced or recursive delete', actionType: 'file_delete' },
  { pattern: /\bRemove-Item\b.*-Recurse/i, reason: 'recursive delete', actionType: 'file_delete' },
  { pattern: /\b(mkfs|format)\b/i, reason: 'formats a volume', actionType: 'other' },
  { pattern: /\bdd\s+.*\bof=/i, reason: 'writes raw blocks to a device', actionType: 'other' },
  { pattern: /\btruncate\s+-s\s*0/i, reason: 'empties files', actionType: 'file_delete' },

  // Destructive database statements
  { pattern: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, reason: 'destroys database objects', actionType: 'other' },
  { pattern: /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, reason: 'deletes every row (no WHERE clause)', actionType: 'other' },

  // Remote code execution and credential exposure
  { pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[\s\S]*\|\s*(ba|z|fi|)?sh\b/i, reason: 'pipes downloaded content into a shell', actionType: 'network' },
  { pattern: /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(python|node|pwsh|powershell)\b/i, reason: 'pipes downloaded content into an interpreter', actionType: 'network' },
  { pattern: /\.(env|pem|key|pfx|p12)\b/i, reason: 'touches a credential file', actionType: 'other' },

  // Publishing and deployment
  { pattern: /\bnpm\s+publish\b/i, reason: 'publishes a package publicly', actionType: 'network' },
  { pattern: /\b(kubectl|helm)\s+(delete|uninstall)\b/i, reason: 'tears down deployed infrastructure', actionType: 'network' },
  { pattern: /\bterraform\s+(destroy|apply)\b/i, reason: 'changes real infrastructure', actionType: 'network' },
  { pattern: /\bdocker\s+(system\s+prune|volume\s+rm)\b/i, reason: 'deletes container data', actionType: 'other' },

  // Host control
  { pattern: /\b(shutdown|reboot|halt|Stop-Computer|Restart-Computer)\b/i, reason: 'shuts down or restarts the machine', actionType: 'other' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: 'makes files world-writable', actionType: 'other' },
  { pattern: /\b(taskkill|Stop-Process)\b.*(\/f|-Force)/i, reason: 'force-kills processes', actionType: 'other' },
];

const MEDIUM_RISK_RULES: readonly DangerRule[] = [
  { pattern: /\bgit\s+(commit|merge|cherry-pick|revert|stash|tag)\b/i, reason: 'modifies repository state', actionType: 'git_operation' },
  { pattern: /\bgit\s+push\b/i, reason: 'publishes commits to a remote', actionType: 'git_operation' },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update)\b/i, reason: 'changes installed packages', actionType: 'package_install' },
  { pattern: /\bpip3?\s+(install|uninstall)\b/i, reason: 'changes installed packages', actionType: 'package_install' },
  { pattern: /\bdotnet\s+(add|remove|nuget)\b/i, reason: 'changes project dependencies', actionType: 'package_install' },
  { pattern: /\b(apt|apt-get|yum|dnf|brew|choco|winget|scoop)\s+(install|remove|uninstall|upgrade)\b/i, reason: 'changes system packages', actionType: 'package_install' },
  { pattern: /\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b/i, reason: 'makes a network request', actionType: 'network' },
  { pattern: /\bssh\b|\bscp\b|\brsync\b/i, reason: 'connects to a remote host', actionType: 'network' },
];

/** Maps ACP's tool kind onto the Bridge's action categories from §21. */
function actionTypeForToolKind(request: CopilotPermissionRequest): ActionType {
  switch (request.toolKind) {
    case 'execute':
      return 'execute_command';
    case 'edit':
    case 'move':
      return 'file_edit';
    case 'delete':
      return 'file_delete';
    case 'read':
    case 'search':
      return 'file_read';
    case 'fetch':
      return 'network';
    default:
      return request.command ? 'execute_command' : 'other';
  }
}

function baselineRisk(actionType: ActionType): RiskLevel {
  switch (actionType) {
    case 'file_read':
      return 'low';
    case 'file_delete':
      return 'high';
    case 'file_edit':
    case 'execute_command':
    case 'git_operation':
    case 'package_install':
    case 'network':
    case 'memory_write':
    case 'mcp_tool':
    case 'other':
      return 'medium';
    default:
      return 'medium';
  }
}

/**
 * The text a rule is matched against.
 *
 * Includes the command and the tool title, because Copilot sometimes describes
 * an action in the title while `rawInput` carries only a script path.
 */
function matchableText(request: CopilotPermissionRequest): string {
  return [request.command ?? '', request.title, ...request.paths].join('\n');
}

export function assessRisk(
  request: CopilotPermissionRequest,
  project: ProjectConfig,
): RiskAssessment {
  const haystack = matchableText(request);
  const fallbackType = actionTypeForToolKind(request);

  // A project's own deny list is absolute — it blocks without asking a human.
  for (const pattern of project.security.denyPatterns) {
    if (pattern.test(haystack)) {
      return {
        actionType: fallbackType,
        riskLevel: 'blocked',
        reason: `matches this project's security.deny_patterns rule ${pattern.source}`,
      };
    }
  }

  for (const rule of HIGH_RISK_RULES) {
    if (rule.pattern.test(haystack)) {
      return { actionType: rule.actionType ?? fallbackType, riskLevel: 'high', reason: rule.reason };
    }
  }

  for (const rule of MEDIUM_RISK_RULES) {
    if (rule.pattern.test(haystack)) {
      return { actionType: rule.actionType ?? fallbackType, riskLevel: 'medium', reason: rule.reason };
    }
  }

  return { actionType: fallbackType, riskLevel: baselineRisk(fallbackType), reason: null };
}
