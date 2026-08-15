# Workspace conflicts

`OmpWorkspaceObserver` + `WorkspaceConflictStore` provide JCode-style
stale-read awareness. Reads and writes are recorded only from observable
tool events with explicit path fields — never invented. When a write lands,
every agent that read the old hash is notified with a versioned
`workspace_conflict` (path, old/new hash, writer, bounded summary) before
its next write; the gate opens on re-read or explicit acknowledgement.

State persists in the durable ledger DB across OMP restarts. The CLI agent
surfaces conflicts as jsonl events and terminal warnings.
