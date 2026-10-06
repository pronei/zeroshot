# Handoff: implement per-node runtime lanes, issue 1193

Status: spec approved on 2026-10-05 (`planning/plans/per-node-runtime-lanes-1193.md`). No
implementation plan exists and no code has changed. This document carries the code survey done
while designing the spec so the implementing session does not repeat it.

Authority: the spec above, then `AGENTS.md`, then `CLAUDE.md`. Where this document and the spec
disagree, the spec wins.

## Deliverables

Two pull requests against `main`, each from an isolated worktree, squash-merged, with a
Conventional Commit title and a nonempty `## Summary`:

1. `feat(runtime): choose the harness and provider per node in a RuntimePlan`
2. `feat(ui): edit per-node harness and provider lanes` (branch from PR 1's branch; rebase onto
   `main` after PR 1 merges)

Every commit ends with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

and every PR description ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Rules that bite here

- Never run `zeroshot run`.
- Git only inside the worktree you created for this work. Never commit on `main`.
- `protocol/openengine-cluster/v1/` is generated. Regenerate with
  `cargo run -p openengine-cluster-testkit --bin generate-cluster-protocol -- --write`, verify
  with `--check` (also `npm run protocol:check`). Never hand-edit.
- `docs/zeroshot-cli.md` and `docs/zeroshot-cli.html` are generated. Regenerate with
  `cargo run -p zeroshot --example generate_cli_docs -- --write`, verify with `--check`.
- New Rust APIs respect the four-parameter Clippy ceiling (counts `self`). Use request structs.
- Model and provider identifiers stay opaque. Do not probe login state. Do not add catalogs.
- Unix tests that create executables use `openengine_cluster_testkit::fixture::write_executable`
  (wrapped by `TestDirectory::write_executable` in `zeroshot/src/native_v2_candidate/test_support.rs`).
- `prettier --check .` runs over the whole repo, including `planning/`, `ui/src`, JSON fixtures,
  and docs. Format what you touch.
- `python -m mkdocs build --strict` must pass after docs edits.

