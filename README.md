# Crimson feedback relay

Runs on Deno Deploy. Players' Crimson launchers send their feedback here (`POST /feedback`); every message is kept
in Deno KV. The owner's Crimson Inbox app reads them (`GET /inbox`, owner key). The source of truth is
`tools/feedback-relay/main.ts` in the Crimson Client project.
