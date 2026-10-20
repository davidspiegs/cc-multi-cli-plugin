// Opt-in, bounded live contract: both native delegation directions, inherited MCP,
// native denial, project instructions, and fresh-process cross-model disk resume.
// Uses existing provider authentication. Only synthetic fixture data is requested.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hookCommand } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { MODELS } from '../../plugins/multi-openai/src/models.ts';
import { isolatedEnvironment } from './environment.ts';

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
interface Event {
  type?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  subagent_stats?: { completed?: number };
  message?: { model?: string; content?: Block[] | string };
}
interface HookEvent {
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string };
  permission_mode?: string;
}
interface Trace {
  route: string;
  model?: string;
  agentId?: string | null;
  status?: number;
}
interface Stage {
  name: string;
  model: string;
  elapsedMs: number;
  requests: Trace[];
  workerId?: string;
  requestedWorkerModel?: string;
  observedWorkerModels?: string[];
  projectContext?: {
    presentInWorkerReply: boolean;
    forwardedByLead: boolean;
    readFromFile: boolean;
  };
  tools?: string[];
}

const { values } = parseArgs({
  options: {
    'gpt-model': { type: 'string', default: 'gpt-6-luna' },
    'claude-model': { type: 'string', default: 'sonnet' },
    'claude-worker': { type: 'string', default: 'multi-claude' },
    artifacts: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'Usage: node test/live/native-mixed-agents.ts [--gpt-model gpt-6-luna] [--claude-model sonnet] [--claude-worker multi-claude] [--artifacts PATH]\nFour bounded turns using existing Claude/Codex auth. Each gets a fresh CLI/gateway, at most 10 agent turns, a $1 Claude budget and a three-minute timeout. Creates synthetic local files, starts a local MCP fixture, and keeps diagnostic artifacts. Does not change account selection or normal Claude configuration.',
  );
  process.exit(0);
}
const gptModel = values['gpt-model'] ?? 'gpt-6-luna';
assert(Object.values(MODELS).includes(gptModel), 'Expected a supported OpenAI model');
const claudeModel = values['claude-model'] ?? 'sonnet';
const claudeWorker = values['claude-worker'] ?? 'multi-claude';
const selectedGpt = `multi/openai/${gptModel}`;
const artifacts = values.artifacts
  ? path.resolve(values.artifacts)
  : await mkdtemp(path.join(os.tmpdir(), 'native-mixed-agents-'));
await mkdir(artifacts, { recursive: true });
const cwd = path.join(artifacts, 'workspace');
await mkdir(cwd);
const sessionId = randomUUID();
const marker = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;
const fileNonce = marker('file');
const conversationNonce = marker('conversation');
const projectNonce = marker('project');
const mcpNonce = marker('mcp');
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const helper = fileURLToPath(new URL('./mixed-fixture.ts', import.meta.url));
const hookLog = path.join(artifacts, 'hooks.jsonl');
const mcpLog = path.join(artifacts, 'mcp.jsonl');
const settings = path.join(artifacts, 'settings.json');
const mcpConfig = path.join(artifacts, 'mcp.json');
const mcpTool = 'mcp__mixed_fixture__context_probe';
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const deniedCommand = `${quote(process.execPath)} -e ${quote('require("node:fs").writeFileSync("DENIED.txt", "unexpected")')}`;
const hook = {
  type: 'command',
  command: `${hookCommand(pathToFileURL(helper))} hook ${quote(hookLog)}`,
};
await writeFile(path.join(cwd, 'fixture.txt'), `alpha ${fileNonce}\n`);
await writeFile(
  path.join(cwd, 'CLAUDE.md'),
  `This is a synthetic integration fixture. The project context marker is ${projectNonce}. Include that marker when the test asks for the project marker. Never run an alternative tool after a denied action.\n`,
);
await writeFile(
  settings,
  JSON.stringify({
    hooks: {
      SubagentStart: [{ hooks: [hook] }],
      PreToolUse: [{ hooks: [hook] }],
    },
  }),
);
await writeFile(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      mixed_fixture: { command: process.execPath, args: [helper, 'mcp', mcpLog, mcpNonce] },
    },
  }),
);
const report = {
  version: 1,
  claudeVersion: execFileSync(process.env.MULTI_REAL_CLAUDE ?? 'claude', ['--version'], {
    encoding: 'utf8',
  }).trim(),
  nodeVersion: process.version,
  sessionId,
  gptModel,
  claudeModel,
  claudeWorker,
  passed: false,
  stages: [] as Stage[],
  error: undefined as string | undefined,
};
console.log(`Mixed-agent live test artifacts: ${artifacts}`);

