# Contributing

Thanks for your interest in improving krm-quota-planner.

Setup, the test commands, and where things live are under [Development](README.md#development) in the README. `npm run demo` runs the planner on bundled fixtures, with no cluster needed.

## Before you open a pull request

1. Run the test suites: `npm run test:all` (or `npm test` and `npm run test:e2e` separately)
2. Keep changes focused — the planner is deliberately small; match existing style in the files you touch
3. Do not commit secrets, kubeconfigs, or copies of real cluster tenancy files that identify a particular organization

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE), the same terms as the rest of this project.

## Questions and bugs

Security problems go through [SECURITY.md](SECURITY.md), not a public issue. For everything else, open an issue with:

- What you expected
- What happened (error text, screenshot, or minimal repro steps)
- Whether you were planning from the **cluster** or **git** source
