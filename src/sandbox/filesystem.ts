/**
 * Pod-backed WorkspaceFilesystem.
 *
 * File operations run inside the sandbox pod over `pods/exec`, with binary
 * content shuttled as base64. The backing store is the workspace PVC, so
 * files persist across suspend/resume. Suitable for code, configs, and
 * uploads; large-file transfer is capped (default 8 MiB per file).
 *
 * Requires GNU coreutils/findutils in the workspace image (the default
 * ghcr.io/appmana/workspace-base image qualifies).
 */

import { Buffer } from 'node:buffer';
import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  FilesystemInfo,
  ListOptions,
  ProviderStatus,
  ReadOptions,
  RemoveOptions,
  WorkspaceFilesystem,
  WriteOptions,
} from '@mastra/core/workspace';
import {
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  NotDirectoryError,
} from '@mastra/core/workspace';
import type { KubernetesSandbox } from './index';

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface PodFilesystemOptions {
  /** Maximum file size for read/write, in bytes. @default 8388608 (8 MiB) */
  maxFileBytes?: number;
  /** Treat the filesystem as read-only. */
  readOnly?: boolean;
}

export class PodFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name = 'PodFilesystem';
  readonly provider = 'kubernetes';
  readonly readOnly: boolean;
  readonly displayName = 'Workspace volume';
  readonly description = 'Persistent volume mounted in the workspace pod';
  status: ProviderStatus = 'pending';

  private readonly sandbox: KubernetesSandbox;
  private readonly maxFileBytes: number;

  constructor(sandbox: KubernetesSandbox, options: PodFilesystemOptions = {}) {
    this.sandbox = sandbox;
    this.id = `podfs-${sandbox.id}`;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.readOnly = options.readOnly ?? false;
  }

  get basePath(): string {
    return this.sandbox.workingDir;
  }

  getInstructions(): string {
    return [
      `Files live on the workspace volume at ${this.basePath} and persist across workspace restarts.`,
      `Paths are resolved relative to ${this.basePath}.`,
    ].join('\n');
  }

  async getInfo(): Promise<FilesystemInfo> {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      metadata: { basePath: this.basePath },
    } as FilesystemInfo;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolve(path: string): string {
    if (path.includes('\0')) throw new Error('Invalid path');
    const joined = path.startsWith('/') ? path : `${this.basePath}/${path}`;
    // Normalize without touching the pod: collapse //, resolve . and ..
    const parts: string[] = [];
    for (const part of joined.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    const normalized = `/${parts.join('/')}`;
    if (normalized !== this.basePath && !normalized.startsWith(`${this.basePath}/`)) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return normalized;
  }

  private async run(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.sandbox.ensureRunning();
    return this.sandbox.processes.runScript(script, { timeout: 60_000 });
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('Filesystem is read-only');
  }

  /** stat type char: f = regular file, d = directory, missing = '' */
  private async pathType(abs: string): Promise<'file' | 'directory' | 'other' | 'missing'> {
    const r = await this.run(
      `if [ -d ${shellQuote(abs)} ]; then echo d; elif [ -f ${shellQuote(abs)} ]; then echo f; elif [ -e ${shellQuote(abs)} ]; then echo o; else echo n; fi`,
    );
    const t = r.stdout.trim();
    return t === 'd' ? 'directory' : t === 'f' ? 'file' : t === 'o' ? 'other' : 'missing';
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const abs = this.resolve(path);
    const type = await this.pathType(abs);
    if (type === 'missing') throw new FileNotFoundError(path);
    if (type === 'directory') throw new IsDirectoryError(path);

    const r = await this.run(
      `size=$(stat -c %s ${shellQuote(abs)}); if [ "$size" -gt ${this.maxFileBytes} ]; then echo TOO_LARGE >&2; exit 42; fi; base64 -w0 ${shellQuote(abs)}`,
    );
    if (r.exitCode === 42) throw new Error(`File ${path} exceeds the ${this.maxFileBytes}-byte transfer limit`);
    if (r.exitCode !== 0) throw new Error(`readFile(${path}) failed: ${r.stderr.slice(0, 300)}`);

    const buffer = Buffer.from(r.stdout.replace(/\s/g, ''), 'base64');
    return options?.encoding ? buffer.toString(options.encoding) : buffer;
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    this.assertWritable();
    const abs = this.resolve(path);
    const buffer =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (buffer.byteLength > this.maxFileBytes) {
      throw new Error(`writeFile(${path}): content exceeds the ${this.maxFileBytes}-byte transfer limit`);
    }

    const type = await this.pathType(abs);
    if (type === 'directory') throw new IsDirectoryError(path);
    if (type === 'file' && options?.overwrite === false) throw new FileExistsError(path);

    const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
    const mkdirCmd = options?.recursive === false ? '' : `mkdir -p ${shellQuote(parent)} && `;
    if (options?.recursive === false) {
      const parentType = await this.pathType(parent);
      if (parentType !== 'directory') throw new DirectoryNotFoundError(parent);
    }

    const b64 = buffer.toString('base64');
    // Send the payload in chunks through the script body to keep argv small.
    const r = await this.run(`${mkdirCmd}printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(abs)}`);
    if (r.exitCode !== 0) throw new Error(`writeFile(${path}) failed: ${r.stderr.slice(0, 300)}`);
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    this.assertWritable();
    const abs = this.resolve(path);
    const buffer =
      typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.isBuffer(content) ? content : Buffer.from(content);
    const b64 = buffer.toString('base64');
    const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
    const r = await this.run(
      `mkdir -p ${shellQuote(parent)} && printf '%s' ${shellQuote(b64)} | base64 -d >> ${shellQuote(abs)}`,
    );
    if (r.exitCode !== 0) throw new Error(`appendFile(${path}) failed: ${r.stderr.slice(0, 300)}`);
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    this.assertWritable();
    const abs = this.resolve(path);
    const type = await this.pathType(abs);
    if (type === 'missing') {
      if (options?.force) return;
      throw new FileNotFoundError(path);
    }
    if (type === 'directory') throw new IsDirectoryError(path);
    const r = await this.run(`rm -f ${shellQuote(abs)}`);
    if (r.exitCode !== 0) throw new Error(`deleteFile(${path}) failed: ${r.stderr.slice(0, 300)}`);
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    this.assertWritable();
    const absSrc = this.resolve(src);
    const absDest = this.resolve(dest);
    if ((await this.pathType(absSrc)) === 'missing') throw new FileNotFoundError(src);
    if (options?.overwrite === false && (await this.pathType(absDest)) !== 'missing') throw new FileExistsError(dest);
    const flag = options?.recursive ? '-r ' : '';
    const r = await this.run(
      `mkdir -p $(dirname ${shellQuote(absDest)}) && cp ${flag}${shellQuote(absSrc)} ${shellQuote(absDest)}`,
    );
    if (r.exitCode !== 0) throw new Error(`copyFile(${src}, ${dest}) failed: ${r.stderr.slice(0, 300)}`);
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    this.assertWritable();
    const absSrc = this.resolve(src);
    const absDest = this.resolve(dest);
    if ((await this.pathType(absSrc)) === 'missing') throw new FileNotFoundError(src);
    if (options?.overwrite === false && (await this.pathType(absDest)) !== 'missing') throw new FileExistsError(dest);
    const r = await this.run(
      `mkdir -p $(dirname ${shellQuote(absDest)}) && mv ${shellQuote(absSrc)} ${shellQuote(absDest)}`,
    );
    if (r.exitCode !== 0) throw new Error(`moveFile(${src}, ${dest}) failed: ${r.stderr.slice(0, 300)}`);
  }

  // ---------------------------------------------------------------------------
  // Directories
  // ---------------------------------------------------------------------------

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.assertWritable();
    const abs = this.resolve(path);
    if ((await this.pathType(abs)) === 'file') throw new FileExistsError(path);
    const flag = options?.recursive === false ? '' : '-p ';
    const r = await this.run(`mkdir ${flag}${shellQuote(abs)}`);
    if (r.exitCode !== 0) throw new Error(`mkdir(${path}) failed: ${r.stderr.slice(0, 300)}`);
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    this.assertWritable();
    const abs = this.resolve(path);
    if (abs === this.basePath) throw new Error('Refusing to remove the workspace root');
    const type = await this.pathType(abs);
    if (type === 'missing') {
      if (options?.force) return;
      throw new DirectoryNotFoundError(path);
    }
    if (type !== 'directory') throw new NotDirectoryError(path);
    const cmd = options?.recursive ? `rm -rf ${shellQuote(abs)}` : `rmdir ${shellQuote(abs)}`;
    const r = await this.run(cmd);
    if (r.exitCode !== 0) throw new Error(`rmdir(${path}) failed: ${r.stderr.slice(0, 300)}`);
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    const abs = this.resolve(path);
    const type = await this.pathType(abs);
    if (type === 'missing') throw new DirectoryNotFoundError(path);
    if (type !== 'directory') throw new NotDirectoryError(path);

    const maxDepth = options?.recursive ? (options.maxDepth ?? 32) : 1;
    const r = await this.run(
      `find ${shellQuote(abs)} -mindepth 1 -maxdepth ${maxDepth} -printf '%y\\t%s\\t%l\\t%P\\n'`,
    );
    if (r.exitCode !== 0) throw new Error(`readdir(${path}) failed: ${r.stderr.slice(0, 300)}`);

    const extensions = options?.extension
      ? (Array.isArray(options.extension) ? options.extension : [options.extension]).map(e =>
          e.startsWith('.') ? e : `.${e}`,
        )
      : null;

    const entries: FileEntry[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const [typeChar, sizeStr, symlinkTarget, name] = line.split('\t');
      if (!name) continue;
      const isDir = typeChar === 'd';
      if (extensions && !isDir && !extensions.some(e => name.endsWith(e))) continue;
      entries.push({
        name,
        type: isDir ? 'directory' : 'file',
        size: isDir ? undefined : Number(sizeStr),
        isSymlink: typeChar === 'l' || undefined,
        symlinkTarget: typeChar === 'l' && symlinkTarget ? symlinkTarget : undefined,
      });
    }
    return entries;
  }

  // ---------------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------------

  async exists(path: string): Promise<boolean> {
    return (await this.pathType(this.resolve(path))) !== 'missing';
  }

  async stat(path: string): Promise<FileStat> {
    const abs = this.resolve(path);
    const r = await this.run(`stat -c '%F|%s|%W|%Y' ${shellQuote(abs)}`);
    if (r.exitCode !== 0) throw new FileNotFoundError(path);
    const [kind, sizeStr, createdStr, modifiedStr] = r.stdout.trim().split('|');
    const isDir = kind?.includes('directory') ?? false;
    const created = Number(createdStr);
    const modified = Number(modifiedStr);
    return {
      name: abs.split('/').pop() ?? abs,
      path: abs,
      type: isDir ? 'directory' : 'file',
      size: isDir ? 0 : Number(sizeStr),
      // %W is 0 when birth time is unknown; fall back to mtime.
      createdAt: new Date((created > 0 ? created : modified) * 1000),
      modifiedAt: new Date(modified * 1000),
    };
  }
}
