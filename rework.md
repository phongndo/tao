# Tau Rework Plan

Tau is pivoting from a minimal IDE/worktree workflow into a Pi-focused GUI for Pi power users. The product should feel like a small, fast native companion to Pi: a cleaner GUI over the Pi kernel, not a new AI IDE with forced workflows.

## Product Direction

Tau should be the GUI layer for Pi in the same way the Codex app is a GUI layer over Codex CLI:

- Pi is the only kernel.
- Tau provides the GUI around Pi sessions, projects, persistence, extensions, and remote control.
- The primary experience is UI chat.
- A terminal Pi view remains available as a secondary representation of the same session.
- Worktrees remain a feature, but only as temporary execution sandboxes tied to a thread or tool run.
- Tau should avoid clunky feature accumulation and avoid forcing a specific workflow.

The target user is an existing Pi power user who wants a GUI without losing the customizability, extension behavior, performance, and minimalism that makes Pi useful in the terminal.

## Core Primitive

Replace the old workspace/worktree-first model with:

```text
Project -> Project Thread -> Pi Session
```

The current code can keep compatibility while this migrates, but the product language and model should move toward:

- Project: a user-owned repo or folder.
- Project thread: a persistent conversation/session attached to a project.
- Pi session: the running Pi process or resumable Pi-owned session behind the thread.
- Temporary worktree: an optional execution isolation detail, not the primary object.

## Minimal Target UI

The first usable Tau shell should be intentionally narrow:

- Left sidebar:
  - Native traffic-light area.
  - Sidebar toggle, back, forward controls near the native buttons.
  - Search icon button, not a persistent search field.
  - Projects list.
  - Project threads nested under projects.
  - Plus project button next to the Projects header.
  - Settings at the bottom.
- Main area:
  - Minimal titlebar with active thread/project title.
  - UI chat view by default.
  - Setting or toggle to show terminal Pi view instead.
- No right side panel for now.
- No dashboard surface for extensions yet.

Search should behave like Codex search:

- A titlebar icon opens a command/search popup.
- The popup searches projects and project threads.
- It should support typing, escape to close, click outside to close, and enter to open the first result.

## Extension System

Customizability means users can change Tau's UI and workflows through extensions without Tau hardcoding every workflow.

Tau extensions are Tau-owned UI and workflow adapters. Pi remains the source of truth for kernel capabilities, slash command definitions, and session events; Tau extensions wrap those Pi primitives with renderer surfaces, project/thread actions, settings, and local presentation.

Initial extension surfaces should be constrained:

- Slash command definitions discovered from Pi and exposed through Tau extension manifests.
- Tool call renderers.
- Diff viewers.
- File viewers.
- Project/thread actions.
- Settings panels.

Do not start with arbitrary dashboard or full custom UI extensions. That makes the trust model and product surface too large too early.

The goal is for a user to ask Pi to build their Tau workflow, with enough Tau extension docs and examples available for the AI to safely implement that workflow.

## Pi Integration

The key technical question is how Pi exposes session and extension state.

Blocking verification ticket:

- Before any Pi-first UI or extension feature work, build a Pi capability probe that records whether Pi exposes structured RPC/events for assistant messages, tool calls, approvals, diffs, errors, files, and command status.
- The probe must also document how Pi discovers slash commands and extensions, how Pi persists sessions, and which state must remain Pi-owned versus indexable by Tau.
- If the probe shows that Pi exposes only terminal output or partial structure, use the narrow bridge plan below and keep the first UI pass limited to verified events.

Need to research and test:

- Does Pi expose structured RPC/events, or only terminal output?
- How does Pi represent assistant messages, tool calls, approvals, diffs, errors, files, and command status?
- How are Pi slash commands and extensions discovered?
- How does Pi persist sessions?
- What state is safe for Tau to index versus what must remain Pi-owned?

Desired direction:

- Render chat from structured Pi events, not scraped terminal output.
- Keep terminal view as a raw secondary view of the same session.
- Let Pi own persistence where possible.
- Tau can maintain lightweight indexes for projects, threads, recents, and UI state.

If Pi does not expose enough structure, build a narrow bridge or adapter and test it against real Pi behavior before designing a large abstraction.

