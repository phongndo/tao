# Workspace + Worktree Workflow Plan

**Status**: Final implementation plan  
**Last updated**: 2026-05-18

## Summary

Tao should make parallel agent work frictionless by treating Git worktrees as daemon-owned children of
normal workspaces. The happy path is:

1. User opens/adds a workspace that points at a repository root.
2. User presses **New Worktree** on that workspace.
3. Tao immediately generates a temporary-friendly folder and branch name.
4. `taod` creates the Git worktree under Tao's worktree root.
5. The UI selects the new worktree and opens a terminal or AI CLI with `cwd = worktree.path`.
6. The user or AI agent may later rename the branch/title to reflect the actual task.

There are only two domain objects:

- **Workspace**: the user's original project checkout / repository root.
- **Worktree**: a Git worktree that belongs to one workspace.

Important modeling rule: a worktree is selectable, but it is not another workspace row. It is a child
record with its own id. The UI may render both as items in the sidebar, but the daemon model stays
simple: one `workspaces` table and one `worktrees` table.

The Electron app remains a thin client. The Zig daemon is the source of truth for workspaces,
worktrees, session cwd/env metadata, and filesystem/Git lifecycle operations.

## Final product decisions

- Use only two domain objects: `workspace` and `worktree`.
- **New Worktree** is frictionless: no required name/task dialog before creation.
- Tao creates the worktree folder and an initial Git branch before launching a shell or AI CLI.
- The generated folder is stable and should generally not be renamed.
- The Git branch is allowed to change later; the user or AI agent can rename it after the task is
  known.
- The display title/task name is separate from both the folder and branch.
- Default branch namespace is `work/<generated-folder-name>` for the first slice.
- No automatic `git fetch`, branch deletion, force removal, or destructive cleanup as hidden side
  effects.
- Renderer/UI worktree code should use plain TypeScript/Promises; Effect can remain an internal
  preload/main/shared-schema implementation detail where already used.

## Goals

- Frictionless **New Worktree** creation with no required naming step.
- First-class worktree creation from the sidebar.
- Daemon-owned workspace/worktree registry persisted in SQLite.
- Safe generated paths under Tao's worktree root.
- Generated names that are pleasant, unique, and branch-safe.
- The main workspace checkout and each worktree are selectable in the UI.
- Worktree-aware terminal and agent sessions.
- Read-only reconciliation with `git worktree list` so externally removed worktrees become visible as
  `missing` instead of silently disappearing.

## Non-goals

- No separate `projects` abstraction.
- No review UI.
- No PR UI.
- No merge/rebase UI.
- No diff approval workflow.
- No Electron-main-owned Git worktree lifecycle.
- No automatic branch deletion when removing a worktree.
- No destructive cleanup of the user's original checkout.

Git status, branch labels, and simple dirty/clean indicators are in scope only as workspace/worktree
metadata, not as a review product.

## Terms and identity model

### Workspace

A workspace points at a real repository root, usually the user's normal checkout. It is the parent for
all Tao-known worktrees for that repository.

Example:

```text
/Users/dp/code/projects/tao
```

The workspace itself remains selectable and represents the main checkout. Tao never deletes or moves
this path.

### Worktree

A worktree is a Git worktree associated with exactly one workspace. Tao-created worktrees live under
Tao's worktree root by default and are selectable alongside the workspace's main checkout.

Example:

```text
~/.tao/worktrees/tao/luminous-galileo-a13f
```

### Selection model

The active code context is either:

```text
workspace_id only                 # main checkout
workspace_id + worktree_id         # child worktree
```

Terminal sessions should keep `workspace_id` for grouping/history and add optional `worktree_id` when
running inside a worktree.

If the renderer needs a single key for tab/layout maps, derive one at the UI boundary instead of
storing it as a daemon object:

```text
workspace:<workspace_id>
worktree:<worktree_id>
```

That derived key should decode back to `workspace_id + worktree_id?` before calling daemon APIs.

## Ownership model

`taod` owns:

- workspace registry
- worktree registry
- worktree root/path generation
- branch name generation
- Git worktree create/list/remove/adopt/refresh operations
- worktree-related session cwd/env metadata
- SQLite persistence for workspace/worktree state

Electron owns:

- rendering the sidebar, tabs, and terminals
- invoking daemon RPCs
- file-picker UX for adding a workspace root
- terminal surface lifecycle
- temporary client-side caching for responsiveness

