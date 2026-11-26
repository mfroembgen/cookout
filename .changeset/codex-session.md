---
"@ai-hero/cookout": patch
---

Inside Codex, `cookout join --as <name>` keys the agent session it keeps by `CODEX_THREAD_ID`, so the whole thread acts as the joined agent; before, Codex gave no session ID and `join` was refused with `harness_session_missing`. `CODEX_CI=1` alone still gives none.
