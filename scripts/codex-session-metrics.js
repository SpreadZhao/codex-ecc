#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_CALL_TYPES = new Set(['function_call', 'local_shell_call', 'custom_tool_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'local_shell_call_output', 'custom_tool_call_output']);
const RECENT_TOOLS_SIZE = 5;

function usage() {
  return [
    'Usage: codex-session-metrics.js <codex-rollout.jsonl> [options]',
    '',
    'Options:',
    '  --home-dir <path>   Isolated ECC hook home; default .ecc/home',
    '  --dry-run           Parse and report without writing metrics',
    '  --limit <n>         Process at most n tool calls',
    '  --help              Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    homeDir: process.env.CODEX_ECC_HOME || '',
    limit: null,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--home-dir') {
      options.homeDir = argv[++i] || '';
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[++i] || '', 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('Invalid --limit value');
      }
      options.limit = parsed;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  options.input = positionals[0] || '';
  options.homeDir = path.resolve(options.homeDir || path.join(workspaceRoot(), '.ecc', 'home'));
  return options;
}

function workspaceRoot() {
  return path.resolve(__dirname, '..');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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

function collectToolCalls(entries, fallbackCwd) {
  let sessionId = process.env.ECC_SESSION_ID || process.env.CLAUDE_SESSION_ID || 'unknown';
  let currentCwd = fallbackCwd || process.cwd();
  let sequence = 0;
  const calls = [];
  const byCallId = new Map();

  for (const entry of entries) {
    const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
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
      const id = String(item.call_id || item.id || `${item.type}-${sequence}`);
      sequence += 1;
      const call = {
        cwd: currentCwd,
        id,
        input: parseToolInput(item.arguments || item.input),
        output: item.type === 'custom_tool_call' ? outputForTool(item) : undefined,
        outputTimestamp: entry.timestamp || '',
        sessionId,
        timestamp: entry.timestamp || '',
        toolName: item.name || item.tool_name || item.type,
      };
      calls.push(call);
      byCallId.set(id, call);
      continue;
    }

    if (TOOL_OUTPUT_TYPES.has(item.type)) {
      const id = item.call_id || item.id;
      if (!id) continue;
      const call = byCallId.get(String(id));
      if (call) {
        call.output = outputForTool(item);
        call.outputTimestamp = entry.timestamp || '';
      }
    }
  }

  return calls;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\n/g, ' ')
    .replace(/--token[= ][^ ]*/g, '--token=<REDACTED>')
    .replace(/Authorization:[: ]*[^ ]*[: ]*[^ ]*/gi, 'Authorization:<REDACTED>')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '<REDACTED>')
    .replace(/\bASIA[A-Z0-9]{16}\b/g, '<REDACTED>')
    .replace(/password[= ][^ ]*/gi, 'password=<REDACTED>')
    .replace(/\bgh[pous]_[A-Za-z0-9_]+\b/g, '<REDACTED>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '<REDACTED>');
}

function truncateSummary(value, maxLength = 220) {
  const normalized = stripAnsi(redactSecrets(value)).trim().replace(/\s+/g, ' ');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
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

function normalizeToolCall(call) {
  if (call.toolName === 'exec_command') {
    return {
      toolName: 'Bash',
      toolInput: {
        command: call.input.cmd || '',
        cwd: call.input.workdir || call.cwd,
      },
    };
  }

  if (call.toolName === 'apply_patch') {
    const patch = call.input.input || call.input.patch || call.input.arguments || '';
    return {
      toolName: 'Edit',
      toolInput: {
        file_paths: extractPatchFilePaths(patch),
        patch: truncateSummary(patch, 1200),
      },
    };
  }

  return {
    toolName: call.toolName,
    toolInput: call.input && typeof call.input === 'object' ? call.input : {},
  };
}

function sanitizeParamValue(value, depth = 0) {
  if (depth >= 4) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateSummary(value, 160);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => sanitizeParamValue(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value).slice(0, 20)) {
      out[key] = sanitizeParamValue(nested, depth + 1);
    }
    return out;
  }
  return truncateSummary(String(value), 160);
}

