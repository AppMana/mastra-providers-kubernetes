/**
 * Kubernetes Process Manager
 *
 * Runs commands in the sandbox pod over the `pods/exec` websocket.
 *
 * Spawned processes are detached inside the pod (`setsid`) with their output
 * and exit code persisted under `/workspace/.mastra/proc/<id>/` on the PVC, so
 * a process survives a dropped exec connection or an app restart and its
 * handle can be reattached by PID. Output is streamed back by tailing the log
 * files over a second exec session.
 */

import { ProcessHandle, SandboxProcessManager } from '@mastra/core/workspace';
import type { CommandResult, ProcessInfo, SpawnProcessOptions } from '@mastra/core/workspace';
import type { KubernetesSandbox } from './index';
import type { RunningExec } from './exec';
import { startExec } from './exec';

const PROC_DIR = '.mastra/proc';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envPrefix(env: Record<string, string | undefined>): string {
  const entries = Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined);
  if (entries.length === 0) return '';
  return `export ${entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}; `;
}

class KubernetesProcessHandle extends ProcessHandle {
  readonly pid: string;

  /** @internal */ _killed = false;
  /** @internal */ _timedOut = false;
  private _exitCode: number | undefined;
  private _waitPromise: Promise<CommandResult> | null = null;
  private _tail: RunningExec | null = null;
  private _startTime: number;

  constructor(pid: string, startTime: number, options?: SpawnProcessOptions) {
    super(options);
    this.pid = pid;
    this._startTime = startTime;
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  /** @internal */
  _setExitCode(code: number): void {
    this._exitCode = code;
  }

  /** @internal */
  _setWaitPromise(p: Promise<CommandResult>): void {
    this._waitPromise = p;
  }

  /** @internal */
  _setTail(tail: RunningExec): void {
    this._tail = tail;
  }

  /** @internal */
  _closeTail(): void {
    this._tail?.close();
    this._tail = null;
  }

  /** @internal */
  _elapsedMs(): number {
    return Date.now() - this._startTime;
  }

  async wait(): Promise<CommandResult> {
    if (!this._waitPromise) {
      throw new Error(`Process ${this.pid} has no wait promise; was it spawned by this manager?`);
    }
    return this._waitPromise;
  }

  async kill(): Promise<boolean> {
    if (this._exitCode !== undefined) return false;
    this._killed = true;
    const manager = this.managerRef;
    if (!manager) return false;
    return manager._killPid(this.pid);
  }

  async sendStdin(_data: string): Promise<void> {
    throw new Error(
      `Process ${this.pid} runs detached inside the pod; stdin is not connected. Use executeCommand for interactive input.`,
    );
  }

  /** @internal Back-reference set by the manager. */
  managerRef: KubernetesProcessManager | null = null;
}

export class KubernetesProcessManager extends SandboxProcessManager<KubernetesSandbox> {
  private readonly _defaultTimeout: number;

  constructor(options: { env: Record<string, string>; defaultTimeout?: number }) {
    super(options);
    this._defaultTimeout = options.defaultTimeout ?? 0;
  }

  /** @internal Called by KubernetesSandbox's constructor. */
  attach(sandbox: KubernetesSandbox): void {
    this.sandbox = sandbox;
  }

  /** Run a short script to completion via exec and capture its output. */
  async runScript(
    script: string,
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const kc = await this.sandbox.kubeConfig();
    let stdout = '';
    let stderr = '';
    const cwd = options.cwd ?? this.sandbox.workingDir;
    const wrapped = `${envPrefix({ ...this.env, ...options.env })}cd ${shellQuote(cwd)} && { ${script}\n}`;

    const session = await startExec(
      kc,
      this.sandbox.namespace,
      this.sandbox.podName,
      this.sandbox.containerName,
      ['sh', '-c', wrapped],
      {
        onStdout: d => {
          stdout += d;
          options.onStdout?.(d);
        },
        onStderr: d => {
          stderr += d;
          options.onStderr?.(d);
        },
      },
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = options.timeout ?? this._defaultTimeout;
    if (timeout > 0) {
      timer = setTimeout(() => session.close(), timeout);
    }
    const exitCode = await session.exited;
    if (timer) clearTimeout(timer);
    return { exitCode, stdout, stderr };
  }

  async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    await this.sandbox.bumpActivity();

    const procId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const dir = `${this.sandbox.workingDir}/${PROC_DIR}/${procId}`;
    const cwd = options.cwd ?? this.sandbox.workingDir;

    // Launch detached: the process group survives this exec session. The
    // wrapper records the command, streams output to files, and writes the
    // exit code on completion so handles can be reattached later.
    const launch = [
      `mkdir -p ${shellQuote(dir)}`,
      `printf '%s' ${shellQuote(command)} > ${shellQuote(`${dir}/cmd`)}`,
      `${envPrefix({ ...this.env, ...options.env })}cd ${shellQuote(cwd)} && ` +
        `setsid sh -c ${shellQuote(`{ ${command}\n} > ${dir}/out.log 2> ${dir}/err.log; echo $? > ${dir}/exit`)} ` +
        `< /dev/null > /dev/null 2>&1 & echo $!`,
    ].join(' && ');

    const launched = await this.runScript(launch, { cwd, timeout: 30_000 });
    const osPid = launched.stdout.trim().split('\n').pop()?.trim();
    if (launched.exitCode !== 0 || !osPid || !/^\d+$/.test(osPid)) {
      throw new Error(
        `Failed to spawn process in pod ${this.sandbox.podName}: exit=${launched.exitCode} stderr=${launched.stderr.slice(0, 500)}`,
      );
    }

    const handle = new KubernetesProcessHandle(osPid, Date.now(), options);
    handle.managerRef = this;
    handle.command = command;
    this._wireHandle(handle, procId, options);
    this._tracked.set(handle.pid, handle);
    return handle;
  }