## Validation lanes (run narrow first, then complete)

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
RUSTDOCFLAGS=-Dwarnings cargo doc --workspace --no-deps
npm run check
npm run format:check
actionlint .github/workflows/*.yml
cd sdks/python && python -m ruff check src tests examples && python -m ruff format --check src tests examples && pydoclint src/zeroshot && python -m mypy src examples && python -m pytest && cd ../..
python -m mkdocs build --strict
```

UI (PR 2): `npm --prefix ui ci` once, then `npm --prefix ui test` (`tsx --test src/*.test.ts`) and
`npm --prefix ui run build` (`tsc -b && vite build`).

## Phases and subagent ownership

Phase 1 is strictly sequential: everything downstream imports `RuntimeLane`. Phases 2a to 2d touch
disjoint files and may run as parallel subagents, but only if each works in its own worktree
branched from the Phase 1 commit and the orchestrator merges them back and re-runs
`cargo clippy --workspace --all-targets -- -D warnings` and `cargo test -p zeroshot` after each
merge. A shared worktree means sequential execution (concurrent cargo builds also contend for the
target directory). Verification and review agents can always run in parallel.

| Phase | Owner files                                                                                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Create worktree, copy the spec and this file in, commit them                                                                                                                                                                                                                                                         |
| 1     | `crates/openengine-cluster-protocol/src/native_v2_run.rs`, `native_v2_run/runtime.rs`, `native_v2_run/wire.rs`, `native_v2_target.rs`, their test files, `tests/native_v2_run.rs` + new fixture, every `NodeRuntimeBinding::Agent {` literal listed below, `zeroshot/src/native_v2_contract.rs`, schema regeneration |
| 2a    | `zeroshot/src/native_v2_candidate.rs`, `native_v2_candidate/provider_access.rs`, both test trees, `zeroshot/src/native_v2_cli/execution/submission.rs` (one helper swap)                                                                                                                                             |
| 2b    | `zeroshot/src/native_v2_local.rs` + `native_v2_local/tests.rs` (lanes, search path, preflight helper)                                                                                                                                                                                                                |
| 2c    | `zeroshot/src/native_v2_hosting/allocator.rs` + `allocator/lifecycle_tests.rs`                                                                                                                                                                                                                                       |
| 2d    | `zeroshot/src/native_v2_target_authority/transport.rs` + tests, `zeroshot/src/native_v2_target/controller_authority/{contract.rs,control.rs,profiles.rs}`, `contract/tests.rs`, `zeroshot/src/native_v2_target/tests/hosted_authority/` (new test file + `direct.rs` discovery helper)                               |
| 3     | After 2b merges: `zeroshot/src/native_v2_cli/local.rs` (preflight call), `zeroshot/src/native_v2_cli/acp.rs` + `acp/tests.rs` (gate and preflight), `zeroshot/src/native_v2_cli/parser.rs` help text + CLI docs regeneration                                                                                         |
| 4     | Docs and `AGENTS.md` (parallel-safe with 3)                                                                                                                                                                                                                                                                          |
| 5     | Full validation lanes, two independent review agents (spec coverage; correctness and security of credential filtering), fix findings, open PR 1                                                                                                                                                                      |
| 6     | UI PR: `ui/src/domain.ts`, new `ui/src/runtime-schema.ts`, new `ui/src/LaneFields.tsx`, `ui/src/Inspector.tsx`, `ui/src/RuntimeEditor.tsx`, `ui/src/RunHistoryView.tsx`, tests; open PR 2                                                                                                                            |

## Phase 1: protocol crate

### `RuntimeLane`

Add to `crates/openengine-cluster-protocol/src/native_v2_run.rs` right after `ClaudeProvider`
(the provider enums are near lines 360 to 400). Add `Hash, Ord, PartialOrd` to the derives of
`CopilotProvider`, `CodexProvider`, and `ClaudeProvider` so a lane can key a `BTreeMap`.

```rust
/// One harness and provider pair: the run-level default, or an agent node's override.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields, tag = "harness", rename_all = "snake_case")]
pub enum RuntimeLane {
    Copilot { provider: CopilotProvider },
    Codex { provider: CodexProvider },
    Claude { provider: ClaudeProvider },
}
```

Give it `harness_name(self) -> &'static str` (`copilot`, `codex`, `claude`; this is also the
executable each lane spawns), `provider_name(self) -> &'static str`, and `impl fmt::Display`
printing `harness/provider`. Test that `Display` equals the serde names for all nine pairs so the
two cannot drift. `lib.rs` glob-re-exports `native_v2_run::*`, so the type becomes
`openengine_cluster_protocol::RuntimeLane` with no further wiring.

Why nested, not flat: serde cannot `flatten` a tagged enum inside an enum variant, and
`deny_unknown_fields` does not combine with `flatten`. The nested object keeps the typed pair check
for free.

### Agent binding

`crates/openengine-cluster-protocol/src/native_v2_run/runtime.rs`, `NodeRuntimeBinding` (near
line 209). Add as the first field of `Agent`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
lane: Option<RuntimeLane>,
```

Import `RuntimeLane` in the `use super::{...}` line. `git_delivery` gets nothing; a `lane` there
is rejected as an unknown field (test it). Plans without `lane` must serialize byte-identically
(test it).

Every struct literal that builds an `Agent` without `..` breaks. Add `lane: None,` at each:

- `zeroshot/src/native_v2_cli/execution/submission.rs:499` (production code, `UniformRuntimePlan::binding`)
- `zeroshot/src/native_v2_runner/test_support.rs:42`
- `zeroshot/src/native_v2_candidate/tests/fixtures.rs:13`
- `zeroshot/src/native_v2_copilot/tests.rs:42`, `native_v2_codex/tests.rs:238`, `native_v2_claude/tests.rs:228`
- `zeroshot/src/native_v2_delivery/tests/routing.rs:336`
- `zeroshot/src/native_v2_supervisor/tests/delivery_gate.rs:23`, `native_v2_supervisor/environment/tests.rs:38`
- `zeroshot/src/native_v2_capsule/permission_tests.rs:111`, `native_v2_capsule/tests.rs:25`
- `zeroshot/src/native_v2_admission/tests.rs:76` and `:85`
- `zeroshot/src/native_v2_cli/local/connections/tests.rs:53`, `native_v2_cli/acp/tests.rs:195`, `native_v2_cli/execution/submission/tests.rs:82`
- `zeroshot/src/native_v2_hosting/tests/fixtures.rs:140` and `:156`
- `zeroshot/src/native_v2_templates/tests/support.rs:81`
- `zeroshot/src/native_v2_cloud/source/tests.rs:48`, `native_v2_cloud/tests/support_graph.rs:10` and `:202`

Then `cargo build --workspace --all-targets` to catch any site the list missed. Pattern matches
with `..` need no change.

### `RuntimePlan` accessors

`crates/openengine-cluster-protocol/src/native_v2_run/wire.rs`. Keep the enum shape and
`deny_unknown_fields`. Add:

| Method                                       | Behaviour                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `lane(&self) -> RuntimeLane`                 | run-level pair                                                            |
| `effective_lane(&self, &NodeRuntimeBinding)` | `Option<RuntimeLane>`: binding lane, else run-level; delivery gets `None` |
| `lanes(&self) -> BTreeSet<RuntimeLane>`      | distinct effective lanes over agent bindings                              |
| `has_lane_overrides(&self) -> bool`          | any agent binding with `lane: Some(_)`                                    |
| `nodes_mut(&mut self)`                       | mutable `BTreeMap<NodeName, NodeRuntimeBinding>`                          |

`nodes_mut` replaces two private helpers that destructure the three variants:
`runtime_nodes_mut` in `zeroshot/src/native_v2_candidate/provider_access.rs` and the inline match
in `insert_template_binding` in `zeroshot/src/native_v2_cli/execution/submission.rs` (near line
594). After this, the only variant matches left in the product are the ones that construct a plan.

Tests go in `native_v2_run/tests.rs` (has `use super::*;` and `AssertValue`) and
`native_v2_run/runtime/tests.rs` (has `use super::*;`; reference provider enums via `crate::`).
`BTreeSet` order is variant order: Copilot, Codex, Claude.

### Fixture and integration test

`crates/openengine-cluster-protocol/tests/native_v2_run.rs` builds submissions inline (see
`submission()`), uses `AssertValue`, and imports `RunSubmitParams`. Add
`tests/fixtures/native-v2-lane-submission.json` (copy the shape of
`tests/fixtures/native-v2-target-request.json`, give `worker` no lane and `acceptance` a Claude
lane) and a test that deserializes it with `include_str!`, checks `effective_lane` and
`has_lane_overrides`, and asserts `to_value(params) == wire`. Run prettier on the JSON.

### Discovery marker

`crates/openengine-cluster-protocol/src/native_v2_target.rs`, next to
`WORKSPACE_RECOVERY_KIND` (near line 440):

```rust
pub const NODE_RUNTIME_LANES_KIND: &str = "openengine.node-runtime-lanes/v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetNodeRuntimeLanesDiscovery {
    pub kind: String,
}
```

Add `node_runtime_lanes: Option<TargetNodeRuntimeLanesDiscovery>` to
`TargetDiscoveryExtensions` (serde `default` on the struct, `skip_serializing_if` on the field,
snake_case so the wire key is `node_runtime_lanes`), include it in
`TargetDiscoveryExtensions::is_empty`, and add `TargetDiscoveryDocument::with_node_runtime_lanes()`
modelled on `with_workspace_recovery` but unconditional (hosted OAuth targets advertise it too).
Leave `TargetDiscoveryDocument::direct` without the marker so tests can model an old target by
simply not calling the builder. Test in `native_v2_target/tests.rs` (style at the top of that
file).

### Contract re-export

`zeroshot/src/native_v2_contract.rs` line 16 re-exports protocol names; add `RuntimeLane`. Its
module doc says the contract binds leaves to "one graph-wide harness/provider lane"; change to the
run-level default plus per-node override.

## Phase 2a: candidate and provider access

### Candidate (`zeroshot/src/native_v2_candidate.rs`)

Today: `NativeV2HarnessConfig` is a three-way enum documented as the one lane for the graph;
`NativeV2CandidateConfig { harness, delivery, github }`; `build_candidate` builds one adapter;
`validate_config` matches `(admitted.runtime, config.harness)` pairs; `CandidateNodeLane` holds
one `agent_driver`/`agent_sessions` pair and routes only Agent vs GitDelivery.

Target shape:

```rust
pub struct NativeV2CandidateConfig {
    /// One configuration per distinct lane in the admitted plan.
    pub lanes: Vec<NativeV2HarnessConfig>,
    pub delivery: NativeV2DeliveryConfig,
    pub github: Arc<dyn GitHubDeliveryAuthority>,
}

impl NativeV2HarnessConfig {
    pub fn lane(&self) -> RuntimeLane { /* Copilot => github; Codex/Claude => config.provider */ }
    fn workspace(&self) -> &Path { /* each config's workspace */ }
}

