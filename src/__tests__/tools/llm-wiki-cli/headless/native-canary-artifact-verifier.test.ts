import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createKeyRegistry } from '../../../../../tools/llm-wiki-cli/src/headless/crypto';
import { verifyNativeCanaryArtifacts } from '../../../../../tools/llm-wiki-cli/src/headless/verification';

describe('native canary artifact verifier', () => {
  it('refuses a missing terminal artifact set before accepting any result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spm-native-canary-verifier-'));

    await expect(verifyNativeCanaryArtifacts({
      directory,
      registry: createKeyRegistry(),
      expectedRunId: 'run-missing',
    })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'missing-artifact', path: 'live-idle-observation.json' })],
    });
  });

  it('does not accept a partial observation chain as a canary result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spm-native-canary-partial-'));
    writeFileSync(join(directory, 'live-idle-observation.json'), '{}\n', 'utf8');

    await expect(verifyNativeCanaryArtifacts({
      directory,
      registry: createKeyRegistry(),
      expectedRunId: 'run-partial',
    })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'missing-artifact', path: 'live-terminal-observation.json' })],
    });
  });
});