Target flow:

```text
Renderer → preload/main IPC → taod RPC → Git/filesystem/SQLite
```

Renderer state may cache daemon state, but daemon state is authoritative.

## Storage layout

Default worktree root:

```text
~/.tao/worktrees/<workspace-slug>/<generated-folder-name>
```

Examples:

```text
~/.tao/worktrees/tao/luminous-galileo-a13f
~/.tao/worktrees/tao/orbital-copernicus-82bd
~/.tao/worktrees/straycat/logical-aristotle-09ce
```

The generated folder name must **not** include a `tao-` prefix.

Use Tao's configured state root if/when `TAO_HOME` or app-data overrides exist; otherwise default to
`~/.tao`.

## Generated names

Use a Superconductor-style combinatorial name generator:

```text
<adjective>-<name>-<hex>
```

Examples:

```text
luminous-galileo-a13f
orbital-copernicus-82bd
logical-aristotle-09ce
stellar-kepler-77aa
rigorous-noether-d02c
elegant-euclid-44b0
curious-newton-c912
```

Suggested topic: scientists, philosophers, astronomers, mathematicians, inventors.

Initial adjectives:

```text
axiomatic
celestial
classical
cosmic
curious
elliptic
elegant
empirical
harmonic
heliocentric
logical
luminous
lunar
orbital
parabolic
prime
quantum
radial
rigorous
solar
stellar
synthetic
theorematic
vectorial
```

Initial names:

```text
ada
archimedes
aristotle
copernicus
curie
euclid
faraday
feynman
galileo
gauss
hypatia
kepler
lovelace
maxwell
newton
noether
plato
riemann
tesla
turing
```

Collision handling:

1. Generate `<adjective>-<name>-<hex4>`.
2. Validate folder and branch names against an allowlist: lowercase letters, numbers, and `-` for the
   folder; Git-safe `work/<folder>` for the generated branch.
3. Check the filesystem path, SQLite path/branch records, and Git refs.
4. Retry with a new random suffix on collision.
5. After several collisions, use a longer suffix.

Default branch name mirrors the folder without a Tao prefix:

```text
work/<generated-folder-name>
```

Example:

```text
folder: luminous-galileo-a13f
branch: work/luminous-galileo-a13f
```

If the user provides a branch name, Tao should still auto-generate a safe folder name unless the user
explicitly provides a folder name in advanced options.

## Branch and folder creation policy

Default behavior: Tao should create both the worktree folder and a temporary-friendly Git branch before
opening the terminal/agent. The user should not have to name the worktree up front.

Recommended default command:

```sh
git -C <workspace-root> worktree add --no-track -b <branch> <worktree-path> <start-point>
```

This one Git command:

1. creates the worktree directory if it does not exist,
2. creates the branch at `<start-point>`,
3. checks that branch out in the new directory, and
4. writes Git's worktree metadata under the repository's common Git directory.

Tao should not create the final worktree directory manually first. It should create only parent
directories such as `~/.tao/worktrees/<workspace-slug>` and let Git create/populate the final worktree
path.

Why Tao should create the branch by default:

- The sidebar can immediately show the correct branch.
- The daemon can detect branch/path collisions before launching an agent.
- The agent starts in a normal checked-out branch instead of detached HEAD.
- The workflow is deterministic and does not depend on the agent choosing a branch name.
- The user gets an instant terminal/agent and can decide the task name later.

Git has a convenience mode where `git worktree add <path>` can infer a branch from the basename of the
path. Tao should avoid relying on that because our folder names are generated implementation details
and we want branch names under an explicit namespace like `work/<folder-name>`.

Supported creation modes:

```text
auto branch, auto folder       default: branch = work/<generated-folder>
manual branch, auto folder     user supplies branch; Tao generates folder
existing branch, auto folder   advanced: checkout an existing branch if not checked out elsewhere
detached worktree              advanced/later: no branch, agent/user may create one manually
```

The agent may still create or switch branches manually after launch, because it is just running inside
a normal Git worktree. Tao should treat that as external Git activity and refresh branch metadata from
Git rather than assuming the original branch is still checked out forever.

This makes the primary flow intentionally frictionless:

```text
click + Worktree → generated branch/folder → terminal or AI CLI opens there → user gives task
```