struct CandidateNodeLane {
    default_lane: RuntimeLane,
    agents: BTreeMap<RuntimeLane, CandidateAgents>,
    delivery: Arc<NativeV2DeliveryAdapter>,
}

impl CandidateNodeLane {
    fn agents_for(&self, binding: &NodeRuntimeBinding) -> Result<&CandidateAgents, NodeRunnerError>
    // Agent => agents.get(&lane.unwrap_or(default_lane)).ok_or(Driver); GitDelivery => Err(Driver)
}
```

`validate_config`: duplicate lane in `config.lanes` → `RuntimeMismatch`; any config workspace ≠
`config.delivery.workspace` → `WorkspaceMismatch`; configured lane set ≠
`admitted.runtime.lanes()` → `RuntimeMismatch`. Keep both error variants and their mapping to
`CapsuleAllocationUnavailable::Runtime`; reword the `RuntimeMismatch` message to "candidate lanes
do not match the admitted graph runtime". `build_candidate` loops `config.lanes`, keeps the
local/hosted constructor split per harness, inserts into the map, and `assemble_runner` takes the
map plus `admitted.runtime.lane()`. `open` and `run` resolve through `agents_for`; there is never a
fallback to another lane. Remove the now-unused `RuntimePlan` import (`-D warnings`).

Sessions need no change: the pool key is run id plus node instance
(`zeroshot/src/native_v2_runner/state.rs` near line 509), private homes are keyed by role and
node instance or execution (`HostedProcessScope::private_home` in
`zeroshot/src/execution/process.rs`), and each adapter downcasts only sessions it opened.
`HostedProcessPool` is `Copy`, so several adapters can share it.

Tests (`zeroshot/src/native_v2_candidate/tests.rs`, `#![cfg(unix)]`, and `tests/fixtures.rs`):

