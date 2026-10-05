# KAI Hour Key Contracts

This directory is the production-compatible contract seam for the account-bound KAI Hour Key runtime. It defines the domain vocabulary, ports, JSON contracts, and pure policy functions shared by local and deployment implementations.

This package owns normalized contracts and Runtime orchestration. Live provider execution, persistence, secret issuance, transport, legacy `market-gateway` integration, and preview integration are separate adapters or composition-root concerns; they can be injected through the existing ports without moving provider or storage logic into the domain package.

## Design intent

### One account key, many authorization grants

`key_id` identifies the account-bound KAI key. A model or provider change is represented by a new `AuthorizationGrant` (or a revised grant version) attached to the same key. The runtime evaluates the grant at request time; callers do not create a new key merely because the active model changes.

The grant limits execution to an explicit model/provider/region scope. An execution request outside it returns `SCOPE_EXPANSION_REQUIRED` until the account receives an appropriate grant. `allowProviderSwitch` is a boolean authorization field, defaulting to false; `canExecuteAlternative` checks this permission together with resource scope. It is a candidate policy check, while execution also needs a valid grant, a Holding bound to that grant and resource, both active time windows, and explicit selection. Runtime dispatch currently uses the requested provider or the Holding default; adding routing adapters is a separate integration.

### Hidden runtime policy

`trigger_mode`, tool exposure, scope checks, and provider switching rules are runtime policy. They are not product copy that the user must understand. User-facing adapters should render the resulting Offer, Holding, or Receipt, while keeping the policy decision and reason code available for audit.

### Deep seams

The public seams are small and replaceable:

- `KeyVerifierPort`: verify an opaque KAI key and resolve its account/grants.
- `OfferCatalogPort`: read current KAI Offers; it never executes compute.
- `HourKeyPackagingPort`: wrap a real market Offer as a KAI Hour Key Offer; it changes packaging state, not market truth. Its command carries `accountId`, the source `offer`, and an `idempotencyKey`; repeated commands return the same packaged Offer.
- `HourKeyPackagingStorePort`: atomically persist the packaged Offer for `(accountId, idempotencyKey)`; deployment implementations should use a database unique constraint and transaction.
- `HoldingPort`: read, lock, and consume an existing Holding.
- `ProviderAdapterPort`: adapt one upstream provider to KAI's normalized execution shape and receive the execution idempotency token.
- `UsageExecutionLedger`: resume Provider success, Holding consumption, and Receipt commit by request hash and idempotency key.
- `ReceiptWriterPort`: append a normalized usage Receipt.
- `ClockPort`: make hour boundaries deterministic in tests.

Pure functions in `src/` sit in front of these ports and decide intent, scope, and hour-window state. Local tests call the same functions used by deployment implementations; provider SDKs belong inside provider adapters and are not required by the pure policy layer.

## Contract flow

```text
user request
  -> classifyIntent (pure)
  -> evaluateIntent / evaluateScope (pure)
  -> selected port
       compute      -> UsageExecutionLedger -> ProviderAdapterPort / HoldingPort / ReceiptWriterPort
       discovery   -> OfferCatalogPort
       lock        -> OfferCatalogPort.get -> HourKeyPackagingPort -> HoldingPort
       receipt     -> ReceiptWriterPort
  -> normalized result
```

The normal compute path never calls an Offer catalog. Ambiguous discovery intent asks before querying. Provider switching is never implicit. Compute requires an explicit Idempotency-Key of at least eight characters. The Usage Execution Ledger records Provider success, Holding consumption, and Receipt commit so a retry can resume at the first incomplete state. A Receipt is generated only after a successful usage event and records `hourKeyStatus='packaged'` together with the Offer/Holding that authorized it.

## Slot boundary

The window has three independent instants: `slot_start`, `lock_deadline`, and `slot_end`.

- Before `lock_deadline`: read and lock are allowed when the grant permits them.
- At or after `lock_deadline` and before `slot_start`: a new lock is denied.
- At or after `slot_start` and before `slot_end`: compute is allowed when the grant and Holding permit it.
- At or after `slot_end`: compute and lock are denied; Receipt reads remain possible.

