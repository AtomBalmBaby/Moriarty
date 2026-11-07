# Copilot task: complete Twinny evidence-first integration

Read `TWINNY_EVIDENCE_MANIFESTO.md` in the repository root. **That file is the authoritative engineering contract for this task.** Follow its P0 -> P1 -> P2 order, reuse the existing implementation, and do not create competing subsystems. Do not mistake a long manifesto for a request to implement every subsection simultaneously.

## Immediate P0 target

The live source-location test succeeded (`read_file` at `src/extension/tools/workspace.ts:169–216`, snapshot hash `xxh64:d5c69eebc0ba0792`), yet the next lookup returned `{"ok":true,"facts":[],"total":0}`. A completed/passed TODO also appeared with `"evidence":[]`. Diagnose the **actual production path** from tool observation, through task acceptance, to accepted-fact promotion and SQLite lookup. Reproduce the bug in a test first. Fix atomic persistence/recovery and correct project-wide retrieval, including the `readFile`/`read_file` identity issue if relevant. Do not 'fix' this simply by removing a filter without proving the fact exists.

Implement the authorization contract: **all conversations in a project may read one another's TODOs and all evidence (with trust status preserved), but only a conversation may modify its own TODO state.** Never allow cross-project access; derive project identity from host context, not model claims. Enforce at repository mutation boundaries.

Verify a complete two-chat same-project and third-chat other-project scenario, including repository close/reopen, retained provenance, zero redundant source reads on a fresh lookup, and rejection of cross-chat writes.

## Next priorities if P0 is green

1. Finish deterministic evidence verification so an objectively proven function location does **not** call Cerebras. Unknown/disproven is never passed. Complete source/tool/command verification criteria where safely grounded.
2. Enforce the **no administrative TODOs** law in planner prompts, titles, descriptions and *each criterion*, with bounded corrective retry and preservation of real TODO-system engineering requests. Repair already malformed plans safely.
3. Fix follow-up lifecycle after a completed plan: new substantive user requests receive an independent planning decision; `track:false` remains valid for trivial questions but never blocks evidence lookup.
4. Preserve the successful three-call broad-read workflow, avoid repeated source reads, and reduce routine INFO noise while retaining DEBUG/TRACE diagnostics.
5. Add real integrated tests through production boundaries; do not substitute helper-only tests.

## Execution discipline

Inspect files before editing. Implement complete vertical slices; verify each one. Run TypeScript, build, build-tests, lint, full standalone/SQLite and extension-host tests (using a Node runtime that actually runs SQLite), plus `git diff --check`. Keep existing Stop, Feedback proposal, user approval and MCP behavior working. No placeholders, weakened tests, auto-commits or generated reports. Do not ask routine implementation questions when the manifesto supplies the answer.

End with a **brief** report: confirmed root cause, changed files, production-path tests, actual pass/fail/skip counts, remaining requirements. If unfinished, say precisely what's left. The goal is working evidence reuse, **not** a prettier test count.
