# Independent Todo Agent

This Node >=24.11 CLI uses `node:sqlite`, its own tables and typed Todo services. It calls the same emitted `@momoki/agent-core` execution loop as Momoki and consumes the public provider codec. It imports no Studio source or product schema. The model is deterministic and makes no paid requests.

From the repository root, run `pnpm agent:example:check` with the repository's pinned pnpm. The command builds and packs both libraries, installs their tarballs offline into a temporary consumer with an empty independent package store, compiles copied example sources with strict emitted declarations, then runs every process and SQLite conformance test there. It prints the retained evidence directory. Source aliases and workspace links are absent from that consumer.

For interactive local exploration, build with `pnpm --filter @momoki/agent-todo build`, then run:

```sh
node examples/agent-todo/dist/cli.js begin /tmp/todo.sqlite todo
node examples/agent-todo/dist/cli.js open /tmp/todo.sqlite RUN_ID
node examples/agent-todo/dist/cli.js approve /tmp/todo.sqlite RUN_ID CALL_ID
node examples/agent-todo/dist/cli.js resume /tmp/todo.sqlite RUN_ID
```

Each command emits JSON. A new write waits for approval by default. `reject` records an explicit rejected result without invoking the write. `open` acquires ownership and recovers durable state with zero model work; only `resume` executes. `TODO_PERMISSION=full` selects full permission. An exhausted 32-request segment requires `resume ... next-segment` explicitly.

`TodoStore` holds a SQLite transaction on a separate `.ownership` sidecar for the lifetime of the process. The business database uses short transactions. SQLite excludes a second live owner and releases the sidecar after actual process death. A run additionally carries owner/revision predicates; stale checkpoints, decisions and claims fail closed. An active execution must drain before the store closes.

Local Todo changes, evidence and completed result are serialized and committed together. Receipt/result failure or abort before COMMIT rolls everything back. A committed result wins over a lost acknowledgement; an unreadable or unknown external outcome cannot authorize replay. The example's deterministic external tool saves intent before one dispatch and retains unknown state for manual reconciliation.

The conformance suite exercises real spawned processes and readiness handshakes, SIGKILL, reopen and explicit resume after both a partial checkpoint and an already committed tool. It also covers a durable summary job killed before activation, capability loading, request segments, approvals, exact wire arguments, cancellation, stale claims, result bounds and emitted provider/privacy behavior. `TODO_HOLD=checkpoint|summary` is the deterministic process-test handshake, not an ownership timeout.

The ordinary Node22 quality/type/library-test lane discovers these sources without executing the Node24 CLI. The independent Node24 CI job runs the complete packed-consumer gate. This example is a private reference host, not an npm publication or API stability promise.