All comparisons use ISO-8601 instants after parsing. Implementations must not use local wall-clock strings for authorization.

## Files

- `types/index.d.ts`: domain types and normalized results.
- `ports/index.d.ts`: provider-neutral ports/adapters.
- `ports/runtime.d.ts`: the single application seam and discriminated responses.
- `RequestHasherPort` is required by the Runtime Facade; the production implementation must hash a normalized request, never substitute `requestId`.
- `schema/*.schema.json`: wire contracts; secrets are intentionally absent.
- `types/errors.d.ts` and `schema/runtime-error.schema.json`: stable denial/error vocabulary.
- `openapi/kai-hour-key.openapi.json`: gateway transport contract; `baseUrl` is supplied by deployment configuration, with a local development default. The gateway maps an internal `RuntimeResponse.kind='policy'` decision to the structured `runtime-error` wire shape; Runtime error responses already use that shape directly.
- `src/policy.mjs`: pure intent, scope, and slot-state decisions.
- `src/intent.mjs`, `src/scope.mjs`, `src/time.mjs`: replaceable pure seams used by policy.
- `src/source-policy.mjs`: canonicalizes `kai.com` fact URLs; arbitrary model-provided URLs are rejected.
- `src/runtime.mjs`: injected-port Runtime Facade; a lock reads and validates the current Offer, checks its resource against the selected grant, packages it, and only then writes Holding.
- `src/adapters/reference-market.mjs`: read-only projection of the existing `pricing.kai.com/v1` market; it preserves real market eligibility as `executionEligible=true` and marks the separate KAI packaging state as `hourKeyStatus='unpackaged'`.
- `src/adapters/hour-key-packaging.mjs`: packaging adapter with an injected atomic store; it preserves market facts and provides idempotent status transition. Its default store is process-local for unit tests.
- `src/adapters/json-hour-key-packaging-store.mjs`: restart-readable local adapter using an exclusive lock and atomic rename; production deployments should replace it with a transactional database adapter.
- `src/usage-ledger.mjs`: resumable usage state machine; it avoids repeating recorded Provider, Holding, or Receipt steps.
- `src/adapters/json-usage-execution-ledger-store.mjs`: restart-readable local ledger store; production deployments should use a transactional execution ledger.
- `src/staging-rehearsal.mjs`: local fenced transaction and immutable-artifact rehearsal; it is evidence for the staging seam, not a production database or deployment implementation.
- `StagingTransactionalStorePort` in `ports/index.d.ts`: replaceable snapshot/transaction boundary for release state; the current in-memory store is only one adapter.
- `StagingTargetPort` in `ports/index.d.ts`: replaceable deployment destination boundary for inspection, activation, health checks, and rollback; `src/adapters/local-staging-target.mjs` is a network-disabled dry-run adapter.
- `src/release-user-result.mjs`: pure redacted projection from internal release decisions to the four user-facing states.
- `src/staging-release-facade.mjs`: composition seam that accepts a candidate version and obtains manifest, checks, and fence internally.
- `scripts/staging-gate-verify.mjs`: deterministic local release-gate evidence for artifact manifests, health-check decisions, automatic rollback, blocking without a verified previous artifact, and gate idempotency.
- `scripts/staging-target-verify.mjs`: deterministic local deployment-target evidence; it records the dry-run boundary, activation, health failure, and rollback without claiming real staging.
- `src/staging-service.mjs` / `scripts/staging-service.mjs`: loopback-only runtime entry exposing `/healthz` and `/version` from an immutable release manifest.
- `src/staging-artifact-slots.mjs`: local two-slot release store retaining current and previous immutable artifacts with digest verification and rollback.
- `scripts/staging-runtime-verify.mjs`: local runtime evidence joining version reporting, health checks, and two-slot rollback.
- `src/adapters/dahono-router-provider.mjs`: separate OpenAI-compatible Dahono Router adapter with bounded SSE parsing, usage/diagnostic mapping, and safe error classification; network is disabled by default.
- `scripts/dahono-live-smoke.mjs`: explicit-confirmation single-request live gate; it records redacted evidence only.
- `scripts/install-dahono-staging-secret.sh`: hidden-input helper that writes `DAHONO_API_KEY` to the GitHub `staging` Environment without printing its value.
- `StagingReleaseFacade.preview({ version })` / `.publish({ version })`: user-facing release entry points; the system obtains manifest, checks, and fence internally, then returns only a readable status, message, version, and next action.
- `test/contracts.test.mjs` and `test/hour-key-packaging.test.mjs`: Node's built-in test runner exercising policy, wire, packaging, restart, concurrency, and corrupt-state seams.
- `test/runtime.test.mjs`, `test/usage-ledger.test.mjs`, and `test/support/fakes.mjs`: orchestration, recovery, idempotency, and provider-token tests.

