# Offline demo fixtures

Use these for **screenshots and demos** without a real cluster or kubeconfig.

## Quick start

```sh
npm run demo:generate   # once, or after changing scripts/generate-demo-fixture.mjs
npm run demo            # http://localhost:4781 (4780 is left for npm start)
```

The browser title uses **Research cloud (demo)**. Switch cluster context between **demo** and **demo-busy** in the header to change live usage (calm vs busy).

## What it does

| Piece | Source |
|--------|--------|
| Tenancy (pools, departments, projects) | `examples/demo/large/tenancy.yaml` in a local git repo |
| Card counts & queue usage | JSON under `examples/demo/large/cluster/<context>/` |
| `kubectl` | `test/fixtures/bin/kubectl` (via `FAKE_CLUSTER`) |

Nothing contacts your network or your real kubeconfig.

## Customize size

The default **large** fixture is **160 GPUs on 20 nodes** (12×8 H100 + 8×8 A100), with 62 queues: one per department and project on its home pool, plus two H100 departments (and two projects of each) that also hold a small queue on the A100 pool. Edit `scripts/generate-demo-fixture.mjs` (`POOLS`, `DEPTS_PER_POOL`, `PROJECTS_PER_DEPT`, `GUESTS`), then:

```sh
npm run demo:generate
```

## Manual wiring

Same as the demo script, without npm:

```sh
export FAKE_CLUSTER="$(pwd)/examples/demo/large/cluster"
export PATH="$(pwd)/test/fixtures/bin:$PATH"
npm start -- --repo examples/demo/large --config examples/demo/large/demo.config.json --context demo --no-fetch
```

## Commits in demo mode

Commits land on a **local branch inside the demo git repo** only — safe to experiment. Nothing is pushed.
