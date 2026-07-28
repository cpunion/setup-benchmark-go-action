# Setup Benchmark Go

Record standard Go benchmark output on one or more GitHub Actions runners,
compare each platform with its matching `main` history, update one pull request
comment, and publish long-term charts with GitHub Pages.

The recorder does not install Go or Node, run `go`, or inspect toolchain caches.
Projects keep full control of benchmark execution; this action only parses the
result file and uploads a validated artifact.

## Quick Start

Create `.github/go-benchmark.yml`:

```yaml
id: my-project
title: My project benchmarks
groups:
  core: "^Core.*$"
  runtime: "^(Runtime|Scheduler).*$"
  parser:
    match: "^Parse.*$"
    chart: single
```

Record benchmarks in `.github/workflows/benchmark.yml`:

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
      - uses: cpunion/setup-benchmark-go-action@v1
        with:
          config: .github/go-benchmark.yml
          benchmark-file: benchmark.txt
```

Publish from a trusted workflow on the default branch. Create
`.github/workflows/benchmark-publish.yml`:

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
    uses: cpunion/setup-benchmark-go-action/.github/workflows/publish.yml@v1
    with:
      run_id: ${{ github.event.workflow_run.id }}
```

The separate `workflow_run` publisher is intentional. Pull request code can
produce benchmark artifacts, but only the publisher from the default branch can
write history or comments. It validates every artifact before using it.

By default, data and the generated site are committed atomically to a `pages`
branch in the project repository. In **Settings > Pages**, select **Deploy from
a branch**, then choose `pages` and `/ (root)`.

## Configuration

Patterns use RE2 syntax and are matched against all of:

- short name: `CoreRead`
- benchmark name: `BenchmarkCoreRead`
- package-qualified short name: `example.org/project/pkg::CoreRead`
- package-qualified benchmark name:
  `example.org/project/pkg::BenchmarkCoreRead`

The shorthand group form assigns a combined chart:

```yaml
groups:
  core: "^Core.*$"
```

Use the object form for a display title, several patterns, or one chart per
benchmark:

```yaml
version: 1
id: my-project
title: My project benchmarks
site-path: go-benchmarks/my-project
include:
  - "^Benchmark"
exclude: "^Experimental"
max-benchmarks: 500
groups:
  storage:
    title: Storage
    match:
      - "^(File|Database)"
    chart: combined
  parser:
    match: "^Parse"
    chart: single
```

| Field               | Default              | Meaning                                                            |
| ------------------- | -------------------- | ------------------------------------------------------------------ |
| `version`           | `1`                  | Configuration schema version.                                      |
| `id`                | required             | Stable suite ID using lowercase letters, digits, `.`, `_`, or `-`. |
| `title`             | `<id> benchmarks`    | Report and site title.                                             |
| `site-path`         | `go-benchmarks/<id>` | Site directory within the data branch.                             |
| `include`           | `^Benchmark`         | RE2 pattern or pattern list selecting benchmarks.                  |
| `exclude`           | none                 | RE2 pattern or pattern list applied after `include`.               |
| `max-benchmarks`    | `500`                | Maximum selected benchmarks, from 1 through 5000.                  |
| `groups`            | none                 | Named chart groups. Group IDs are lowercase path-safe names.       |
| `groups.<id>.title` | title-cased ID       | Display title.                                                     |
| `groups.<id>.match` | required             | RE2 pattern or pattern list.                                       |
| `groups.<id>.chart` | `combined`           | `combined` or `single`.                                            |

A benchmark may match at most one group. Overlap is rejected instead of
silently selecting a group. Included benchmarks that match no group remain
visible under **Other**, with a separate chart for each benchmark. This lets new
benchmarks appear without first changing configuration.

## Measurements

Input is ordinary `go test -bench` output. Package names, `goos`, and `goarch`
are read from the standard header:

```text
goos: linux
goarch: amd64
pkg: example.org/project/parser
BenchmarkParseSmall-8  125000  912.4 ns/op  64 B/op  1 allocs/op
```

Every reported metric is retained. Repeated samples, such as `-count=5`, are
stored and the median becomes the displayed and historical value. The action
does not average results from different platforms.

Common Go units have their usual direction automatically: lower is better for
`ns/op`, `sec/op`, `B/op`, and `allocs/op`; higher is better for `MB/s` and
`B/s`. Custom metrics can declare metadata in the benchmark output:

```text
Unit requests/s better=higher
Unit binary-bytes better=lower assume=exact
```

Supported metadata is:

| Metadata | Values             | Meaning                                        |
| -------- | ------------------ | ---------------------------------------------- |
| `better` | `lower`, `higher`  | Marks a PR delta as better or worse.           |
| `assume` | `nothing`, `exact` | Records the benchmark's comparison assumption. |

Units come from benchmark output, not the YAML configuration. A unit is never
combined with another unit.

## Matrices And Shards

Each recorder job uploads one artifact. `shard-id` defaults to `GITHUB_JOB`.
Different jobs may contribute disjoint benchmarks to the same platform; the
publisher merges them before making its single data commit and single PR
comment.

