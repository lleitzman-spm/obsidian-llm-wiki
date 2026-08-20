# Codex/Luna host bridge

`provider-host` is the only intended boundary between the headless engine and an authorized OpenAI-Codex/Luna runtime. It is deliberately an injected capability, not a provider SDK integration.

```text
headless worker
    -> CodexHostProviderBridge
    -> CodexHostCapability.invoke(request, { signal })
    -> authorized host (Codex session / browser login / service)
    -> CodexHostResponse
```

The bridge does not import Codex collaboration internals, inspect process environment variables, read Obsidian `SecretStorage`, or create credentials. The host owns those concerns. The request and response are transient JSON values and are validated against the closed `codex-host/v1` protocol before they are sent or accepted.

## Production host contract

An authorized desktop/service host supplies:

```ts
const capability: CodexHostCapability = {
  invoke: (request, { signal }) => hostOwnedCodexCall(request, signal),
  cancel: requestId => hostOwnedCancellation(requestId),
  capacity: () => currentlyAvailableLanes,
};
```

The host adapter may use Codex collaboration agents (including Luna) outside this repository. It should keep credentials and login/session state in the host process, pass source content only for the active request, and return a bounded `CodexHostResponse`. The bridge emits metadata-only events: request id, provider/model, byte counts, status, elapsed time, and allowlisted error code. It never logs messages, source text, response text, schemas, output, authorization handles, or raw host errors.

The existing `HeadlessProviderAdapter` can receive the bridge with `createCodexHostProviderFactory`. Because that legacy client surface does not yet carry an `AbortSignal`, callers that need cancellation should use `bridge.call(params, { signal })` directly until signal plumbing is added at the outer worker boundary.

## Staging worker artifacts from Codex tasks

Codex tasks can act as the authorized host without making the plugin depend on Codex internals:

1. The task reads a source from the authority checkout and sends a transient `CodexHostRequest` to a host adapter.
2. The host asks bounded Luna workers to analyze the source and returns only the provider-neutral typed result needed by the worker.
3. The headless engine turns that result into a signed `WorkerArtifact`, validates it, and stages it in the candidate artifact spool. The host does not write native vault pages.
4. A later reducer/transaction phase owns candidate projection and readback. Only that phase can produce a receipt; a host response is not an ingest receipt.

The staging directory and artifact writer belong to the engine's transaction boundary, not this bridge. The bridge's deterministic adapter is test-only and keeps an in-memory transcript; it must not be selected for production runs.

## Safety properties

- No implicit credential discovery or fallback to API keys.
- Plain JSON only, with bounded request/response sizes and depth.
- Fair bounded in-flight queue, optional start-rate shaping, and cooperative cancellation.
- Host error messages are not copied into provider attempt evidence; only safe status/code metadata can survive.
- Responses must match the request id and protocol version and must contain a terminal status.
- Invalid, oversized, cyclic, non-finite, or non-JSON object values fail closed before host invocation; source text remains transient request data and is never placed in bridge telemetry.
