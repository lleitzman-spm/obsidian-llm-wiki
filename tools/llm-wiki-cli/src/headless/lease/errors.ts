export type LeaseErrorCode =
  | 'LEASE_BUSY'
  | 'LEASE_FROZEN'
  | 'LEASE_STALE'
  | 'LEASE_INVALID';

export class LeaseError extends Error {
  readonly code: LeaseErrorCode;

  constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}

export class LeaseBusyError extends LeaseError {
  constructor(message = 'The headless writer lease is already held.') {
    super('LEASE_BUSY', message);
    this.name = 'LeaseBusyError';
  }
}

export class LeaseFrozenError extends LeaseError {
  constructor(message = 'The headless writer is frozen and refuses acquisition or writes.') {
    super('LEASE_FROZEN', message);
    this.name = 'LeaseFrozenError';
  }
}

export class StaleLeaseError extends LeaseError {
  constructor(message = 'The writer lease is stale, expired, released, or fenced out.') {
    super('LEASE_STALE', message);
    this.name = 'StaleLeaseError';
  }
}
