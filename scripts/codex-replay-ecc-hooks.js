#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL_CALL_TYPES = new Set(['function_call', 'local_shell_call', 'custom_tool_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'local_shell_call_output', 'custom_tool_call_output']);

const DEFAULT_HOOK_IDS = new Set([
  'post:bash:dispatcher',
  'post:quality-gate',
  'post:edit:design-quality-check',
  'post:edit:accumulator',
  'post:edit:console-warn',
  'post:governance-capture',
  'post:ecc-context-monitor',
  'post:mcp-health-check',
  'stop:format-typecheck',
  'stop:check-console-log',
  'stop:session-end',
  'stop:evaluate-session',
  'stop:cost-tracker',
  'session:end:marker',
]);

const DUPLICATED_BY_CODEX_BRIDGES = new Set([
  'post:observe:continuous-learning',
  'post:session-activity-tracker',
  'post:ecc-metrics-bridge',
]);

const DEFAULT_SKIP_HOOK_IDS = new Set([
  ...DUPLICATED_BY_CODEX_BRIDGES,
  'stop:desktop-notify',
]);

function usage() {
  return [
    'Usage: codex-replay-ecc-hooks.js <codex-rollout.jsonl> [options]',
    '',
    'Options:',
    '  --claude-transcript <path>   Adapted transcript path for Stop hooks',
    '  --runtime <path>             ECC runtime root; default CODEX_ECC_RUNTIME/.ecc/source',
    '  --state-dir <path>           ECC state dir; default ECC_STATE_DIR/.ecc/state',
    '  --home-dir <path>            Isolated ECC hook home; default .ecc/home',
    '  --session-id <id>            Session id; default transcript/session env',
    '  --profile <name>             ECC_HOOK_PROFILE value; default standard',
    '  --since <iso>                Only replay tool calls at or after this timestamp',
    '  --limit <n>                  Replay at most n tool calls',
    '  --include <id[,id...]>       Include extra hook ids',
    '  --skip <id[,id...]>          Skip hook ids',
    '  --preflight-audit            Also run PreToolUse hooks as post-session diagnostics',
    '  --dry-run                    Report hooks that would run without executing them',
    '  --report <path>              Write JSONL hook execution report',
    '  --help                       Show this help',
  ].join('\n');
}

function splitCsv(value) {
  if (!value) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    claudeTranscript: '',
    dryRun: false,
    homeDir: process.env.CODEX_ECC_HOME || '',
    includeIds: new Set(),
    limit: null,
    preflightAudit: process.env.CODEX_ECC_REPLAY_PREFLIGHT === '1',
    profile: process.env.ECC_HOOK_PROFILE || 'standard',
    report: '',
    runtime: process.env.CODEX_ECC_RUNTIME || process.env.CLAUDE_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || '',
    sessionId: process.env.ECC_SESSION_ID || process.env.CLAUDE_SESSION_ID || '',
    since: '',
    skipIds: new Set(splitCsv(process.env.CODEX_ECC_REPLAY_SKIP || '')),
    stateDir: process.env.ECC_STATE_DIR || '',
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--claude-transcript') {
      options.claudeTranscript = argv[++i] || '';
    } else if (arg === '--runtime') {
      options.runtime = argv[++i] || '';
    } else if (arg === '--state-dir') {
      options.stateDir = argv[++i] || '';
    } else if (arg === '--home-dir') {
      options.homeDir = argv[++i] || '';
    } else if (arg === '--session-id') {
      options.sessionId = argv[++i] || '';
    } else if (arg === '--profile') {
      options.profile = argv[++i] || '';
    } else if (arg === '--since') {
      options.since = argv[++i] || '';
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[++i] || '', 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid --limit value');
      options.limit = parsed;
    } else if (arg === '--include') {
      for (const id of splitCsv(argv[++i] || '')) options.includeIds.add(id);
    } else if (arg === '--skip') {
      for (const id of splitCsv(argv[++i] || '')) options.skipIds.add(id);
    } else if (arg === '--preflight-audit') {
      options.preflightAudit = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--report') {
      options.report = argv[++i] || '';
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  options.input = positionals[0] || '';
  return resolveDefaults(options);
}

function workspaceRoot() {
  return path.resolve(__dirname, '..');
}

function resolveDefaults(options) {
  const root = workspaceRoot();
  return {
    ...options,
    homeDir: path.resolve(options.homeDir || path.join(root, '.ecc', 'home')),
    runtime: path.resolve(options.runtime || path.join(root, '.ecc', 'source')),
    stateDir: path.resolve(options.stateDir || path.join(root, '.ecc', 'state')),
  };
}

function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`[codex-hook-replay] skipped invalid jsonl line ${i + 1}: ${error.message}\n`);
    }
  }
  return entries;
}

