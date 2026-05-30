#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL_CALL_TYPES = new Set(['function_call', 'local_shell_call', 'custom_tool_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'local_shell_call_output', 'custom_tool_call_output']);
const MAX_HOOK_VALUE_CHARS = 20000;

function usage() {
  return [
    'Usage: codex-observe-session.js <codex-rollout.jsonl> [options]',
    '',
    'Options:',
    '  --force                 Observe even if this transcript was already marked observed',
    '  --dry-run               Parse and report without invoking ECC observe hooks',
    '  --limit <n>             Observe at most n tool calls; does not mark transcript observed',
    '  --mode <direct|hook>    direct writes observations.jsonl; hook calls ECC observe.sh',
    '  --plugin-root <path>    ECC runtime root; default CODEX_ECC_RUNTIME/.ecc/source',
    '  --state-dir <path>      ECC state dir; default ECC_STATE_DIR/.ecc/state',
    '  --homunculus-dir <path> Continuous-learning state dir; default <state-dir>/ecc-homunculus',
    '  --help                  Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: process.env.CODEX_ECC_OBSERVE_FORCE === '1',
    homunculusDir: process.env.CLV2_HOMUNCULUS_DIR || '',
    limit: null,
    mode: process.env.CODEX_ECC_OBSERVE_MODE || 'direct',
    pluginRoot: process.env.CODEX_ECC_RUNTIME || process.env.CLAUDE_PLUGIN_ROOT || process.env.ECC_PLUGIN_ROOT || '',
    stateDir: process.env.ECC_STATE_DIR || '',
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--limit') {
      const value = argv[++i];
      const parsed = Number.parseInt(value || '', 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --limit value: ${value}`);
      }
      options.limit = parsed;
    } else if (arg === '--mode') {
      options.mode = argv[++i] || '';
    } else if (arg === '--plugin-root') {
      options.pluginRoot = argv[++i] || '';
    } else if (arg === '--state-dir') {
      options.stateDir = argv[++i] || '';
    } else if (arg === '--homunculus-dir') {
      options.homunculusDir = argv[++i] || '';
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  options.input = positionals[0] || '';
  if (options.mode !== 'direct' && options.mode !== 'hook') {
    throw new Error(`Invalid --mode value: ${options.mode}`);
  }
  return options;
}

function workspaceRoot() {
  return path.resolve(__dirname, '..');
}

function resolveDefaults(options) {
  const root = workspaceRoot();
  return {
    ...options,
    pluginRoot: path.resolve(options.pluginRoot || path.join(root, '.ecc', 'source')),
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
      process.stderr.write(`[codex-observe] skipped invalid jsonl line ${i + 1}: ${error.message}\n`);
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
    return { arguments: value };
  }
}

function compactObject(source, excludedKeys) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!excludedKeys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function inputForTool(item) {
  if (Object.prototype.hasOwnProperty.call(item, 'arguments')) {
    return parseToolInput(item.arguments);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'input')) {
    return parseToolInput(item.input);
  }

  return compactObject(item, new Set([
    'type',
    'name',
    'tool_name',
    'call_id',
    'id',
    'status',
  ]));
}

function outputForTool(item) {
  if (Object.prototype.hasOwnProperty.call(item, 'output')) return item.output;
  if (Object.prototype.hasOwnProperty.call(item, 'result')) return item.result;
  if (Object.prototype.hasOwnProperty.call(item, 'content')) return item.content;
  if (Object.prototype.hasOwnProperty.call(item, 'error')) return item.error;
  return '';
}

function hookSafeValue(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (!serialized || serialized.length <= MAX_HOOK_VALUE_CHARS) {
    return value;
  }
  return `${serialized.slice(0, MAX_HOOK_VALUE_CHARS)}\n...[codex-observe truncated ${serialized.length - MAX_HOOK_VALUE_CHARS} chars]`;
}

function collectToolCalls(entries, fallbackCwd) {
  let sessionId = process.env.ECC_SESSION_ID || process.env.CLAUDE_SESSION_ID || 'unknown';
  let currentCwd = fallbackCwd || process.cwd();
  let sequence = 0;

  const calls = [];
  const byCallId = new Map();
  const pendingOutputs = new Map();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    if (entry.type === 'session_meta') {
      if (payload.id) sessionId = String(payload.id);
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
      const callId = item.call_id || item.id || `${item.type}-${sequence}`;
      sequence += 1;
      const call = {
        cwd: currentCwd,
        id: String(callId),
        input: inputForTool(item),
        output: item.type === 'custom_tool_call' && item.status ? { status: item.status } : undefined,
        outputTimestamp: '',
        sessionId,
        timestamp: entry.timestamp || '',
        toolName: item.name || item.tool_name || item.type,
      };

      if (pendingOutputs.has(call.id)) {
        const pending = pendingOutputs.get(call.id);
        call.output = pending.output;
        call.outputTimestamp = pending.timestamp;
        pendingOutputs.delete(call.id);
      }

      calls.push(call);
      byCallId.set(call.id, call);
      continue;
    }

    if (TOOL_OUTPUT_TYPES.has(item.type)) {
      const callId = item.call_id || item.id;
      if (!callId) continue;
      const key = String(callId);
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

  return calls;
}

function transcriptStamp(input) {
  const resolved = path.resolve(input);
  const stat = fs.statSync(resolved);
  const hash = crypto.createHash('sha256')
    .update(resolved)
    .update('\0')
    .update(String(stat.size))
    .update('\0')
    .update(String(Math.trunc(stat.mtimeMs)))
    .digest('hex');

  return {
    file: resolved,
    hash,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function stampPath(stateDir, stamp) {
  return path.join(stateDir, 'observed-transcripts', `${stamp.hash}.json`);
}

function payloadFor(call, phase, transcriptPath) {
  const payload = {
    cwd: call.cwd,
    hook_event_name: phase === 'pre' ? 'PreToolUse' : 'PostToolUse',
    session_id: call.sessionId,
    tool_input: hookSafeValue(call.input),
    tool_name: call.toolName,
    tool_use_id: call.id,
    transcript_path: transcriptPath,
  };

  if (phase === 'post') {
    const output = hookSafeValue(call.output === undefined ? '' : call.output);
    payload.tool_response = output;
    payload.tool_output = output;
  }

  return payload;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  const stdout = String(result.stdout || '').trim();
  if (stdout && result.status === 0 && !result.signal) return stdout;
  if (result.status !== 0 || result.error || result.signal) return '';
  return stdout;
}

function normalizeRemoteUrl(url) {
  if (!url) return '';
  const isNetwork = url.startsWith('file://') ? false : /:\/\/|@[^/]+:/.test(url);
  let normalized = String(url)
    .replace(/:\/\/[^@]+@/, '://')
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/:]+@([^:/]+):/, '$1/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
  if (isNetwork) normalized = normalized.toLowerCase();
  return normalized;
}

function firstExistingCwd(calls) {
  for (const call of calls) {
    if (call.cwd && fs.existsSync(call.cwd)) return call.cwd;
  }
  return workspaceRoot();
}

function projectForCalls(calls, options) {
  const cwd = firstExistingCwd(calls);
  const root = runGit(['-C', cwd, 'rev-parse', '--show-toplevel'], cwd);
  const homunculusDir = path.resolve(options.homunculusDir || path.join(options.stateDir, 'ecc-homunculus'));

  if (!root) {
    return {
      dir: homunculusDir,
      id: 'global',
      name: 'global',
      remote: '',
      root: '',
    };
  }

  const remote = runGit(['-C', root, 'remote', 'get-url', 'origin'], root);
  const hashInput = normalizeRemoteUrl(remote) || root;
  const id = crypto.createHash('sha256').update(hashInput, 'utf8').digest('hex').slice(0, 12);

  return {
    dir: path.join(homunculusDir, 'projects', id),
    id,
    name: path.basename(root),
    remote: remote.replace(/:\/\/[^@]+@/, '://'),
    root,
  };
}

function ensureProjectLayout(project, options) {
  fs.mkdirSync(project.dir, { recursive: true });
  if (project.id !== 'global') {
    for (const rel of [
      'instincts/personal',
      'instincts/inherited',
      'observations.archive',
      'evolved/skills',
      'evolved/commands',
      'evolved/agents',
    ]) {
      fs.mkdirSync(path.join(project.dir, rel), { recursive: true });
    }
  }

  const homunculusDir = path.resolve(options.homunculusDir || path.join(options.stateDir, 'ecc-homunculus'));
  fs.mkdirSync(homunculusDir, { recursive: true });
  if (project.id === 'global') return;

  const now = new Date().toISOString();
  const registryPath = path.join(homunculusDir, 'projects.json');
  const projectPath = path.join(project.dir, 'project.json');
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    registry = {};
  }

  const previous = registry[project.id] || {};
  const metadata = {
    id: project.id,
    name: project.name,
    root: project.root,
    remote: project.remote,
    created_at: previous.created_at || now,
    last_seen: now,
  };
  registry[project.id] = metadata;
  writeJsonAtomic(projectPath, metadata);
  writeJsonAtomic(registryPath, registry);
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

const SECRET_RE = /(api[_-]?key|token|secret|password|authorization|credentials?|auth)(["'\s:=]+)([A-Za-z]+\s+)?([A-Za-z0-9_\-/.+=]{8,})/gi;

function scrubSecrets(value) {
  return String(value).replace(SECRET_RE, (_match, key, sep, scheme) => `${key}${sep}${scheme || ''}[REDACTED]`);
}

function observationValue(value) {
  if (value === undefined || value === null) return null;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return scrubSecrets(serialized.slice(0, 5000));
}

function eventTimestamp(value) {
  if (!value) return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function rotateObservationFileIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) return;
  const size = fs.statSync(filePath).size;
  if (size < 10 * 1024 * 1024) return;

  const archiveDir = path.join(path.dirname(filePath), 'observations.archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  fs.renameSync(filePath, path.join(archiveDir, `observations-${stamp}-${process.pid}.jsonl`));
}

function directObservationRows(calls, project) {
  const rows = [];
  for (const call of calls) {
    const input = observationValue(call.input);
    const start = {
      timestamp: eventTimestamp(call.timestamp),
      event: 'tool_start',
      tool: call.toolName,
      session: call.sessionId,
      project_id: project.id,
      project_name: project.name,
    };
    if (input) start.input = input;
    rows.push(start);

    if (call.output !== undefined) {
      const output = observationValue(call.output);
      const complete = {
        timestamp: eventTimestamp(call.outputTimestamp || call.timestamp),
        event: 'tool_complete',
        tool: call.toolName,
        session: call.sessionId,
        project_id: project.id,
        project_name: project.name,
      };
      if (output !== null) complete.output = output;
      rows.push(complete);
    }
  }
  return rows;
}

function observeDirect(calls, options) {
  const project = projectForCalls(calls, options);
  if (options.dryRun) {
    return { emitted: directObservationRows(calls, project).length, failures: 0 };
  }

  ensureProjectLayout(project, options);
  const observationsFile = path.join(project.dir, 'observations.jsonl');
  rotateObservationFileIfNeeded(observationsFile);
  const rows = directObservationRows(calls, project);
  if (rows.length > 0) {
    fs.appendFileSync(observationsFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(path.join(project.dir, '.observer-last-activity'), new Date().toISOString() + '\n');
  }
  return { emitted: rows.length, failures: 0 };
}

function invokeObserveHook(observeScript, payload, phase, options) {
  const cwd = payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : workspaceRoot();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observe-'));
  const inputPath = path.join(tempDir, 'payload.json');
  fs.writeFileSync(inputPath, JSON.stringify(payload));

  let fd;
  try {
    fd = fs.openSync(inputPath, 'r');
    const result = spawnSync('bash', [observeScript, phase], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || 'cli',
        CLAUDE_HOOK_EVENT_NAME: phase === 'pre' ? 'PreToolUse' : 'PostToolUse',
        CLAUDE_PLUGIN_ROOT: options.pluginRoot,
        ECC_PLUGIN_ROOT: options.pluginRoot,
        CLV2_HOMUNCULUS_DIR: options.homunculusDir || path.join(options.stateDir, 'ecc-homunculus'),
        ECC_STATE_DIR: options.stateDir,
      },
      stdio: [fd, 'pipe', 'pipe'],
      timeout: Number.parseInt(process.env.CODEX_ECC_OBSERVE_TIMEOUT_MS || '15000', 10),
      windowsHide: true,
    });

    if (result.error) {
      return { ok: false, message: result.error.message };
    }
    if (result.signal) {
      return { ok: false, message: `terminated by signal ${result.signal}` };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      return { ok: false, message: stderr || `exit ${result.status}` };
    }
    return { ok: true };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function observeCalls(calls, observeScript, options, transcriptPath) {
  let emitted = 0;
  let failures = 0;

  for (const call of calls) {
    for (const phase of ['pre', 'post']) {
      if (phase === 'post' && call.output === undefined) continue;
      emitted += 1;

      if (options.dryRun) continue;

      const result = invokeObserveHook(observeScript, payloadFor(call, phase, transcriptPath), phase, options);
      if (!result.ok) {
        failures += 1;
        process.stderr.write(`[codex-observe] observe ${phase} failed for ${call.toolName}/${call.id}: ${result.message}\n`);
      }
    }
  }

  return { emitted, failures };
}

function markObserved(stateDir, stamp, summary) {
  const target = stampPath(stateDir, stamp);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    observed_at: new Date().toISOString(),
    transcript: stamp.file,
    transcript_mtime_ms: stamp.mtimeMs,
    transcript_size: stamp.size,
    ...summary,
  }, null, 2) + '\n');
}

function main() {
  let options;
  try {
    options = resolveDefaults(parseArgs(process.argv.slice(2)));
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

  const input = path.resolve(options.input);
  if (!fs.existsSync(input)) {
    process.stderr.write(`[codex-observe] transcript not found: ${input}\n`);
    process.exit(2);
  }

  const observeScript = path.join(options.pluginRoot, 'skills', 'continuous-learning-v2', 'hooks', 'observe.sh');
  if (options.mode === 'hook' && !options.dryRun && !fs.existsSync(observeScript)) {
    process.stderr.write(`[codex-observe] observe hook not found: ${observeScript}\n`);
    return;
  }

  const stamp = transcriptStamp(input);
  const observedPath = stampPath(options.stateDir, stamp);
  const shouldMark = options.limit === null && !options.dryRun;

  if (!options.force && shouldMark && fs.existsSync(observedPath)) {
    process.stderr.write(`[codex-observe] transcript already observed: ${input}\n`);
    return;
  }

  let calls = collectToolCalls(readJsonl(input), workspaceRoot());
  if (options.limit !== null) {
    calls = calls.slice(0, options.limit);
  }

  const summary = options.mode === 'hook'
    ? observeCalls(calls, observeScript, options, input)
    : observeDirect(calls, options);

  if (shouldMark) {
    markObserved(options.stateDir, stamp, {
      emitted_events: summary.emitted,
      failed_events: summary.failures,
      tool_calls: calls.length,
    });
  }

  process.stderr.write(
    `[codex-observe] ${options.dryRun ? 'parsed' : 'observed'} ${calls.length} tool calls, ` +
    `${summary.emitted} ${options.mode === 'hook' ? 'hook' : 'direct'} events, ${summary.failures} failures\n`
  );

  if (summary.failures > 0 && process.env.CODEX_ECC_OBSERVE_STRICT === '1') {
    process.exit(1);
  }
}

main();
