#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const BASH_TOOLS = 'Bash,Shell,exec_command,unified_exec,local_shell_call,user_shell';
const EDIT_TOOLS = 'Write,Edit,MultiEdit,apply_patch,file_change,custom_tool_call';

const HOOKS = {
  SessionStart: [
    direct('session:start', 'SessionStart', 'scripts/hooks/session-start.js', '', 30, 'Load ECC session context'),
  ],
  PreToolUse: [
    direct('pre:bash:dispatcher', 'PreToolUse', 'scripts/hooks/pre-bash-dispatcher.js', BASH_TOOLS, 30, 'ECC Bash preflight dispatcher'),
    flagged('pre:write:doc-file-warning', 'PreToolUse', 'scripts/hooks/doc-file-warning.js', EDIT_TOOLS, 10, 'Warn on ad-hoc documentation writes'),
    flagged('pre:edit-write:suggest-compact', 'PreToolUse', 'scripts/hooks/suggest-compact.js', EDIT_TOOLS, 10, 'Suggest compaction at logical intervals'),
    flagged('pre:config-protection', 'PreToolUse', 'scripts/hooks/config-protection.js', EDIT_TOOLS, 10, 'Block weakening formatter/linter config'),
    flagged('pre:edit-write:gateguard-fact-force', 'PreToolUse', 'scripts/hooks/gateguard-fact-force.js', EDIT_TOOLS, 10, 'Require investigation before edits'),
    flagged('pre:mcp-health-check', 'PreToolUse', 'scripts/hooks/mcp-health-check.js', 'MCP,mcp_tool_call', 10, 'Check MCP health before MCP calls'),
  ],
  PreCompact: [
    flagged('pre:compact', 'PreCompact', 'scripts/hooks/pre-compact.js', '', 30, 'Save ECC state before compaction'),
  ],
  PostToolUse: [
    direct('post:bash:dispatcher', 'PostToolUse', 'scripts/hooks/post-bash-dispatcher.js', BASH_TOOLS, 30, 'ECC Bash postflight dispatcher'),
    flagged('post:quality-gate', 'PostToolUse', 'scripts/hooks/quality-gate.js', EDIT_TOOLS, 60, 'Run quality gate checks after edits'),
    flagged('post:edit:design-quality-check', 'PostToolUse', 'scripts/hooks/design-quality-check.js', EDIT_TOOLS, 20, 'Warn about generic frontend UI drift'),
    flagged('post:edit:accumulate', 'PostToolUse', 'scripts/hooks/post-edit-accumulator.js', EDIT_TOOLS, 10, 'Record edited files for stop-time checks'),
    flagged('post:edit:console-warn', 'PostToolUse', 'scripts/hooks/post-edit-console-warn.js', 'Edit,apply_patch,file_change,custom_tool_call', 10, 'Warn about console logging after edits'),
    flagged('post:session-activity-tracker', 'PostToolUse', 'scripts/hooks/session-activity-tracker.js', '', 10, 'Track tool activity for ECC status'),
    flagged('post:ecc-context-monitor', 'PostToolUse', 'scripts/hooks/ecc-context-monitor.js', '', 10, 'Maintain ECC context monitor state'),
  ],
  Stop: [
    flagged('stop:format-typecheck', 'Stop', 'scripts/hooks/stop-format-typecheck.js', '', 300, 'Batch format/typecheck at turn end'),
    flagged('stop:check-console-log', 'Stop', 'scripts/hooks/check-console-log.js', '', 30, 'Check for leftover console logging'),
    flagged('stop:session-end', 'Stop', 'scripts/hooks/session-end.js', '', 30, 'Write ECC session summary'),
    flagged('stop:evaluate-session', 'Stop', 'scripts/hooks/evaluate-session.js', '', 30, 'Evaluate session outcome'),
    flagged('stop:cost-tracker', 'Stop', 'scripts/hooks/cost-tracker.js', '', 30, 'Update ECC cost tracking'),
  ],
};

function direct(id, event, target, tools, timeoutSec, statusMessage) {
  return hook(id, event, tools, timeoutSec, statusMessage, ['--target', target]);
}

function flagged(id, event, target, tools, timeoutSec, statusMessage) {
  return hook(id, event, tools, timeoutSec, statusMessage, ['--run-with-flags', target, '--profiles', 'standard,strict']);
}

function hook(id, event, tools, timeoutSec, statusMessage, extraArgs) {
  const args = [
    'node',
    'scripts/codex-native-hook-adapter.js',
    '--event',
    event,
    '--id',
    id,
  ];
  if (tools) args.push('--tools', tools);
  args.push(...extraArgs);
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: args.join(' '),
        async: false,
        timeoutSec,
        statusMessage,
      },
    ],
    description: statusMessage,
    id,
  };
}

function main() {
  const outPath = path.join(ROOT, '.codex/hooks.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    `${JSON.stringify({
      $schema: 'https://developers.openai.com/codex/hooks.schema.json',
      hooks: HOOKS,
    }, null, 2)}\n`,
  );
  console.log(`generated: ${path.relative(ROOT, outPath)}`);
}

main();
