---
name: patch-notes
description: Structure and style for release patch notes built from several change briefs.
---
Patch notes answer, in order: what's new worth trying, what got fixed, what changed, what to do to upgrade.

Structure (omit empty sections):
1. Title line: version and a short phrase with the headline change.
2. Two or three sentence intro for users: the one or two changes that matter most.
3. "New": features and new capabilities, one bullet each, user language, with the PR number at the end (#16).
4. "Fixed": bugs users could hit, described by the symptom.
5. "Changed": behavior or defaults that differ now.
6. "Breaking changes / Upgrade": what users must do, as numbered steps. Put this first if there are breaking changes.
7. One line on how to update (taken from the project profile, e.g. the install command).

Rules: only changes present in the briefs; internal changes are left out entirely; no hype words; Markdown is fine here (the notes are a document, not a post).
