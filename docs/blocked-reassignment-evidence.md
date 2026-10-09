# Blocked task explicit reassignment — local evidence

Date: 2026-10-09. Base: origin/main 0b7122b (PR #8 merge). Local main was fast-forwarded without reset or discarded work.

## Reproduction before patch

Ran `HOME="$ROOT/home" node_modules/.bin/tsx --test tests/assignment.test.ts` with an isolated temporary HOME and SQLite fixtures. Both new cases failed at the expected assertion: "explicit reassignment must save a new pending dispatch". No unrelated gate failure occurred.

Exact flow for assignment POST and task PATCH:

1. Initial gateway run ends with blocked; both assignment fields clear.
2. Human posts "Now unblocked. Mark done." while unassigned. Comment persists, no dispatch is admitted.
3. Human sets todo, then assigns the original agent.
4. Before patch: no pending dispatch. After patch: one durable pending row references that human comment.
5. Fake gateway receives the continuation prompt, the same session key and expectedExistingSessionId=original-session. The continuation ends done and archives only after matching terminal evidence.

Expected-red log: /tmp/clawtask-reassignment-red.J8ENPp/red.log.

## Automated coverage

29 new assignment tests, 75 total. Covers both assignment routes; duplicates in pending/submitting/running states; recovery/outcome_required rejection; assignment/title/activity rollback on conflict; outbox insertion rollback through both APIs; another task's busy owner and delayed queue dispatch; automatic blocked no-repeat; latest unused human input; original-agent session restriction; subtask PATCH; assigned task/subtask creation; blocked creation; repeated identical completed assignment; uncertain blocked run remaining held after status-only todo.

Tests inject isolated SQLite databases and fake adapter/gateway objects. No production database or real gateway is used.

## Gates

Node v26.9.0, npm 11.19.1, Next.js 16.2.6, macOS arm64.

- `HOME="$ROOT/home" npm test`: 75 passed, 0 failed.
- `HOME="$ROOT/home" npm run typecheck`: passed.
- `HOME="$ROOT/home" NEXT_TELEMETRY_DISABLED=1 npm run build`: passed.
- `git diff --check`: passed.

Gate logs: /tmp/clawtask-reassignment-gates.UcSg3J/{test,typecheck,build}.log. These temporary logs are local supporting evidence, not repository artifacts.

Build warnings: existing experimental.instrumentationHook option is obsolete/unrecognized; Browserslist data is six months old. Test runtime warns that module.register() is deprecated. No dependency or configuration edits were made to hide those warnings.

## Limits and release boundary

No real-gateway or browser test was run for this patch. The API regression uses the actual route handlers, RunControl and adapter prompt builder with fake transport. This is not proof of Node 20 CI or production container behavior. No Docker build, push, publication, deployment, production access, gateway mutation or process termination occurred. Existing local apps on ports 3433/3434 were left alone. The generated next-env.d.ts change from the local build is restored before commit.

Johnny owns push/deploy. After parent review and an authorized release, manually verify the same blocked/comment/todo/reassign flow in the app. Keep recovery/owner conflicts held; do not delete dispatch history to make a test pass.