- `fixtures::candidate_config` returns `NativeV2CandidateConfig { harness, ... }`; change to
  `lanes: vec![harness]`. Add `RuntimePlanKind::ClaudeOverride`: a Codex run-level plan whose
  `worker` binding carries `lane: Some(Claude/Anthropic)`, so `lanes()` is `{claude/anthropic}`
  and `candidate_config` must return a Claude config for it.
- `CandidateAllocator::allocate` in `tests.rs` calls
  `assemble_runner(admitted, CandidateAgents::new(self.agent.clone()), delivery, Capsule)`;
  change to a one-entry map keyed by `admitted.runtime.lane()`.
- `coverage_contract_candidate_builders_bind_only_to_their_admitted_lane_and_workspace` keeps
  passing; extend or add a test for: override plan accepts the Claude config and rejects the Codex
  config with `RuntimeMismatch`; duplicate lanes → `RuntimeMismatch`; empty `lanes` for a plan
  with agent nodes → `RuntimeMismatch`.
- Routing test: build a `CandidateNodeLane` with two `ScriptedAgent`s keyed by lane and assert
  `agents_for` returns the right one by pointer identity
  (`Arc::as_ptr(&agents.driver).cast::<()>() == Arc::as_ptr(&scripted).cast::<()>()`), that an
  unconfigured lane errors, and that a delivery binding errors. No invocation structs needed.
- `candidate_source_has_no_route_to_the_replaced_runtime_paths` still requires the strings
  `NativeV2CodexAdapter`, `ClaudeAdapter`, `NativeV2DeliveryAdapter`, `NativeNodeRunner` in the
  source.