If the task later deserves a better name, either the user or the AI CLI can rename the branch. Tao
should discover the new branch name on refresh and update the sidebar metadata.

### Superconductor-style agent launch

The Superconductor-style flow appears to be:

1. The app creates a Git worktree directory and branch first.
2. The app launches the AI CLI with `cwd` set to that worktree directory.
3. The AI CLI discovers context from normal Git commands and/or injected environment/prompt metadata.
4. The user's first task message can then cause the agent to rename/switch the branch, update the UI
   title, or simply continue using the pre-created branch.

The CLI cannot start "inside a worktree" unless the worktree directory already exists. Therefore Tao's
create-and-run-agent path should still create the Git worktree before spawning the CLI.

Important distinction:

- Worktree folder: filesystem path created/populated by `git worktree add`.
- Git branch: ref checked out inside that worktree.
- UI title/task name: user-facing label that may change after the user describes the task.

Those three names may start the same, but Tao should store them separately so a later branch rename or
task-title change does not corrupt the worktree path.

Suggested naming lifecycle:

```text
initial folder:  luminous-galileo-a13f
initial branch:  work/luminous-galileo-a13f
initial title:   luminous-galileo-a13f or "New worktree"

after prompt:    "fix login redirect loop"
branch renamed:  work/fix-login-redirect-loop
title updated:   Fix login redirect loop
folder remains:  luminous-galileo-a13f
```

Branch rename support:

```sh
# from inside the worktree whose current branch should be renamed
git branch -m <new-branch-name>
```

After a branch rename, Tao should refresh the worktree's current branch from Git. The worktree folder
does not need to be renamed, and should generally stay stable.

## Daemon data model

Add daemon SQLite tables for workspaces and worktrees only.

```text
workspaces
  id TEXT PRIMARY KEY
  name TEXT NOT NULL
  root_path TEXT NOT NULL UNIQUE
  git_common_dir TEXT
  workspace_slug TEXT NOT NULL
  default_branch TEXT
  order_index INTEGER NOT NULL DEFAULT 0
  last_active_tab_id TEXT
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  archived_at TEXT

worktrees
  id TEXT PRIMARY KEY
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  title TEXT
  folder_name TEXT NOT NULL
  path TEXT NOT NULL UNIQUE
  branch TEXT NOT NULL
  base_branch TEXT
  target_branch TEXT
  state TEXT NOT NULL CHECK(state IN (
    'creating', 'active', 'missing', 'removing', 'archived', 'error'
  ))
  order_index INTEGER NOT NULL DEFAULT 0
  last_active_tab_id TEXT
  last_error TEXT
  created_by TEXT NOT NULL DEFAULT 'tao'
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  archived_at TEXT
```

Recommended indexes:

```text
CREATE INDEX idx_workspaces_order ON workspaces(order_index);
CREATE UNIQUE INDEX idx_worktrees_workspace_folder ON worktrees(workspace_id, folder_name);
CREATE INDEX idx_worktrees_workspace_order ON worktrees(workspace_id, order_index);
CREATE INDEX idx_worktrees_state ON worktrees(state);
CREATE INDEX idx_worktrees_branch ON worktrees(workspace_id, branch);
```

Notes:

- Existing `terminal_sessions.workspace_id` should keep pointing at `workspaces.id`.
- Add nullable `terminal_sessions.worktree_id` when a session runs inside a worktree.
- Do not persist `dirty` as a lifecycle state. Dirty/clean is computed Git metadata.
- Do not persist `untracked` as a normal row state. `untracked` is a virtual result for Git worktrees
  seen during refresh that are not yet adopted into SQLite.
- Existing `pane-layouts.json` workspace entries should be migrated/imported into daemon `workspaces`
  or treated as a UI cache after daemon ownership lands.
- `git worktree list --porcelain` remains the truth for what Git currently knows. SQLite stores Tao's
  intent and UI metadata.

Recommended terminal session migration:

```text
ALTER TABLE terminal_sessions ADD COLUMN worktree_id TEXT REFERENCES worktrees(id);
CREATE INDEX idx_terminal_sessions_worktree ON terminal_sessions(worktree_id);
```

SQLite cannot add a fully enforced foreign key in all migration shapes without rebuilding the table;
if necessary, add the column first and enforce existence in daemon code until a table rebuild is worth
doing.

