import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import {
  loadWorkerPermissions,
  pluginPermissions,
} from '../../plugins/multi-core/src/gateway/agent-definitions.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { cursorPermissionPolicy } from '../../plugins/multi-cursor/src/permissions.ts';
import { removeTemporary } from '../temporary.ts';

async function writeAgent(directory: string, name: string, source: string) {
  const agents = path.join(directory, '.claude', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, `${name}.md`), source);
}

let inventory: unknown[] = [];
test.beforeEach(() => {
  mock.restoreAll();
  inventory = [];
  mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, JSON.stringify(inventory), '');
    }
  });
});

async function executableFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-executables-'));
  t.after(() => removeTemporary(root));
  const wrapperDirectory = path.join(root, 'multi-bin');
  const nativeDirectory = path.join(root, 'native-bin');
  await mkdir(wrapperDirectory);
  await mkdir(nativeDirectory);
  const native = path.join(nativeDirectory, 'claude');
  const override = path.join(root, 'explicit-claude');
  for (const file of [path.join(wrapperDirectory, 'claude'), native, override]) {
    await writeFile(file, 'fixture', { mode: 0o755 });
  }
  const env = {
    PATH: [wrapperDirectory, nativeDirectory].join(path.delimiter),
    MULTI_REAL_CLAUDE: native,
  };
  return { root, native, override, env };
}

test('plugin inventory probes the configured native Claude when its wrapper leads PATH', async (t) => {
  const fixture = await executableFixture(t);
  mock.restoreAll();
  const calls: unknown[][] = [];
  mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    calls.push(args);
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      callback(null, '[]', '');
    }
  });
  const settings = ['--setting-sources', 'user,project', '--settings', 'caller.json'];
  await pluginPermissions(fixture.root, settings, { env: fixture.env });
  await pluginPermissions(fixture.root, settings, {
    env: fixture.env,
    executable: fixture.override,
  });
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [fixture.native, fixture.override].map((command) => [
      command,
      [...settings, 'plugin', 'list', '--json'],
    ]),
  );
});

test('missing configured native Claude fails without falling back to its PATH wrapper', async (t) => {
  const fixture = await executableFixture(t);
  mock.restoreAll();
  const probe = mock.method(childProcess, 'execFile', () => {
    throw new Error('A missing configured executable must not start a probe');
  });
  const missing = path.join(fixture.root, 'missing-claude');
  for (const options of [
    { env: { ...fixture.env, MULTI_REAL_CLAUDE: missing } },
    { env: fixture.env, executable: missing },
  ]) {
    await assert.rejects(pluginPermissions(fixture.root, [], options), {
      code: 'ENOENT',
      message: `Configured executable does not exist: ${missing}`,
    });
  }
  assert.equal(probe.mock.callCount(), 0);
});

test('loads configured user and nested project definitions in precedence order, then CLI definitions', async (t) => {
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-project-'));
  const cwd = path.join(root, 'nested');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  t.after(() => {
    process.env.CLAUDE_CONFIG_DIR = previousConfig;
  });
  await mkdir(path.join(root, '.git'));
  await mkdir(cwd);
  await writeAgent(
    home,
    'worker',
    '---\nname: worker\ndescription: user\npermissionMode: plan\ntools: Read, Grep\n---\n',
  );
  await writeAgent(
    root,
    'worker',
    '---\nname: worker\ndescription: root\npermissionMode: auto\ndisallowedTools: [Write, Edit]\n---\n',
  );
  await writeAgent(
    cwd,
    'worker',
    '---\nname: worker\ndescription: nested\npermissionMode: dontAsk\ntools: [Read, Glob]\n---\n',
  );
  await writeAgent(
    cwd,
    'nested',
    '---\nname: nested\ndescription: nested\ntools: Read, Bash\n---\n',
  );
  const definitions = await loadWorkerPermissions(cwd, { worker: { permissionMode: 'plan' } });
  assert.deepEqual(definitions.worker, { permissionMode: 'plan' });
  assert.deepEqual(definitions.nested, {
    tools: ['Read', 'Bash'],
    disallowedTools: undefined,
    permissionMode: undefined,
  });
  assert.deepEqual(definitions.Explore, { disallowedTools: ['Write', 'Edit'] });
  assert.deepEqual(definitions.Plan, { disallowedTools: ['Write', 'Edit'] });
  assert.deepEqual(definitions['general-purpose'], {});
});

test('rejects malformed relevant agent frontmatter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-project-'));
  await mkdir(path.join(root, '.git'));
  await writeAgent(root, 'bad', '---\nname: bad\ndescription: bad\npermissionMode: unsafe\n---\n');
  await assert.rejects(loadWorkerPermissions(root, {}), /invalid permissionMode/);
});