### Provider access (`zeroshot/src/native_v2_candidate/provider_access.rs`)

`materialize_provider_access` derives one contract from the plan variant and applies it to every
binding. Change `provider_access_contract` to take a `RuntimeLane`; read `runtime.lane()` once,
loop `runtime.nodes_mut().values_mut()`, and for each `Agent { lane, .. }` use
`lane.unwrap_or(default)`. Everything else (native-local exemption, authored precedence, fallback
merge) is unchanged per node. Call sites stay: `zeroshot/src/native_v2_hosting.rs:170` (before the
submission digest), `zeroshot/src/native_v2_cli/execution/profiles.rs:97-106`,
`zeroshot/src/native_v2_cli/acp.rs:101,111`. Tests in `provider_access/tests.rs` have a
`runtime(harness, provider, connections)` JSON helper and `requirements()`; add a mixed-lane plan
for Local and Contained placements and assert the per-key union.

## Phase 2b: local root and preflight (`zeroshot/src/native_v2_local.rs`)

`local_harness(admitted, workspace, runtime_home, native_environment)` (near line 331) builds
one config from the plan variant. Replace with `local_lanes(...) -> Vec<NativeV2HarnessConfig>`
that computes the shared inputs once (native environment snapshot, local command environment,
search path, user home, `HostedProcessPool::hosted_default()`) into a request struct and builds one
config per `admitted.runtime.lanes()` entry, keeping the three existing bodies. Caller at line
296 and the `NativeV2CandidateConfig { harness, ... }` literal at line 306 become `lanes`. Factor
the search-path derivation (captured `PATH`, else `default_search_path`) into
`local_search_path(&LocalHarnessEnvironment) -> String`; preflight uses the same function.

Preflight:

- `LocalCompositionError::MissingLaneExecutable { lane: RuntimeLane, executable: &'static str }`
  with message `lane {lane} needs the \`{executable}\` executable on PATH`.
- The lookup is not a separate local helper. Every harness process is spawned by
  `build_child_command`, which resolves the program with
  `crate::execution::platform::executable(program, child_environment)`. That module gains
  `pub(crate) fn find_executable(program, &BTreeMap<String, String>) -> Option<PathBuf>`, the
  lookup spawning uses. On Windows it is the loop `executable` already ran: a bare name is tried
  only with the fixed suffixes `.exe`, `.com`, `.cmd`, and `.bat`, in that order, in each `PATH`
  directory, and the first file wins; `PATHEXT` is ignored and an extensionless file never
  matches. `executable` becomes `find_executable(..).unwrap_or_else(|| program.into())` there, so
  Windows spawning is unchanged. Elsewhere `executable` still returns the name for the OS to
  search, and `find_executable` follows that search: a name containing a path separator is checked
  directly, and a bare name is looked up in each nonempty `PATH` directory as a regular file with
  at least one execute bit.
- `check_lane_executables(&RuntimePlan, &BTreeMap<String, String>) -> Result<(), LocalCompositionError>`
  in this module builds a lookup environment whose `PATH` is `local_search_path` of the snapshot
  and calls `find_executable(lane.harness_name(), ..)` for each of `runtime.lanes()` in order,
  failing on the first missing one.

The native environment comes from the real process environment
(`capture_local_native_environment` reads `std::env::vars_os`), so it cannot be injected through
`LocalCliBackend`. Test the helpers directly in `native_v2_local/tests.rs` with
`TestDirectory::write_executable` under a fake `PATH`; do not assert on the default search path
(developer machines may have the CLIs installed). No existing test submits agent bindings through
the local backend, so wiring the check into the CLI breaks nothing.

Existing test `local_harness_contract_materializes_each_native_lane_without_processes` uses
`admitted_for(harness, provider)` whose plan has `nodes: {}`; with lanes derived from agent
bindings that yields zero configs. Give it a graph with one step node and a `worker` binding:

```json
{
  "kind": "step",
  "name": "worker",
  "worker": "agent.worker@1",
  "instructions": "Implement the worker node.",
  "input": { "kind": "null" },
  "output": { "kind": "null" },
  "inputBindings": [],
  "writeBindings": [],
  "timeoutMs": 1000,
  "attempts": 1
}
```