## Daemon RPC API

Initial workspace RPCs:

```text
workspace.list
workspace.add
workspace.remove
workspace.refresh
workspace.reorder
```

Initial worktree RPCs:

```text
worktree.list
worktree.create
worktree.remove
worktree.adopt
worktree.refresh
worktree.reorder
```

Recommended list shape:

```json
{
  "workspaces": [
    {
      "id": "...",
      "name": "tao",
      "root_path": "/Users/dp/code/projects/tao",
      "branch": "main",
      "default_branch": "main",
      "git_status": { "changed": 0, "staged": 0 },
      "worktrees": [
        {
          "id": "...",
          "workspace_id": "...",
          "title": "New worktree",
          "folder_name": "luminous-galileo-a13f",
          "path": "/Users/dp/.tao/worktrees/tao/luminous-galileo-a13f",
          "branch": "work/luminous-galileo-a13f",
          "state": "active",
          "git_status": { "changed": 2, "staged": 0 }
        }
      ]
    }
  ]
}
```

The daemon may expose flat list RPCs internally, but the desktop sidebar benefits from a nested
workspace-with-worktrees response.

Creation input:

```json
{
  "workspace_id": "...",
  "base_branch": "main",
  "target_branch": "main",
  "branch": null,
  "folder_name": null,
  "start_point": null,
  "launch": null
}
```

Creation semantics:

- `workspace_id` is required.
- `base_branch` is the default start point and should default to the workspace's current default
  branch or current branch.
- `target_branch` is metadata for future review/merge intent and should default to `base_branch`.
- `start_point`, if supplied, overrides the Git start point while leaving `base_branch` as user intent
  metadata.
- `branch = null` means generate `work/<folder_name>`.
- User-provided branches should fail if already checked out elsewhere unless an explicit
  `checkout_existing` option is added later.

Creation output:

```json
{
  "id": "...",
  "workspace_id": "...",
  "title": "New worktree",
  "folder_name": "luminous-galileo-a13f",
  "path": "/Users/dp/.tao/worktrees/tao/luminous-galileo-a13f",
  "branch": "work/luminous-galileo-a13f",
  "base_branch": "main",
  "target_branch": "main",
  "state": "active"
}
```

Error codes should be stable enough for UI handling:

```text
invalid-workspace
invalid-worktree
invalid-path
invalid-name
branch-exists
branch-checked-out
worktree-dirty
git-failed
state-conflict
unauthorized
```

Mutating RPCs should be serialized per workspace so two simultaneous `worktree.create` calls cannot
choose the same generated path/branch or race Git's worktree lock files.

## Create/remove transaction strategy

`worktree.create` should be resilient to Git failures and daemon restarts:

1. Validate workspace, names, branch, and resolved path.
2. Insert a `worktrees` row with `state = 'creating'`.
3. Run `git worktree add ...`.
4. On success, update the row to `state = 'active'`.
5. On failure, remove any partially-created path only if it is still under Tao's worktree root and is
   safe to delete, then mark the row `error` with `last_error` or delete the row if nothing was
   created.

`worktree.remove` should be similarly staged:

1. Refuse the workspace root/main checkout.
2. Check dirty status unless `force = true`.
3. Set `state = 'removing'`.
4. Run `git worktree remove`, with `--force` only when requested.
5. On success, set `state = 'archived'` and `archived_at = now`.
6. Branch deletion is a separate explicit option and should run only after worktree removal succeeds.

## Git operations

Before creating a worktree:

```sh
git -C <workspace-root> rev-parse --show-toplevel
git -C <workspace-root> rev-parse --git-common-dir
git -C <workspace-root> worktree prune
git -C <workspace-root> worktree list --porcelain -z
git -C <workspace-root> show-ref --verify --quiet refs/heads/<branch>
```

Default new branch/worktree:

```sh
git -C <workspace-root> worktree add --no-track -b <branch> <worktree-path> <start-point>
```

Existing local branch, only if it is not already checked out by another worktree:

```sh
git -C <workspace-root> worktree add <worktree-path> <branch>
```

Existing remote branch, only when requested explicitly or when the user-provided branch clearly matches
one remote branch:

```sh
git -C <workspace-root> worktree add --track -b <branch> <worktree-path> origin/<branch>
```

Dirty check before removal:

```sh
git -C <worktree-path> status --porcelain=v1 --untracked-files=normal
```

Remove worktree:

```sh
git -C <workspace-root> worktree remove <worktree-path>
```

Forced remove, only when the caller passes an explicit force flag:

```sh
git -C <workspace-root> worktree remove --force <worktree-path>
```

Optional branch deletion is a separate explicit option, not the default:

```sh
git -C <workspace-root> branch -D <branch>
```

Parsing notes:

- Prefer `--porcelain -z` so paths with spaces are handled safely.
- Track `worktree`, `HEAD`, `branch`, `detached`, `bare`, and `prunable` fields.
- Treat worktrees known to Git but not SQLite as `untracked` candidates for adoption.
- Treat SQLite worktrees missing from Git as `missing` until the user removes/archives the metadata.

Adoption should create a `worktrees` row with `created_by = 'external'`. Removing an adopted worktree
from Tao should default to unregister/archive only unless the user explicitly asks Tao to remove it
from Git.

## Safety rules

- Resolve all generated paths under Tao's configured worktree root.
- Reject path traversal and symlink escapes.
- Never delete outside the configured worktree root for Tao-managed worktree removals.
- Never remove the workspace's main checkout through `worktree.remove`.
- Refuse removal of dirty worktrees unless caller passes an explicit force flag.
- Keep the original workspace checkout safe; never run destructive cleanup there.
- If SQLite and Git disagree, show `missing` or `untracked` rather than guessing.
- Do not run `git fetch`, branch deletion, or force removal as hidden side effects.

## UI workflow

Sidebar should group worktrees under their workspace:

```text
tao
  main                         main
  luminous-galileo-a13f        work/luminous-galileo-a13f
  orbital-copernicus-82bd      work/orbital-copernicus-82bd
  logical-aristotle-09ce       work/logical-aristotle-09ce
```

Primary control:

```text
+ Worktree
```

Fast path:

```text
Click + Worktree → create immediately → open shell or default agent in the generated worktree
```

Optional create popover/dialog:

```text
Base: main
Agent: shell / pi / codex / claude
Name: auto
```

Advanced fields:

- branch
- folder name
- target branch
- start point
- worktree root override, if supported later
- run command / agent prompt
- fetch before create
- delete branch on remove, disabled by default

Default behavior after creation:

1. Add/select the new worktree.
2. Open a terminal tab in the worktree path, or launch the selected AI CLI there.
3. If an agent was selected, spawn that agent command in the terminal.

Worktree status badges:

```text
clean
changed
missing
untracked
creating
error
```

Suggested sidebar behavior:

- Clicking the workspace row opens the main checkout (`workspace_id`, no `worktree_id`).
- Clicking a worktree row opens that worktree (`workspace_id + worktree_id`).
- The **+ Worktree** action lives on the workspace row and defaults to that workspace's current/default
  branch.
- Missing worktrees remain visible with a repair/remove action instead of disappearing.

## Agent session environment

When spawning shells or agents inside a worktree, `taod` should inject:

```text
TAO_WORKSPACE_ID
TAO_WORKSPACE_ROOT
TAO_WORKTREE_ID
TAO_WORKTREE_PATH
TAO_WORKTREE_BRANCH
TAO_BASE_BRANCH
TAO_TARGET_BRANCH
```

For terminals in the main checkout, omit `TAO_WORKTREE_*` and set `TAO_WORKSPACE_ROOT` to the workspace
root path.

This requires extending daemon session spawn metadata to accept per-session environment variables and
persisting optional `worktree_id` for reattach.

## Migration from current desktop state

Current desktop state includes `pane-layouts.json` workspaces and Electron-main Git metadata helpers.
The migration should be staged:

1. Import existing layout workspaces with `projectPath != null` into daemon `workspaces`.
2. Keep layout file fields for ordering and last active tab during the transition.
3. Replace Electron-main Git worktree/branch queries with daemon RPC reads.
4. Once daemon workspaces are authoritative, make the layout file a view/layout cache only.
5. Preserve unknown or non-Git workspaces as normal selectable workspaces, but hide worktree controls
   unless `workspace.refresh` identifies a Git repository.

## Implementation phases

### Phase 0 — Contracts and inventory

