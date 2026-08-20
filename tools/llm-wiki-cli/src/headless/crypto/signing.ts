import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
  type KeyPairKeyObjectResult,
} from 'node:crypto';

import {
  DOMAINS,
  digestFromHex,
  digestHex,
  domainBytes,
  hashCanonical,
  type DomainName,
} from './domains';
import type { JsonValue } from './canonical-json';

export class CryptoVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CryptoVerificationError';
    this.code = code;
  }
}

export type KeyMaterial = KeyObject | string | Uint8Array;

export interface DelegationConstraints {
  runId?: string;
  workerId?: string;
  sourceIdentity?: string;
  partition?: string;
  /** Fencing/lease generation bound to this key. */
  fence?: number | string;
}

export interface Signer {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly scopes: readonly string[];
  readonly constraints?: DelegationConstraints;
}

export interface TrustedKeyRecord {
  readonly keyId: string;
  readonly publicKey: KeyMaterial;
  readonly scopes?: readonly string[];
  readonly parentKeyId?: string;
  readonly constraints?: DelegationConstraints;
}

export interface KeyRecord {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly scopes: readonly string[];
  readonly parentKeyId?: string;
  readonly constraints?: DelegationConstraints;
}

export interface SignedEnvelope<T extends JsonValue = JsonValue> {
  readonly version: 'spm-brain/signed/v1';
  readonly domain: DomainName;
  readonly keyId: string;
  readonly digest: string;
  readonly signature: string;
  readonly payload: T;
}

/** Wire signature shape used by the checked-in headless-ingest contracts. */
export interface ContractSignature {
  readonly key_id: string;
  readonly algorithm: 'Ed25519';
  readonly signature: string;
  readonly signed_digest: string;
}

export interface KeyDelegation {
  readonly version: 'spm-brain/key-delegation/v1';
  readonly domain: typeof DOMAINS.COORDINATOR_DELEGATION_SIGNATURE;
  readonly keyId: string;
  readonly parentKeyId: string;
  readonly publicKey: string;
  readonly scopes: readonly string[];
  readonly runId?: string;
  readonly workerId?: string;
  readonly sourceIdentity?: string;
  readonly partition?: string;
  readonly fence?: number | string;
  readonly digest: string;
  readonly signature: string;
}

export interface VerificationContext extends DelegationConstraints {
  requiredScope?: string;
}

function toPrivateKey(material: KeyMaterial): KeyObject {
  const key = material instanceof Object && 'type' in material
    ? material as KeyObject
    : typeof material === 'string'
      ? createPrivateKey(material)
      : createPrivateKey({ key: Buffer.from(material), format: 'der', type: 'pkcs8' });
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Only Ed25519 private keys are supported');
  }
  return key;
}

function toPublicKey(material: KeyMaterial): KeyObject {
  const key = material instanceof Object && 'type' in material
    ? material as KeyObject
    : typeof material === 'string'
      ? createPublicKey(material)
      : createPublicKey({ key: Buffer.from(material), format: 'der', type: 'spki' });
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Only Ed25519 public keys are supported');
  }
  return key;
}

function publicKeyDer(key: KeyObject): Buffer {
  const exported = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(exported as Buffer);
}

function publicKeyFromDerBase64(value: string): KeyObject {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw new CryptoVerificationError('invalid-public-key', 'Delegated public key is not valid base64');
  }
  if (bytes.length === 0) throw new CryptoVerificationError('invalid-public-key', 'Delegated public key is empty');
  return toPublicKey(bytes);
}

function normalizedScopes(scopes: readonly string[] | undefined): readonly string[] {
  const values = [...(scopes ?? [])];
  if (values.some(scope => typeof scope !== 'string' || scope.trim() === '')) {
    throw new TypeError('Key scopes must be non-empty strings');
  }
  if (new Set(values).size !== values.length) {
    throw new TypeError('Key scopes must not contain duplicates');
  }
  return [...new Set(values)].sort();
}

function assertFence(value: unknown, label: string): asserts value is number | string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return;
  }
  if (typeof value === 'string' && value.length > 0) return;
  throw new TypeError(`${label} must be a non-empty string or non-negative safe integer`);
}

