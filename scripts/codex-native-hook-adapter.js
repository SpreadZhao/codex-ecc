#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAX_STDIN = 1024 * 1024;

function parseArgs(argv) {
  const parsed = {
    event: '',
    id: '',
    tools: [],
    target: '',
    runWithFlags: null,
    profiles: '',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--event') {
      parsed.event = String(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--id') {
      parsed.id = String(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--tools') {
      parsed.tools = String(argv[index + 1] || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
    } else if (arg === '--target') {
      parsed.target = String(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--run-with-flags') {
      parsed.runWithFlags = String(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--profiles') {
      parsed.profiles = String(argv[index + 1] || '');
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.event) throw new Error('--event is required');
  if (!parsed.id) throw new Error('--id is required');
  if (!parsed.target && !parsed.runWithFlags) {
    throw new Error('either --target or --run-with-flags is required');
  }
  return parsed;
}

function printHelp() {
  console.log([
    'Usage: scripts/codex-native-hook-adapter.js --event <event> --id <hook-id> [options]',
    '',
    'Bridge native Codex hook stdin into the Claude-shaped payload expected by ECC hooks.',
    '',
    'Options:',
    '  --tools <csv>                 Only run when the inferred tool matches one entry',
    '  --target <script>             Run an ECC hook script directly',
    '  --run-with-flags <script>     Run scripts/hooks/run-with-flags.js for the target',
    '  --profiles <csv>              Profiles passed to run-with-flags.js',
  ].join('\n'));
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let truncated = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.slice(0, remaining);
        if (chunk.length > remaining) truncated = true;
      } else {
        truncated = true;
      }
    });
    process.stdin.on('end', () => resolve({ raw, truncated }));
    process.stdin.on('error', () => resolve({ raw, truncated: true }));
  });
}

function parseJson(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) return value.join(' ');
  }
  return '';
}