  /** Tail output files and resolve the handle when the exit file appears. */
  private _wireHandle(handle: KubernetesProcessHandle, procId: string, options: SpawnProcessOptions = {}): void {
    const dir = `${this.sandbox.workingDir}/${PROC_DIR}/${procId}`;

    const waitPromise = (async (): Promise<CommandResult> => {
      const kc = await this.sandbox.kubeConfig();

      // Stream both logs from the beginning; tail exits when the exit file
      // shows up (--pid is unavailable for a non-child, so poll in shell).
      const tailScript =
        `tail -n +1 -F ${dir}/out.log ${dir}/err.log 2>/dev/null & TP=$!; ` +
        `while [ ! -f ${dir}/exit ]; do sleep 0.5; done; sleep 0.5; kill $TP 2>/dev/null; ` +
        `cat ${dir}/exit`;

      let exitText = '';
      let inErrSection = false;
      const tail = await startExec(
        kc,
        this.sandbox.namespace,
        this.sandbox.podName,
        this.sandbox.containerName,
        ['sh', '-c', tailScript],
        {
          onStdout: chunk => {
            // `tail -F` on two files emits `==> path <==` section headers.
            for (const line of chunk.split(/(?<=\n)/)) {
              const header = line.match(/^==> (.*) <==\n?$/);
              if (header) {
                inErrSection = header[1]!.endsWith('err.log');
                continue;
              }
              // The final `cat exit` output is a bare integer line after the
              // tail is killed; capture it for the exit code.
              if (/^\d+\n?$/.test(line) && exitText === '' && line.length <= 12) {
                exitText = line.trim();
                continue;
              }
              if (line.length === 0) continue;
              if (inErrSection) handle.emitStderr(line);
              else handle.emitStdout(line);
            }
          },
        },
      );
      handle._setTail(tail);

      await tail.exited;

      // Authoritative exit code from the file (the stream parse is best-effort).
      const finalize = await this.runScript(`cat ${dir}/exit 2>/dev/null || echo ''`, { timeout: 15_000 });
      const fileExit = finalize.stdout.trim();
      const parsed = /^\d+$/.test(fileExit) ? Number(fileExit) : /^\d+$/.test(exitText) ? Number(exitText) : undefined;

      const exitCode = handle._killed ? 137 : (parsed ?? 1);
      handle._setExitCode(exitCode);
      return {
        success: exitCode === 0,
        exitCode,
        stdout: handle.stdout,
        stderr: handle.stderr,
        executionTimeMs: handle._elapsedMs(),
        killed: handle._killed || undefined,
        timedOut: handle._timedOut || undefined,
        command: handle.command,
      };
    })();

    handle._setWaitPromise(waitPromise);

    const timeout = options.timeout ?? this._defaultTimeout;
    if (timeout > 0) {
      const timer = setTimeout(() => {
        if (handle.exitCode === undefined) {
          handle._timedOut = true;
          handle.kill().catch(() => {});
        }
      }, timeout);
      void waitPromise.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
    }
  }

  /** @internal Kill a detached process group inside the pod. */
  async _killPid(pid: string): Promise<boolean> {
    if (!/^\d+$/.test(pid)) return false;
    const result = await this.runScript(
      `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null; sleep 1; ` +
        `kill -KILL -- -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`,
      { timeout: 15_000 },
    );
    const handle = this._tracked.get(pid) as KubernetesProcessHandle | undefined;
    handle?._closeTail();
    return result.exitCode === 0;
  }

  async list(): Promise<ProcessInfo[]> {
    const results: ProcessInfo[] = [];
    for (const [pid, handle] of this._tracked) {
      results.push({
        pid,
        command: handle.command,
        running: handle.exitCode === undefined,
        exitCode: handle.exitCode,
      });
    }
    return results;
  }

  /** Clear tracked handles (after stop/destroy). Detached processes die with the pod. */
  reset(): void {
    for (const handle of this._tracked.values()) {
      (handle as KubernetesProcessHandle)._closeTail?.();
    }
    this._tracked.clear();
  }
}