```yaml
strategy:
  fail-fast: false
  matrix:
    suite: [core, storage]
steps:
  - run: go test -run '^$' -bench . -count=5 ./bench/${{ matrix.suite }} | tee benchmark.txt
  - uses: cpunion/setup-benchmark-go-action@v1
    with:
      config: .github/go-benchmark.yml
      benchmark-file: benchmark.txt
      shard-id: ${{ matrix.suite }}
```

The publisher rejects duplicate shard IDs, duplicate benchmarks across shards,
configuration differences, unit metadata conflicts, platform label conflicts,
and source commit mismatches. This makes partial or ambiguous matrix output a
hard failure instead of publishing misleading data.

Platform ID and label normally come from the benchmark `goos` and `goarch`.
Set them explicitly for cross compilation, virtual environments, or a Go
version matrix:

```yaml
- uses: cpunion/setup-benchmark-go-action@v1
  with:
    config: .github/go-benchmark.yml
    benchmark-file: benchmark.txt
    platform-id: ubuntu-go1.26-amd64
    platform-label: Ubuntu / amd64 / Go 1.26
    shard-id: ${{ github.job }}-${{ matrix.package }}
```

Two Go versions on the same OS and architecture must use distinct platform IDs.
Only equal platform IDs are merged or compared.

## Published Results

The generated Pages site keeps separate **Main**, **Branches**, and **Pull
requests** views. A pull request run updates both its PR series and its branch
series. History is capped at 500 commits per series.

For a pull request, the publisher creates one bot comment and updates that same
comment on later commits. Each metric is compared only with the newest matching
platform in `main`. If no `main` baseline exists yet, including the first setup
PR in a new project, the report succeeds and marks every metric as `new`.

The publisher also uploads a rendered preview artifact and writes the report to
the job summary. Pull requests from forks get only those two outputs: the
publisher parses their untrusted artifacts but does not push data or create a
comment.

### External Data Repository

The default `pages` branch can live in another repository:

```yaml
jobs:
  publish:
    if: github.event.workflow_run.conclusion == 'success'
    uses: cpunion/setup-benchmark-go-action/.github/workflows/publish.yml@v1
    with:
      run_id: ${{ github.event.workflow_run.id }}
      data_repository: owner/project-benchmark-data
    secrets:
      data_token: ${{ secrets.BENCHMARK_DATA_TOKEN }}
```

`data_token` needs contents write access to the data repository. Configure Pages
there from its `pages` branch. If the Pages URL is nonstandard, set
`site_base_url`.

## Recorder Reference

| Input            | Required | Default                    | Meaning                                  |
| ---------------- | -------- | -------------------------- | ---------------------------------------- |
| `config`         | no       | `.github/go-benchmark.yml` | Grouping configuration path.             |
| `benchmark-file` | yes      |                            | `go test -bench` output path.            |
| `platform-id`    | no       | `<goos>-<goarch>`          | Stable comparison and merge identity.    |
| `platform-label` | no       | derived                    | Human-readable platform name.            |
| `shard-id`       | no       | `GITHUB_JOB`               | Stable shard identity within a platform. |
| `retention-days` | no       | `30`                       | Uploaded artifact retention.             |

| Output          | Meaning                 |
| --------------- | ----------------------- |
| `artifact-name` | Uploaded artifact name. |
| `platform-id`   | Resolved platform ID.   |
| `shard-id`      | Resolved shard ID.      |
| `suite-id`      | Configuration ID.       |

## Publisher Reference

Call
`cpunion/setup-benchmark-go-action/.github/workflows/publish.yml@v1` as a job.

| Input              | Required | Default                 | Meaning                                               |
| ------------------ | -------- | ----------------------- | ----------------------------------------------------- |
| `run_id`           | yes      |                         | Workflow run containing recorder artifacts.           |
| `data_repository`  | no       | caller repository       | Repository containing the data branch and Pages site. |
| `data_branch`      | no       | `pages`                 | Data and Pages branch.                                |
| `site_base_url`    | no       | derived from repository | Public Pages root URL.                                |
| `artifact_pattern` | no       | `go-benchmark-*`        | Artifact download glob.                               |

| Secret       | Required                 | Meaning                                                |
| ------------ | ------------------------ | ------------------------------------------------------ |
| `data_token` | external repository only | Token with contents write access to `data_repository`. |

Recommended publisher permissions are `actions: read`, `contents: write`,
`issues: write`, and `pull-requests: write`. GitHub may reduce permissions
passed to a reusable workflow, so the caller must grant them.

## Runtime And Security

Parsing and rendering execute through `actions/github-script@v8` on the
runner-provided Node 24 runtime. The action is isolated from a consumer's
`setup-go`, `setup-node`, Go cache, Node cache, and selected toolchain versions.
It has no production dependency on the Go toolchain.

Artifacts contain JSON data and a configuration snapshot, never executable
code. Before merging shards or writing history, the publisher validates schema
versions, repository and commit identity, URLs, labels, metric values, sample
medians, configuration, layouts, units, platforms, and size limits.

The trusted publisher serializes writes per data repository and publishes one
commit after all platform artifacts have passed validation.

## Development

The implementation requires Node 24:

```sh
npm ci
npm run check
npm run build
npm audit --omit=dev
npm run benchmark
```

`npm run build` updates both checked-in bundles: `dist/index.js` and
`publish/dist/index.js`.