function normalizedConstraints(constraints: DelegationConstraints | undefined): DelegationConstraints | undefined {
  if (!constraints) return undefined;
  const result: DelegationConstraints = {};
  for (const key of ['runId', 'workerId', 'sourceIdentity', 'partition'] as const) {
    const value = constraints[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Delegation ${key} must be non-empty`);
      result[key] = value;
    }
  }
  if (constraints.fence !== undefined) {
    assertFence(constraints.fence, 'Delegation fence');
    result.fence = constraints.fence;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const DELEGATION_CONSTRAINT_KEYS = ['runId', 'workerId', 'sourceIdentity', 'partition', 'fence'] as const;

/** A delegated key may only remove authority from its parent. */
function assertDelegationAttenuates(
  parentScopes: readonly string[],
  parentConstraints: DelegationConstraints | undefined,
  childScopes: readonly string[],
  childConstraints: DelegationConstraints | undefined,
): void {
  for (const scope of childScopes) {
    if (!parentScopes.includes(scope)) {
      throw new CryptoVerificationError(
        'scope-attenuation',
        `Delegation scope ${scope} is not held by the parent; recursive delegation may not escalate privileges`,
      );
    }
  }
  for (const key of DELEGATION_CONSTRAINT_KEYS) {
    const parentValue = parentConstraints?.[key];
    if (parentValue !== undefined && childConstraints?.[key] !== parentValue) {
      throw new CryptoVerificationError(
        'constraint-attenuation',
        `Delegation ${key} must retain the parent's constrained value`,
      );
    }
  }
}

/** Generate an ephemeral Ed25519 key pair for a worker/coordinator. */
export function generateEd25519KeyPair(): KeyPairKeyObjectResult {
  return generateKeyPairSync('ed25519');
}

/** Key IDs are lowercase SHA-256 of the DER-encoded Ed25519 SPKI key. */
export function keyIdForPublicKey(material: KeyMaterial): string {
  const key = toPublicKey(material);
  return createHash('sha256').update(publicKeyDer(key)).digest('hex');
}

export function publicKeyBase64(material: KeyMaterial): string {
  return publicKeyDer(toPublicKey(material)).toString('base64');
}

export function createSigner(
  material: KeyMaterial,
  options: { scopes?: readonly string[]; keyId?: string; constraints?: DelegationConstraints } = {},
): Signer {
  const privateKey = toPrivateKey(material);
  const publicKey = createPublicKey(privateKey);
  const keyId = keyIdForPublicKey(publicKey);
  if (options.keyId !== undefined && options.keyId !== keyId) {
    throw new TypeError(`Signer key ID does not match its public key: ${options.keyId}`);
  }
  const constraints = normalizedConstraints(options.constraints);
  return {
    keyId,
    publicKey,
    privateKey,
    scopes: normalizedScopes(options.scopes),
    ...(constraints ? { constraints } : {}),
  };
}

/** Sign the domain separator followed by the raw 32-byte digest. */
export function signDigest(domain: DomainName, digest: Uint8Array, privateKey: KeyMaterial): string {
  if (digest.byteLength !== 32) throw new TypeError('Ed25519 signatures require a raw 32-byte digest');
  const key = toPrivateKey(privateKey);
  const signature = cryptoSign(null, Buffer.concat([domainBytes(domain), Buffer.from(digest)]), key);
  return signature.toString('base64');
}