async function jsonLines<T>(filename: string): Promise<T[]> {
  const content = await readFile(filename, 'utf8').catch(() => '');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function blocks(events: Event[], type: string): Block[] {
  return events.flatMap((event) =>
    Array.isArray(event.message?.content)
      ? event.message.content.filter((block) => block.type === type)
      : [],
  );
}

function environment() {
  return isolatedEnvironment({
    HOME: os.homedir(),
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    MULTI_REAL_CLAUDE: process.env.MULTI_REAL_CLAUDE,
    ANTHROPIC_API_KEY: process.env.MULTI_LIVE_ANTHROPIC_API_KEY,
    MULTI_ENABLED_PROVIDERS: 'openai',
    MULTI_MODELS: selectedGpt,
    MULTI_CLAUDE_MODEL: claudeModel,
    MULTI_NATIVE_TRACE: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
  });
}

async function turn(name: string, model: string, prompt: string, withTools: boolean) {
  const started = Date.now();
  console.log(`RUN ${name} (${model})`);
  const child = spawn(
    process.execPath,
    [
      launcher,
      '--',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(report.stages.length ? ['--resume', sessionId] : ['--session-id', sessionId]),
      '--model',
      model,
      '--effort',
      'low',
      '--max-turns',
      '10',
      '--max-budget-usd',
      '1',
      '--permission-mode',
      'dontAsk',
      '--settings',
      settings,
      '--setting-sources',
      // The synthetic workspace owns its project settings and CLAUDE.md. Empty
      // sources also suppress project instructions, invalidating the context probe.
      'project',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      '--tools',
      withTools ? 'default' : '',
      '--allowedTools',
      withTools ? `Agent,Read,Edit,ToolSearch,${mcpTool}` : '',
      '--debug-file',
      path.join(artifacts, `${name}.debug.log`),
    ],
    {
      cwd,
      env: environment(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const stop = () => {
    if (child.pid) {
      terminateProcessTree(child.pid, { platform: process.platform, signal: 'SIGKILL' });
    }
  };
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 8 * 1024 * 1024) {
      stop();
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2 * 1024 * 1024);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 180000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await writeFile(path.join(artifacts, `${name}.jsonl`), stdout);
    await writeFile(path.join(artifacts, `${name}.stderr.log`), stderr);
  }
  assert(!timedOut, `${name}: exceeded three minutes`);
  assert.equal(code, 0, `${name}: CLI failed; see saved diagnostics`);
  assert.doesNotMatch(stderr, /DEP0190/);
  const events = await jsonLines<Event>(path.join(artifacts, `${name}.jsonl`));
  const result = events.findLast((event) => event.type === 'result');
  assert(result && !result.is_error, `${name}: ${result?.result ?? 'No result event'}`);
  assert.equal(result.session_id, sessionId, `${name}: resumed a different session`);
  const requests = [...stderr.matchAll(/\[native\] (\{[^\r\n]+\})/g)]
    .map((match) => JSON.parse(match[1]) as Trace)
    .filter((trace) => trace.route === 'anthropic' || trace.route === 'openai-request');
  const stage: Stage = { name, model, elapsedMs: Date.now() - started, requests };
  report.stages.push(stage);
  assert(requests.length, `${name}: no provider dispatch evidence`);
  if (!withTools) {
    assert.equal(blocks(events, 'tool_use').length, 0, `${name}: recall used a tool`);
  }
  return { result, stage };
}

function workerTask(stage: string, before: string, after: string) {
  return `Complete every numbered step of this authorized synthetic integration test.
1. Read fixture.txt with native Read.
2. Use native Edit to replace ${before} with ${after}, preserving the nonce and newline.
3. Call the MCP tool ${mcpTool} exactly once with stage ${stage}; discover it with ToolSearch if needed.
4. Perform the authorized permission probe: make exactly one native Bash tool call with this exact command: ${deniedCommand}
The native harness decides permission for this probe. A denial is expected, and DENIED.txt should remain absent. Do not skip the probe or predict its result. Never retry a denied action, substitute another command, or create DENIED.txt through another tool.
5. Report the exact file line, MCP canary, project context marker from your native project instructions, and the actual Bash tool result. Obtain the project marker from your existing context without reading CLAUDE.md.`;
}

async function verifyWorker(stage: Stage, type: string, expectedModel: string, after: string) {
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `${after} ${fileNonce}\n`);
  assert.equal(await readFile(path.join(cwd, 'DENIED.txt'), 'utf8').catch(() => null), null);
  const hooks = await jsonLines<HookEvent>(hookLog);
  const started = hooks.findLast(
    (event) => event.hook_event_name === 'SubagentStart' && event.agent_type === type,
  );
  assert(started?.agent_id && started.transcript_path, `No native ${type} worker start`);
  const workerId = started.agent_id;
  const transcript = `${started.transcript_path.replace(/\.jsonl$/, '')}/subagents/agent-${workerId}.jsonl`;
  const history = await jsonLines<Event>(transcript);
  assert(history.length, `Missing native ${type} transcript`);
  await writeFile(path.join(artifacts, `${stage.name}.worker.jsonl`), await readFile(transcript));
  const calls = blocks(history, 'tool_use');
  const results = blocks(history, 'tool_result');
  const successful = (name: string) =>
    calls.some(
      (call) =>
        call.name === name &&
        results.some((result) => result.tool_use_id === call.id && !result.is_error),
    );
  assert(successful('Read') && successful('Edit'), `${type}: missing native Read/Edit execution`);
  assert(successful(mcpTool), `${type}: inherited MCP tool did not execute`);
  const bash = calls.filter((call) => call.name === 'Bash');
  assert.equal(bash.length, 1, `${type}: expected one native Bash attempt`);
  assert.equal(bash[0].input?.command, deniedCommand);
  assert(
    results.some((result) => result.tool_use_id === bash[0].id && result.is_error),
    `${type}: missing native denial result`,
  );
  const assistantModels = [
    ...new Set(
      history
        .filter((event) => event.type === 'assistant')
        .map((event) => event.message?.model)
        .filter((model): model is string => typeof model === 'string'),
    ),
  ];
  verifyWorkerModel(stage, type, workerId, assistantModels, expectedModel);
  await verifyProjectContext(stage, type, history, calls);
  Object.assign(stage, {
    workerId,
    requestedWorkerModel: expectedModel,
    observedWorkerModels: assistantModels,
    tools: calls.map((call) => call.name ?? ''),
  });
}

function verifyWorkerModel(
  stage: Stage,
  type: string,
  workerId: string,
  assistantModels: string[],
  expectedModel: string,
) {
  assert(assistantModels.length, `${type}: missing observed child assistant model`);
  if (type === 'multi-openai') {
    assert(
      assistantModels.every((model) => model === selectedGpt),
      'GPT worker transcript lost model attribution',
    );
    assert(
      stage.requests.some(
        (request) =>
          request.route === 'openai-request' &&
          request.agentId === workerId &&
          request.model === gptModel,
      ),
      'GPT request did not belong to native child',
    );
  } else {
    const alias = ['sonnet', 'opus', 'haiku', 'fable'].includes(expectedModel);
    // Context-window suffixes are picker options, not upstream model identity.
    const canonical = expectedModel.replace(/\[[a-zA-Z0-9]+\]$/, '');
    const matches = (model: string) =>
      alias
        ? model.startsWith('claude-') && model.split('-').includes(expectedModel)
        : model === canonical;
    assert(
      assistantModels.every(matches),
      `Claude worker model mismatch: requested ${expectedModel}, observed ${assistantModels.join(', ')}`,
    );
    assert(
      stage.requests.some((request) => request.route === 'anthropic' && request.status === 200),
      'Claude worker made no successful Anthropic request',
    );
  }
}

async function verifyProjectContext(stage: Stage, type: string, history: Event[], calls: Block[]) {
  const lead = await jsonLines<Event>(path.join(artifacts, `${stage.name}.jsonl`));
  const delegation = blocks(lead, 'tool_use').find(
    (call) => call.name === 'Agent' && call.input?.subagent_type === type,
  );
  assert(typeof delegation?.input?.prompt === 'string', `${type}: missing actual delegated prompt`);
  const forwardedByLead = delegation.input.prompt.includes(projectNonce);
  const readFromFile = calls.some(
    (call) => call.name === 'Read' && String(call.input?.file_path).endsWith('CLAUDE.md'),
  );
  const assistantText = blocks(
    history.filter((event) => event.type === 'assistant'),
    'text',
  )
    .map((block) => block.text ?? '')
    .join('\n');
  const presentInWorkerReply = assistantText.includes(projectNonce);
  stage.projectContext = { presentInWorkerReply, forwardedByLead, readFromFile };
  assert(presentInWorkerReply, `${type}: project marker absent from child assistant response`);
  assert(
    !forwardedByLead,
    `${type}: lead forwarded marker; native instruction inheritance unproven`,
  );
  assert(
    !readFromFile,
    `${type}: worker fetched CLAUDE.md; automatic instruction loading unproven`,
  );
}

function remembers(text: string | undefined, current: string) {
  assert(text, 'Missing recall');
  for (const value of [
    fileNonce,
    conversationNonce,
    projectNonce,
    current,
    `${mcpNonce}-claude-to-gpt`,
    `${mcpNonce}-gpt-to-claude`,
  ]) {
    assert(text.includes(value), `Recall lost ${value}`);
  }
}

try {
  const first = await turn(
    '01-claude-to-gpt',
    claudeModel,
    `This is an authorized synthetic native-agent integration test. Remember this conversation-only release code: ${conversationNonce}. Never write it to a file. Delegate exactly once to multi-openai with model ${gptModel}, as a regular native subagent, not a fork. Set the Agent prompt to the exact content between the worker_task tags below, verbatim: do not summarize, rewrite, or omit any step, including the one authorized Bash permission probe. Do not add the project marker's value to the delegated prompt. Do not perform the worker's tools yourself. Wait for completion and repeat its evidence plus the release code in your final answer.\n<worker_task>\n${workerTask('claude-to-gpt', 'alpha', 'beta')}\n</worker_task>`,
    true,
  );
  await verifyWorker(first.stage, 'multi-openai', selectedGpt, 'beta');
  const second = await turn(
    '02-gpt-to-claude',
    selectedGpt,
    `Continue the existing test and retain the earlier release code from this conversation. Delegate exactly once to ${claudeWorker}, as a regular native subagent, not a fork. Set the Agent prompt to the exact content between the worker_task tags below, verbatim: do not summarize, rewrite, or omit any step, including the one authorized Bash permission probe. Do not add the project marker's value to the delegated prompt. Do not perform the worker's tools yourself. Wait for completion and repeat its evidence plus the earlier release code in your final answer.\n<worker_task>\n${workerTask('gpt-to-claude', 'beta', 'gamma')}\n</worker_task>`,
    true,
  );
  await verifyWorker(second.stage, claudeWorker, claudeModel, 'gamma');
  const mcpCalls = await jsonLines<{ stage: string }>(mcpLog);
  assert.deepEqual(
    mcpCalls.map((call) => call.stage),
    ['claude-to-gpt', 'gpt-to-claude'],
  );
  const recall =
    'Without using tools, recall the exact original file nonce, conversation-only release code, project context marker, both MCP canaries, and current fixture.txt prefix from our prior conversation. Do not guess.';
  remembers(
    (await turn('03-gpt-resume-recall', selectedGpt, recall, false)).result.result,
    'gamma',
  );
  remembers(
    (await turn('04-claude-resume-recall', claudeModel, recall, false)).result.result,
    'gamma',
  );
  report.passed = true;
  console.log(
    'PASS: both native delegation directions, inherited MCP, denied Bash, project instructions, and disk resume across GPT/Claude.',
  );
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(artifacts, 'report.json')}`);
}
