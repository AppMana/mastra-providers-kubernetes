import { describe, expect, it } from 'vitest';
import type { V1Status } from '@kubernetes/client-node';
import { exitCodeFromStatus } from './exec';
import { KubernetesSandbox } from './index';

const auth = {
  strategy: 'tokenExchange',
  tokenUrl: 'https://idp.example.com/token',
  clientId: 'app',
  audience: 'serverclient',
  subjectToken: () => 'token',
  server: 'https://kubernetes.example.com:6443',
} as const;

describe('KubernetesSandbox namespace guard', () => {
  it('accepts per-user namespaces', () => {
    const sandbox = new KubernetesSandbox({
      namespace: 'user-7f3a1b2c-9d4e-4f5a-8b6c-1d2e3f4a5b6c',
      sandboxTemplateName: 'workspace-base',
      auth,
    });
    expect(sandbox.namespace).toBe('user-7f3a1b2c-9d4e-4f5a-8b6c-1d2e3f4a5b6c');
    expect(sandbox.sandboxName).toBe(`ws-${sandbox.id}`);
  });

  it('rejects namespaces outside the tenant pattern', () => {
    for (const namespace of ['default', 'kube-system', 'inference', 'userland', 'user-../etc']) {
      expect(
        () =>
          new KubernetesSandbox({
            namespace,
            sandboxTemplateName: 'workspace-base',
            auth,
          }),
      ).toThrow(/does not match the tenant namespace pattern/);
    }
  });

  it('honors a custom namespace pattern', () => {
    const sandbox = new KubernetesSandbox({
      namespace: 'workspace-smoke',
      sandboxTemplateName: 'workspace-base',
      auth,
      namespacePattern: /^workspace-[a-z-]+$/,
    });
    expect(sandbox.namespace).toBe('workspace-smoke');
  });
});

describe('exitCodeFromStatus', () => {
  it('maps Success to 0', () => {
    expect(exitCodeFromStatus({ status: 'Success' } as V1Status)).toBe(0);
  });

  it('extracts the exit code from NonZeroExitCode causes', () => {
    const status = {
      status: 'Failure',
      reason: 'NonZeroExitCode',
      details: { causes: [{ reason: 'ExitCode', message: '42' }] },
    } as V1Status;
    expect(exitCodeFromStatus(status)).toBe(42);
  });

  it('falls back to 1 for unknown failures', () => {
    expect(exitCodeFromStatus({ status: 'Failure', reason: 'InternalError' } as V1Status)).toBe(1);
    expect(exitCodeFromStatus(undefined)).toBe(1);
  });
});
