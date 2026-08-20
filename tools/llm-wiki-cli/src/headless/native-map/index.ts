export {
  analyzeNativeSource,
  createNativeMapPolicy,
  mapNativeSource,
} from './adapter';

export type {
  NativeAliasProposal,
  NativeClaimProposal,
  NativeConceptProposal,
  NativeContradictionProposal,
  NativeEntityProposal,
  NativeMapArtifact,
  NativeMapArtifactKind,
  NativeMapClient,
  NativeMapExistingPage,
  NativeMapInput,
  NativeMapIR,
  NativeMapPolicy,
  NativeMapPolicyInput,
  NativeMapSettings,
  NativeMapSource,
  NativeMention,
  NativeRelatedProposal,
} from './types';
export {
  NATIVE_MAP_CONTRACT_VERSION,
  NATIVE_MAP_DEFAULT_EXTRACTED_AT,
  NATIVE_MAP_PROMPT_VERSION,
  NativeMapProtocolError,
} from './types';