## Trust Model

This is currently unknown and must be researched before the extension system becomes real.

Questions to answer:

- How does Pi trust or sandbox extensions?
- Can arbitrary TypeScript or scripts run?
- What filesystem access does an extension get?
- What network access does an extension get?
- Are tool calls user-approved, policy-approved, or fully automatic?
- Are slash commands trusted like local code?
- Can an extension render UI, or only provide commands/tools?
- How does Tau prevent an extension from spoofing approvals, diffs, or terminal output?

Conservative starting point:

- Treat project extensions as untrusted until explicitly enabled.
- Require clear user approval for filesystem, network, process, and remote actions.
- Keep extension UI limited to declared contribution points.
- Do not let extensions render approval controls directly.
- Keep Tau-owned security UI separate from extension-rendered content.

## Remote Control

Remote control should be first-class, not an afterthought.

Likely direction:

- A Zig daemon supervises local and remote Pi sessions.
- SSH is a first-class connection type.
- The daemon handles process lifecycle, attach/detach, logs, and health.
- The GUI talks to the daemon over a stable protocol.
- Remote sessions should preserve the same project/thread/session model as local sessions.

Open questions:

- Does the daemon run locally only, remotely, or both?
- How are credentials stored and delegated?
- How are remote files viewed or diffed?
- How are ports, shell env, and Pi binaries discovered remotely?

## Persistence

Persistence should be Pi-owned when it concerns Pi session truth.

Tau-owned state should be limited to:

- Project list.
- Project display metadata.
- Thread index/cache.
- UI preferences.
- Extension enablement/config.
- Recent/search indexes.
- Remote connection metadata.

Pi-owned state should include:

- Conversation history.
- Tool run history.
- Approval state.
- Session resume data.
- Kernel-specific execution state.

Tau should be able to quit, reopen, and reattach to a Pi session without pretending to own the whole session format.

## Worktrees

Worktrees are no longer the product primitive.

Keep them as:

- Temporary sandboxes for risky edits.
- Optional per-thread execution environments.
- A feature similar to Codex app-style temporary worktrees.

Do not:

- Lead the UI with worktrees.
- Force every project/thread into a worktree workflow.
- Make worktree creation the main onboarding path.

## Implementation Backlog

### Pi Capability Verification (Blocking prerequisite)

- Build a Pi capability probe that records whether Pi exposes structured RPC/events for assistant messages, tool calls, approvals, diffs, errors, files, and command status.
- Document how Pi discovers slash commands and extensions, how Pi persists sessions, and which state must remain Pi-owned versus indexable by Tau.
- If Pi exposes only terminal output or partial structure, document the narrow bridge plan and keep the first UI shell limited to verified events.
- Prerequisite for: Foundation (`PiSession` model), Pi Bridge, and UI Shell.

### Foundation

- Depends on: Pi Capability Verification.
- Rename product concepts in code and docs from workspace/tab to project/thread where safe.
- Add a `PiSession` domain model beside the existing workspace model after the probe defines which session fields Tau may own.
- Keep compatibility shims until the UI and persistence are migrated.
- Document non-goals: no generic AI IDE, no forced worktree workflow, no dashboard extensions yet.

### Pi Bridge

- Depends on: Pi Capability Verification.
- Build a minimal Pi adapter that can start Pi and stream structured events only for the capabilities verified by the probe.
- If Pi lacks structured events, follow the narrow bridge plan and compare it against terminal scraping before expanding adapter scope.
- Define event types for message, tool call, approval request, diff, file activity, command output, error, and session lifecycle.
- Prove one live flow: start Pi, send prompt, receive assistant response, approve tool call, show diff.

### UI Shell

- Finish Codex-style minimal layout.
- Keep right side panel disabled.
- Sidebar should show projects and project threads.
- Search should be popup-only from the titlebar icon.
- Main pane should default to UI chat.
- Add setting/toggle for terminal Pi view.
- Reuse existing terminal pane only as a raw Pi view.

### Chat Renderer

- Render assistant/user messages from Pi session events.
- Render tool calls with explicit approval state.
- Render diffs from structured file activity.
- Keep security and approval controls Tau-owned.
- Keep terminal output available but secondary.

