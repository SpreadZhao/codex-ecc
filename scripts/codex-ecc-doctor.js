#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  'flake.nix',
  'flake.lock',
  '.envrc',
  'AGENTS.md',
  'AGENTS.ecc.md',
  'README.md',
  'repos.yaml',
  '.codex/AGENTS.md',
  '.codex/config.toml',
  '.codex/hooks.json',
  '.codex/agents/explorer.toml',
  '.codex/agents/reviewer.toml',
  '.codex/agents/docs-researcher.toml',
  '.codex/prompts/ecc-prompts-manifest.txt',
  '.codex/git-hooks/pre-commit',
  '.codex/git-hooks/pre-push',
  '.ecc/source/scripts/ecc.js',
  '.ecc/source/hooks/hooks.json',
];

const REQUIRED_EXECUTABLES = [
  'scripts/bin/codex',
  'scripts/bin/ecc',
  'scripts/codex-workspace',
  'scripts/ecc-workspace',
  'scripts/bootstrap-workspace-instance.sh',
  'scripts/sync-workspace-instance.sh',
  'scripts/sync-ecc.sh',
  'scripts/init-ecc-workspace.sh',
  'scripts/bootstrap-ecc-node-deps.sh',
  'scripts/import-repo.sh',
  'scripts/install-ecc-git-hooks.sh',
  'scripts/codex-session-adapter.js',
  'scripts/codex-observe-session.js',
  'scripts/codex-session-metrics.js',
  'scripts/codex-replay-ecc-hooks.js',
  'scripts/codex-native-hook-adapter.js',
  'scripts/generate-codex-native-hooks.js',
  'scripts/codex-ecc-doctor.js',
];

const REQUIRED_MCP_SECTIONS = [
  'github',
  'context7',
  'exa',
  'memory',
  'playwright',
  'sequential-thinking',
];

const REQUIRED_AGENT_SECTIONS = [
  'agents',
  'agents.explorer',
  'agents.reviewer',
  'agents.docs_researcher',
];

let checks = 0;
let warnings = 0;
let failures = 0;

function rel(filePath) {
  return path.relative(ROOT, filePath) || '.';
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function ok(message) {
  checks += 1;
  console.log(`[OK] ${message}`);
}

function warn(message) {
  checks += 1;
  warnings += 1;
  console.log(`[WARN] ${message}`);
}

function fail(message) {
  checks += 1;
  failures += 1;
  console.log(`[FAIL] ${message}`);
}

function checkFile(relativePath) {
  if (exists(relativePath)) ok(`${relativePath} exists`);
  else fail(`${relativePath} missing`);
}

function checkExecutable(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    fail(`${relativePath} missing`);
    return;
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    ok(`${relativePath} executable`);
  } catch {
    fail(`${relativePath} is not executable`);
  }
}