Run the contract tests with:

~~~sh
npm test
~~~

To produce CI evidence locally, run the same locked-install sequence used by the workflow:

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run ci:verify -- --output-dir evidence/ci
~~~

The verifier writes a machine-readable JSON record, the raw test log, and a LATEST.json pointer under evidence/ci/. The record includes the test exit code, runtime versions, and a SHA-256 fingerprint of the source files. The workspace-level CI/CD evidence policy is documented in ../../docs/CI_CD_EVIDENCE.md.

Deployment adapters should be added behind these stable contracts. A real provider key must be injected through a secret manager or local environment; it must never be committed into this directory. Each adapter must document its authoritative source, failure behavior, and acceptance evidence.

Release execution keeps two views separate. The internal `release()` result is used for audit and evidence; `StagingReleaseFacade` returns `可发布`, `已激活`, `已自动回滚`, or `需要处理` so callers do not need to inspect source commits, lockfile digests, runtime ranges, Provider models, or gate IDs. `可发布` is side-effect-free preflight; an executed activation remains `已激活`.

Market truth and KAI packaging are separate facts. `executionEligible` describes whether the source Offer is a current execution candidate; `hourKeyStatus` describes whether KAI has wrapped that Offer as a KAI Hour Key. An Offer can therefore be real and execution-eligible while still being `unpackaged`; account scope, the selected Grant, Holding resource scope, both Offer/Holding time windows, and provider policy remain runtime checks before execution.

The catalog mode `market_data` describes read access to supply facts, not a permanent execution restriction. On a confirmed lock, Runtime reads the current Offer, preserves `unavailable` as unavailable, rejects stale or untrusted facts, evaluates the Offer resource against the selected Grant, checks the Offer lock deadline, calls `HourKeyPackagingPort`, and writes Holding only after a packaged eligible Offer is returned. A packaging failure, including an unavailable market Offer, is retryable when the source may recover and never creates a partial Holding. The required `hour_key_status` wire field and `hourKeyStatus` domain field are therefore a cross-seam lifecycle state, not an internal note; successful Usage Receipts record the packaged state explicitly. Deployment packaging stores must enforce an atomic unique constraint for `(accountId, idempotencyKey)`; the JSON adapter and restart/concurrency tests model that persistence seam. This contract update also renames the catalog mode `reference_only` to `market_data`; consumers should update together. JSON Schema defaults are annotations: grant issuers should explicitly supply the boolean permission.

## Account continuity and Receipt retention

The same account-bound `key_id` may reference multiple active grants. A model or provider change is represented by a new `scopeEpoch`/grant version; it is not a reason to issue a new user-facing Key. The policy selects a grant by account, requested resource, capability, and time instead of taking the first grant in storage.

The Usage Execution Ledger state sequence is `started → provider_succeeded → holding_consumed → receipt_committed`. A local JSON store proves restart recovery; production still requires a transactional ledger row and an upstream Provider idempotency contract before claiming effective-once execution.

The account Key's `expires_at` is the credential lifecycle; it does not equal an hourly slot. A Grant/Holding closes Compute at its own `slot_end`. `receipt_until` is a separate read window, so a user can inspect a private Receipt after the hour has ended without reopening Compute. Public GEO proof is always a redacted projection; full Holding and private Receipt data remain account-scoped.
