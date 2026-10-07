# KAI Hour Key Contracts

This directory is the production-compatible contract seam for the account-bound KAI Hour Key runtime. It defines the domain vocabulary, ports, JSON contracts, and pure policy functions shared by local and deployment implementations.

This package owns normalized contracts and Runtime orchestration. Live provider execution, persistence, secret issuance, transport, legacy `market-gateway` integration, and preview integration are separate adapters or composition-root concerns; they can be injected through the existing ports without moving provider or storage logic into the domain package.

## Local Exchange business entry

Run `node scripts/exchange-sandbox-verify.mjs` from this directory for repeatable acceptance. It creates an ephemeral account key and synthetic Holding, exercises real loopback HTTP, and writes sanitized `evidence/exchange-entry/` results with source hashes. It never resolves supplier credentials or calls a live Provider. No manual key setup is required.

`createExchangeServer({ runtime })` exposes authenticated `POST /v1/compute` and private `GET /v1/receipts/{receipt_id}`. Other OpenAPI paths remain candidates and are marked accordingly. Compute returns private `{ output, receipt }`; Receipt reads return no model body. The transport fixes intent by route, independent of prompt text. Body limit is 64 KiB/32 levels, default admission 8, body timeout 5 seconds and execution response timeout 30 seconds; loopback binding is mandatory. HTTP 503 `EXCHANGE_BUSY` is local admission, not upstream capacity proof. A 504 or client disconnect does not release the permit until underlying execution settles and does not prove cancellation.

`createExchangeSandbox` fixes the Provider to the local sandbox and supplies one synthetic preauthorized account/Holding. Account Key lifetime is independent of the hourly Grant. This is non-streaming and memory-only, with no real account issuance, booking, payment or staging deployment. A future production composition root can inject the existing Provider/storage ports without changing HTTP routing.

`createExchangeSandbox` now composes `ReservationUsageLedger` with one shared `MemoryReservationStore`. Short atomic reservations admit different requests on the same Holding concurrently when units are available; only one caller may claim a given account/idempotency key. Provider I/O occurs outside the store mutation. The existing `UsageExecutionLedger` remains supported with the Runtime's Holding-level serial guard; only a server-injected ledger declaring `admissionMode='atomic-reservation'` selects the new path. A request body cannot enable that mode.

Same-key retries within authorization return saved output and Receipt without another deduction, including the last unit. An operation admitted before the hour closes may finish settlement after it closes; a new Compute remains denied. An independent authorized HTTP recovery path for previously unfinished settlement or private output retrieval after expiry is still to be built. Existing committed Receipts remain readable during their receipt window. Unknown Provider outcomes retain a pending reservation and never automatically resend or release it. Old ledger entries without binding metadata fail closed and need explicit trusted migration. Neither local claims nor a request hash establish exactly-once upstream execution.

The reservation slice has completed local technical verification and awaits user acceptance; it is not automatically `ACCEPTED`. Its shared-store and snapshot reconstruction tests are in-process evidence, not disk durability, cross-process transactions, or fencing. The next integration is a production transaction store and an authorized recovery/reconciliation seam with separate evidence. No new paid Provider window is part of this work.

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
- `UsageExecutionLedgerPort`: return private output and Receipt through either the compatible serial ledger or the reservation ledger.
- `ReservationStorePort`: atomically claim and reserve an operation, advance owned states, and expose account-scoped Holding/balance data. One store owns both reservations and their Holding balance; it does not call a Provider.
- `ReceiptWriterPort`: atomically insert or return the same account/idempotency-bound Receipt candidate; conflicting payloads fail without a new row.
- `ClockPort`: make hour boundaries deterministic in tests.

Pure functions in `src/` sit in front of these ports and decide intent, scope, and hour-window state. Local tests call the same functions used by deployment implementations; provider SDKs belong inside provider adapters and are not required by the pure policy layer.

## Contract flow

```text
user request
  -> classifyIntent (pure)
  -> evaluateIntent / evaluateScope (pure)
  -> selected port
       compute      -> UsageExecutionLedgerPort -> ProviderAdapterPort / ReceiptWriterPort
                        legacy: HoldingPort.consume
                        reserved: ReservationStorePort claim / commit / release
       discovery   -> OfferCatalogPort
       lock        -> OfferCatalogPort.get -> HourKeyPackagingPort -> HoldingPort
       receipt     -> ReceiptWriterPort
  -> normalized result
```

The normal compute path never calls an Offer catalog. Ambiguous discovery intent asks before querying. Provider switching is never implicit. Compute requires an explicit Idempotency-Key of at least eight characters. Both ledger paths record successful settlement stages. The reservation path also records dispatch uncertainty and prepares a validated, immutable Receipt before calling its writer; writer output must match that candidate. A Receipt records `hourKeyStatus='packaged'` together with the Offer/Holding that authorized it.

## Slot boundary

The window has three independent instants: `slot_start`, `lock_deadline`, and `slot_end`.

- Before `lock_deadline`: read and lock are allowed when the grant permits them.
- At or after `lock_deadline` and before `slot_start`: a new lock is denied.
- At or after `slot_start` and before `slot_end`: compute is allowed when the grant and Holding permit it.
- At or after `slot_end`: new Compute and lock are denied; authorized Receipt reads remain possible. Already admitted in-flight execution may finish settlement without issuing another Provider request.