### Extension System

- Define a manifest format.
- Define contribution points:
  - slash commands
  - tool renderers
  - diff/file viewers
  - project actions
  - settings panes
- Add extension docs that Pi can use to build extensions.
- Add example extensions for a command and a diff renderer.
- Research and implement trust/sandbox boundaries before allowing arbitrary code.

### Remote

- Define daemon protocol boundaries.
- Decide local-only versus local-and-remote daemon topology.
- Add SSH connection model.
- Add remote Pi binary/session discovery.
- Add attach/detach lifecycle.
- Add remote logs and health reporting.

### Persistence

- Identify Pi-owned persistence APIs or files.
- Store Tau project/thread indexes separately.
- Add session resume/reattach flow.
- Make search use persisted project/thread metadata.
- Avoid duplicating Pi session truth unless no Pi API exists.

### Worktree Demotion

- Move worktree controls out of the primary sidebar.
- Treat worktrees as optional thread/session execution isolation.
- Add temporary worktree creation only where a tool run or thread needs it.
- Clean old docs that imply worktrees are the core workflow.

## Smallest Credible Demo

The pivot is proven when Tau can:

1. Add a project.
2. Create a project thread.
3. Start a Pi session for that thread.
4. Send a prompt in UI chat.
5. Stream structured assistant output.
6. Surface a tool approval.
7. Show a diff from the session.
8. Toggle to the raw terminal Pi view.
9. Quit and reopen Tau.
10. Reattach to the same Pi-owned session.

Anything beyond this should wait until the foundation is proven.

## Risks

- Pi may not expose enough structured session data; the blocking Pi capability ticket must prove this before UI scope expands, otherwise Tau should fall back to the narrow bridge plan.
- A powerful extension system can become a security hole if trust is vague.
- Remote control can balloon into a second product if scoped poorly.
- Renaming workspace/tab concepts without a migration plan can destabilize persistence.
- UI polish can mask the fact that the kernel/session model is still wrong.
- Worktrees can creep back into the primary product if temporary sandboxes are not clearly scoped.

## Decisions Made So Far

- Pi is the only kernel.
- UI chat is primary.
- Terminal Pi view is secondary.
- No right side panel for now.
- Search is a popup opened by an icon, not a persistent sidebar search bar.
- Plus project belongs next to the Projects header.
- Worktrees stay, but only as temporary/sandboxed support.
- Persistence should be Pi-owned where possible.
- Extension system is central, but dashboard/full-UI extensions are not part of the first cut.

### Migration Strategy

Existing Tau users move from the workspace/worktree model to the project/thread model through gate-based milestones. This section is the release roadmap until a versioned roadmap exists.

Roles are responsibility areas, not named owners:

- Desktop persistence owner: owns schema changes, compatibility shims, migration reads/writes, and data-loss checks.
- Desktop UX owner: owns in-app notices, concept rename copy, deprecation messaging, and rollback instructions.
- Desktop tooling owner: owns import/export and automated converters for worktrees to projects/threads.

Milestones:

- Phase 1, persistence gate: add schema changes and compatibility shims that read existing workspace/worktree records as projects with threads.
- Phase 2, beta gate: ship project/thread UI behind the beta path with in-app notices, deprecation messaging for worktree-first flows, and rollback instructions.
- Phase 3, removal gate: remove compatibility shims only after import/export, automated converters, and rollback telemetry show no unresolved migration blockers.

Rollback path:

- Until Phase 3 starts, users can disable the project/thread beta path, reopen Tau, and keep using workspace/worktree persistence through the compatibility shims.
- If a conversion fails, Tau should leave the original workspace/worktree records untouched, export the failed conversion report, and let the user retry after updating Tau.

Conversion risks:

- Workspace metadata may not map cleanly to project metadata.
- Active worktree sessions may require manual reconciliation with Pi-owned session state.
- Automated converters can lose user intent if worktree names, branches, or session history conflict.

Compatibility window:

- Compatibility shims, import/export, automated converters, and the rollback path stay supported for at least one beta milestone and one stable milestone after project/thread UI becomes the default.
