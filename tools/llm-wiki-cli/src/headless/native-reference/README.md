# Native reference runner

`native-reference/v1` is the compatibility lane for comparing the production
`WikiEngine` and native lint controller with the new headless runtime.

It is deliberately narrower than the ordinary `llm-wiki ingest` CLI:

- The caller must provide `liveRoot`, `copiedVaultRoot`, and `artifactRoot`.
  The runner resolves every root, rejects symlinks/reparse points and overlap,
  and only opens the copied vault after those checks. It never writes the live
  root.
- The caller supplies an exact settings hash binding and a source inventory.
  The runner re-hashes the copied `data.json` and selected source bytes before
  the native engine starts. Drift is a typed refusal.
- Provider authorization is an injected `{ provider, model,
  authorizationRef, createClient }` identity. The runner does not read
  `SecretStorage`, environment variables, a plaintext `apiKey`, or an OS
  keychain. The authorization reference is stored only as a SHA-256 digest in
  the binding artifact.
- A signer with the explicit `spm-brain-native-reference-sign` scope is
  required. `native-receipt.json` is the normal `headless-ingest/v1` native
  receipt signed in the `NATIVE_RECEIPT_SIGNATURE` domain.
- `native-before-snapshot.json`, `native-after-snapshot.json`,
  `native-projection.json`, `native-receipt.json`, and
  `native-reference-binding.json` are written outside the vault.

Ingest uses the production `WikiEngine.ingestSource` sequentially over the
selected inventory paths. Lint uses the native controller's non-UI `auto`
trigger. A copied settings surface with `autoSmartFix: true` is refused,
because the native controller would otherwise start Smart Fix without an
interactive approval surface. The manual lint path is not used: it opens
`LintReportModal`, which has no safe Node equivalent. If auto lint returns
without writing its report to the copied vault, the run is rejected with the
typed `lint-native-seam-unavailable` refusal rather than being reported as a
successful native comparison.

This runner is a reference/canary tool, not a live-vault command. Create the
copy with the checked-in copied-vault snapshot/preflight path first, then pass
the resulting root and exact source/settings bindings to `runNativeReference`.