All comparisons use ISO-8601 instants after parsing. Implementations must not use local wall-clock strings for authorization.

## Files

- `types/index.d.ts`: domain types and normalized results.
- `ports/index.d.ts`: provider-neutral ports/adapters.
- `ports/runtime.d.ts`: the single application seam and discriminated responses.
- `ports/reservations.d.ts`: reservation commands, eight states, entry binding, private reconstruction snapshot, and store interface.
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
- `src/reservation-usage-ledger.mjs`: claims and reserves before Provider I/O, retains uncertain outcomes, and prepares a bound Receipt before external writing; supports recovery from recorded success without redispatch.
- `src/reservation-store.mjs`: shared in-process atomic claim/balance adapter with owner/state/payload validation and checked snapshot reconstruction. A snapshot contains private Provider output and is not public evidence or durable persistence.
- `src/exchange-sandbox.mjs`: local composition root using the reservation store as the authoritative Holding balance and a fixed sandbox Provider.
- `tsconfig.json` and `tsconfig.reservations.json`: strict declaration checks plus actual `checkJs` implementation checking for `src/reservation-store.mjs`; other `.mjs` files are not yet covered by this static implementation check.
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
- `src/concurrency-quota-acceptance.mjs` and `src/adapters/quota-sandbox-provider.mjs`: provider-neutral burst-result harness and network-disabled quota adapter; the harness validates responses/usage without depending on private adapter telemetry or asserting transport isolation.
- `scripts/dahono-live-smoke.mjs`: explicit-confirmation single-request live gate; it records redacted evidence only.
- `scripts/concurrency-quota-verify.mjs`: local 10+1 concurrency/quota evidence writer; it records redacted results under `evidence/provider-concurrency-quota/`.
- `src/dahono-capacity-acceptance.mjs` and `scripts/dahono-capacity-verify.mjs`: explicit-confirmation live collector, gated by a one-hour window and a confirmed booking ID; at most 14 inference calls and 2 telemetry reads within five minutes, with no retries. The CLI hashes `DAHONO_BOOKING_SLOT_ID`; a mismatched chat slot stops further work. Sampling depends on successful booked calls and a matching baseline, independently of overflow.
- `src/dahono-capacity-assessment.mjs`: pure shared assessment for live collection and historical replay. Separates ten successful calls, booked identity, discovery consistency, SSE overlap, overflow 429, attribution, and small-sample accounting. Discovery drift cannot erase successful calls; missing capacity proof stays `not_proven`. Explicit phase/index/timing prevents accounting samples from becoming invented overload evidence. Full hourly throughput is outside this probe; legacy v1 compatibility does not rewrite old evidence.
- `scripts/install-dahono-staging-secret.sh`: hidden-input helper that writes `DAHONO_API_KEY` to the GitHub `staging` Environment without printing its value.
- `StagingReleaseFacade.preview({ version })` / `.publish({ version })`: user-facing release entry points; the system obtains manifest, checks, and fence internally, then returns only a readable status, message, version, and next action.
- `test/contracts.test.mjs` and `test/hour-key-packaging.test.mjs`: Node's built-in test runner exercising policy, wire, packaging, restart, concurrency, and corrupt-state seams.
- `test/runtime.test.mjs`, `test/usage-ledger.test.mjs`, and `test/support/fakes.mjs`: orchestration, recovery, idempotency, and provider-token tests.
- `test/reservation-store.test.mjs`, `test/reservation-usage-ledger.test.mjs`, and `test/reservation-runtime.test.mjs`: shared-store claims, actual overlapping local execution, balance conservation, unknown results, Receipt preparation, reconstruction, and hour-boundary tests. The Exchange verification script also records a separate real loopback HTTP overlap scenario.

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

The compatible legacy Usage Execution Ledger sequence remains `started → provider_succeeded → holding_consumed → receipt_committed`. Its existing JSON adapter has its own restart evidence; that evidence is not transferred to the new reservation store.

The reservation ledger has eight states. Its successful path is `reserved → dispatching → provider_succeeded → committed → receipt_prepared → receipt_committed`; `reserved` or `dispatching` may become `released` only when the ledger knows it has not invoked the Provider, and `dispatching → uncertain` keeps its reservation. No automatic transition releases or resends an uncertain operation. `receipt_prepared` already counts as committed usage and stores the validated Receipt candidate for writer retries.

The in-memory invariant is `total = available + reserved + committed`; `Holding.unitsRemaining` includes reserved units, so availability is `unitsRemaining - reserved`. A claim and reservation are one mutation, and committing one reservation decrements the Holding once. The memory adapter's `snapshot()` deep-copies private reconstruction data and restoration cross-checks entries, balances, bindings, and settlement snapshots. This helper is not required by the production store interface, whose four operations are asynchronous. It does not write storage, prove recovery after machine failure, or provide cross-process fencing. Production still needs a transaction adapter, durable execution claims and explicit reconciliation for unknown upstream results.

The account Key's `expires_at` is the credential lifecycle; it does not equal an hourly slot. A Grant/Holding closes Compute at its own `slot_end`. `receipt_until` is a separate read window, so a user can inspect a private Receipt after the hour has ended without reopening Compute. Public GEO proof is always a redacted projection; full Holding and private Receipt data remain account-scoped.