(`full_graph(vec![...])` and `success_node()` come from `native_v2_candidate::test_support`.) Add
a mixed test: Codex run-level, `reviewer` overridden to Claude, expect configs for exactly
`[Codex/OpenAi, Claude/Anthropic]` in that order.

## Phase 2c: hosted allocator (`zeroshot/src/native_v2_hosting/allocator.rs`)

`ProductionCapsuleAllocator::harness(admitted, filesystem, process_pool)` (near line 656) is the
same three-way match; its only caller is `finish_capsule` (near line 397). Rename to `lanes`
returning `Vec<NativeV2HarnessConfig>`; compute `run_root`, `search_path`, tools directory, and
the base environment once into a `Copy` inputs struct (refs plus `HostedProcessPool`), then map
`admitted.runtime.lanes()` through a per-lane builder that keeps the three bodies (the Claude
branch rebuilds its `ClaudeProcessEnvironment` per lane; that is cheap). The config already holds
all three executables, validated non-empty in `new`. Remove the unused `RuntimePlan` import and
reference `crate::native_v2_contract::RuntimePlan::Copilot` in the test instead.

`allocator/lifecycle_tests.rs::hosted_copilot_harness_and_invalid_filesystem_layout_preserve_capsule_boundaries`
re-wraps `crate::native_v2_runner::test_support::admitted()` (ten agent nodes) in a Copilot plan
and calls `allocator.harness(...)`; switch to `lanes` and destructure
`let [NativeV2HarnessConfig::Copilot(config)] = lanes.as_slice() else { panic!(...) }`.

## Phase 2d: target discovery and client check

- Serve: `zeroshot/src/native_v2_target_authority/transport.rs` near line 408,
  `discovery_document()` starts from `TargetDiscoveryDocument::direct(...)`; chain
  `.with_node_runtime_lanes()` unconditionally. Test in
  `zeroshot/src/native_v2_target_authority/tests.rs` using `direct_test_server(Arc::new(FakeFactory::default()))`
  and `target_discovery(address)` (see `assert_workspace_recovery_capability` near line 788 for
  the assertion style).
- Client descriptor: `zeroshot/src/native_v2_target/controller_authority/contract.rs`.
  `ControllerDescriptor` gains `node_runtime_lanes: bool`, read by `parse_node_runtime_lanes`:
  the exact kind is true; an absent marker or any other kind is false. Unlike
  `parse_workspace_recovery`, another kind is not a descriptor error, because plans without lanes
  must keep working with every target. Tests in `contract/tests.rs` cover the three cases.
- Guard: `require_node_runtime_lanes(&ControllerDescriptor, &RuntimePlan)` beside
  `require_session_capability` in `controller_authority.rs`, failing with
  `target does not support per-node runtime lanes (openengine.node-runtime-lanes/v1)` when
  `runtime.has_lane_overrides()` and the descriptor says false. Unit tests in
  `controller_authority/tests.rs`.
- Submit: the guard must run after the descriptor is resolved and before any access token is
  acquired, not after `controller_access`: on hosted targets `access_token` may POST a refresh
  exchange, which would send a request body before the refusal. `submit` in
  `controller_authority/control.rs` uses `controller_access_for_runtime(target, runtime)`, which
  passes the plan to `controller_access_inner`; that resolves `descriptors_inner(General)` (hosted)
  or `controller_descriptor` (direct), runs the guard, and only then, on hosted targets, calls
  `access_token`. No `TargetSessionPurpose` variant is added.
- Remote profile set: `controller_authority/profiles.rs`. Direct targets already reject every
  profile operation. `profile_access` runs the guard after `self.descriptors(target)` and the
  profile-route check, and before `access_token`. `profile_json(&self, target, operation, input)`
  is at the four-parameter ceiling, so the plan travels through a private `ProfileBody` trait that
  every request body implements: `stored_runtime()` is `Some(&self.runtime)` for
  `RunProfileSetRequest` and `None` for the rest. `profile_run` needs no guard: the plan is
  already stored on the target. No path gains an HTTP request.
