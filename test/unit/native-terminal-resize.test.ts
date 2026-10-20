import assert from 'node:assert/strict';
import { ChildProcess, execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { forwardTerminalResize } from '../../plugins/multi-core/src/gateway/terminal-resize.ts';
import { removeTemporary } from '../temporary.ts';

for (const event of ['exit', 'error'] as const) {
  test(`terminal resize relay forwards only SIGWINCH and cleans up on child ${event}`, (t) => {
    const child = new ChildProcess();
    const kill = t.mock.method(child, 'kill', () => true);
    const listeners = process.listenerCount('SIGWINCH');
    const cleanup = forwardTerminalResize(child, { platform: 'linux', isTTY: true });
    t.after(cleanup);
    assert.equal(process.listenerCount('SIGWINCH'), listeners + 1);
    process.emit('SIGWINCH', 'SIGWINCH');
    assert.deepEqual(
      kill.mock.calls.map((call) => call.arguments),
      [['SIGWINCH']],
    );
    child.emit(event);
    assert.equal(process.listenerCount('SIGWINCH'), listeners);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
    process.emit('SIGWINCH', 'SIGWINCH');
    assert.equal(kill.mock.callCount(), 1, 'never signal an exited or failed child');
    cleanup();
    assert.equal(process.listenerCount('SIGWINCH'), listeners, 'cleanup is idempotent');
  });
}

test('terminal resize relay is absent on Windows and without inherited terminal output', (t) => {
  const child = new ChildProcess();
  const kill = t.mock.method(child, 'kill', () => true);
  const listeners = process.listenerCount('SIGWINCH');
  for (const options of [
    { platform: 'win32', isTTY: true },
    { platform: 'linux', isTTY: false },
  ] as const) {
    forwardTerminalResize(child, options)();
  }
  assert.equal(process.listenerCount('SIGWINCH'), listeners);
  process.emit('SIGWINCH', 'SIGWINCH');
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

// The PTY owns the foreground process group. Resizing it signals the wrapper,
// while its detached child must receive the resize through the production relay.
const resizePty = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
output = b""
resized = False
finished = False
try:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output += data
            if not resized and b"READY 80 24" in output:
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 120, 0, 0))
                resized = True
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            finished = True
            break
        time.sleep(0.01)
    if not finished:
        raise RuntimeError("PTY child did not exit")
    sys.stdout.buffer.write(output)
    sys.stdout.flush()
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    if not finished:
        for line in output.splitlines():
            if line.startswith(b"CHILD_PID "):
                try: os.killpg(int(line.split()[1]), signal.SIGKILL)
                except ProcessLookupError: pass
        try: os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
    os.close(fd)
`;

const resizeChild = `
console.log('CHILD_PID', process.pid);
const timeout = setTimeout(() => {
  console.error('Resize signal was not delivered to the detached child.');
  process.exit(7);
}, 3000);
process.on('SIGWINCH', () => {
  console.log('RESIZED', process.stdout.columns, process.stdout.rows);
  clearTimeout(timeout);
});
console.log('READY', process.stdout.columns, process.stdout.rows);
`;

function ptyUnavailable(): string | false {
  if (process.platform === 'win32') {
    return 'POSIX PTY resize signals are not available on Windows';
  }
  if (spawnSync('python3', ['-c', 'import fcntl, pty, termios']).status !== 0) {
    return 'Python 3 with POSIX PTY support is required for the terminal integration proof';
  }
  return false;
}
const ptySkip = ptyUnavailable();

async function resizeFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multi-terminal-resize-'));
  t.after(() => removeTemporary(root));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const claude = path.join(bin, 'claude');
  await writeFile(
    claude,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.304'); process.exit(0); }
if (args.includes('plugin') && args.includes('list')) { console.log('[]'); process.exit(0); }
if (args[0] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
// Deliberately do not acknowledge Mods startup: resize must work before that await.
${resizeChild}`,
    { mode: 0o755 },
  );
  const runModule = new URL('../../plugins/multi-core/src/install/process.ts', import.meta.url);
  const wrapper = path.join(root, 'wrapper.mjs');
  await writeFile(
    wrapper,
    `import { run } from ${JSON.stringify(runModule.href)};
process.exitCode = await run(process.execPath, process.argv.slice(2));`,
  );
  return {
    root,
    wrapper,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'config'),
      CODEX_HOME: path.join(root, 'codex'),
      MULTI_ENABLED_PROVIDERS: '',
      MULTI_REAL_CLAUDE: claude,
    },
  };
}

for (const launchGateway of [false, true]) {
  test(`terminal resize reaches the detached ${launchGateway ? 'launcher child before Mods startup' : 'run child'}`, {
    skip: ptySkip,
  }, async (t) => {
    const fixture = await resizeFixture(t);
    const args = launchGateway
      ? [
          fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
          '--',
          '--model',
          'claude-sonnet-5-5',
        ]
      : ['-e', resizeChild];
    const { stdout } = await promisify(execFile)(
      'python3',
      ['-c', resizePty, process.execPath, fixture.wrapper, ...args],
      { cwd: fixture.root, env: fixture.env, timeout: 25000 },
    );
    assert.match(stdout, /READY 80 24/);
    assert.match(stdout, /RESIZED 120 42/);
  });
}