function listDirs(relativePath) {
  const dir = path.join(ROOT, relativePath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listFiles(relativePath, predicate = () => true) {
  const dir = path.join(ROOT, relativePath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(predicate)
    .sort();
}

function tableExists(raw, tablePath) {
  const escaped = tablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, 'm').test(raw);
}

function rootKeyExists(raw, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*=`, 'm').test(raw);
}

function checkCodexConfig() {
  const configPath = '.codex/config.toml';
  if (!exists(configPath)) {
    fail(`${configPath} missing`);
    return;
  }

  const raw = read(configPath);
  if (rootKeyExists(raw, 'notify')) fail('project config contains unsupported notify key');
  else ok('project config excludes unsupported notify key');

  if (/^\s*\[profiles(?:\.|\])/.test(raw)) fail('project config contains unsupported profiles tables');
  else ok('project config excludes unsupported profiles tables');

  for (const section of REQUIRED_MCP_SECTIONS) {
    if (tableExists(raw, `mcp_servers.${section}`)) ok(`MCP section [mcp_servers.${section}] exists`);
    else fail(`MCP section [mcp_servers.${section}] missing`);
  }

  for (const section of REQUIRED_AGENT_SECTIONS) {
    if (tableExists(raw, section)) ok(`Codex section [${section}] exists`);
    else fail(`Codex section [${section}] missing`);
  }

  if (/^\s*multi_agent\s*=\s*true\b/m.test(raw)) ok('multi_agent enabled');
  else fail('multi_agent not enabled');

  if (rootKeyExists(raw, 'persistent_instructions')) ok('persistent_instructions configured');
  else warn('persistent_instructions missing');
}

function checkCounts() {
  const sourceSkillNames = new Set([
    ...listDirs('.ecc/source/skills'),
    ...listDirs('.ecc/source/.agents/skills'),
  ]);
  const workspaceSkillNames = new Set(listDirs('.agents/skills'));
  const missingSkills = [...sourceSkillNames].filter((name) => !workspaceSkillNames.has(name));

  if (sourceSkillNames.size === 0) {
    fail('no source skills found under .ecc/source');
  } else if (missingSkills.length === 0) {
    ok(`workspace skills cover ${sourceSkillNames.size} upstream skill directories`);
  } else {
    fail(`workspace skills missing ${missingSkills.length}: ${missingSkills.slice(0, 12).join(', ')}`);
  }

  const commandFiles = listFiles('.ecc/source/commands', (name) => name.endsWith('.md'));
  const promptFiles = listFiles('.codex/prompts', (name) => /^ecc-.*\.md$/.test(name));
  if (commandFiles.length === 0) {
    fail('no upstream command files found');
  } else if (promptFiles.length >= commandFiles.length) {
    ok(`Codex prompts cover ${promptFiles.length}/${commandFiles.length} upstream commands`);
  } else {
    fail(`Codex prompts cover only ${promptFiles.length}/${commandFiles.length} upstream commands`);
  }
}

function collectSkillFiles(relativePath) {
  const dir = path.join(ROOT, relativePath);
  if (!fs.existsSync(dir)) return [];

  const result = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name === 'SKILL.md') result.push(fullPath);
    }
  }
  return result.sort();
}

function unquoteYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function checkSkillFrontmatter() {
  const files = collectSkillFiles('.agents/skills');
  const invalid = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) {
      invalid.push(`${rel(filePath)}: missing frontmatter`);
      continue;
    }

    const description = frontmatter[1].match(/^description:\s*(.*)$/m);
    if (!description) {
      invalid.push(`${rel(filePath)}: missing description`);
      continue;
    }

    const value = unquoteYamlScalar(description[1]);
    if (value.length > 1024) {
      invalid.push(`${rel(filePath)}: description length ${value.length}`);
    }
  }

  if (invalid.length === 0) ok(`workspace skill frontmatter valid for ${files.length} skill(s)`);
  else fail(`workspace skill frontmatter invalid: ${invalid.slice(0, 8).join('; ')}`);
}

function checkCodexNativeHooks() {
  const hooksPath = '.codex/hooks.json';
  if (!exists(hooksPath)) {
    fail(`${hooksPath} missing`);
    return;
  }

  let config;
  try {
    config = JSON.parse(read(hooksPath));
  } catch (error) {
    fail(`${hooksPath} is not valid JSON: ${error.message}`);
    return;
  }

  const hooks = config.hooks || {};
  const requiredEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'];
  for (const event of requiredEvents) {
    if (Array.isArray(hooks[event]) && hooks[event].length > 0) ok(`native Codex hooks include ${event}`);
    else fail(`native Codex hooks missing ${event}`);
  }

  const allHandlers = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      fail(`native Codex hooks event ${event} is not an array`);
      continue;
    }
    for (const group of groups) {
      for (const handler of group.hooks || []) {
        allHandlers.push({ event, handler });
      }
    }
  }

  if (allHandlers.length >= 18) ok(`native Codex hooks expose ${allHandlers.length} ECC handlers`);
  else fail(`native Codex hooks expose only ${allHandlers.length} handlers`);

  const nonAdapter = allHandlers.filter(({ handler }) => {
    return handler.type === 'command' && !String(handler.command || '').includes('scripts/codex-native-hook-adapter.js');
  });
  if (nonAdapter.length === 0) ok('native Codex hook commands route through codex-native-hook-adapter');
  else fail(`native Codex hooks have ${nonAdapter.length} command(s) not using codex-native-hook-adapter`);

  const asyncHandlers = allHandlers.filter(({ handler }) => handler.async === true);
  if (asyncHandlers.length === 0) ok('native Codex hooks avoid async handlers');
  else fail(`native Codex hooks contain ${asyncHandlers.length} async handler(s) unsupported by current Codex`);

  const ids = new Set();
  for (const groups of Object.values(hooks)) {
    for (const group of groups || []) {
      if (group.id) ids.add(group.id);
    }
  }
  for (const id of ['pre:bash:dispatcher', 'pre:config-protection', 'post:quality-gate', 'stop:format-typecheck']) {
    if (ids.has(id)) ok(`native Codex hook ${id} exists`);
    else fail(`native Codex hook ${id} missing`);
  }
}

function checkGitIgnore() {
  if (!exists('.gitignore')) {
    fail('.gitignore missing');
    return;
  }
  const raw = read('.gitignore');
  for (const pattern of ['.workspaces/', '.ecc/source/', '.ecc/state/', '.ecc/home/', '.ecc/codex-home/', '.npm-cache/', '.npm-global/']) {
    if (raw.includes(pattern)) ok(`.gitignore ignores ${pattern}`);
    else fail(`.gitignore missing ${pattern}`);
  }
}

function checkTemplateBoundary() {
  if (!exists('.codex-ecc-template')) {
    ok('workspace is an instance, not a reusable template');
    return;
  }

  ok('template marker .codex-ecc-template exists');

  const addRepo = exists('scripts/add-repo.sh') ? read('scripts/add-repo.sh') : '';
  if (addRepo.includes('CODEX_ECC_ALLOW_TEMPLATE_REPOS') && addRepo.includes('bootstrap-workspace-instance.sh')) {
    ok('template add-repo guard is installed');
  } else {
    fail('template add-repo guard missing');
  }

  const repos = exists('repos.yaml')
    ? read('repos.yaml')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .join('\n')
    : '';
  if (repos === 'repositories: {}' || repos === 'repositories:') {
    ok('template repos.yaml contains no business repositories');
  } else {
    warn('template repos.yaml appears to contain instance-specific repository state');
  }
}

function checkFlake() {
  if (!exists('flake.nix')) {
    fail('flake.nix missing');
    return;
  }
  const raw = read('flake.nix');
  for (const fragment of ['ecc-src', 'ecc-universal', 'codex-ecc', 'ecc-workspace', 'ecc2', 'nodejs_24']) {
    if (raw.includes(fragment)) ok(`flake contains ${fragment}`);
    else fail(`flake missing ${fragment}`);
  }
}

function checkLocalStateBoundary() {
  const forbiddenGlobalPaths = ['~/.codex', '$HOME/.codex', '~/.claude', '$HOME/.claude'];
  const files = [
    'scripts/codex-workspace',
    'scripts/ecc-workspace',
    'scripts/bootstrap-ecc-node-deps.sh',
    'scripts/codex-native-hook-adapter.js',
  ];
  for (const file of files) {
    if (!exists(file)) continue;
    const raw = read(file);
    const normalized = file === 'scripts/codex-workspace'
      ? raw.replace('${CODEX_HOME:-$HOME/.codex}/sessions', '${CODEX_HOME}/sessions')
      : raw;
    const hits = forbiddenGlobalPaths.filter((needle) => normalized.includes(needle));
    if (hits.length === 0) ok(`${file} has no hardcoded global state path`);
    else warn(`${file} references global path text: ${hits.join(', ')}`);
  }
}

function main() {
  console.log('Codex ECC workspace doctor');
  console.log(`Workspace: ${ROOT}\n`);

  for (const file of REQUIRED_FILES) checkFile(file);
  for (const file of REQUIRED_EXECUTABLES) checkExecutable(file);
  checkCodexConfig();
  checkCounts();
  checkSkillFrontmatter();
  checkCodexNativeHooks();
  checkGitIgnore();
  checkTemplateBoundary();
  checkFlake();
  checkLocalStateBoundary();

  console.log(`\nSummary: checks=${checks}, warnings=${warnings}, failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main();
