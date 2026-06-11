import { describe, expect, it, vi } from 'vitest';
import { PodFilesystem } from './filesystem';
import type { KubernetesSandbox } from './index';

/** Minimal sandbox stub: records scripts and replies from a queue. */
function stubSandbox(replies: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  const scripts: string[] = [];
  const sandbox = {
    id: 'test',
    workingDir: '/workspace',
    ensureRunning: vi.fn(async () => {}),
    processes: {
      runScript: vi.fn(async (script: string) => {
        scripts.push(script);
        return replies.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
      }),
    },
  } as unknown as KubernetesSandbox;
  return { sandbox, scripts };
}

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

describe('PodFilesystem path handling', () => {
  it('rejects paths that escape the workspace', async () => {
    const { sandbox } = stubSandbox([]);
    const fs = new PodFilesystem(sandbox);
    await expect(fs.readFile('../etc/passwd')).rejects.toThrow(/escapes the workspace/);
    await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/escapes the workspace/);
    await expect(fs.writeFile('a/../../../x', 'data')).rejects.toThrow(/escapes the workspace/);
  });

  it('normalizes relative paths against the working directory', async () => {
    const { sandbox, scripts } = stubSandbox([ok('f'), ok(Buffer.from('hello').toString('base64'))]);
    const fs = new PodFilesystem(sandbox);
    const content = await fs.readFile('./src/../notes.txt', { encoding: 'utf8' });
    expect(content).toBe('hello');
    expect(scripts[0]).toContain("'/workspace/notes.txt'");
  });

  it('refuses writes when read-only', async () => {
    const { sandbox } = stubSandbox([]);
    const fs = new PodFilesystem(sandbox, { readOnly: true });
    await expect(fs.writeFile('a.txt', 'x')).rejects.toThrow(/read-only/);
    await expect(fs.deleteFile('a.txt')).rejects.toThrow(/read-only/);
  });

  it('round-trips file content through base64', async () => {
    const { sandbox, scripts } = stubSandbox([ok('n'), ok()]);
    const fs = new PodFilesystem(sandbox);
    await fs.writeFile('uploads/data.bin', Buffer.from([0, 1, 2, 255]));
    const writeScript = scripts[1]!;
    expect(writeScript).toContain(Buffer.from([0, 1, 2, 255]).toString('base64'));
    expect(writeScript).toContain("base64 -d > '/workspace/uploads/data.bin'");
  });

  it('enforces the transfer size cap on writes', async () => {
    const { sandbox } = stubSandbox([ok('n')]);
    const fs = new PodFilesystem(sandbox, { maxFileBytes: 4 });
    await expect(fs.writeFile('big.bin', Buffer.alloc(5))).rejects.toThrow(/transfer limit/);
  });

  it('parses readdir output into entries', async () => {
    const { sandbox } = stubSandbox([
      ok('d'),
      ok(['d\t4096\t\tsrc', 'f\t12\t\tREADME.md', 'l\t5\t/workspace/src\tlink'].join('\n') + '\n'),
    ]);
    const fs = new PodFilesystem(sandbox);
    const entries = await fs.readdir('.');
    expect(entries).toEqual([
      { name: 'src', type: 'directory', size: undefined, isSymlink: undefined, symlinkTarget: undefined },
      { name: 'README.md', type: 'file', size: 12, isSymlink: undefined, symlinkTarget: undefined },
      { name: 'link', type: 'file', size: 5, isSymlink: true, symlinkTarget: '/workspace/src' },
    ]);
  });

  it('refuses to remove the workspace root', async () => {
    const { sandbox } = stubSandbox([]);
    const fs = new PodFilesystem(sandbox);
    await expect(fs.rmdir('.')).rejects.toThrow(/workspace root/);
  });
});
