# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on this repository, open **Security** → **Report a vulnerability**, or go straight to [the form](https://github.com/aleibovici/krm-quota-planner/security/advisories/new).

Say what you found, how to reproduce it, and what it lets someone do. You will get a reply there, and a fix or a decision is discussed in the same place before anything is made public.

## What is in scope

krm-quota-planner is a local tool: it serves a page on `127.0.0.1`, reads a git repository or a cluster through your own `git` and `kubectl`, and writes only a local commit on a new branch. Of particular interest:

- anything that lets a web page or another machine reach the local server (it validates `Host` and requires a per-session token on API calls);
- anything that makes `git` or `kubectl` run with arguments or a shell the user did not intend;
- anything that writes to a cluster, pushes, or touches the user's checkout — the tool is meant to do none of these;
- a check that passes a plan it documents as refused.

Problems in KAI, KRM, `kubectl`, or `git` themselves belong with those projects.

## Supported versions

Fixes go to the latest commit on `main`. There are no maintained release branches.