function parseToolInput(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return { value };

  try {
    return JSON.parse(value);
  } catch {
    return { input: value };
  }
}

function outputForTool(item) {
  if (Object.prototype.hasOwnProperty.call(item, 'output')) return item.output;
  if (Object.prototype.hasOwnProperty.call(item, 'result')) return item.result;
  if (Object.prototype.hasOwnProperty.call(item, 'content')) return item.content;
  if (Object.prototype.hasOwnProperty.call(item, 'error')) return item.error;
  if (Object.prototype.hasOwnProperty.call(item, 'status')) return { status: item.status };
  return '';
}

function inputForTool(item) {
  if (Object.prototype.hasOwnProperty.call(item, 'arguments')) return parseToolInput(item.arguments);
  if (Object.prototype.hasOwnProperty.call(item, 'input')) return parseToolInput(item.input);
  return {};
}

function entryTime(entry) {
  const date = new Date(entry.timestamp || '');
  return Number.isNaN(date.getTime()) ? null : date;
}

function collectToolCalls(entries, options) {
  const sinceTime = options.since ? new Date(options.since) : null;
  const sinceMs = sinceTime && !Number.isNaN(sinceTime.getTime()) ? sinceTime.getTime() : null;
  let sessionId = options.sessionId || 'unknown';
  let currentCwd = workspaceRoot();
  let sequence = 0;
  const calls = [];
  const byCallId = new Map();
  const pendingOutputs = new Map();

  for (const entry of entries) {
    const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    if (entry.type === 'session_meta') {
      if (payload.id && !options.sessionId) sessionId = String(payload.id);
      if (payload.cwd) currentCwd = String(payload.cwd);
      continue;
    }
    if (entry.type === 'turn_context') {
      if (payload.cwd) currentCwd = String(payload.cwd);
      continue;
    }
    if (entry.type !== 'response_item') continue;

    const item = payload;
    if (!item || typeof item !== 'object') continue;

    if (TOOL_CALL_TYPES.has(item.type)) {
      const timestamp = entry.timestamp || '';
      const time = entryTime(entry);
      const callId = item.call_id || item.id || `${item.type}-${sequence}`;
      sequence += 1;
      const call = {
        cwd: currentCwd,
        id: String(callId),
        input: inputForTool(item),
        output: item.type === 'custom_tool_call' ? outputForTool(item) : undefined,
        outputTimestamp: item.type === 'custom_tool_call' ? timestamp : '',
        sessionId,
        timestamp,
        toolName: item.name || item.tool_name || item.type,
      };

      if (pendingOutputs.has(call.id)) {
        const pending = pendingOutputs.get(call.id);
        call.output = pending.output;
        call.outputTimestamp = pending.timestamp;
        pendingOutputs.delete(call.id);
      }

      if (!sinceMs || !time || time.getTime() >= sinceMs) {
        calls.push(call);
      }
      byCallId.set(call.id, call);
      continue;
    }

    if (TOOL_OUTPUT_TYPES.has(item.type)) {
      const id = item.call_id || item.id;
      if (!id) continue;
      const key = String(id);
      const output = outputForTool(item);
      const call = byCallId.get(key);
      if (call) {
        call.output = output;
        call.outputTimestamp = entry.timestamp || '';
      } else {
        pendingOutputs.set(key, { output, timestamp: entry.timestamp || '' });
      }
    }
  }

  return options.limit === null ? calls : calls.slice(0, options.limit);
}