test('keeps an agent named __proto__ as data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-project-'));
  await mkdir(path.join(root, '.git'));
  await writeAgent(root, 'proto', '---\nname: __proto__\ndescription: data\ntools: Read\n---\n');
  const definitions = await loadWorkerPermissions(root, {});
  assert.equal(Object.getPrototypeOf(definitions), null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(definitions, '__proto__')?.value, {
    tools: ['Read'],
    disallowedTools: undefined,
    permissionMode: undefined,
  });
});

test('discovers scoped plugin workers, manifest replacement paths and inherited project scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-agents-'));
  const cwd = path.join(root, 'nested');
  await mkdir(cwd);
  await mkdir(path.join(root, '.claude-plugin'));
  await mkdir(path.join(root, 'agents'));
  await writeFile(
    path.join(root, 'agents', 'ignored.md'),
    '---\nname: ignored\ndescription: ignored\n---\n',
  );
  await writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fixture', agents: ['./reader.md'] }),
  );
  await writeFile(
    path.join(root, 'reader.md'),
    '---\nname: reader\ndescription: reader\ntools: Read, Grep\npermissionMode: bypassPermissions\n---\n',
  );
  inventory = [
    { id: 'multi-core@cc-multi-cli-plugin', enabled: true, installPath: root, projectPath: root },
    { id: 'fixture@inline', enabled: true, installPath: root, projectPath: root },
    { id: 'disabled@test', enabled: false, installPath: '/does-not-exist' },
    {
      id: 'elsewhere@test',
      enabled: true,
      installPath: '/does-not-exist',
      projectPath: '/elsewhere',
    },
  ];
  const pluginInventory = await pluginPermissions(cwd, ['--plugin-dir', root]);
  assert.equal(pluginInventory.multiCoreEnabled, true);
  const definitions = await loadWorkerPermissions(cwd, {}, ['--plugin-dir', root]);
  assert.deepEqual(definitions['fixture:reader'], {
    tools: ['Read', 'Grep'],
    disallowedTools: undefined,
  });
  assert.equal(definitions['fixture:ignored'], undefined);
  await writeFile(path.join(root, 'reader.md'), '---\ntools: [Read\n---\n');
  const malformed = await loadWorkerPermissions(cwd, {});
  assert.match(malformed['fixture:reader'].nativePermissionError ?? '', /metadata is unavailable/);
});

async function pluginFixture(t: test.TestContext, sources: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-metadata-'));
  t.after(() => removeTemporary(root));
  await mkdir(path.join(root, 'agents'));
  await mkdir(path.join(root, 'core'));
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(path.join(root, 'agents', name), source);
  }
  inventory = [
    { id: 'fixture@test', enabled: true, installPath: root },
    { id: 'multi-core@cc-multi-cli-plugin', enabled: true, installPath: path.join(root, 'core') },
  ];
  return root;
}

test('one malformed plugin agent preserves restrictive neighbors and cannot enter a harness', async (t) => {
  const root = await pluginFixture(t, {
    'reader.md': '---\nname: reader\ntools: [Read, Grep]\ndisallowedTools: [Bash, Write]\n---\n',
    'broken.md':
      '---\nname: renamed\ndescription: Inspect failures: report them\ntools: [Read]\n---\n',
  });
  const discovered = await pluginPermissions(root, []);
  assert.equal(discovered.multiCoreEnabled, true);
  assert.deepEqual(discovered.permissions['fixture:reader'], {
    tools: ['Read', 'Grep'],
    disallowedTools: ['Bash', 'Write'],
  });
  assert.equal(discovered.warnings?.length, 1);
  assert.match(discovered.warnings?.[0] ?? '', /fixture:broken.*fixture:renamed/);
  assert.doesNotMatch(discovered.warnings?.[0] ?? '', /fixture:reader/);

  const modes = new PermissionModes(async () => discovered.permissions);
  await modes.precompute(root);
  const parentModel = 'multi/openai/gpt-6-astra';
  modes.recordModSession('session', { cwd: root, model: parentModel, permissionMode: 'auto' });
  const spawn = { cwd: root, parentModel, permissionMode: 'auto' };
  for (const type of ['fixture:broken', 'fixture:renamed']) {
    const definition = discovered.permissions[type];
    assert.deepEqual(Object.keys(definition), ['nativePermissionError']);
    assert.throws(
      () => cursorPermissionPolicy({ ...definition, permissionMode: 'auto' }),
      /metadata is unavailable/,
    );
    await assert.rejects(
      modes.prepareModWorker('session', {
        ...spawn,
        subagentType: type,
        model: 'multi/cursor/default',
      }),
      /metadata is unavailable/,
    );
    // Registration stays observational for the host's own Claude loop.
    assert.equal(
      typeof (await modes.prepareModWorker('session', {
        ...spawn,
        subagentType: type,
        model: 'claude-sonnet-4-6',
      })),
      'string',
    );
  }
  await assert.rejects(
    modes.prepareModWorker('session', {
      ...spawn,
      subagentType: 'fixture:unknown',
      model: 'multi/cursor/default',
    }),
    /Cannot resolve permissions/,
  );
  const token = await modes.prepareModWorker('session', {
    ...spawn,
    subagentType: 'fixture:reader',
    model: 'multi/cursor/default',
  });
  modes.recordPreparedModWorker('session', 'reader', token);
  const allowed = modes.resolveHarness('session', 'reader', 'multi/cursor/default');
  assert.deepEqual(allowed.tools, ['Read', 'Grep']);
  assert.deepEqual(allowed.disallowedTools, ['Bash', 'Write']);
});

