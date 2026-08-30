import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';

import {
  createIsolatedInjectedRunner,
  IsolatedRunnerError,
  type IsolatedProviderCallRequest,
} from '../../../../../tools/llm-wiki-cli/src/headless/isolation';
import type { SourceInventory } from '../../../../../tools/llm-wiki-cli/src/headless/preflight/source-inventory';
import { DOMAINS } from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import {
  canonicalJsonSha256,
  sha256Hex,
  snapshotTreeHash,
  sourceIdentityDigest,
} from '../../../../../tools/llm-wiki-cli/src/headless/preflight/hashing';

const AUTHORITY_TREE = 'a'.repeat(64);
const SOURCE_PATH = 'notes/source.md';

function inventory(): SourceInventory {
  const bytes = new TextEncoder().encode('# source\n');
  const byteSha256 = sha256Hex(bytes);
  const source = {
    path: SOURCE_PATH,
    byteLength: bytes.byteLength,
    byteSha256,
    sourceIdentity: sourceIdentityDigest(AUTHORITY_TREE, SOURCE_PATH, byteSha256),
  };
  const body = {
    version: 'source-inventory/v1' as const,
    authorityTree: AUTHORITY_TREE,
    selectorVersion: 'test-selector/v1',
    includes: ['notes/**/*.md'],
    exclusions: [],
    sources: [source],
    snapshotTreeHash: snapshotTreeHash([source]),
  };
  return { ...body, inventorySha256: canonicalJsonSha256(body) };
}

function workerSource(body: string): string {
  return `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
const pending = new Map();
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
const waitFor = id => new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
rl.on('line', async line => {
  const value = JSON.parse(line);
  if (value.type === 'provider_response' || value.type === 'sign_response') {
    const waiter = pending.get(value.request_id);
    if (!waiter) throw new Error('unknown capability response');
    pending.delete(value.request_id);
    waiter.resolve(value);
    return;
  }
  if (value.type !== 'run') throw new Error('expected run');
  request = value;
  ${body}
});
`;
}

