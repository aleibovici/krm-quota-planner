# Changelog

History of `main`. This project has no Git tags and no GitHub Releases, so the sections below are dates, not versions. The `version` field in `package.json` has been `0.1.0` since the first commit and has not been released.

## 2026-10-16

- Follow a project's namespace quota across pools, listed or not — [`9515261`](https://github.com/aleibovici/krm-quota-planner/commit/95152615972bb172324c39eaf20b99c60916c7fc) (#3)
- Check fractional quotas against what the cluster can share — [`7bf0ea4`](https://github.com/aleibovici/krm-quota-planner/commit/7bf0ea4a1b9f5804ad3a8c36c3ed264086359b27) (#2)
- Pick a project's node pools from its own row — [`2c552cd`](https://github.com/aleibovici/krm-quota-planner/commit/2c552cdd083fdece019e4873f7549743ae848c51) (#1)

## 2026-10-07

- Initial commit — [`0f15dd5`](https://github.com/aleibovici/krm-quota-planner/commit/0f15dd5e543154d4fd453fe80c4af72d62677457). Local planner for KRM GPU quotas, reading a cluster or a git ref and exporting kubectl commands or a local commit, plus the offline demo and CI.
