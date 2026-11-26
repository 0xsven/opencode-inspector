# OpenCode Inspector

## Keep OpenCode’s database read-only

- Open the source database read-only. Never modify its data, schema, indexes, triggers, or journal settings, and never run maintenance commands against it.
- Apply indexing and performance changes only to Inspector-owned caches. Inspector may use indexes that OpenCode already provides, but must not create them in the source database.
- For benchmarks, read from the source and write only to isolated, Inspector-owned scratch storage. Do not replace the running index.
