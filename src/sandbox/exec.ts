/**
 * Kubernetes exec websocket wrapper.
 *
 * Thin layer over `@kubernetes/client-node`'s `Exec` that turns a single
 * `pods/exec` call into start/stream/exit-code semantics usable by both
 * `executeCommand` and the process manager.
 */

import { PassThrough, Writable } from 'node:stream';
import type { KubeConfig } from '@kubernetes/client-node';
import { Exec } from '@kubernetes/client-node';
import type { V1Status } from '@kubernetes/client-node';

export interface ExecStreams {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** Provide to get a writable stdin. */
  stdin?: boolean;
}

export interface RunningExec {
  /** Writable stdin stream (null when not requested). */
  stdin: NodeJS.WritableStream | null;
  /** Resolves with the process exit code when the exec session ends. */
  exited: Promise<number>;
  /** Force-close the websocket; `exited` resolves afterwards. */
  close: () => void;
}

/**
 * Extract the process exit code from the V1Status the apiserver sends on the
 * exec status channel. `Success` means 0; `NonZeroExitCode` carries the code in
 * `details.causes[]` under reason `ExitCode`.
 */
export function exitCodeFromStatus(status: V1Status | null | undefined): number {
  if (!status) return 1;
  if (status.status === 'Success') return 0;
  const causes = status.details?.causes ?? [];
  for (const cause of causes) {
    if (cause.reason === 'ExitCode' && cause.message !== undefined) {
      const parsed = Number(cause.message);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 1;
}

/**
 * Start a command in a pod via the exec subresource.
 *
 * The command is always wrapped in `sh -c` by callers that need shell
 * semantics; this function passes argv through verbatim.
 */
export async function startExec(
  kubeConfig: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  argv: string[],
  streams: ExecStreams = {},
): Promise<RunningExec> {
  const exec = new Exec(kubeConfig);

  const stdout = new Writable({
    write(chunk: Buffer, _enc, cb) {
      streams.onStdout?.(chunk.toString('utf8'));
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk: Buffer, _enc, cb) {
      streams.onStderr?.(chunk.toString('utf8'));
      cb();
    },
  });
  const stdin = streams.stdin ? new PassThrough() : null;

  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => {
    resolveExit = resolve;
  });

  let statusSeen = false;
  const ws = await exec.exec(
    namespace,
    podName,
    containerName,
    argv,
    stdout,
    stderr,
    stdin,
    false /* tty */,
    (status: V1Status) => {
      statusSeen = true;
      resolveExit(exitCodeFromStatus(status));
    },
  );

  // If the socket closes without a status frame (killed pod, network drop),
  // resolve with a failure code so callers never hang.
  ws.on('close', () => {
    if (!statusSeen) resolveExit(137);
  });
  ws.on('error', () => {
    if (!statusSeen) resolveExit(1);
  });

  return {
    stdin,
    exited,
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}
