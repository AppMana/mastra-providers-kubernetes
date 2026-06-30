import { describe, expect, it, vi } from 'vitest';
import { CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
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

describe('KubernetesSandbox SandboxClaim lifecycle', () => {
  it('creates a SandboxClaim and executes against the claimed sandbox pod', async () => {
    const created: Array<Record<string, unknown>> = [];
    const patched: Array<Record<string, unknown>> = [];
    let claimCreated = false;

    const custom = {
      getNamespacedCustomObject: vi.fn(async ({ plural, name }: { plural: string; name: string }) => {
        if (plural === 'sandboxclaims' && name === 'ws-test-thread') {
          if (!claimCreated) {
            const error = new Error('not found') as Error & { code: number };
            error.code = 404;
            throw error;
          }
          return {
            status: {
              sandbox: {
                name: 'sandbox-from-claim',
              },
            },
          };
        }
        throw new Error(`unexpected get ${plural}/${name}`);
      }),
      createNamespacedCustomObject: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
        created.push(body);
        claimCreated = true;
        return body;
      }),
      patchNamespacedCustomObject: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
        patched.push(body);
        return body;
      }),
    };
    const core = {
      readNamespacedPod: vi.fn(async ({ name }: { name: string }) => ({
        metadata: { name },
        spec: { containers: [{ name: 'workspace', image: 'workspace-image' }] },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      })),
    };
    const kc = {
      makeApiClient: vi.fn(api => {
        if (api === CustomObjectsApi) return custom;
        if (api === CoreV1Api) return core;
        throw new Error('unexpected api client');
      }),
    };

    const sandbox = new KubernetesSandbox({
      id: 'test-thread',
      namespace: 'user-7f3a1b2c-9d4e-4f5a-8b6c-1d2e3f4a5b6c',
      sandboxTemplateName: 'workspace-base',
      auth,
    });
    vi.spyOn(sandbox, 'kubeConfig').mockResolvedValue(kc as never);
    vi.spyOn(sandbox.processes, 'runScript').mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });

    await sandbox.start();
    const result = await sandbox.executeCommand('pwd');

    expect(result.stdout).toBe('ok');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
      kind: 'SandboxClaim',
      metadata: {
        name: 'ws-test-thread',
        namespace: 'user-7f3a1b2c-9d4e-4f5a-8b6c-1d2e3f4a5b6c',
      },
      spec: {
        sandboxTemplateRef: { name: 'workspace-base' },
        lifecycle: { shutdownPolicy: 'Retain' },
      },
    });
    const claim = created[0] as {
      spec?: { additionalPodMetadata?: { labels?: Record<string, string> } };
    };
    expect(claim.spec?.additionalPodMetadata?.labels).toMatchObject({
      'appmana.com/managed-by': 'mastra',
      'appmana.com/workspace-id': 'test-thread',
    });
    expect(claim.spec?.additionalPodMetadata?.labels).not.toHaveProperty('app.kubernetes.io/managed-by');
    expect(core.readNamespacedPod).toHaveBeenCalledWith({
      name: 'sandbox-from-claim',
      namespace: 'user-7f3a1b2c-9d4e-4f5a-8b6c-1d2e3f4a5b6c',
    });
    expect(sandbox.podName).toBe('sandbox-from-claim');
    expect(custom.patchNamespacedCustomObject).toHaveBeenCalled();
    expect(patched.at(-1)).toMatchObject({
      spec: {
        lifecycle: {
          shutdownPolicy: 'Retain',
        },
      },
    });
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