- Tests for the submit path: `zeroshot/src/native_v2_target/tests/hosted_authority/direct.rs`
  has a fake direct target (`spawn_direct_target_authority(request_count)`, discovery built by
  `discovery(address)`); add `.with_node_runtime_lanes()` there so lane-bearing submissions reach
  the POST. For the refusal, write a bespoke one-request server with `bind_target_authority`,
  `read_http_request`, and `write_http_response_with_status` from `hosted_authority.rs` that serves
  a discovery document without the marker, then assert `authority.submit(...)` fails with the exact
  message (`test_http_authority`, `direct_target`, `exact_run_request` live in
  `tests/fixtures.rs`; `problem_errors.rs` shows the pattern; register a new test file in
  `hosted_authority.rs` with `#[path]`). `CapturedHttpRequest` has `method`, `path`,
  `authorization`, `body`. Built as `hosted_authority/runtime_lanes.rs`: a recording fake answers
  until stopped, so a test sees every request. Without the marker, a direct submission stops after
  the discovery GET, and a hosted submission or profile set stops after the discovery and OAuth
  metadata GETs, with no token POST. With the marker, both proceed and send the lane.

## Phase 3: CLI wiring, ACP, help text

- Preflight call: `zeroshot/src/native_v2_cli/local.rs::start_prepared_controller_with_lineage`
  (near line 235) is reached by both `run` (via `start_controller`) and `resume` (via
  `local/backend.rs::start_local_successor`). Its first statement, before `create_run_storage`,
  is `crate::native_v2_local::check_lane_executables(&prepared.submission.runtime, &prepared.native_environment)`
  mapped with `NativeV2CliError::Usage(error.to_string())`, not `local_error`: `local_error`
  wraps into `NativeV2CliError::Local`, which prefixes `local controller operation failed: `.
  `Usage` prints the bare message and gets the `request.invalid` diagnostic code. A `resume` that
  fails here still reconciles its claimed workspace, because `start_local_successor` calls
  `reconcile_local_resume_claim` on any error and the successor storage does not exist yet.
- ACP (`zeroshot/src/native_v2_cli/acp.rs`): `validate_profile` (near line 846) rejects at run
  level with "only Codex and Claude runtimes are supported"; replace with a check over
  `profile.runtime.lanes()` rejecting any `RuntimeLane::Copilot` with "only Codex and Claude lanes
  are supported" (the existing test matches on "only Codex and Claude"). In `serve_local_acp`
  after `validate_profile`, capture the native environment with
  `crate::native_v2_local::capture_local_native_environment(&std::env::current_dir()...)` (the
  pattern at line ~518) and call `check_lane_executables`, mapping its error into `AcpServeError`
  through `NativeV2CliError::Usage` as `materialize_acp_provider_access` does. Tests in `acp/tests.rs` have
  `runtime(harness, scope, connections)` and `acp_profile`; add a case where a Codex plan's
  `worker` carries a Claude lane (accepted) and where a Claude plan's `worker` carries a Copilot
  lane (rejected), mutating through `nodes_mut()`.
- Help text: `zeroshot/src/native_v2_cli/parser.rs` lines 423-460 (`after_long_help` for the
  runtime configuration). Add a short paragraph on `lane`, then regenerate the CLI docs.

## Phase 4: docs and AGENTS.md

- `docs/reference/runtime-plan.md`: replace "One harness, provider, and size apply to the whole
  run." with the default-lane wording; add a `lane` row to the `agent` table; add a "Per-node
  lane" section with the issue's example in nested form, the capability marker, the client
  refusal, and the local executable preflight; connections paragraph says access is derived from
  the node's effective lane.
- `docs/concepts/runtimes-and-connections.md`: the "Four explicit choices" list and the
  materialization paragraph (lines ~55-70) become per effective lane.
- `docs/concepts/targets.md`: local section, one sentence on needing every lane's CLI and the
  preflight.
- `docs/guides/review-loop.md`: a "Cross-vendor review" variant including a new
  `docs/assets/review-loop/review-loop.cross-vendor.runtime.json` via `--8<--` (the existing
  include is at line ~174; the files table is at line ~31).