/** Verify a signature over domain || raw digest. */
export function verifyDigest(
  domain: DomainName,
  digest: Uint8Array,
  signature: string,
  publicKey: KeyMaterial,
): boolean {
  if (digest.byteLength !== 32) return false;
  try {
    const key = toPublicKey(publicKey);
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64) return false;
    return cryptoVerify(
      null,
      Buffer.concat([domainBytes(domain), Buffer.from(digest)]),
      key,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export function signPayload(domain: DomainName, payload: JsonValue, signer: Signer): {
  digest: string;
  signature: string;
} {
  const digest = hashCanonical(domain, payload);
  return { digest: digestHex(digest), signature: signDigest(domain, digest, signer.privateKey) };
}

export function createSignedEnvelope<T extends JsonValue>(
  domain: DomainName,
  payload: T,
  signer: Signer,
): SignedEnvelope<T> {
  const signed = signPayload(domain, payload, signer);
  return {
    version: 'spm-brain/signed/v1',
    domain,
    keyId: signer.keyId,
    ...signed,
    payload,
  };
}

export function verifySignedEnvelope<T extends JsonValue>(
  envelope: SignedEnvelope<T>,
  publicKey: KeyMaterial,
): boolean {
  try {
    if (envelope.version !== 'spm-brain/signed/v1') return false;
    const digest = hashCanonical(envelope.domain, envelope.payload);
    if (envelope.digest !== digestHex(digest)) return false;
    return verifyDigest(envelope.domain, digest, envelope.signature, publicKey);
  } catch {
    return false;
  }
}

export function createContractSignature(
  domain: DomainName,
  signedDigest: string,
  signer: Signer,
): ContractSignature {
  const digest = digestFromHex(signedDigest);
  return {
    key_id: signer.keyId,
    algorithm: 'Ed25519',
    signature: signDigest(domain, digest, signer.privateKey),
    signed_digest: signedDigest,
  };
}

export function verifyContractSignature(
  domain: DomainName,
  signature: ContractSignature,
  registry: KeyRegistry,
  context?: VerificationContext,
): void {
  if (signature.algorithm !== 'Ed25519') {
    throw new CryptoVerificationError('wrong-algorithm', `Unsupported signature algorithm: ${signature.algorithm}`);
  }
  const record = registry.require(signature.key_id, context);
  if (!verifyDigest(domain, digestFromHex(signature.signed_digest), signature.signature, record.publicKey)) {
    throw new CryptoVerificationError('invalid-signature', `Invalid ${domain} signature from ${signature.key_id}`);
  }
}

interface DelegationPayload {
  readonly version: 'spm-brain/key-delegation/v1';
  readonly keyId: string;
  readonly parentKeyId: string;
  readonly publicKey: string;
  readonly scopes: readonly string[];
  readonly runId?: string;
  readonly workerId?: string;
  readonly sourceIdentity?: string;
  readonly partition?: string;
  readonly fence?: number | string;
}

function delegationPayload(input: {
  keyId: string;
  parentKeyId: string;
  publicKey: string;
  scopes: readonly string[];
  runId?: string;
  workerId?: string;
  sourceIdentity?: string;
  partition?: string;
  fence?: number | string;
}): DelegationPayload {
  return {
    version: 'spm-brain/key-delegation/v1',
    keyId: input.keyId,
    parentKeyId: input.parentKeyId,
    publicKey: input.publicKey,
    scopes: input.scopes,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
    ...(input.sourceIdentity !== undefined ? { sourceIdentity: input.sourceIdentity } : {}),
    ...(input.partition !== undefined ? { partition: input.partition } : {}),
    ...(input.fence !== undefined ? { fence: input.fence } : {}),
  };
}

export function createKeyDelegation(input: {
  parentSigner: Signer;
  childPublicKey: KeyMaterial;
  scopes: readonly string[];
  runId?: string;
  workerId?: string;
  sourceIdentity?: string;
  partition?: string;
  fence?: number | string;
}): KeyDelegation {
  if (!input.parentSigner.scopes.includes('spm-brain-key-delegate')) {
    throw new CryptoVerificationError('scope-denied', `Signer ${input.parentSigner.keyId} lacks scope spm-brain-key-delegate`);
  }
  const childKey = toPublicKey(input.childPublicKey);
  const keyId = keyIdForPublicKey(childKey);
  const parentKeyId = input.parentSigner.keyId;
  if (keyId === parentKeyId) {
    throw new CryptoVerificationError('self-delegation', `Key ${parentKeyId} may not delegate to itself`);
  }
  const scopes = normalizedScopes(input.scopes);
  if (scopes.length === 0) throw new TypeError('A delegation must grant at least one scope');
  const constraints = normalizedConstraints({
    runId: input.runId,
    workerId: input.workerId,
    sourceIdentity: input.sourceIdentity,
    partition: input.partition,
    fence: input.fence,
  });
  assertDelegationAttenuates(input.parentSigner.scopes, input.parentSigner.constraints, scopes, constraints);
  const payload = delegationPayload({
    keyId,
    parentKeyId,
    publicKey: publicKeyBase64(childKey),
    scopes,
    ...constraints,
  });
  const signed = signPayload(DOMAINS.COORDINATOR_DELEGATION_SIGNATURE, payload, input.parentSigner);
  return {
    version: payload.version,
    keyId: payload.keyId,
    parentKeyId: payload.parentKeyId,
    publicKey: payload.publicKey,
    scopes: payload.scopes,
    ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
    ...(payload.workerId !== undefined ? { workerId: payload.workerId } : {}),
    ...(payload.sourceIdentity !== undefined ? { sourceIdentity: payload.sourceIdentity } : {}),
    ...(payload.partition !== undefined ? { partition: payload.partition } : {}),
    ...(payload.fence !== undefined ? { fence: payload.fence } : {}),
    domain: DOMAINS.COORDINATOR_DELEGATION_SIGNATURE,
    digest: signed.digest,
    signature: signed.signature,
  };
}

function assertContext(record: KeyRecord, context: VerificationContext | undefined): void {
  if (!context) return;
  if (context.requiredScope !== undefined && !record.scopes.includes(context.requiredScope)) {
    throw new CryptoVerificationError('scope-denied', `Key ${record.keyId} lacks scope ${context.requiredScope}`);
  }
  for (const key of DELEGATION_CONSTRAINT_KEYS) {
    const constrained = record.constraints?.[key];
    const requested = context[key];
    if (constrained !== undefined && constrained !== requested) {
      throw new CryptoVerificationError('scope-denied', `Key ${record.keyId} is not delegated for ${key}=${requested ?? '<missing>'}`);
    }
  }
}

function normalizeTrustedRecord(input: TrustedKeyRecord | Signer): KeyRecord {
  const publicKey = toPublicKey(input.publicKey);
  const expected = keyIdForPublicKey(publicKey);
  if (input.keyId !== expected) throw new CryptoVerificationError('key-id-mismatch', `Key ID ${input.keyId} does not match its public key`);
  return {
    keyId: expected,
    publicKey,
    scopes: normalizedScopes(input.scopes),
    ...(('parentKeyId' in input && input.parentKeyId) ? { parentKeyId: input.parentKeyId } : {}),
    ...(input.constraints ? { constraints: normalizedConstraints(input.constraints) } : {}),
  };
}

export class KeyRegistry {
  private readonly records = new Map<string, KeyRecord>();

  constructor(trustedKeys: readonly (TrustedKeyRecord | Signer)[] = []) {
    for (const trustedKey of trustedKeys) this.addTrustedKey(trustedKey);
  }

  addTrustedKey(input: TrustedKeyRecord | Signer): KeyRecord {
    const record = normalizeTrustedRecord(input);
    const existing = this.records.get(record.keyId);
    if (existing && publicKeyBase64(existing.publicKey) !== publicKeyBase64(record.publicKey)) {
      throw new CryptoVerificationError('key-id-collision', `Trusted key ID collision: ${record.keyId}`);
    }
    if (existing) {
      const scopesMatch = existing.scopes.length === record.scopes.length
        && existing.scopes.every((scope, index) => scope === record.scopes[index]);
      const constraintsMatch = DELEGATION_CONSTRAINT_KEYS.every(key => existing.constraints?.[key] === record.constraints?.[key]);
      if (!scopesMatch || !constraintsMatch || existing.parentKeyId !== record.parentKeyId) {
        throw new CryptoVerificationError(
          'key-replacement',
          `Trusted key ${record.keyId} already exists and may not be privilege-replaced`,
        );
      }
      return existing;
    }
    this.records.set(record.keyId, record);
    return record;
  }

  addDelegation(delegation: KeyDelegation): KeyRecord {
    const parent = this.records.get(delegation.parentKeyId);
    if (!parent) throw new CryptoVerificationError('unknown-key', `Unknown delegation parent key: ${delegation.parentKeyId}`);
    if (!parent.scopes.includes('spm-brain-key-delegate')) {
      throw new CryptoVerificationError('scope-denied', `Delegation parent ${delegation.parentKeyId} lacks scope spm-brain-key-delegate`);
    }
    if (delegation.domain !== DOMAINS.COORDINATOR_DELEGATION_SIGNATURE) {
      throw new CryptoVerificationError('wrong-domain', 'Delegation uses the wrong signature domain');
    }
    const payload = delegationPayload({
      keyId: delegation.keyId,
      parentKeyId: delegation.parentKeyId,
      publicKey: delegation.publicKey,
      scopes: normalizedScopes(delegation.scopes),
      runId: delegation.runId,
      workerId: delegation.workerId,
      sourceIdentity: delegation.sourceIdentity,
      partition: delegation.partition,
      fence: delegation.fence,
    });
    if (!verifySignedEnvelope({
      version: 'spm-brain/signed/v1',
      domain: delegation.domain,
      keyId: delegation.parentKeyId,
      digest: delegation.digest,
      signature: delegation.signature,
      payload,
    }, parent.publicKey)) {
      throw new CryptoVerificationError('invalid-signature', 'Delegation signature is invalid');
    }
    const publicKey = publicKeyFromDerBase64(delegation.publicKey);
    const expectedKeyId = keyIdForPublicKey(publicKey);
    if (expectedKeyId !== delegation.keyId) {
      throw new CryptoVerificationError('key-id-mismatch', 'Delegated key ID does not match its public key');
    }
    if (expectedKeyId === parent.keyId) {
      throw new CryptoVerificationError('self-delegation', `Key ${parent.keyId} may not delegate to itself`);
    }
    const scopes = normalizedScopes(delegation.scopes);
    const constraints = normalizedConstraints(delegation);
    assertDelegationAttenuates(parent.scopes, parent.constraints, scopes, constraints);
    const existing = this.records.get(expectedKeyId);
    if (existing) {
      throw new CryptoVerificationError(
        'key-replacement',
        `Delegated key ${expectedKeyId} already exists and may not be privilege-replaced`,
      );
    }
    const record: KeyRecord = {
      keyId: expectedKeyId,
      publicKey,
      scopes,
      parentKeyId: delegation.parentKeyId,
      ...(constraints
        ? { constraints }
        : {}),
    };
    this.records.set(record.keyId, record);
    return record;
  }

  get(keyId: string): KeyRecord | undefined {
    return this.records.get(keyId);
  }

  require(keyId: string, context?: VerificationContext): KeyRecord {
    const record = this.records.get(keyId);
    if (!record) throw new CryptoVerificationError('unknown-key', `Unknown signing key: ${keyId}`);
    assertContext(record, context);
    return record;
  }

  verifyEnvelope<T extends JsonValue>(envelope: SignedEnvelope<T>, context?: VerificationContext): void {
    const record = this.require(envelope.keyId, context);
    if (!verifySignedEnvelope(envelope, record.publicKey)) {
      throw new CryptoVerificationError('invalid-signature', `Invalid ${envelope.domain} signature from ${envelope.keyId}`);
    }
  }

  entries(): readonly KeyRecord[] {
    return [...this.records.values()];
  }
}

export function createKeyRegistry(input: {
  trustedKeys?: readonly (TrustedKeyRecord | Signer)[];
  delegations?: readonly KeyDelegation[];
} = {}): KeyRegistry {
  const registry = new KeyRegistry(input.trustedKeys ?? []);
  for (const delegation of input.delegations ?? []) registry.addDelegation(delegation);
  return registry;
}

/** Validate a delegation against a parent record without mutating a registry. */
export function verifyDelegation(
  delegation: KeyDelegation,
  parent: TrustedKeyRecord | Signer | KeyRecord,
): KeyRecord {
  const registry = new KeyRegistry([parent]);
  return registry.addDelegation(delegation);
}

export function verifyReceiptSignature<T extends JsonValue>(
  envelope: SignedEnvelope<T>,
  registry: KeyRegistry,
  context?: VerificationContext,
): void {
  registry.verifyEnvelope(envelope, context);
}

// Keep these lower-level aliases discoverable to callers that describe the
// operation as "canonical" signing rather than envelope signing.
export const signCanonical = createSignedEnvelope;
export const verifyCanonicalSignature = verifySignedEnvelope;

// Deliberately keep digestFromHex imported/exported through this module too;
// callers verifying a serialized receipt should not have to reimplement the
// lowercase/32-byte boundary check.
export { digestFromHex, digestHex };
