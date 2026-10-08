# CH Query skill

An installable Agent Skill for collecting and analyzing ClickHouse query-plan evidence with [CH Query](https://chquery.com/).

CH Query is independent and is not affiliated with or endorsed by ClickHouse, Inc.

## Install

```bash
npx skills add maxsumrall/chquery-skills
```

Then give your agent this prompt:

> Use chquery.com to explain and visualize this ClickHouse query: <paste query>

The skill runs locally with Node.js 20 or newer, has no dependencies, and makes no network requests while analyzing a bundle. See the [agent guide](https://chquery.com/agents.html) and [complete agent instructions](https://chquery.com/llms-full.txt).

Test the installed CLI from this repository:

```bash
node skills/chquery/scripts/chquery.mjs analyze skills/chquery/examples/agent-bundle.json --link
node skills/chquery/scripts/chquery-conformance.mjs capabilities
node skills/chquery/scripts/chquery-conformance.mjs validate skills/chquery/examples/agent-bundle.json
node skills/chquery/scripts/validate-producer-conformance.mjs
```

Producer schemas, typed diagnostics and the transport corpus are included under `skills/chquery/contracts` and `skills/chquery/conformance`. See `skills/chquery/reference/producer-conformance.md`. The conformance commands are local-only and never access or publish to GitHub.

## Source

This repository is generated from a private repository. Do not edit files here; changes are overwritten by the publishing workflow.