function nested(input, pathParts) {
  let current = input;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function inferToolName(input) {
  const direct = firstString(
    input.tool_name,
    input.toolName,
    input.name,
    input.namespace,
    nested(input, ['tool', 'name']),
    nested(input, ['tool', 'type']),
    nested(input, ['action', 'type']),
    nested(input, ['payload', 'tool_name']),
    nested(input, ['payload', 'toolName']),
    nested(input, ['payload', 'name']),
    nested(input, ['arguments', 'tool_name']),
  );
  if (direct) return direct;

  if (
    input.command ||
    input.cmd ||
    input.parsed_cmd ||
    nested(input, ['payload', 'command']) ||
    nested(input, ['arguments', 'command']) ||
    nested(input, ['action', 'command'])
  ) {
    return 'Bash';
  }

  if (
    input.patch ||
    input.changes ||
    input.files ||
    input.file_path ||
    input.path ||
    nested(input, ['payload', 'changes'])
  ) {
    return 'Edit';
  }

  return '';
}

function canonicalToolName(name) {
  const value = String(name || '').toLowerCase();
  if (['bash', 'shell', 'exec_command', 'unified_exec', 'local_shell_call', 'user_shell'].includes(value)) {
    return 'Bash';
  }
  if (['write', 'edit', 'multiedit', 'apply_patch', 'file_change', 'custom_tool_call'].includes(value)) {
    return value === 'write' ? 'Write' : 'Edit';
  }
  if (['mcp', 'mcp_tool_call', 'mcpserver'].includes(value)) return 'MCP';
  return name || '';
}

function matchesTool(filters, toolName) {
  if (!filters || filters.length === 0) return true;
  const canonical = canonicalToolName(toolName).toLowerCase();
  const raw = String(toolName || '').toLowerCase();
  return filters.some((filter) => {
    const normalized = filter.toLowerCase();
    return normalized === '*' || normalized === raw || normalized === canonical;
  });
}

function extractCommand(input) {
  return firstString(
    input.command,
    input.cmd,
    input.parsed_cmd,
    nested(input, ['tool_input', 'command']),
    nested(input, ['input', 'command']),
    nested(input, ['arguments', 'command']),
    nested(input, ['action', 'command']),
    nested(input, ['payload', 'command']),
  );
}

function extractFilePath(input) {
  const change = Array.isArray(input.changes) ? input.changes[0] : undefined;
  const payloadChange = Array.isArray(nested(input, ['payload', 'changes']))
    ? nested(input, ['payload', 'changes'])[0]
    : undefined;
  const file = Array.isArray(input.files) ? input.files[0] : undefined;

  return firstString(
    input.file_path,
    input.path,
    input.absolute_file_path,
    nested(input, ['tool_input', 'file_path']),
    nested(input, ['tool_input', 'path']),
    nested(input, ['input', 'file_path']),
    nested(input, ['arguments', 'file_path']),
    nested(input, ['arguments', 'path']),
    change && (change.absolute_file_path || change.path || change.file_path),
    payloadChange && (payloadChange.absolute_file_path || payloadChange.path || payloadChange.file_path),
    typeof file === 'string' ? file : file && (file.path || file.file_path),
  );
}

function normalizePayload(input, raw, event, truncated) {
  const toolName = canonicalToolName(inferToolName(input));
  const command = extractCommand(input);
  const filePath = extractFilePath(input);
  const cwd = firstString(input.cwd, input.working_directory, nested(input, ['payload', 'cwd'])) || process.cwd();

  const toolInput = input.tool_input && typeof input.tool_input === 'object'
    ? { ...input.tool_input }
    : {};
  if (command && !toolInput.command) toolInput.command = command;
  if (filePath && !toolInput.file_path) toolInput.file_path = filePath;
  if (Object.keys(toolInput).length === 0 && input.arguments && typeof input.arguments === 'object') {
    Object.assign(toolInput, input.arguments);
  }

  const toolResponse = input.tool_response && typeof input.tool_response === 'object'
    ? { ...input.tool_response }
    : {};
  for (const key of ['stdout', 'stderr', 'exit_code', 'success', 'status']) {
    if (input[key] !== undefined && toolResponse[key] === undefined) toolResponse[key] = input[key];
  }
  if (input.output !== undefined && toolResponse.output === undefined) toolResponse.output = input.output;
  if (input.result !== undefined && toolResponse.result === undefined) toolResponse.result = input.result;

  return {
    ...input,
    hook_event_name: input.hook_event_name || event,
    session_id: firstString(input.session_id, input.thread_id, input.threadId, process.env.ECC_SESSION_ID, process.env.CODEX_THREAD_ID),
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    codex_hook_input: input,
    codex_hook_raw_input: raw,
    codex_hook_input_truncated: truncated,
  };
}

function resolveRuntime() {
  const candidates = [
    process.env.CODEX_ECC_RUNTIME,
    process.env.ECC_PLUGIN_ROOT,
    process.env.CLAUDE_PLUGIN_ROOT,
    path.join(ROOT, '.ecc/source'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'scripts/hooks'))) {
      return path.resolve(candidate);
    }
  }
  return '';
}

function hookEnv(runtime) {
  const home = path.join(ROOT, '.ecc/home');
  const state = path.join(ROOT, '.ecc/state');
  const npmPrefix = process.env.NPM_CONFIG_PREFIX || path.join(ROOT, '.npm-global');
  const npmCache = process.env.NPM_CONFIG_CACHE || path.join(ROOT, '.npm-cache');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(npmPrefix, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });

  return {
    ...process.env,
    HOME: home,
    CODEX_ECC_WORKSPACE: ROOT,
    CODEX_ECC_RUNTIME: runtime,
    CLAUDE_PLUGIN_ROOT: runtime,
    ECC_PLUGIN_ROOT: runtime,
    AGENTS_HOME: process.env.AGENTS_HOME || path.join(ROOT, '.agents'),
    CLV2_HOMUNCULUS_DIR: process.env.CLV2_HOMUNCULUS_DIR || path.join(state, 'ecc-homunculus'),
    ECC_STATE_DIR: process.env.ECC_STATE_DIR || state,
    ECC_GLOBAL_HOOKS_DIR: process.env.ECC_GLOBAL_HOOKS_DIR || path.join(ROOT, '.codex/git-hooks'),
    NPM_CONFIG_PREFIX: npmPrefix,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache,
  };
}