- `docs/guides/python-sdk.md` line ~128: one sentence that an opaque `RuntimePlan` may carry
  per-node lanes and passes through unchanged.
- `AGENTS.md` line 64 ("Runtime selection requires caller-authored ..."): append the lane
  invariants (default lane, typed override, one adapter per distinct effective lane, no per-turn
  provider switching, the discovery marker and client refusal, local executable preflight without
  login probing).
- `docs/reference/cluster/schema.json` is copied from `protocol/` by `scripts/docs_hook.py`;
  nothing to edit by hand.

## Phase 5: review and PR 1

Run the complete validation lanes. Then two independent review agents against the spec:

1. Spec coverage: every acceptance criterion and every section has code and a test.
2. Correctness and security: credential filtering in `ClaudeAdapter::new_local` and
   `NativeV2CodexAdapter::new_local` is untouched; no fallback to the run-level lane anywhere;
   digest computed after materialization; no new error leaks secrets.

Fix findings, re-run lanes, push, open PR 1 with the title above and a `## Summary` naming the
user-facing change.

## Phase 6: UI PR

Facts: `ui/src/domain.ts` `Binding` has an index signature, so an old UI preserves `lane` through
edits (the core PR is safe to land first). `RuntimeEditor.tsx` derives harness and provider
options from the served `schema_for!(RuntimePlan)` (`oneOf` variants, `properties.harness.const`,
provider `$ref` into `$defs`), has the "Applies to the whole graph." copy, and clears the provider
when the harness changes. `Inspector.tsx` (`bindingChange` near line 310, agent block near line 365) already edits per-node model, effort, and session and passes `doc.runtime.harness/provider`
to `ModelPicker`. `models.ts::suggestedModels(harness, provider)`. `RunHistoryView.tsx` shows
`run.runtime.harness / run.runtime.provider` near line 991 and the raw node binding near line 1103. Tests are `node:test` via `tsx` (`ui/src/domain.test.ts` has a `fixture()` document).

Work:

- `ui/src/runtime-schema.ts`: move `harnessLabels` and the schema derivation into
  `harnessOptions(schema)` and `providerOptions(schema, harness)`.
- `domain.ts`: `type Lane`, `Binding.lane?: Lane`, `effectiveLane(runtime, name)`,
  `setRuntimeField(document, key, value)` (harness change clears provider and deletes every
  node's `lane`; provider change keeps them), `setNodeLane(document, name, lane | undefined)`,
  and `assertRuntime` validation that a present `lane` is an object with string `harness` and
  `provider`. Pair validity is enforced by the inspector's option lists and by Rust admission.
- `ui/src/LaneFields.tsx`: harness select with a leading "Run default" option and a provider
  select shown only when a lane is set; choosing a harness sets `{harness, provider: ''}`.
- `Inspector.tsx`: render `LaneFields` above `ModelPicker` for agent nodes and pass the node's
  effective lane to `ModelPicker`.
- `RuntimeEditor.tsx`: use the helpers; copy becomes "Default for every node. A node can override
  its harness and provider in the inspector."; per-node rows show an overridden lane and pass the
  effective lane to the picker.
- `RunHistoryView.tsx`: under the Runtime fact, list each node whose binding has a `lane`.
- Tests: clearing rule, `effectiveLane`, `setNodeLane` round trip, validation error for a
  half-specified lane, schema option helpers with a small fake schema.
- `npm --prefix ui test`, `npm --prefix ui run build`, `npx prettier --write ui/src`, then PR 2.

## Acceptance (from the spec)

1. Codex worker plus Claude reviewers admits and runs locally with both CLIs and on a hosted
   target, each node on its own CLI.
2. Plans without `lane` serialize byte for byte as before and keep their hosted digest.
3. A lane-bearing plan sent to a target without the marker fails before any body is sent, naming
   the capability.
4. A local run with a missing lane executable fails before the controller launches, naming lane
   and executable.
5. UI override, reset, clearing on run-level harness change, retention on provider change, and
   history display.
6. ACP accepts mixed Codex and Claude lanes and rejects a Copilot lane.
7. All validation lanes pass.
