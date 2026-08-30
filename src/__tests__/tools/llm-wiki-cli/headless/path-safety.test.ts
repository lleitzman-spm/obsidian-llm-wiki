import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertRootBindingUnchanged,
  assertRootPathBinding,
  captureRootBinding,
  sameRootPath,
  withExclusiveRootLock,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/path-safety';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('headless path-safety contracts', () => {
  it('binds Windows roots case-insensitively while preserving POSIX case sensitivity', () => {
    expect(sameRootPath('C:/Shadow/Vault', 'c:/shadow/vault', 'win32')).toBe(true);
    expect(sameRootPath('/Shadow/Vault', '/shadow/vault', 'linux')).toBe(false);
  });

  it('rejects a reparse-point ancestor even when the leaf lstat looks plain', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spm-path-safety-reparse-'));
    roots.push(base);
    const safe = join(base, 'safe');
    const leaf = join(safe, 'leaf');
    const outside = join(base, 'outside');
    await mkdir(leaf, { recursive: true });
    await mkdir(outside, { recursive: true });

    await expect(assertRootPathBinding(
      { requested: leaf, resolved: leaf },
      {
        lstat: async path => lstat(path),
        realpath: async path => path === safe || path === leaf ? outside : path,
      },
    )).rejects.toThrow(/reparse|ancestor|binding/i);
  });

  it('rejects a root whose realpath changes between the pre and post checks', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spm-path-safety-toctou-'));
    roots.push(base);
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    let rootRealpathCalls = 0;

    await expect(captureRootBinding(root, {
      lstat: async path => lstat(path),
      realpath: async path => {
        if (path === root && rootRealpathCalls++ > 0) return outside;
        return path;
      },
    })).rejects.toThrow(/changed|reparse|binding/i);
  });

  it('rejects replacement of a bound root even when the replacement is byte-identical', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spm-path-safety-cas-'));
    roots.push(base);
    const root = join(base, 'root');
    const replacement = join(base, 'replacement');
    await mkdir(root, { recursive: true });
    const binding = await captureRootBinding(root, {
      lstat: async path => lstat(path),
      realpath: async path => path,
    });
    await rename(root, replacement);
    await mkdir(root, { recursive: true });

    await expect(assertRootBindingUnchanged(binding, {
      lstat: async path => lstat(path),
      realpath: async path => path,
    })).rejects.toThrow(/changed|identity|binding/i);
  });

  it('serializes root-scoped work with an atomic lock and releases it after failure', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spm-path-safety-lock-'));
    roots.push(base);
    let release: (() => void) | undefined;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const held = withExclusiveRootLock(base, () => {
      enteredResolve?.();
      return new Promise<void>(resolve => { release = resolve; });
    });
    await entered;
    await expect(withExclusiveRootLock(base, async () => undefined)).rejects.toThrow(/lock/i);
    release?.();
    await held;

    await expect(withExclusiveRootLock(base, async () => undefined)).resolves.toBeUndefined();
  });
});