function resolveHookScript(runtime, relScriptPath) {
  const resolvedRoot = path.resolve(runtime);
  const scriptPath = path.resolve(runtime, relScriptPath || '');

  if (!scriptPath.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`hook script escapes ECC runtime: ${relScriptPath}`);
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`hook script not found: ${relScriptPath}`);
  }

  return scriptPath;
}

function normalizeHookOutput(rawInput, output) {
  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    return {
      stdout: String(output),
      stderr: '',
      status: 0,
      signal: null,
      error: null,
    };
  }

  if (output && typeof output === 'object') {
    let stdout = '';
    if (Object.prototype.hasOwnProperty.call(output, 'additionalContext')) {
      const { buildPreToolUseAdditionalContext } = require(
        path.join(resolveRuntime(), 'scripts/hooks/pretooluse-visible-output.js'),
      );
      stdout = buildPreToolUseAdditionalContext(output.additionalContext);
    } else if (Object.prototype.hasOwnProperty.call(output, 'stdout')) {
      stdout = String(output.stdout ?? '');
    } else if (Object.prototype.hasOwnProperty.call(output, 'output')) {
      stdout = String(output.output ?? '');
    } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
      stdout = rawInput;
    }

    return {
      stdout,
      stderr: typeof output.stderr === 'string' ? output.stderr : '',
      status: Number.isInteger(output.exitCode) ? output.exitCode : 0,
      signal: null,
      error: null,
    };
  }

  return {
    stdout: rawInput,
    stderr: '',
    status: 0,
    signal: null,
    error: null,
  };
}

function loadRunExport(scriptPath) {
  const source = fs.readFileSync(scriptPath, 'utf8');
  if (!/\bmodule\.exports\b/.test(source) || !/\brun\b/.test(source)) {
    return null;
  }

  const hookModule = require(scriptPath);
  return hookModule && typeof hookModule.run === 'function' ? hookModule.run : null;
}

function withHookProcessContext(env, cwd, callback) {
  const touchedKeys = Object.keys(env);
  const previousEnv = new Map();
  for (const key of touchedKeys) {
    previousEnv.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = env[key];
  }

  const previousCwd = process.cwd();
  let changedCwd = false;
  try {
    if (cwd && fs.existsSync(cwd)) {
      process.chdir(cwd);
      changedCwd = true;
    }
  } catch {
    // Hooks should not fail because Codex supplied a stale cwd.
  }

  try {
    return callback();
  } finally {
    if (changedCwd) {
      try {
        process.chdir(previousCwd);
      } catch {
        // Leave the process alive; the adapter is one-shot.
      }
    }

    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function runBashDispatcher(parsed, rawInput, runtime, env, cwd) {
  const dispatcherPath = path.join(runtime, 'scripts/hooks/bash-hook-dispatcher.js');
  const dispatcher = require(dispatcherPath);
  const isPost = parsed.target && parsed.target.endsWith('post-bash-dispatcher.js');
  const run = isPost ? dispatcher.runPostBash : dispatcher.runPreBash;

  if (typeof run !== 'function') {
    throw new Error('ECC bash dispatcher does not export the expected runner');
  }

  return normalizeHookOutput(rawInput, withHookProcessContext(env, cwd, () => run(rawInput)));
}

function runExportedHook(parsed, rawInput, scriptPath, runtime, env, cwd) {
  const run = loadRunExport(scriptPath);
  if (!run) return null;

  return normalizeHookOutput(
    rawInput,
    withHookProcessContext(env, cwd, () => run(rawInput, {
      hookId: parsed.id,
      pluginRoot: runtime,
      scriptPath,
      truncated: false,
      maxStdin: MAX_STDIN,
    })),
  );
}

function runLegacySpawn(parsed, rawInput, runtime, env, cwd, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: cwd || ROOT,
    env,
    input: rawInput,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 1024 * 1024 * 8,
  });

  if (result.error) {
    return {
      stdout: rawInput,
      stderr: `[codex-native-hook-adapter] skipped legacy hook ${parsed.id}: ${result.error.message}\n`,
      status: 0,
      signal: result.signal || null,
      error: null,
    };
  }

  return result;
}

