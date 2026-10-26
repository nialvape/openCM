---
name: x-post
description: How to write a single X post announcing a user-visible change (or a change and its follow-ups).
---
One message, in one post of at most 280 characters, continued in replies when it doesn't read well
in one (three posts at most, and fewer is better). When it covers several PRs, they're one story:
tell the result, not each PR.

A post goes straight to the point: no hook, no build-up, no teaser. The first line is the news.
(A story told to be read whole, opening with a hook, is a thread, not a post.)

Use the next post instead of cramming. Each post is full sentences; a fragment like
"Segundo factor: terminal o navegador" means something should move to the next post or go.

Shape:
1. Open with the news: who it's for and what they can do now, addressed the way the voice section
   says (person, number, tone). Lead with the reader's gain, not with what the project did.
2. Then what they need to do or know to use it: the command, which user to enter with, where it
   works. Only what changes how they use it.
3. A short closer if there's room: where it's available, or an invitation to try it.
With replies, the first post must still work alone (most people only see it): the news and who
it's for. The replies carry the how-to and the caveats.

Choosing what goes in:
- One main idea. A post packed with every detail and caveat reads like a changelog; pick what the
  reader needs and drop the rest. The release notes carry the full list.
- A caveat goes in only when leaving it out would mislead the reader (e.g. something that doesn't
  work yet for some of them).
- An example request in quotes only when the change makes it possible and the briefs say so.

Don't:
- Hashtags or hype words ("revolucionario", "game changer"), unless the voice asks for them.
- Internal names (functions, files, providers, PR jargon).
- Links or domain names in the post when the project puts links in a reply or in the profile.

Emoji: as the voice section says; if it says nothing, at most one.

Length: at most 280 characters per post, checked with measure_posts, never by counting yourself.
