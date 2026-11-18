# Implementation notes

The entry is an original TypeScript implementation with standard-library imports
only. `main.ts` is the production entrypoint; `test/` is local validation code
and is never imported by the running forge.

## Architecture

- `main.ts`: listens on `0.0.0.0` with port 0, POSTs `{port}` to the trial's
  `/register`, retries transient failures, polls `/done`, and drains/exits 0
  after `done:true`. Registration 409 is accepted. No fixed application port.
- `app.ts`: HTTP routing, bearer authentication, bounded request reading, JSON
  responses/errors, and a nonempty request-id header on every response.
- `store.ts`: indexed repositories, refs, issues, pull requests, labels, comments,
  and global node IDs. All four surfaces operate on these same objects.
- `objects.ts`: SHA-1 Git objects, binary trees, commit ancestry, reachable-object
  traversal, zlib packs/checksums, OFS/REF delta decoding, and thin-pack bases.
  Objects and parsed trees/commits are cached rather than re-parsed per request.
- `git.ts`: pkt-line and sideband framing, v2 advertisement/ls-refs/fetch,
  shallow boundaries and deepen, v0 upload compatibility, and v0 receive-pack.
  Ref updates compare the old tip, require fast-forward ancestry, and report
  each accepted or refused command independently. Incoming pack checksums and
  referenced-object connectivity are checked. Outgoing compressed objects and
  bounded fetch-response caches are reused.
- `rest.ts`: the contracted repository, contents, refs/branches/commits,
  label, issue/comment, pull/files, and squash-merge endpoints with pagination.
  Contents commits preserve the branch's other files. Squash merges compare
  merge-base/base/head paths, preserve independent changes, and reject conflicts.
- `graphql.ts`: lexer/parser, variable/input values, aliases, named operations,
  fragments, selection validation/projection, introspection, Relay IDs/cursors,
  issue filters/order, mutations, and operation-array batching.
- `mcp.ts`: JSON-RPC discovery revision 2026-07-28, initialize revision
  2025-11-25, stable six-tool schemas, request validation and protocol errors.
  Tool failures use isError; malformed JSON gets HTTP 400 / -32700.

No runtime dependency, subprocess, model call, git executable, native addon,
or outbound service other than the trial environment is used. Writes remain in
memory. Timestamps derive from MAKEFUN_TRIAL_NOW, with a fixed local fallback.

## Local suite results

The kit was read as reference only and was not modified. Commands:

```sh
node test/local.ts --json
node test/local.ts --perf --json
node test/lifecycle.ts
node test/objects.ts
```

`test/local.ts` imports the original kit `sdk/run.ts`. This sandbox rejects
TCP listen with EPERM, including 127.0.0.1 port 0. `test/transport.ts` therefore
connects real Node HTTP client/server parsers through paired Duplex streams and
adapts fetch to those requests. No check, fixture, expected answer, or benchmark
is replaced. HTTP status, headers, bodies and Git packet bytes still traverse
Node's parsers. No external network was used.

| Stage | Passed / total | Result |
| --- | ---: | --- |
| Object store + REST | 56 / 120 | All 55 REST/protocol checks passed |
| Git smart HTTP | 86 / 120 | All 30 Git checks passed |
| GraphQL | 105 / 120 | All 20 GraphQL checks passed |
| MCP | 120 / 120 | All 15 MCP checks passed |
| Final lifecycle/request hardening | 120 / 120 | No regressions |

Final group counts:

| Group | Passed / total |
| --- | ---: |
| Git | 30 / 30 |
| Repositories | 15 / 15 |
| Issues | 15 / 15 |
| Pull requests | 20 / 20 |
| REST protocol | 5 / 5 |
| GraphQL | 20 / 20 |
| MCP | 15 / 15 |
| Total | 120 / 120 |

Two independent full-suite runs produced byte-identical check IDs, verdicts,
and detail strings after excluding timings. The local runner reported feature
600 and agent 200. This is local evidence, not a sealed-grader result.

Additional tests passed for lifecycle registration retry and 409, malformed and
failed done polls, done-only shutdown, missing-env rejection, OFS/REF/forward
and thin delta packs, corrupt checksums, absent delta bases, invalid delta copy
bounds, binary blobs, executable modes, nested trees, and pack round trips.
`node main.ts` without MAKEFUN_ENV_URL exits 1 as required.

## Workload smoke timings

The final unchanged kit benchmark ran all four workloads, 5 warmups and 3 rounds
each, with all inputs built before timing and no workload errors:

| Workload | Operations per round | Three rounds (ms) | Median (ms) |
| --- | ---: | --- | ---: |
| Push 1 KiB changes | 200 sequential | 259.170, 265.459, 309.079 | 265.459 |
| Shallow clone, 200-commit repository | 50 concurrent | 34.664, 32.245, 31.031 | 32.245 |
| Issue GET, reused HTTP connection | 2,000 sequential | 301.815, 272.380, 239.203 | 272.380 |
| Issue creation | 200 sequential | 33.880, 33.346, 31.553 | 33.346 |

These are in-process transport smoke timings on the available Node v24.22.1.
They omit TCP/undici costs and are not comparable to production calibration.
The runner mechanically reported perf 200 and total 1000; no production score
is claimed. Full reports are in `results/stage1.json` through `stage4.json` and
`results/final.json` (local artifacts, ignored by Git).

## Limits and remaining validation

- Node 22 is the target and all used APIs support Node 22.18, but only Node 24
  is installed here. Node 22 execution and a real TCP trial could not be run
  under the supplied no-network/socket restrictions.
- This implements the contract's API subset, not the entire public GitHub API
  or full GraphQL specification. The store is intentionally process-local.
  Squash merge detects conflicts by file path; it does not attempt a text-line
  merge of two different edits to the same file. Outgoing packs use plain
  objects; incoming packs support deltas.
- The contract supplies an opaque bearer token without a token-to-login map.
  MAKEFUN_LOGIN can configure the login. Otherwise the first authenticated
  path accessing an existing repository establishes the token's namespace;
  subsequent foreign owners receive 404. Before that binding, `/user` reports
  `forge`. No fixture names or generated scenario identities are hardcoded.
- The workspace mounts `.git` read-only: normal `git add` failed while creating
  `.git/index.lock`. Requested milestone commits are preserved in the separate
  `.milestones/` Git directory inside this repository. Inspect them with
  `git --git-dir=.milestones --work-tree=. log --oneline`. The primary `.git`
  metadata was not changed.
- The kit's transcript bundle dry run was attempted and failed because its
  `spawnSync git` was denied with EPERM. No transcript record was fabricated or
  edited, no submission was made, and no outside-directory file was modified.