test('a native descendant cannot clear malformed ancestor permissions before a harness spawn', async (t) => {
  const root = await pluginFixture(t, {
    'reader.md': '---\nname: reader\ntools: [Read, Grep]\ndisallowedTools: [Bash, Write]\n---\n',
    'broken.md': '---\nname: broken\ndescription: Inspect failures: report them\n---\n',
  });
  const discovered = await pluginPermissions(root, []);
  const modes = new PermissionModes(async () => discovered.permissions);
  await modes.precompute(root);
  const nativeModel = 'claude-sonnet-4-6';
  modes.recordModSession('session', { cwd: root, model: nativeModel, permissionMode: 'auto' });
  const spawn = { cwd: root, parentModel: nativeModel, permissionMode: 'auto' };
  const broken = await modes.prepareModWorker('session', {
    ...spawn,
    subagentType: 'fixture:broken',
    model: nativeModel,
  });
  modes.recordPreparedModWorker('session', 'broken', broken);
  const reader = await modes.prepareModWorker('session', {
    ...spawn,
    parentAgentId: 'broken',
    subagentType: 'fixture:reader',
    model: nativeModel,
  });
  modes.recordPreparedModWorker('session', 'reader', reader);
  await assert.rejects(
    modes.prepareModWorker('session', {
      ...spawn,
      parentAgentId: 'reader',
      subagentType: 'fixture:reader',
      model: 'multi/cursor/default',
    }),
    /metadata is unavailable/,
  );
  const inherited = modes.resolve('session', 'reader');
  assert.equal(
    inherited.nativePermissionError,
    discovered.permissions['fixture:broken'].nativePermissionError,
  );
  assert.deepEqual(inherited.tools, ['Read', 'Grep']);
  assert.deepEqual(inherited.disallowedTools, ['Bash', 'Write']);
});

test('malformed aliases stay blocked regardless of neighboring definition order', async (t) => {
  const root = await pluginFixture(t, {
    'valid.md': '---\nname: reader\ntools: [Read]\ndisallowedTools: [Write]\n---\n',
    'broken.md': '---\nname: reader\ndescription: Inspect failures: report them\n---\n',
  });
  await mkdir(path.join(root, '.claude-plugin'));
  for (const agents of [
    ['./agents/valid.md', './agents/broken.md'],
    ['./agents/broken.md', './agents/valid.md'],
  ]) {
    await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ agents }));
    const discovered = await pluginPermissions(root, []);
    const reader = discovered.permissions['fixture:reader'];
    assert.deepEqual(reader.tools, ['Read']);
    assert.deepEqual(reader.disallowedTools, ['Write']);
    assert.match(reader.nativePermissionError ?? '', /metadata is unavailable/);
    assert.throws(
      () => cursorPermissionPolicy({ ...reader, permissionMode: 'auto' }),
      /metadata is unavailable/,
    );
  }
});

test('plugin and worker hooks never block native execution; Claude hooks do not run natively', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'plugin-hooks-'));
  await mkdir(path.join(root, 'hooks'));
  await writeFile(
    path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } }),
  );
  inventory = [{ id: 'guard@test', enabled: true, installPath: root }];
  const definitions = await loadWorkerPermissions(root, {});
  assert.equal(definitions['general-purpose'].nativePermissionError, undefined);
});

test('worker hooks do not restrict the native worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-hooks-'));
  await writeAgent(
    root,
    'guarded',
    '---\nname: guarded\ndescription: guarded\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks: []\n---\n',
  );
  await writeAgent(
    root,
    'ordinary',
    '---\nname: ordinary\ndescription: ordinary\ntools: Read\n---\n',
  );
  const definitions = await loadWorkerPermissions(root, {});
  assert.equal(definitions.guarded.nativePermissionError, undefined);
  assert.equal(definitions.ordinary.nativePermissionError, undefined);
  assert.deepEqual(definitions.ordinary.tools, ['Read']);
  assert.equal(definitions['general-purpose'].nativePermissionError, undefined);
  for (const definition of [definitions.guarded, definitions.ordinary]) {
    assert.doesNotThrow(() => cursorPermissionPolicy({ ...definition, permissionMode: 'auto' }));
  }
});