- Confirm control RPC shape for non-terminal methods in `apps/daemon/src/rpc.zig`.
- Decide exact JSON field casing and shared TypeScript schemas.
- Map current `pane-layouts.json` workspace ids to future daemon workspace ids.
- Use `workspace_id + worktree_id?` as the daemon/session representation. If the renderer needs one
  string key, derive `workspace:<id>` / `worktree:<id>` in renderer-only code.
- Add fixtures for `git worktree list --porcelain -z` output.

### Phase 1 — Daemon model and generator

- Add SQLite migrations for `workspaces` and `worktrees`.
- Add nullable `worktree_id` to `terminal_sessions`.
- Add repository discovery helpers: toplevel, common git dir, default branch.
- Add name generator in Zig.
- Add path helpers for `~/.tao/worktrees/<workspace-slug>/<folder-name>`.
- Add tests for collision handling, path safety, generated-name shape, and branch-safe names.

Suggested Zig modules:

```text
apps/daemon/src/workspace.zig      # workspace DB + repository discovery
apps/daemon/src/worktree.zig       # worktree DB + Git operations
apps/daemon/src/worktree_name.zig  # generated names and validation
apps/daemon/src/git.zig            # small Git command wrappers/parsers
```

### Phase 2 — Read-only workspace/worktree RPCs

- Add `workspace.add/list/remove/refresh/reorder`.
- Add `worktree.list/refresh/adopt/reorder` without creation/removal first.
- Parse `git worktree list --porcelain -z` in Zig.
- Surface `missing` and `untracked` reconciliation states.

### Phase 3 — Mutating worktree RPCs

- Add `worktree.create` with generated folder/branch defaults.
- Add `worktree.remove` with dirty checks and explicit force support.
- Persist daemon-created worktrees transactionally.
- Mark failed operations as `error` with `last_error` when recovery is useful.

### Phase 4 — Desktop bridge and schemas

- Add TypeScript shared schemas for workspace/worktree RPC payloads.
- Add Electron bridge methods that call `taod` instead of running Git directly.
- Keep existing Git metadata queries temporarily, but migrate source of truth to daemon RPC.
- Add one-time import from layout workspaces to daemon workspaces.

TypeScript guideline:

- Do not introduce Effect as a requirement for renderer/UI worktree state management.
- Use the existing shared schema/IPC style where it already exists, including Effect Schema if that
  remains the package convention.
- Keep UI-facing APIs as plain `Promise<T>` functions and plain discriminated unions/objects.
- If an Electron main/preload service already uses Effect internally, it may continue to do so as an
  implementation detail, but worktree feature code should not require renderer components/hooks to be
  written in Effect.

### Phase 5 — Sidebar and create flow

- Render workspaces with nested worktrees.
- Add **New Worktree** instant-create button plus optional advanced popover/dialog.
- Select created worktree and open terminal with `cwd = worktree.path`.
- Show status badges and recoverable errors.

### Phase 6 — Agent launch integration

- Extend session creation to pass daemon-owned env metadata.
- Add optional create-and-run-agent flow.
- Persist optional worktree id on terminal/agent sessions for later reattach and UI grouping.

## Acceptance criteria for the first shippable slice

- Adding a Git repository creates one workspace in SQLite.
- Pressing **New Worktree** creates a worktree under `~/.tao/worktrees/<slug>/<name>`.
- The new branch defaults to `work/<name>`.
- The sidebar immediately selects the new worktree and opens a terminal or selected AI CLI there.
- Restarting Tao preserves workspaces, worktrees, and session associations.
- Removing a clean Tao-managed worktree deletes only the worktree path and archives its worktree row.
- Dirty worktree removal requires explicit force.
- External deletion shows `missing` after refresh instead of crashing or silently dropping metadata.
- If the branch is renamed inside the worktree, refresh updates Tao's branch metadata without renaming
  the folder.

## Deferred decisions after the first slice

- Whether branch namespace should become user-configurable beyond the first-slice default `work/`.
- Whether `git fetch` should be offered as an explicit create option or background action.
- Whether non-Git directories should become daemon workspaces or remain layout-only entries.
- Whether force-removal belongs in the first visible UI or only in an advanced/command-palette flow.
- Whether adopted non-Tao worktrees should ever be movable under `~/.tao/worktrees`; first slice should
  track them in place.
- Whether worktree root overrides should be supported; first slice should keep a daemon-global root for
  safety.
