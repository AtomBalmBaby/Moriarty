# Moriarty Context Management — Compaction Policy Addendum

**Priority:** P1 — immediate addition to the context-management plan

**Implementation order:** Integrate into the existing context-management work when resumed after Git integration and the queued authorization fixes. Do not interrupt the current Stage 4 run.

## Observed evidence (2026-11-27)

- Configured context capacity: 524,288 tokens.
- Before compaction: 404,608 tokens (77.17% occupancy).
- After compaction: 310,386 tokens (59.20% occupancy).
- Reclaimed: 94,222 tokens (23.29% of the previous prompt).
- Cached prefix fell to 11,404 tokens; ordinary subsequent requests resumed approximately 99.8% reuse.
- The observed rebuild took approximately 24 minutes. A second compaction subsequently occurred during the same Stage 4 task; its duration and reclaimed token count have not been measured here.
- These observations are consistent with compaction-driven prefix invalidation; the precise trigger must be verified in Moriarty's implementation and logs.

## Immediate requirements

1. Separate effective model/provider context capacity, operational headroom, compaction trigger and compaction target. Never inflate the reported capacity to compensate for policy.
2. Compute capacity headroom in absolute tokens from the pending request's generation/reasoning allowance (avoid double counting), protocol overhead, tool-result admission needs and estimation uncertainty. Tool output size does not inherently scale with context occupancy. Retain percentage-based policy as an optional heuristic, particularly for small models, not a universal rule.
3. Treat actual context exhaustion as a hard failure boundary. Proactively prevent admission of requests that exceed effective capacity. Account for provider-specific limits and tokenizer uncertainty; recover explicitly from context-length failures without replaying accepted mutations.
4. Decouple trigger and target. Use meaningful hysteresis: reclaim sufficient space to avoid repeated shallow compactions and amortize the cost of KV reconstruction. Candidate targets of 64K–128K for the observed large-context workload are experiments, not mandatory limits or assumed safe compression ratios.
5. Preserve durable intent, constraints, accepted decisions, current task state, pending interactions, recent working context and evidence references. Keep complete tool results in persistent evidence storage and retrieve them on demand. Explicitly identify partial delivery; never silently truncate or substitute a summary for required evidence.
6. Estimate tool-result token cost before admission. Handle unexpected large results by persisting them and using explicit retrieval/continuation or compaction as appropriate. Preserve the existing evidence integrity contract.
7. Preserve stable prompt prefixes wherever practical; measure the actual reusable prefix after compaction. Do not assume all providers expose cache telemetry or support prefix reuse.
8. Expose configurable policy and report the reason for each compaction, effective context capacity, calculated headroom, pre/post token counts, tokens reclaimed, retained evidence references and next eligible trigger. Avoid repeated compaction without meaningful progress; report a bounded failure when no safe target can be achieved.

## Immediate telemetry

Track per event and cumulative per session:
- Compaction count, reason and policy version.
- Context size before/after, absolute and relative tokens reclaimed.
- Summary/compaction generation time and subsequent prefill/rebuild time, separately.
- Reused and invalidated prefix tokens when measurable; explicitly mark unavailable data rather than estimating it as fact.
- Time and token growth between compactions; repeated compaction count.
- Total elapsed time, inference time, tool time, compaction overhead and approval/user-answer waiting time (avoid double counting overlapping intervals).

## Follow-on adaptive controller

Use measured, model/backend-specific prefill and decode curves, prefix reuse, anticipated remaining workload, evidence retrieval costs and context quality indicators to decide whether proactive compaction pays for itself. Keep performance-based decisions independent of the hard capacity constraint. Do not assume linear performance scaling or require this controller to be complete before implementing the immediate requirements.

## Acceptance tests

- Small and large effective context capacities use truthful limits and operation-specific absolute headroom.
- Identical tool results have identical admission costs regardless of current context occupancy, subject to actual serialization/tokenization.
- Large-context compaction reclaims meaningful headroom without losing required intent, task state or evidence access.
- A compaction followed by ordinary tool calls reuses a stable prefix where supported.
- Repeated shallow compactions are prevented or explicitly diagnosed.
- Oversized results, provider context exhaustion, cancellation and restart are recoverable without repeating completed mutations.
- Telemetry distinguishes compaction work, cache rebuilding and approval waiting; missing provider telemetry is explicitly represented.
- Compare representative workloads against the current policy for completion time, compaction count, reclaimed tokens, cache reuse and correctness. Do not accept compression ratio alone as evidence of improvement.

## Integration note

Review the existing `docs/Moriarty_Context_Management_Implementation_Plan.md` and its stage dependencies before incorporating this addendum. Reuse existing evidence, intent, budget and telemetry contracts; avoid creating a parallel subsystem. This note records requirements only; no repository changes have been made.