function filePathsFromInput(toolInput) {
  const value = toolInput.file_paths || toolInput.file_path || [];
  return [...new Set((Array.isArray(value) ? value : [value]).map(String).filter(Boolean))];
}

function summarizeInput(toolName, toolInput, filePaths) {
  if (toolName === 'Bash') return truncateSummary(toolInput.command || 'bash');
  if (filePaths.length > 0) return truncateSummary(`${toolName} ${filePaths.join(', ')}`);
  return truncateSummary(JSON.stringify(sanitizeParamValue(toolInput || {})));
}

function summarizeOutput(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return truncateSummary(output);
  return truncateSummary(JSON.stringify(output));
}

function eventTime(call) {
  const value = call.outputTimestamp || call.timestamp;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function activityRows(calls) {
  return calls.map((call) => {
    const normalized = normalizeToolCall(call);
    const filePaths = filePathsFromInput(normalized.toolInput);
    const fileEvents = filePaths.map((filePath) => ({
      action: normalized.toolName === 'Edit' ? 'modify' : 'touch',
      path: filePath,
    }));

    return {
      id: `tool-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      timestamp: eventTime(call),
      session_id: call.sessionId,
      tool_name: normalized.toolName,
      input_summary: summarizeInput(normalized.toolName, normalized.toolInput, filePaths),
      input_params_json: JSON.stringify(sanitizeParamValue(normalized.toolInput || {})),
      output_summary: summarizeOutput(call.output),
      duration_ms: 0,
      file_paths: filePaths,
      file_events: fileEvents,
    };
  });
}

function stableStringify(value, depth = 0) {
  if (depth > 4) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`).join(',')}}`;
}

function toolHash(row) {
  let key = '';
  const input = JSON.parse(row.input_params_json || '{}');
  if (row.tool_name === 'Bash') key = String(input.command || '').slice(0, 160);
  else if (input.file_path) key = String(input.file_path);
  else if (Array.isArray(input.file_paths)) key = input.file_paths.join(',');
  else key = stableStringify(input).slice(0, 2048);
  return crypto.createHash('sha256').update(`${row.tool_name}:${key}`).digest('hex').slice(0, 8);
}

function sanitizeSessionId(raw) {
  if (!raw || typeof raw !== 'string' || /[/\\]|\.\./.test(raw)) return null;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe || null;
}

function writeBridge(rows) {
  if (rows.length === 0) return null;
  const sessionId = sanitizeSessionId(rows[0].session_id);
  if (!sessionId) return null;

  const files = [...new Set(rows.flatMap((row) => row.file_paths || []))].slice(0, 200);
  const recent = rows.slice(-RECENT_TOOLS_SIZE).map((row) => ({
    hash: toolHash(row),
    tool: row.tool_name,
  }));
  const bridge = {
    session_id: sessionId,
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    tool_count: rows.length,
    files_modified_count: files.length,
    files_modified: files,
    recent_tools: recent,
    first_timestamp: rows[0].timestamp,
    last_timestamp: rows[rows.length - 1].timestamp,
    context_remaining_pct: null,
  };
  const target = path.join(os.tmpdir(), `ecc-metrics-${sessionId}.json`);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bridge), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

function writeRows(rows, homeDir) {
  const metricsDir = path.join(homeDir, '.claude', 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  const target = path.join(metricsDir, 'tool-usage.jsonl');
  if (rows.length > 0) {
    fs.appendFileSync(target, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  return target;
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

  let calls = collectToolCalls(readJsonl(path.resolve(options.input)), workspaceRoot());
  if (options.limit !== null) calls = calls.slice(0, options.limit);
  const rows = activityRows(calls);

  if (!options.dryRun) {
    const target = writeRows(rows, options.homeDir);
    const bridge = writeBridge(rows);
    process.stderr.write(`[codex-metrics] wrote ${rows.length} rows to ${target}${bridge ? ` and ${bridge}` : ''}\n`);
  } else {
    process.stderr.write(`[codex-metrics] parsed ${rows.length} activity rows\n`);
  }
}

main();
