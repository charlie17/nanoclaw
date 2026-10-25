/**
 * Built-in tool policy for agent containers.
 *
 * `allowedTools` only auto-approves; it does not restrict the surface. It
 * still matters because the SDK drops Grep/Glob (the qmd gate's targets) and
 * the Task* tracking tools from the default surface unless they are named
 * there. `Task` is the subagent tool (the model sees it as `Agent`);
 * teammates spawn through it, there is no TeamCreate.
 */
export const ALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'SendMessage',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__qmd__*',
  'mcp__readwise__*',
];

const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

/**
 * SDK builtins removed from every container (`disallowedTools`) and blocked
 * again at call time by the PreToolUse hook: they bypass nanoclaw's
 * scheduler/IPC, hang headless, or (RemoteTrigger, DesignSync) reach
 * claude.ai with the proxy-injected account credential.
 */
export const SDK_DISALLOWED_TOOLS: readonly string[] = [
  'AskUserQuestion', // we use mcp__nanoclaw__ask_user_question
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate', // we use mcp__nanoclaw__schedule_task
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'DesignSync',
  'ReportFindings',
];

/**
 * NANOCLAW_STRIP_WEB_TOOLS=1 (set for main) drops the web tools from the
 * auto-approve list only; under bypassPermissions they stay available.
 */
export function allowedToolsFor(env: NodeJS.ProcessEnv): string[] {
  return env.NANOCLAW_STRIP_WEB_TOOLS === '1'
    ? ALLOWED_TOOLS.filter((t) => !WEB_TOOLS.has(t))
    : [...ALLOWED_TOOLS];
}
