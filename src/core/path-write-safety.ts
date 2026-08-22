import { PathWriteQueue } from '../wiki/engine-internals/path-write-queue';

/**
 * One canonical lease registry per vault.  The lint and startup helpers are
 * intentionally dependency-inverted and therefore do not receive WikiEngine;
 * sharing this registry keeps their writes serialized with one another.
 */
const vaultQueues = new WeakMap<object, PathWriteQueue>();

export function getVaultPathWriteQueue(
  vault: object,
  existingPaths: Iterable<string> = [],
): PathWriteQueue {
  let queue = vaultQueues.get(vault);
  if (!queue) {
    queue = new PathWriteQueue({ existingPaths });
    vaultQueues.set(vault, queue);
  } else {
    for (const path of existingPaths) queue.registerExistingPath(path);
  }
  return queue;
}

export function notifyVaultWrite(
  callback: ((path: string) => void) | undefined,
  queue: PathWriteQueue,
  path: string,
): void {
  callback?.(queue.canonicalPath(path));
}
