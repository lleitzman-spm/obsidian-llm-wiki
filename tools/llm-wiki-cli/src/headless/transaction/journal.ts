import { mkdir, open, readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type {
  FileState,
  JournalEvent,
  ReadbackMismatch,
  TransactionOperation,
  TransactionPlan,
} from './types';
import { assertPlanHash } from './planner';

interface SerializedFileState {
  exists: boolean;
  hash: string | null;
  bytes: string | null;
}

interface SerializedOperation {
  kind: TransactionOperation['kind'];
  path: string;
  scope: TransactionOperation['scope'];
  preconditionHash: string | null;
  before: SerializedFileState;
  after: SerializedFileState;
}

interface SerializedPlan {
  version: TransactionPlan['version'];
  transactionId: string;
  fence: TransactionPlan['fence'];
  operations: SerializedOperation[];
  planHash: string;
}

interface SerializedJournalEvent {
  version: JournalEvent['version'];
  sequence: number;
  at: string;
  transactionId: string;
  fence: JournalEvent['fence'];
  planHash: string;
  kind: JournalEvent['kind'];
  plan?: SerializedPlan;
  operationIndex?: number;
  error?: JournalEvent['error'];
  mismatches?: readonly ReadbackMismatch[];
}

function encodeState(state: FileState): SerializedFileState {
  return {
    exists: state.exists,
    hash: state.hash,
    bytes: state.bytes === null ? null : Buffer.from(state.bytes).toString('base64'),
  };
}

function decodeState(state: SerializedFileState): FileState {
  const bytes = state.bytes === null ? null : new Uint8Array(Buffer.from(state.bytes, 'base64'));
  if (state.exists !== (bytes !== null)) throw new Error('Journal file-state existence does not match bytes');
  return { exists: state.exists, hash: state.hash, bytes };
}

function encodePlan(plan: TransactionPlan): SerializedPlan {
  return {
    version: plan.version,
    transactionId: plan.transactionId,
    fence: plan.fence,
    operations: plan.operations.map((operation) => ({
      kind: operation.kind,
      path: operation.path,
      scope: operation.scope,
      preconditionHash: operation.preconditionHash,
      before: encodeState(operation.before),
      after: encodeState(operation.after),
    })),
    planHash: plan.planHash,
  };
}

function decodePlan(plan: SerializedPlan): TransactionPlan {
  const decoded: TransactionPlan = {
    version: plan.version,
    transactionId: plan.transactionId,
    fence: plan.fence,
    operations: plan.operations.map((operation): TransactionOperation => ({
      kind: operation.kind,
      path: operation.path,
      scope: operation.scope,
      preconditionHash: operation.preconditionHash,
      before: decodeState(operation.before),
      after: decodeState(operation.after),
    })),
    planHash: plan.planHash,
  };
  assertPlanHash(decoded);
  return decoded;
}

function encodeEvent(event: JournalEvent): SerializedJournalEvent {
  return {
    version: event.version,
    sequence: event.sequence,
    at: event.at,
    transactionId: event.transactionId,
    fence: event.fence,
    planHash: event.planHash,
    kind: event.kind,
    plan: event.plan === undefined ? undefined : encodePlan(event.plan),
    operationIndex: event.operationIndex,
    error: event.error,
    mismatches: event.mismatches,
  };
}

function decodeEvent(raw: SerializedJournalEvent): JournalEvent {
  return {
    version: raw.version,
    sequence: raw.sequence,
    at: raw.at,
    transactionId: raw.transactionId,
    fence: raw.fence,
    planHash: raw.planHash,
    kind: raw.kind,
    plan: raw.plan === undefined ? undefined : decodePlan(raw.plan),
    operationIndex: raw.operationIndex,
    error: raw.error,
    mismatches: raw.mismatches,
  };
}

/**
 * Append-only JSONL journal. Prepare records contain the full plan, including
 * staged and restoration bytes, so recovery never depends on a second source
 * of truth after an interruption.
 */
export class TransactionJournal {
  private static readonly appendQueues = new Map<string, Promise<void>>();
  readonly path: string;
  private nextSequence: number | undefined;

  constructor(path: string) {
    this.path = nodePath.resolve(path);
  }

  private async readUnlocked(): Promise<JournalEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.nextSequence = 1;
        return [];
      }
      throw error;
    }
    const events: JournalEvent[] = [];
    for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
      if (line.trim() === '') continue;
      let raw: SerializedJournalEvent;
      try {
        raw = JSON.parse(line) as SerializedJournalEvent;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid transaction journal JSON at line ${lineIndex + 1}: ${detail}`);
      }
      if (raw.version !== 'transaction-journal/v1') {
        throw new Error(`Unsupported transaction journal version at line ${lineIndex + 1}`);
      }
      events.push(decodeEvent(raw));
    }
    const max = events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    this.nextSequence = max + 1;
    return events;
  }

  async read(): Promise<JournalEvent[]> {
    await (TransactionJournal.appendQueues.get(this.path) ?? Promise.resolve());
    return this.readUnlocked();
  }

  async append(event: Omit<JournalEvent, 'sequence' | 'at'> & Partial<Pick<JournalEvent, 'at'>>): Promise<JournalEvent> {
    const previous = TransactionJournal.appendQueues.get(this.path) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    TransactionJournal.appendQueues.set(this.path, previous.then(() => slot));
    await previous;
    try {
      // Another journal instance may have appended since this instance's last
      // call, so refresh the sequence while holding the process-wide queue.
      await this.readUnlocked();
      const complete: JournalEvent = {
        ...event,
        sequence: this.nextSequence ?? 1,
        at: event.at ?? new Date().toISOString(),
      };
      await mkdir(nodePath.dirname(this.path), { recursive: true });
      const handle = await open(this.path, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(encodeEvent(complete))}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.nextSequence = complete.sequence + 1;
      return complete;
    } finally {
      release();
    }
  }
}

export function latestEventsByTransaction(events: readonly JournalEvent[]): Map<string, JournalEvent> {
  const latest = new Map<string, JournalEvent>();
  for (const event of events) {
    const prior = latest.get(event.transactionId);
    if (prior === undefined || event.sequence > prior.sequence) latest.set(event.transactionId, event);
  }
  return latest;
}

export function isTerminalJournalEvent(kind: JournalEvent['kind']): boolean {
  // A frozen event is terminal for an apply attempt, but intentionally remains
  // recoverable: restore failure must not make the WAL undiscoverable.
  return kind === 'committed' || kind === 'restored' || kind === 'recovered';
}

export function pendingJournalEvents(events: readonly JournalEvent[]): JournalEvent[] {
  return [...latestEventsByTransaction(events).values()]
    .filter((event) => !isTerminalJournalEvent(event.kind))
    .sort((left, right) => left.sequence - right.sequence);
}
