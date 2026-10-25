---
name: explain-change
description: How to turn a diff into user-facing impact — what counts as a change users notice and what to leave out.
---
Read the change from the user's side. For each change ask: what can a user do now that they couldn't, what works that was broken, what behaves differently, what must they do to keep working?

Count as user-facing:
- New commands, tools, options, endpoints, platforms or integrations users can call or enable.
- Fixed bugs users could hit (name the symptom they saw, not the code that fixed it).
- Changed behavior, defaults, messages or limits users will notice.
- Install, setup or upgrade steps that changed.
- Docs that fix a real misunderstanding (e.g. the correct login format).

Not user-facing (kind "internal"): refactors, renames, types, tests, CI, logging, dependency bumps without visible effect, admin-only internals users never touch.

Admin or operator features are user-facing only for the audience that operates the project; say who in userImpact ("for whoever hosts the server: …").

Be concrete: "students of the TUP can now log in" beats "improved login support". One change per idea; split a PR that does several things. If the PR description promises something the diff doesn't show, leave it out.
