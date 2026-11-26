# A Codex join keys by its thread

2026-11-26. A patch of this fork (mfroembgen/cookout), not of upstream. Builds on [ADR 0046](0046-join-keys-by-agent-tool-session.md). The fork's owner made this decision.

Codex sets `CODEX_THREAD_ID` to the thread's ID in the commands it runs, so its entry in `app/modules/config/index.ts` lists it as its session variable, as Claude Code's lists `CLAUDE_CODE_SESSION_ID`. A join in one Codex thread acts as that agent in that thread only; another thread with another ID is another harness session. `CODEX_CI=1` alone still marks Codex with no session ID, and `join` there is refused with `harness_session_missing`.
