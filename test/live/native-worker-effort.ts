// Opt-in paid check of an installed normal-command bridge. No --model or --effort:
// the invoked command's defaults must provide Opus and the Astra Max worker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hookCommand } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
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
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  result?: string;
  message?: { model?: string; content?: Block[] | string };
}
interface HookEvent {
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
  transcript_path?: string;
}
interface Trace {
  route: string;
  model?: string;
  effort?: string;
  agentId?: string | null;
  status?: number;
}

const { values } = parseArgs({
  options: {
    command: { type: 'string', default: 'claude' },
    'command-arg': { type: 'string', multiple: true },
    'setting-sources': { type: 'string', default: 'user,project' },
    artifacts: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'Usage: node test/live/native-worker-effort.ts [--command /path/to/claude] [--command-arg ARG] [--setting-sources user,project] [--artifacts PATH]\nPaid, opt-in check: one native Opus 5.5 lead turn delegating to default Astra Max, with Read/Edit/MCP/denied Bash. Does not pass a model or effort flag. Uses existing login, user defaults and a synthetic project; never edits user configuration. Bounds: 10 parent turns, $1.50 Claude budget, three-minute timeout. Native per-task effort is unavailable; only the fixed worker default is tested.',
  );
  process.exit(0);
}

const command = values.command ?? 'claude';
const commandArgs = values['command-arg'] ?? [];
assert(
  !commandArgs.some((arg) => /^--(?:model|effort)(?:=|$)/.test(arg)),
  'Do not inject --model or --effort: this test verifies installed defaults',
);
const artifacts = values.artifacts
  ? path.resolve(values.artifacts)
  : await mkdtemp(path.join(os.tmpdir(), 'native-worker-effort-'));
await mkdir(artifacts, { recursive: true });
const cwd = path.join(artifacts, 'workspace');
await mkdir(cwd);
const sessionId = randomUUID();
const marker = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;
const fileNonce = marker('file');
const projectNonce = marker('project');
const mcpNonce = marker('mcp');
const expectedLead = 'claude-opus-5-5';
const expectedWorker = 'gpt-6-astra';
const expectedEffort = 'max';
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
  `Synthetic integration fixture. The project context marker is ${projectNonce}. Include it when asked for the project marker. Never try an alternative tool after a denied action.\n`,
);
await writeFile(
  settings,
  JSON.stringify({
    // A full Bash deny removes the tool from Claude's offered toolset. Deny only
    // this probe, overriding broad user allows while preserving the actual call.
    permissions: { deny: [`Bash(${deniedCommand})`] },
    hooks: { SubagentStart: [{ hooks: [hook] }] },
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

const args = [
  ...commandArgs,
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--session-id',
  sessionId,
  '--max-turns',
  '10',
  '--max-budget-usd',
  '1.50',
  '--permission-mode',
  'dontAsk',
  '--settings',
  settings,
  '--setting-sources',
  values['setting-sources'] ?? 'user,project',
  '--strict-mcp-config',
  '--mcp-config',
  mcpConfig,
  '--tools',
  'default',
  '--allowedTools',
  `Agent,Read,Edit,ToolSearch,${mcpTool}`,
  '--debug-file',
  path.join(artifacts, 'claude-debug.log'),
];
const task = `Complete every step of this authorized synthetic integration test.
1. Read fixture.txt with native Read.
2. Use native Edit to replace alpha with beta, preserving the nonce and newline.
3. Call ${mcpTool} exactly once with stage claude-to-gpt; discover it with ToolSearch if needed.
4. Make exactly one native Bash tool call with this exact command: ${deniedCommand}
This is an authorized permission probe. The native harness decides permission; a denial is expected and DENIED.txt should remain absent. Do not skip the call or predict its result. Never retry, substitute another command, or create DENIED.txt through another tool.
5. Report the exact file line, MCP canary, project marker from your existing native project instructions (without reading CLAUDE.md), and actual Bash tool result.`;
const prompt = `This is an authorized synthetic integration test. Delegate exactly once to multi-openai as a regular native subagent, not a fork. Omit model and effort from the Agent arguments: this test checks the configured worker defaults. Set its prompt to the exact content between worker_task tags, verbatim. Do not omit any step, especially the Bash permission probe; do not add the project marker value. Do not perform the worker's tools yourself. Wait and repeat the worker's evidence in your final answer.\n<worker_task>\n${task}\n</worker_task>`;
const report = {
  version: 1,
  command,
  args,
  nodeVersion: process.version,
  sessionId,
  expectedLead,
  expectedWorker,
  expectedEffort,
  perTaskEffort: 'unsupported by native Agent spawn API; fixed default only',
  passed: false,
  elapsedMs: 0,
  observedLeadModels: [] as string[],
  observedWorkerModels: [] as string[],
  requests: [] as Trace[],
  workerId: undefined as string | undefined,
  tools: [] as string[],
  error: undefined as string | undefined,
};

async function jsonLines<T>(filename: string): Promise<T[]> {
  return (await readFile(filename, 'utf8'))
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

function blocks(events: Event[], type: string): Block[] {
  return events.flatMap((event) =>
    Array.isArray(event.message?.content)
      ? event.message.content.filter((block) => block.type === type)
      : [],
  );
}

function assistantModels(events: Event[]) {
  return [
    ...new Set(
      events
        .filter((event) => event.type === 'assistant')
        .map((event) => event.message?.model)
        .filter((model): model is string => typeof model === 'string'),
    ),
  ];
}

async function run() {
  const child = spawn(command, args, {
    cwd,
    env: isolatedEnvironment({
      HOME: os.homedir(),
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      MULTI_REAL_CLAUDE: process.env.MULTI_REAL_CLAUDE,
      MULTI_ENABLED_PROVIDERS: 'openai',
      MULTI_NATIVE_TRACE: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
    }),
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    await writeFile(path.join(artifacts, 'lead.jsonl'), stdout);
    await writeFile(path.join(artifacts, 'stderr.log'), stderr);
  }
  assert(!timedOut, 'Exceeded three-minute limit');
  assert.equal(code, 0, 'CLI failed; see saved diagnostics');
  assert.doesNotMatch(stderr, /DEP0190/);
  report.requests = [...stderr.matchAll(/\[native\] (\{[^\r\n]+\})/g)].map(
    (match) => JSON.parse(match[1]) as Trace,
  );
  return jsonLines<Event>(path.join(artifacts, 'lead.jsonl'));
}

function verifyLead(events: Event[]) {
  const result = events.findLast((event) => event.type === 'result');
  assert(result && !result.is_error, result?.result ?? 'No successful result');
  assert.equal(result.session_id, sessionId);
  const lead = events.filter((event) => !event.parent_tool_use_id);
  report.observedLeadModels = assistantModels(lead);
  assert.deepEqual(report.observedLeadModels, [expectedLead], 'Normal command did not keep Opus');
  assert(
    report.requests.some(
      (trace) =>
        trace.route === 'anthropic' && trace.model === expectedLead && trace.status === 200,
    ),
    'Missing successful Opus request',
  );
  const calls = blocks(lead, 'tool_use');
  assert.equal(calls.length, 1, 'Lead must delegate once and leave all other tools to the worker');
  const delegation = calls[0];
  assert.equal(delegation.name, 'Agent');
  assert.equal(delegation.input?.subagent_type, 'multi-openai');
  assert.equal(delegation.input.model, undefined, 'Lead overrode default worker model');
  assert.equal(delegation.input.effort, undefined, 'Lead overrode default worker effort');
  assert(!delegation.input.fork, 'Worker must be a regular native subagent');
  assert.equal(typeof delegation.input.prompt, 'string');
  assert(!String(delegation.input.prompt).includes(projectNonce), 'Lead forwarded project marker');
}

async function workerHistory() {
  const starts = (await jsonLines<HookEvent>(hookLog)).filter(
    (event) => event.hook_event_name === 'SubagentStart' && event.agent_type === 'multi-openai',
  );
  assert.equal(starts.length, 1, 'Expected exactly one native OpenAI worker');
  const started = starts[0];
  assert(started.agent_id && started.transcript_path, 'Missing worker transcript identity');
  report.workerId = started.agent_id;
  const transcript = `${started.transcript_path.replace(/\.jsonl$/, '')}/subagents/agent-${started.agent_id}.jsonl`;
  const contents = await readFile(transcript, 'utf8');
  await writeFile(path.join(artifacts, 'worker.jsonl'), contents);
  return jsonLines<Event>(transcript);
}

function verifyWorkerRoute(history: Event[]) {
  report.observedWorkerModels = assistantModels(history);
  assert.deepEqual(report.observedWorkerModels, [`multi/openai/${expectedWorker}`]);
  const requests = report.requests.filter((trace) => trace.route === 'openai-request');
  assert(requests.length, 'No actual OpenAI request trace');
  for (const request of requests) {
    assert.equal(request.agentId, report.workerId, 'Request lost native worker ownership');
    assert.equal(request.model, expectedWorker, 'Worker did not use default Astra');
    assert.equal(request.effort, expectedEffort, 'Worker did not send default Max effort');
  }
  assert(
    report.requests.some(
      (trace) =>
        trace.route === 'openai' &&
        trace.agentId === report.workerId &&
        trace.model === expectedWorker &&
        trace.effort === expectedEffort,
    ),
    'Missing successful Astra Max response completion for the native worker',
  );
}

async function verifyWorkerTools(history: Event[]) {
  const calls = blocks(history, 'tool_use');
  const results = blocks(history, 'tool_result');
  report.tools = calls.map((call) => call.name ?? '');
  for (const tool of ['Read', 'Edit', mcpTool]) {
    assert(
      calls.some(
        (call) =>
          call.name === tool &&
          results.some((result) => result.tool_use_id === call.id && !result.is_error),
      ),
      `Missing successful native ${tool}`,
    );
  }
  const bash = calls.filter((call) => call.name === 'Bash');
  assert.equal(bash.length, 1, 'Expected exactly one permission probe');
  assert.equal(bash[0].input?.command, deniedCommand);
  assert(
    results.some(
      (result) =>
        result.tool_use_id === bash[0].id &&
        result.is_error &&
        /permission to use Bash.*denied/i.test(JSON.stringify(result.content)),
    ),
    'Missing actual native permission denial; an arbitrary tool error is insufficient',
  );
  assert.equal(await readFile(path.join(cwd, 'DENIED.txt'), 'utf8').catch(() => null), null);
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), `beta ${fileNonce}\n`);
  assert.equal((await jsonLines<{ stage: string }>(mcpLog)).length, 1);
  assert(
    !calls.some(
      (call) => call.name === 'Read' && String(call.input?.file_path).endsWith('CLAUDE.md'),
    ),
    'Worker fetched project instructions; automatic inheritance unproven',
  );
  const reply = blocks(
    history.filter((event) => event.type === 'assistant'),
    'text',
  )
    .map((block) => block.text ?? '')
    .join('\n');
  for (const value of [fileNonce, projectNonce, `${mcpNonce}-claude-to-gpt`]) {
    assert(reply.includes(value), `Worker response omitted ${value}`);
  }
}

console.log(`Worker-effort live artifacts: ${artifacts}`);
const started = Date.now();
try {
  const events = await run();
  verifyLead(events);
  const history = await workerHistory();
  verifyWorkerRoute(history);
  await verifyWorkerTools(history);
  report.passed = true;
  console.log(
    'PASS: normal command kept Opus 5.5 and delegated to default Astra Max with native tools and context.',
  );
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  report.elapsedMs = Date.now() - started;
  await writeFile(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(artifacts, 'report.json')}`);
}
