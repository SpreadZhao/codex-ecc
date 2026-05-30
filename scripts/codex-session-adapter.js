#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.input_text === 'string') return part.input_text;
    if (typeof part.output_text === 'string') return part.output_text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join(' ');
}

function parseToolInput(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  if (typeof argumentsValue !== 'string') return {};

  try {
    return JSON.parse(argumentsValue);
  } catch {
    return { arguments: argumentsValue };
  }
}

function convertEntry(entry) {
  const payload = entry && entry.payload ? entry.payload : entry;
  if (!payload || typeof payload !== 'object') return null;

  if (payload.type === 'message') {
    const role = typeof payload.role === 'string' ? payload.role : 'assistant';
    if (role !== 'user' && role !== 'assistant') return null;

    return {
      type: role,
      message: {
        role,
        content: textFromContent(payload.content),
      },
    };
  }

  if (payload.type === 'function_call' || payload.type === 'local_shell_call') {
    return {
      type: 'tool_use',
      tool_name: payload.name || payload.tool_name || payload.type,
      tool_input: parseToolInput(payload.arguments || payload.input),
    };
  }

  if (payload.type === 'custom_tool_call') {
    return {
      type: 'tool_use',
      tool_name: payload.name || payload.tool_name || payload.type,
      tool_input: typeof payload.input === 'string'
        ? { input: payload.input }
        : parseToolInput(payload.input),
    };
  }

  return null;
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];

  if (!input || !output) {
    console.error('Usage: codex-session-adapter.js <codex-jsonl> <claude-jsonl>');
    process.exit(2);
  }

  const entries = readJsonl(input)
    .map(convertEntry)
    .filter(Boolean);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  console.error(`[codex-session-adapter] wrote ${entries.length} entries to ${output}`);
}

main();
