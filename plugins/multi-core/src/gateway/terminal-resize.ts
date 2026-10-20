import type { ChildProcess } from 'node:child_process';

interface TerminalResizeOptions {
  platform?: NodeJS.Platform;
  isTTY?: boolean;
}

/**
 * A detached Unix child inherits the terminal descriptors, but not its foreground
 * process group's SIGWINCH. Relay only the resize signal to that attached child.
 * Call immediately after spawn, before awaiting startup or other child work.
 */
export function forwardTerminalResize(
  child: ChildProcess,
  options: TerminalResizeOptions = {},
): () => void {
  const platform = options.platform ?? process.platform;
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY || process.stderr.isTTY);
  if (platform === 'win32' || !isTTY) {
    return () => {};
  }
  const resize = () => {
    child.kill('SIGWINCH');
  };
  const cleanup = () => {
    process.off('SIGWINCH', resize);
    child.off('exit', cleanup);
    child.off('error', cleanup);
  };
  process.on('SIGWINCH', resize);
  child.once('exit', cleanup);
  child.once('error', cleanup);
  return cleanup;
}
