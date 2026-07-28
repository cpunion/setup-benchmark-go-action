# setup-benchmark-go-action

Record Go benchmarks on one or more runners, compare each platform with its
matching `main` history, update one pull request comment, and publish long-term
charts with GitHub Pages.

## Configuration

The usual configuration is only an ID and a few regular expressions:

```yaml
id: my-project
groups:
  core: "^Core.*$"
  runtime: "^(Runtime|Scheduler).*$"
  parser:
    match: "^Parse.*$"
    chart: single
```

Every included benchmark must match at most one group. New, unmatched
benchmarks are kept in `Other`, so adding a benchmark does not require a
configuration change. Patterns use Go's RE2 regular expression syntax and are
matched against the short name (`CoreRead`), full name (`BenchmarkCoreRead`),
and package-qualified name.

`include` and `exclude` accept either one regular expression or a list:

```yaml
id: my-project
exclude: "^Experimental"
groups:
  core: "^Core.*$"
  storage:
    title: Storage
    match:
      - "^(File|Database)"
```

## Record

Run normal Go benchmarks and pass their output to the action:

```yaml
name: Go benchmarks

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  benchmark:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-go@v6
        with:
          go-version-file: go.mod
      - name: Run benchmarks
        run: go test -run '^$' -bench '^Benchmark' -benchmem -count=5 ./... | tee benchmark.txt
      - uses: cpunion/setup-benchmark-go-action@main
        with:
          config: .github/go-benchmark.yml
          benchmark-file: benchmark.txt
```

Platform ID and label default to the `goos` and `goarch` recorded in the
benchmark output. Source commit and workflow URL come from the GitHub event.
Results are never averaged or compared across platforms. A matrix that runs
multiple Go versions on the same OS and architecture must give each version a
distinct `platform-id` and `platform-label`.

Multiple jobs can contribute disjoint benchmarks to the same platform. Give
each job a unique `shard-id`; it defaults to `GITHUB_JOB`. The publisher rejects
duplicate shards, duplicate benchmarks across shards, differing configurations,
conflicting unit metadata, and source SHA mismatches.

Metric names and display units come from the standard Go benchmark format, not
from this configuration. Repeated samples such as `-count=5` are retained and
their median is used for the history line. Standard `Unit` metadata is honored:

```text
Unit ns/op better=lower
Unit bytes/s better=higher
Unit binary-bytes assume=exact
```

## Publish

Add a trusted `workflow_run` publisher on the default branch:

```yaml
name: Publish Go benchmarks

on:
  workflow_run:
    workflows: [Go benchmarks]
    types: [completed]

permissions:
  actions: read
  contents: write
  issues: write
  pull-requests: write

jobs:
  publish:
    if: github.event.workflow_run.conclusion == 'success'
    uses: cpunion/setup-benchmark-go-action/.github/workflows/publish.yml@main
    with:
      run_id: ${{ github.event.workflow_run.id }}
```

By default, generated data and the site are committed to the current
repository's `pages` branch. Configure GitHub Pages once to deploy `/` from that
branch. The first pull request is publishable before any benchmark workflow or
configuration has been merged to `main`; without a matching main history, every
value is reported as `new`.

To publish into another repository:

```yaml
uses: cpunion/setup-benchmark-go-action/.github/workflows/publish.yml@main
with:
  run_id: ${{ github.event.workflow_run.id }}
  data_repository: owner/project-benchmark-data
secrets:
  data_token: ${{ secrets.BENCHMARK_DATA_TOKEN }}
```

The external token needs contents write access to the data repository. Pages
can use the same `pages` branch there.

For pull requests from forks, the publisher parses untrusted artifacts without
executing repository code, uploads a rendered preview artifact, and writes the
report to the job summary. It does not push data or create a pull request
comment.

The parser and renderer run inside `actions/github-script@v8` on Node 24. They
do not run `go`, inspect the consumer's Go cache, or depend on a `setup-node`
version selected by the project.
