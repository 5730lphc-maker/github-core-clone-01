[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/5730lphc-maker/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/5730lphc-maker/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Standalone Git Forge

A single-process, in-memory GitHub-compatible forge for the
[make.fun GitHub core clone bounty](https://make.fun/bounty/github-core-clone-01).
Written in TypeScript for Node 22.18+, using only the Node standard library.

Run `node main.ts` with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` supplied by
the trial. The server binds port 0, registers its port with the environment,
polls `/done`, and exits successfully only after `done: true`.

The forge provides Git smart HTTP (upload-pack v2 and v0, receive-pack v0),
REST under `/api/v3`, GraphQL at `/api/graphql`, and MCP Streamable HTTP at
`/mcp`. All surfaces use one store. Contents writes and squash merges create
real Git objects; pushed branches can be queried and merged through the APIs.
The health endpoint `/healthz` is public; the other endpoints require the
trial bearer token.

There is no install step, disk persistence, git subprocess, or external service.
`MAKEFUN_TRIAL_NOW` supplies timestamps. `MAKEFUN_LOGIN`, when supplied,
configures the bearer token's login; with an opaque token and no configured
login, the first authenticated access to an existing repository establishes
the owner's namespace for this process.

Local validation uses the kit beside this directory:

```sh
node test/local.ts --json
node test/local.ts --perf --json
node test/lifecycle.ts
node test/objects.ts
```

The local adapter uses Node's HTTP parsers over paired memory streams because
this workspace forbids socket binding. It runs the kit's unchanged runner and
checks. In a socket-enabled environment, start `createApp()` on an ephemeral
port and run the kit's `sdk/run.ts --url http://127.0.0.1:PORT --token TOKEN
--perf` directly. See [NOTES.md](NOTES.md) for results and validation limits.
