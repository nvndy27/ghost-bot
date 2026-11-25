# ADR 0001 — hybrid runtimes (proposed)

Use app-owned orchestration and state with OpenClaw Gateway and native adapters rather than fork OpenClaw or write all agent engines. Benefits: upstream compatibility, official auth, flexible providers. Tradeoffs: differing capabilities, runtime session portability limits, security enforcement gaps. Do not nest agent loops or double-schedule. Phase 0 may revise after verification.
