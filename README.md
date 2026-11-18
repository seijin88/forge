# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/seijin88/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/seijin88/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in pure Node.js standard library: git smart HTTP (upload-pack v2 and v0, receive-pack), the REST v3 API for repositories, issues, pull requests and contents, a GraphQL v4 endpoint for the documents gh and github-mcp-server send, and a Model Context Protocol endpoint with the tools an agent needs — all four surfaces from one process, its own store, no dependencies and no git binary.

## Run it

```sh
node main.ts
```

The server binds an ephemeral port and prints it. With `MAKEFUN_ENV_URL` set it registers itself with a make.fun trial harness and serves until the harness says done; without one it simply serves.

## How it stays fast

The suite's timed workloads are thousands of small requests, so the transport itself has to be cheap:

* The HTTP/1.1 server sits on raw sockets (`node:net`), not on `node:http`: a request is parsed once, and a reply is one buffer written in one write, with TCP_NODELAY on.
* A ref advertisement, a fetch pack and an issue's REST body are serialized once and reused until the thing they describe changes.
* Objects are stored as they arrive, and a push parses its pack in one pass.
* Every timestamp comes from a logical clock, so the same requests always produce the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t6g9x6hv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>