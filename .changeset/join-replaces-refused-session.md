---
"@ai-hero/cookout": patch
---

`join` in a harness session whose stored agent session token the board refuses (`token_unknown`, as after the board was restored, `agent_session_revoked` or `agent_session_expired`) now joins and replaces it, instead of refusing with `already_joined`. If the board can't be asked, `join` fails and keeps the file. A refused verb no longer deletes the stored token; it says to run `cookout join` again. `join` reads the default board once, so a `login` running meanwhile can't send the stored token to another board, and `leave` deletes the stored token only if it is still the one it revoked.
