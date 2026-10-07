# Titan external-prime checkpoint — 2026-10-08

This branch is an incomplete work checkpoint, not a release or merge-ready change.

## Resume state

- Codex remains the external prime; the approved integration is an MCP entry inside COS sharing the existing broker/bridge. Do not replace it with a Control API adapter.
- Preserve ordinary GPT tool use separately from GPT prime/internal-worker use. Web GPT workers must support research/review and local file changes/commands.
- Tasks 1–5 were implemented and reviewed in their earlier scope. Task 4 admission assurance is reopened. Task 6 stop/resume is partial; later product tasks must not proceed on an assumed identity guarantee.
- Shared-ingress caller attribution and unbound stop/resume remain unresolved. The two attribution-gap tests intentionally remain failing. Existing ordinary unattributed acceptance is intended baseline behavior, not evidence of an upstream bug.
- Owner union/legacy mutable owner duplication needs structural review. Do not patch by adding retries, blanket refusal, or more state without establishing the contract.
- Official ChatGPT metadata (`openai/session`, `openai/subject`) is a research candidate, not authenticated worker ownership by itself. Verify initial binding, issuer trust, missing metadata, lifecycle scope, and normal-use controls before adopting it.
- Native fresh-context review and Claude Code review have been used. Conditional enforcement is not an all-path guarantee; review findings require source adjudication.

## Checks performed at this checkpoint

- `npm run typecheck`: passed.
- `npm run test -- test/external-worker-stop.test.ts test/external-worker-attribution-gap.test.ts`: 8 passed, 2 known failures; exit 1.
- Full verification/build/live provider flow: not completed. Do not omit the failing tests or describe this checkpoint as verified implementation.

## Local continuation material

The enclosing Titan workspace contains AGENTS.md, the detailed design/plan under docs/superpowers, and a local HANDOFF.md. The ignored `.superpowers/sdd/2026-10-08-cos-external-prime/` directory contains progress and review evidence. These local materials are not published by this checkpoint; preserve them for a same-machine session and transfer them explicitly if moving machines.

Chrome profile `Titan Test` was created at the user's request. Its ChatGPT login screen is open; login has not been observed. No account/plugin/COS connection or local tool grant was configured. Continue only after the user logs in, initially with effect-free diagnostics. Strict admission versus verified connector isolation remains undecided; metadata research has priority before proposing structural additions.
