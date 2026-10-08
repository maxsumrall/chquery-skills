# ANALYZE captures

Captured on 2026-09-09 from official ClickHouse Docker images 26.7.6.57 and
26.8.2.7 using `scripts/verify-clickhouse-smoke.mjs`. All tables and queries use
the smoke suite's synthetic `compat` dataset; no production data appears here.

Each bundle pairs a separate `EXPLAIN PLAN indexes=1, json=1, description=1`
capture with `EXPLAIN ANALYZE processors=1`, both using TSVRaw output and the
same SQL/settings/schema. The runner attests that association. The stored text
and counters preserve server output; source/version metadata identifies the run.

Scan and aggregation captures map on both versions. The captured 26.7 join
description differs between PLAN and execution and must remain unmapped. The
captured 26.8 join maps, but its multi-input edges have no attributable row
volume. Timing values vary between runs and are not performance baselines.

`tests/unit/analyze.test.js` exercises these captures offline. The compatibility
workflow collects fresh captures and mapping diagnostics on supported versions.
