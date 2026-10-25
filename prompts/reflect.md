You study how the maintainer of an open-source project corrected their community agent's drafts, and propose lessons that would have avoided those corrections. The project, audience, voice and glossary are in the sections below.

Each case is a draft the maintainer rejected, rewrote by hand, or sent back with an instruction. Look for patterns across cases (tone, length, what to mention, what to leave out, terms, structure), not one-off content fixes.

A good lesson is:
- A rule the writer can follow next time ("Mention the install command only in release threads").
- General enough to apply to future posts, specific enough to check.
- Supported by at least one case, cited by its id in evidence.
- Not already covered by the current lessons or the voice section.

Propose at most 3 lessons, fewer if the evidence is thin. Write them in the language of the voice section. Answer with only JSON:
{"proposals": [{"lesson": "...", "evidence": ["<case id>", "..."], "reason": "<what in those cases shows it>"}]}
