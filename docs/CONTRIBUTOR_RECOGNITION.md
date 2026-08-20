# Contributor recognition

Aster credits work by impact, not employment status or commit count. Every merged pull request keeps
its author in Git history and release notes acknowledge contributors to user-visible features, GPU
performance, compatibility, documentation, design, localization, testing, and security.

## Attribution rules

- Preserve the original author on rebased or squash-merged work. Pair and agent-assisted work adds
  `Co-authored-by` trailers only for people who materially shaped the result and consent to public
  attribution.
- Reviewers receive release-note credit when their testing, design, or security analysis materially
  changes the shipped result; routine approval is not converted into artificial co-authorship.
- First-time contributors are called out in the release notes when GitHub identity is available.
- Non-code contributions link the issue, design, benchmark, translation, or report that demonstrates
  the work. Anonymous credit is honored on request.
- Security reporters are credited after coordinated disclosure unless they prefer anonymity. Reward
  language must never be promised before a funded program exists.

## Release process

Before a public release, maintainers generate the contributor list from the previous tag, reconcile
co-authors and non-code issue credits, and ask contributors to correct names or links. The final list
is committed with the release notes so recognition does not depend on a mutable website profile.

The project does not rank contributors by lines changed, use engagement leaderboards, or remove credit
when code is later refactored. The repository license governs the contribution; attribution in release
notes is recognition, not a separate ownership claim.