function truncateString(value, maxLength = 20000) {
  const text = String(value || '');
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}\n...[codex-hook-replay truncated ${text.length - maxLength} chars]`;
}

function sanitizeValue(value, depth = 0) {
  if (depth >= 5) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value).slice(0, 80)) {
      output[key] = sanitizeValue(nested, depth + 1);
    }
    return output;
  }
  return truncateString(String(value));
}

function outputToHookObject(output) {
  if (output === undefined || output === null) return {};
  if (typeof output === 'string') return { output: truncateString(output) };
  if (typeof output === 'object') {
    if (Object.prototype.hasOwnProperty.call(output, 'output')) return sanitizeValue(output);
    if (Object.prototype.hasOwnProperty.call(output, 'error')) return { ...sanitizeValue(output), output: String(output.error || '') };
    return sanitizeValue(output);
  }
  return { output: truncateString(String(output)) };
}

function extractPatchFilePaths(patch) {
  if (typeof patch !== 'string') return [];
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match && !paths.includes(match[1])) paths.push(match[1]);
  }
  return paths;
}

function normalizedToolCalls(call) {
  const rawName = String(call.toolName || '');
  const name = rawName.includes('.') ? rawName.split('.').pop() : rawName;

  if (name === 'exec_command' || rawName === 'local_shell_call') {
    return [{
      ...call,
      hookToolName: 'Bash',
      hookToolInput: sanitizeValue({
        command: call.input.cmd || call.input.command || '',
        cwd: call.input.workdir || call.input.cwd || call.cwd,
      }),
    }];
  }

  if (name === 'apply_patch') {
    const patch = call.input.input || call.input.patch || call.input.arguments || '';
    const filePaths = extractPatchFilePaths(patch);
    const targets = filePaths.length > 0 ? filePaths : [''];
    return targets.map((filePath) => ({
      ...call,
      hookToolName: 'Edit',
      hookToolInput: sanitizeValue({
        file_path: filePath,
        file_paths: filePaths,
        patch: truncateString(patch, 12000),
      }),
    }));
  }

  return [{
    ...call,
    hookToolName: rawName || 'unknown',
    hookToolInput: sanitizeValue(call.input && typeof call.input === 'object' ? call.input : {}),
  }];
}

function isFailedTool(call) {
  const output = call.output;
  if (!output) return false;
  if (typeof output === 'object') {
    const status = output.status || output.exit_code || output.exitCode;
    if (typeof status === 'number' && status !== 0) return true;
    if (typeof status === 'string' && !['0', 'success', 'completed'].includes(status.toLowerCase())) return true;
    if (output.error) return true;
  }
  return false;
}

function matcherMatches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  return matcher.split('|').map((part) => part.trim()).includes(toolName);
}

function loadHookGraph(runtime) {
  const hooksPath = path.join(runtime, 'hooks', 'hooks.json');
  return JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks || {};
}

function allowedHookIds(options) {
  const allow = new Set(DEFAULT_HOOK_IDS);
  for (const id of options.includeIds) allow.add(id);
  return allow;
}

function shouldRunEntry(entry, options) {
  const id = entry.id || '';
  if (!id) return false;
  if (DEFAULT_SKIP_HOOK_IDS.has(id) && !options.includeIds.has(id)) return false;
  if (options.skipIds.has(id)) return false;
  return allowedHookIds(options).has(id);
}

function eventEntries(hooks, event, toolName, options) {
  return (hooks[event] || [])
    .filter((entry) => shouldRunEntry(entry, options))
    .filter((entry) => matcherMatches(entry.matcher, toolName));
}

function hookTimeoutMs(hook) {
  const timeoutSeconds = Number.parseInt(String(hook.timeout || ''), 10);
  return Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 30000;
}

function resolveCommand(command, runtime) {
  const inlineSpawn = command.match(/\[script,'([^']+)','([^']+)'(?:,'([^']+)')?\]/);
  if (inlineSpawn) {
    return {
      command: process.execPath,
      args: [path.join(runtime, inlineSpawn[2])],
    };
  }

  const runWithFlags = command.match(/run-with-flags\.js\s+([^\s"']+)\s+([^\s"']+)(?:\s+([^\s"']+))?/);
  if (runWithFlags) {
    return {
      command: process.execPath,
      args: [path.join(runtime, runWithFlags[2])],
    };
  }

  const directHook = command.match(/node\s+scripts\/hooks\/([A-Za-z0-9_.-]+\.js)(?:\s|$)/);
  if (directHook) {
    return {
      command: process.execPath,
      args: [path.join(runtime, 'scripts', 'hooks', directHook[1])],
    };
  }

  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { command: 'bash', args: ['-lc', command] };
}

function runHookCommand(command, payload, options, timeoutMs) {
  const tmpDir = path.join(options.stateDir, 'hook-replay', 'stdin');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');

  const fd = fs.openSync(tmpPath, 'r');
  const resolved = resolveCommand(command, options.runtime);
  try {
    return spawnSync(resolved.command, resolved.args, {
      cwd: payload.cwd || workspaceRoot(),
      env: {
        ...process.env,
        HOME: options.homeDir,
        XDG_CONFIG_HOME: path.join(options.homeDir, '.config'),
        XDG_DATA_HOME: path.join(options.homeDir, '.local', 'share'),
        CODEX_ECC_HOME: options.homeDir,
        CODEX_ECC_RUNTIME: options.runtime,
        CLAUDE_PLUGIN_ROOT: options.runtime,
        ECC_PLUGIN_ROOT: options.runtime,
        ECC_STATE_DIR: options.stateDir,
        CLV2_HOMUNCULUS_DIR: process.env.CLV2_HOMUNCULUS_DIR || path.join(options.stateDir, 'ecc-homunculus'),
        ECC_HOOK_PROFILE: options.profile || 'standard',
        ECC_SESSION_ID: options.sessionId,
        CLAUDE_SESSION_ID: options.sessionId,
        CLAUDE_TRANSCRIPT_PATH: payload.transcript_path || '',
      },
      encoding: 'utf8',
      stdio: [fd, 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

function resultSummary(result) {
  if (!result) return {};
  return {
    status: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : '',
    stdout: truncateString(result.stdout || '', 4000),
    stderr: truncateString(result.stderr || '', 4000),
  };
}

function appendReport(options, row) {
  if (!options.report) return;
  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.appendFileSync(options.report, `${JSON.stringify(row)}\n`);
}

function runHookEntry(event, entry, payload, options, stats) {
  for (const hook of entry.hooks || []) {
    if (hook.type !== 'command' || !hook.command) continue;
    const row = {
      event,
      hook_id: entry.id,
      matcher: entry.matcher || '*',
      tool_name: payload.tool_name || '',
      timestamp: new Date().toISOString(),
    };
    if (options.dryRun) {
      stats.planned += 1;
      appendReport(options, { ...row, dry_run: true });
      continue;
    }

    const result = runHookCommand(hook.command, payload, options, hookTimeoutMs(hook));
    stats.executed += 1;
    const failed = Boolean(result.error || result.signal || result.status === null || (Number.isInteger(result.status) && result.status !== 0));
    if (failed) stats.failed += 1;
    appendReport(options, { ...row, ...resultSummary(result), failed });
  }
}

function toolPayload(call, eventName, options) {
  return {
    hook_event_name: eventName,
    session_id: options.sessionId || call.sessionId,
    transcript_path: options.claudeTranscript || options.input,
    cwd: call.cwd || workspaceRoot(),
    tool_name: call.hookToolName,
    tool_input: call.hookToolInput,
    tool_output: outputToHookObject(call.output),
  };
}

function lifecyclePayload(eventName, options) {
  return {
    hook_event_name: eventName,
    session_id: options.sessionId,
    transcript_path: options.claudeTranscript || options.input,
    cwd: workspaceRoot(),
  };
}

function replayToolHooks(hooks, calls, options, stats) {
  for (const rawCall of calls) {
    for (const call of normalizedToolCalls(rawCall)) {
      if (options.preflightAudit) {
        const payload = toolPayload(call, 'PreToolUse', options);
        for (const entry of eventEntries(hooks, 'PreToolUse', call.hookToolName, options)) {
          runHookEntry('PreToolUse', entry, payload, options, stats);
        }
      }

      const postPayload = toolPayload(call, 'PostToolUse', options);
      for (const entry of eventEntries(hooks, 'PostToolUse', call.hookToolName, options)) {
        runHookEntry('PostToolUse', entry, postPayload, options, stats);
      }

      if (isFailedTool(call)) {
        const failurePayload = toolPayload(call, 'PostToolUseFailure', options);
        for (const entry of eventEntries(hooks, 'PostToolUseFailure', call.hookToolName, options)) {
          runHookEntry('PostToolUseFailure', entry, failurePayload, options, stats);
        }
      }
    }
  }
}

function replayLifecycleHooks(hooks, options, stats) {
  const stopPayload = lifecyclePayload('Stop', options);
  for (const entry of eventEntries(hooks, 'Stop', '*', options)) {
    runHookEntry('Stop', entry, stopPayload, options, stats);
  }

  const endPayload = lifecyclePayload('SessionEnd', options);
  for (const entry of eventEntries(hooks, 'SessionEnd', '*', options)) {
    runHookEntry('SessionEnd', entry, endPayload, options, stats);
  }
}

function defaultReportPath(options) {
  const sessionId = (options.sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(options.stateDir, 'hook-replay', `${sessionId || 'unknown'}.jsonl`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.input) {
    process.stderr.write(`${usage()}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(options.runtime, 'hooks', 'hooks.json'))) {
    process.stderr.write(`[codex-hook-replay] missing ECC hook graph under ${options.runtime}\n`);
    process.exit(2);
  }

  if (!options.report && !options.dryRun) {
    options.report = defaultReportPath(options);
  }

  const hooks = loadHookGraph(options.runtime);
  const calls = collectToolCalls(readJsonl(path.resolve(options.input)), options);
  const stats = { calls: calls.length, planned: 0, executed: 0, failed: 0 };

  replayToolHooks(hooks, calls, options, stats);
  replayLifecycleHooks(hooks, options, stats);

  if (options.dryRun) {
    process.stderr.write(`[codex-hook-replay] parsed ${stats.calls} tool calls; would run ${stats.planned} hooks\n`);
  } else {
    process.stderr.write(`[codex-hook-replay] replayed ${stats.executed} hooks for ${stats.calls} tool calls, ${stats.failed} failures${options.report ? `; report ${options.report}` : ''}\n`);
  }
}

main();
