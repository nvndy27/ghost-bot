# Data model — proposed SQLite schema

All IDs UUID/ULID; UTC timestamps except stored routine timezone. Foreign keys on, migrations and transactions. Runtime-specific identifiers scoped to account/runtime. Never store actual secrets here.

| Table | Key fields |
|---|---|
| agents | id, name, description, instructions, avatar_json, runtime_id, model_profile_id, workspace_path, permission_mode, archived_at |
| teams / team_members | id, name, leader_agent_id / team_id, agent_id, role |
| provider_accounts | id, provider, auth_kind, credential_ref, status, capabilities_json, checked_at |
| model_profiles | id, account_id, runtime_id, model_id, effort, options_json |
| sessions | id, agent_id, account_id, runtime_id, external_session_id, title, created_at |
| messages | id, session_id, role, content_json, created_at, run_id |
| runs | id, session_id, parent_task_id, status, model_id, effort, permission_snapshot_json, started_at, ended_at |
| run_events | id, run_id, seq, type, payload_json, timestamp; unique(run_id,seq) |
| tasks | id, parent_id, team_id, agent_id, run_id, status, input_json, result_json, budget_json |
| memories | id, owner_agent_id, team_id nullable, scope, content, provenance, created_at, expires_at |
| routines / routine_runs | id, agent_id, trigger_json, timezone, enabled, next_run_at, policy_json / id, routine_id, scheduled_at, status, run_id; unique(routine_id,scheduled_at) |
| approvals | id, run_id, tool, args_hash, scope_json, status, expires_at, decided_at |
| usage_records | id, account_id, run_id nullable, kind, value_json, source, observed_at, reset_at nullable |
| artifacts | id, run_id, path, media_type, sha256, size |
| audit_logs | id, actor, action, target, outcome, redacted_json, timestamp |
| settings | key, value_json, updated_at |

Use cascade only for clearly owned ephemeral rows; user deletion must consider artifacts and runtime remote data separately. Index sessions(agent_id,created_at), events(run_id,seq), routines(enabled,next_run_at), usage(account_id,observed_at), tasks(status). Store avatar config not redundant raster images. Persist canonical app event projection, runtime mapping and reconnect cursor; avoid duplicating full runtime databases. Migration SQL to be implemented after Phase 0.

## First migration design

Create provider accounts, model profiles, agents, sessions, runs, run events, messages and approvals in dependency order. Defer teams, memory and schedules until their vertical slices. Create the SQLite database beneath the application data directory with user-only permissions. Enable foreign keys on every connection and use one daemon writer. Keep run creation, event insertion, cursor advancement and message projection transactional.

- Store external session IDs under a unique `(runtime_id, account_id, external_session_id)` key. Bind runs to the session's account and runtime and persist the selected model, effort and permission snapshot at creation.
- Use `(run_id, seq)` as the event key, with a positive integer sequence starting at 1. Keep upstream checkpoints separate from the app sequence. Check terminal state before appending or projecting events.
- Give each client run request a unique `(session_id, idempotency_key)`. Reusing the key with different input fails. Pin message order independently of timestamps.
- Bind approvals to run, action hash, scope and expiry. Consume an allowed approval with a conditional update in a transaction. Expire outstanding approvals on restart. Keep ambiguous execution outcomes for reconciliation.
- Use opaque keyring references for credentials. Exclude raw provider payloads, private reasoning, and unredacted tool arguments from the durable event stream.