async function fixture(): Promise<{
  root: string;
  copiedVaultRoot: string;
  artifactRoot: string;
  workerScript: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'spm-isolated-runner-'));
  const copiedVaultRoot = join(root, 'copied-vault');
  const artifactRoot = join(root, 'artifacts');
  const workerScript = join(root, 'worker.mjs');
  await Promise.all([
    mkdir(copiedVaultRoot, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(copiedVaultRoot, 'placeholder.md'), 'copy only\n', { encoding: 'utf8', flag: 'w' }).then(() => undefined),
    writeFile(join(artifactRoot, '.keep'), '', { encoding: 'utf8', flag: 'w' }).then(() => undefined),
  ]);
  // The runner requires an empty artifact root so remove the marker after the
  // directory exists. The test intentionally does not share a live-vault path.
  await rm(join(artifactRoot, '.keep'));
  return {
    root,
    copiedVaultRoot,
    artifactRoot,
    workerScript,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function runnerInput() {
  return {
    runId: 'isolation-test-run',
    sourceInventory: inventory(),
    settings: {
      fullSha256: 'b'.repeat(64),
      safeProjectionSha256: 'c'.repeat(64),
    },
    sourcePaths: [SOURCE_PATH],
    writer: {
      ownerId: 'isolation-test-owner',
      runId: 'isolation-test-run',
      fence: 7,
      candidateRootSha256: 'd'.repeat(64),
    },
  } as const;
}

async function killTestProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function withFixture(
  body: string,
  run: (values: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
): Promise<void> {
  const values = await fixture();
  try {
    await writeFile(values.workerScript, workerSource(body), 'utf8');
    await run(values);
  } finally {
    await values.cleanup();
  }
}

describe('isolated injected runner', () => {
  it('runs a worker with only copied-vault roots and no inherited environment', async () => {
    await withFixture(
      "write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { copied_vault_root: request.copied_vault_root, artifact_root: request.artifact_root, source_paths: request.source_paths, test_env: process.env.ISOLATED_RUNNER_TEST } });",
      async values => {
        const seen: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-1',
          killTree: killTestProcess,
          environment: { ISOLATED_RUNNER_TEST: '1' },
          onSpawn: (file, args, options) => { seen.push({ file, args, options }); },
        });

        const result = await runner.run(runnerInput());

        expect(result.status).toBe('accepted');
        expect(result.result).toMatchObject({
          copied_vault_root: values.copiedVaultRoot,
          artifact_root: values.artifactRoot,
          source_paths: [SOURCE_PATH],
          test_env: '1',
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.file).toBe(process.execPath);
        expect(seen[0]?.args).toContain(values.workerScript);
        expect(seen[0]?.options).toMatchObject({
          cwd: values.copiedVaultRoot,
          shell: false,
          windowsHide: true,
        });
        expect(seen[0]?.options).not.toHaveProperty('env');
      },
    );
  });

  it('proxies an allowlisted provider call without exposing its response to metadata events', async () => {
    await withFixture(
      "const response = await new Promise(resolve => { const id = 'cap-provider-1'; write({ type: 'provider_call', protocol_version: 'headless-isolated-runner/v1', request_id: id, run_id: request.run_id, worker_id: request.worker_id, provider: request.provider.provider, model: request.provider.model, max_tokens: 32, messages: [{ role: 'user', content: 'transient source text' }] }); pending.set(id, { resolve }); }); write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { provider_text: response.text } });",
      async values => {
        const events: unknown[] = [];
        const calls: IsolatedProviderCallRequest[] = [];
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-2',
          killTree: killTestProcess,
          provider: {
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            authorizationRef: 'opaque-grant-2',
            call: async call => {
              calls.push(call);
              return {
                status: 'succeeded',
                text: 'secret response must stay off metadata',
                finish_reason: 'stop',
              };
            },
          },
          onEvent: event => events.push(event),
        });

        const result = await runner.run({
          ...runnerInput(),
          runId: 'provider-run',
          writer: { ...runnerInput().writer, runId: 'provider-run' },
        });

        expect(result.status).toBe('accepted');
        expect(result.result).toEqual({ provider_text: 'secret response must stay off metadata' });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          provider: 'openai-codex',
          model: 'gpt-5.6-luna',
          messages: [{ role: 'user', content: 'transient source text' }],
        });
        expect(JSON.stringify(events)).not.toContain('transient source text');
        expect(JSON.stringify(events)).not.toContain('secret response must stay off metadata');
      },
    );
  });

  it('attenuates signer domains per run and passes a sealed writer context', async () => {
    await withFixture(
      "const response = await new Promise(resolve => { const id = 'cap-sign-1'; write({ type: 'sign_request', protocol_version: 'headless-isolated-runner/v1', request_id: id, run_id: request.run_id, worker_id: request.worker_id, writer: request.writer, domain: request.signer_domains[0], digest: 'e'.repeat(64) }); pending.set(id, { resolve }); }); write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { key_id: response.key_id, signature: response.signature } });",
      async values => {
        const contexts: unknown[] = [];
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-signer',
          killTree: killTestProcess,
          signer: {
            allowedDomains: [DOMAINS.WORKER_ARTIFACT_SIGNATURE],
            sign: async (_request, options) => {
              contexts.push(options.context);
              return { status: 'succeeded', key_id: 'key-1', signature: 's'.repeat(64) };
            },
          },
        });
        const result = await runner.run({
          ...runnerInput(),
          signer: { allowedDomains: [DOMAINS.WORKER_ARTIFACT_SIGNATURE] },
        });
        expect(result.result).toEqual({ key_id: 'key-1', signature: 's'.repeat(64) });
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toEqual({
          workerId: 'worker-signer',
          runId: 'isolation-test-run',
          writer: {
            owner_id: 'isolation-test-owner',
            run_id: 'isolation-test-run',
            fence: 7,
            candidate_root_sha256: 'd'.repeat(64),
          },
          fence: 7,
          domain: DOMAINS.WORKER_ARTIFACT_SIGNATURE,
          digest: 'e'.repeat(64),
        });
      },
    );
  });

  it('refuses a signer domain outside the run attenuation before invoking the signer', async () => {
    await withFixture(
      "write({ type: 'sign_request', protocol_version: 'headless-isolated-runner/v1', request_id: 'cap-sign-2', run_id: request.run_id, worker_id: request.worker_id, writer: request.writer, domain: 'spm-brain/native-receipt-signature/v1', digest: 'e'.repeat(64) });",
      async values => {
        const sign = vi.fn(async () => ({ status: 'succeeded' as const, key_id: 'key-2', signature: 's'.repeat(64) }));
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-signer-refused',
          killTree: killTestProcess,
          signer: { sign },
        });
        await expect(runner.run({
          ...runnerInput(),
          signer: { allowedDomains: [DOMAINS.WORKER_ARTIFACT_SIGNATURE] },
        })).rejects.toMatchObject({ code: 'signer-refused' });
        expect(sign).not.toHaveBeenCalled();
      },
    );
  });

  it('refuses unsafe roots, credential-shaped environment keys, and Windows limits before spawn', async () => {
    await withFixture('', async values => {
      await expect(createIsolatedInjectedRunner({
        workerScript: values.workerScript,
        copiedVaultRoot: values.copiedVaultRoot,
        artifactRoot: values.artifactRoot,
        workerId: 'worker-3',
        killTree: killTestProcess,
        environment: { API_KEY: 'must-not-cross' },
      })).rejects.toMatchObject({ code: 'invalid-input' });

      const unsafeEnvironments: Readonly<Record<string, string>>[] = [
        { node_options: '--require=C:/outside.js' },
        { Node_Tls_Reject_Unauthorized: '0' },
        { openssl_conf: 'C:/outside.cnf' },
        { OPENSSL_MODULES: 'C:/outside-modules' },
        { Ld_PreLoad: 'C:/outside.dll' },
        { Secret_Value: 'must-not-cross' },
        { Path: 'one', PATH: 'two' },
      ];
      for (const environment of unsafeEnvironments) {
        await expect(createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-3',
          killTree: killTestProcess,
          platform: 'win32',
          environment,
        })).rejects.toMatchObject({ code: 'invalid-input' });
      }

      await expect(createIsolatedInjectedRunner({
        workerScript: 'worker.mjs',
        copiedVaultRoot: values.copiedVaultRoot,
        artifactRoot: values.artifactRoot,
        workerId: 'worker-3',
        killTree: killTestProcess,
      })).rejects.toMatchObject({ code: 'unsafe-path' });

      await expect(createIsolatedInjectedRunner({
        workerScript: values.workerScript,
        copiedVaultRoot: values.copiedVaultRoot,
        artifactRoot: values.artifactRoot,
          workerId: 'worker-3',
          killTree: killTestProcess,
        platform: 'win32',
        resourceLimits: { memoryBytes: 64 * 1024 * 1024 },
      })).rejects.toMatchObject({ code: 'resource-limits-unavailable' });

      const runner = await createIsolatedInjectedRunner({
        workerScript: values.workerScript,
        copiedVaultRoot: values.copiedVaultRoot,
        artifactRoot: values.artifactRoot,
        workerId: 'worker-3',
      });
      await expect(runner.run({
        ...runnerInput(),
        sourcePaths: ['../outside.md'],
      })).rejects.toMatchObject({ code: 'unsafe-path' });
    });
  });

  it('cancels and times out by killing the entire child tree', async () => {
    await withFixture(
      "setInterval(() => {}, 1000);",
      async values => {
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-4',
          killTree: killTestProcess,
          timeoutMs: 100,
        });
        const controller = new AbortController();
        const cancelled = runner.run({
          ...runnerInput(),
          runId: 'cancel-run',
          writer: { ...runnerInput().writer, runId: 'cancel-run' },
        }, { signal: controller.signal });
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
        await expect(runner.run({
          ...runnerInput(),
          runId: 'timeout-run',
          writer: { ...runnerInput().writer, runId: 'timeout-run' },
        })).rejects.toMatchObject({ code: 'timeout' });
      },
    );
  });

  it('installs cancellation before observer hooks run', async () => {
    await withFixture(
      "setInterval(() => {}, 1000);",
      async values => {
        const controller = new AbortController();
        const observed: string[] = [];
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-observer-abort',
          killTree: killTestProcess,
          timeoutMs: 1000,
          onEvent: event => {
            if (event.type === 'started') observed.push('started');
          },
          onSpawn: () => {
            observed.push('spawn');
            controller.abort();
          },
        });
        await expect(runner.run(runnerInput(), { signal: controller.signal }))
          .rejects.toMatchObject({ code: 'cancelled' });
        expect(observed).toEqual(['started', 'spawn']);
      },
    );
  });

  it('does not let a hung capability handler defer close after the worker exits', async () => {
    await withFixture(
      "write({ type: 'provider_call', protocol_version: 'headless-isolated-runner/v1', request_id: 'cap-hung-1', run_id: request.run_id, worker_id: request.worker_id, provider: request.provider.provider, model: request.provider.model, max_tokens: 32, messages: [{ role: 'user', content: 'bounded request' }] }); setTimeout(() => process.exit(0), 10);",
      async values => {
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-hung-capability',
          killTree: killTestProcess,
          timeoutMs: 5000,
          provider: {
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            authorizationRef: 'opaque-grant-hung',
            call: async () => new Promise(() => undefined),
          },
        });
        await expect(runner.run({
          ...runnerInput(),
          provider: {
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            authorizationRef: 'opaque-grant-hung',
          },
        })).rejects.toMatchObject({ code: 'worker-exited' });
      },
    );
  });

  it('still terminates the process tree when a terminal frame races process close', async () => {
    await withFixture(
      "write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { closed: true } }); process.exit(0);",
      async values => {
        const killed: number[] = [];
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-close-race',
          killTree: async pid => {
            killed.push(pid);
            await killTestProcess(pid);
          },
        });
        await expect(runner.run(runnerInput())).resolves.toMatchObject({ status: 'accepted' });
        expect(killed.length).toBeGreaterThan(0);
      },
    );
  });

  it('fails closed when Windows taskkill cannot prove an already-exited worker tree', async () => {
    if (process.platform !== 'win32') return;
    await withFixture(
      "write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { windows: true } }); process.exit(0);",
      async values => {
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-windows-taskkill',
          platform: 'win32',
        });
        await expect(runner.run(runnerInput())).rejects.toMatchObject({ code: 'kill-failed' });
      },
    );
  });

  it('fails closed on a hung process-tree cleanup adapter', async () => {
    await withFixture(
      "setInterval(() => {}, 1000);",
      async values => {
        let hungPid: number | undefined;
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-hung-kill',
          timeoutMs: 100,
          killTree: async pid => {
            hungPid = pid;
            return new Promise<void>(() => undefined);
          },
        });
        try {
          await expect(runner.run(runnerInput())).rejects.toMatchObject({ code: 'kill-failed' });
        } finally {
          if (hungPid !== undefined) await killTestProcess(hungPid);
        }
      },
    );
  });

  it('applies an injected OS limiter when a platform adapter is supplied', async () => {
    await withFixture(
      "write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { ok: true } });",
      async values => {
        const applied: number[] = [];
        let cleaned = false;
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-limited',
          killTree: killTestProcess,
          resourceLimits: { memoryBytes: 64 * 1024 * 1024 },
          resourceLimiter: {
            apply: pid => {
              applied.push(pid);
              return () => { cleaned = true; };
            },
          },
        });
        await expect(runner.run(runnerInput())).resolves.toMatchObject({ status: 'accepted' });
        expect(applied).toHaveLength(1);
        expect(applied[0]).toBeGreaterThan(0);
        expect(cleaned).toBe(true);
      },
    );
  });

  it('honors timeout while an injected limiter is still pending', async () => {
    await withFixture(
      "setInterval(() => {}, 1000);",
      async values => {
        let limiterSignal: AbortSignal | undefined;
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-limiter-timeout',
          killTree: killTestProcess,
          timeoutMs: 100,
          resourceLimits: { memoryBytes: 64 * 1024 * 1024 },
          resourceLimiter: {
            apply: (_pid, _limits, options) => {
              limiterSignal = options?.signal;
              return new Promise<void>(() => undefined);
            },
          },
        });
        await expect(runner.run(runnerInput())).rejects.toMatchObject({ code: 'timeout' });
        expect(limiterSignal?.aborted).toBe(true);
      },
    );
  });

  it('fails closed on unknown IPC fields and oversized output', async () => {
    await withFixture(
      "process.stdout.write(JSON.stringify({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', unexpected: 'field' }) + '\\n');",
      async values => {
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-5',
          killTree: killTestProcess,
        });
        await expect(runner.run(runnerInput())).rejects.toBeInstanceOf(IsolatedRunnerError);
      },
    );

    await withFixture(
      "process.stdout.write('x'.repeat(5000));",
      async values => {
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-6',
          killTree: killTestProcess,
          maxResponseBytes: 1024,
        });
        await expect(runner.run(runnerInput())).rejects.toMatchObject({ code: 'response-too-large' });
      },
    );
  });

  it('does not serialize function or credential-shaped properties from the input', async () => {
    await withFixture(
      "write({ type: 'result', protocol_version: 'headless-isolated-runner/v1', request_id: request.request_id, status: 'accepted', result: { provider: request.provider, writer: request.writer } });",
      async values => {
        const spawnSpy = vi.fn();
        const runner = await createIsolatedInjectedRunner({
          workerScript: values.workerScript,
          copiedVaultRoot: values.copiedVaultRoot,
          artifactRoot: values.artifactRoot,
          workerId: 'worker-7',
          killTree: killTestProcess,
          onSpawn: (_file, _args, options) => {
            spawnSpy(options);
          },
        });
        const result = await runner.run({
          ...runnerInput(),
          provider: {
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            authorizationRef: 'opaque-grant-7',
            createClient: () => ({ createMessage: async () => 'never serialized' }),
          },
        });
        expect(result.result?.provider).not.toHaveProperty('authorization_ref');
        expect(result.result?.provider).toMatchObject({
          authorization_ref_sha256: sha256Hex('opaque-grant-7'),
        });
        expect(result.result?.writer).toMatchObject({ owner_id: 'isolation-test-owner', run_id: 'isolation-test-run', fence: 7 });
        const options = spawnSpy.mock.calls[0]?.[0] as { input?: string } | undefined;
        expect(JSON.stringify(options as unknown as Record<string, unknown>)).not.toContain('createClient');
        expect(JSON.stringify(options as unknown as Record<string, unknown>)).not.toContain('opaque-grant-7');
        expect(JSON.stringify(options as unknown as Record<string, unknown>)).not.toContain('apiKey');
      },
    );
  });
});