function runFlaggedHook(parsed, rawInput, runtime, env, cwd) {
  const { isHookEnabled } = require(path.join(runtime, 'scripts/lib/hook-flags.js'));
  if (!isHookEnabled(parsed.id, { profiles: parsed.profiles || 'standard,strict' })) {
    return {
      stdout: rawInput,
      stderr: '',
      status: 0,
      signal: null,
      error: null,
    };
  }

  const scriptPath = resolveHookScript(runtime, parsed.runWithFlags);
  const exported = runExportedHook(parsed, rawInput, scriptPath, runtime, env, cwd);
  if (exported) return exported;

  if (parsed.runWithFlags) {
    const runner = path.join(runtime, 'scripts/hooks/run-with-flags.js');
    return runLegacySpawn(parsed, rawInput, runtime, env, cwd, [
      runner,
      parsed.id,
      parsed.runWithFlags,
      parsed.profiles || 'standard,strict',
    ]);
  }
}

function runHook(parsed, payload, runtime) {
  const env = hookEnv(runtime);
  const input = JSON.stringify(payload);
  const cwd = payload.cwd || ROOT;

  if (parsed.runWithFlags) {
    return runFlaggedHook(parsed, input, runtime, env, cwd);
  }

  if (parsed.target && /(?:^|\/)(?:pre|post)-bash-dispatcher\.js$/.test(parsed.target)) {
    return runBashDispatcher(parsed, input, runtime, env, cwd);
  }

  const scriptPath = resolveHookScript(runtime, parsed.target);
  const exported = runExportedHook(parsed, input, scriptPath, runtime, env, cwd);
  if (exported) return exported;

  return runLegacySpawn(parsed, input, runtime, env, cwd, [scriptPath]);
}

function truncate(text, limit = 4000) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated]`;
}

function isJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return null;
  }
}

function recordEvent(entry) {
  try {
    const dir = path.join(ROOT, '.ecc/state/native-hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort diagnostics only.
  }
}

function emitResult(parsed, payload, rawInput, result) {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const status = Number.isInteger(result.status) ? result.status : result.error ? 1 : 0;
  const reason = truncate(stderr || stdout || (result.error && result.error.message) || `ECC hook ${parsed.id} blocked`);

  recordEvent({
    ts: new Date().toISOString(),
    id: parsed.id,
    event: parsed.event,
    tool: payload.tool_name || '',
    status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
  });

  if (status !== 0 || result.error || result.signal) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    return;
  }

  const trimmedStdout = stdout.trim();
  const rawTrimmed = rawInput.trim();
  const normalizedTrimmed = JSON.stringify(payload);
  const parsedStdout = trimmedStdout ? isJsonObject(trimmedStdout) : null;

  if (stderr.trim()) process.stderr.write(stderr);

  if (
    parsedStdout &&
    (parsedStdout.hookSpecificOutput || parsedStdout.decision || parsedStdout.systemMessage)
  ) {
    process.stdout.write(`${trimmedStdout}\n`);
    return;
  }

  if (trimmedStdout && trimmedStdout !== rawTrimmed && trimmedStdout !== normalizedTrimmed) {
    process.stderr.write(`${truncate(trimmedStdout)}\n`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const { raw, truncated } = await readStdin();
  const input = parseJson(raw);
  const payload = normalizePayload(input, raw, parsed.event, truncated);

  if (!matchesTool(parsed.tools, payload.tool_name)) {
    return;
  }

  const runtime = resolveRuntime();
  if (!runtime) {
    console.error('[codex-native-hook-adapter] ECC runtime not found; skipping hook');
    return;
  }

  const result = runHook(parsed, payload, runtime);
  emitResult(parsed, payload, raw, result);
}

main().catch((error) => {
  console.error(`[codex-native-hook-adapter] ${error.message}`);
  process.exit(0);
});
