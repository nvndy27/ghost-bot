# ADR 0003 — Separate protocol discovery from execution authorization

Status: Accepted for Phase 0.

Use read-only, opt-in probes before implementing provider adapters. The Codex probe uses a temporary profile and stdio. The OpenClaw probe delegates the handshake to the upstream CLI, locked to the default loopback gateway. Ollama discovery uses loopback GET requests. Print only allowlisted summary fields.

The daemon owns a versioned event projection and capability gating. Catalog results inform model and effort selection. Permission claims require independent execution evidence for each runtime and mode. An observed approval event alone cannot establish that all privileged actions are intercepted.

The existing Electron, daemon and hybrid runtime architecture stays in place. The CLI health probe establishes reachability only. Building its native Gateway client still requires scoped pairing, lifecycle handling and boundary tests.
