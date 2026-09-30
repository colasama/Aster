/** Ranks candidate names for "did you mean" hints in agent-facing errors. */
export function closestNames(input: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = input.toLocaleLowerCase();
  const scored: Array<{ name: string; score: number; index: number }> = [];
  let index = 0;
  for (const name of candidates) {
    const candidate = name.toLocaleLowerCase();
    // Whole-word and substring matches tie, so the catalog order (common entries first) decides.
    let score: number;
    if (words(candidate).includes(needle) || words(needle).includes(candidate)) score = -2;
    else if (candidate.includes(needle) || needle.includes(candidate)) score = -1;
    else {
      score = editDistance(needle, candidate) / Math.max(needle.length, candidate.length, 1);
      if (sharedWords(needle, candidate)) score -= 0.3;
    }
    scored.push({ name, score, index: index++ });
  }
  return scored
    .filter((entry) => entry.score < 0.55)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.name);
}

export function didYouMean(input: string, candidates: Iterable<string>, limit = 3): string {
  const matches = closestNames(input, candidates, limit);
  return matches.length ? ` Did you mean: ${matches.join(", ")}?` : "";
}

function words(value: string): string[] {
  return value.split(/[^a-z0-9]+/u).filter(Boolean);
}

function sharedWords(left: string, right: string): boolean {
  const words = new Set(left.split(/[^a-z0-9]+/u).filter((word) => word.length > 2));
  return right.split(/[^a-z0-9]+/u).some((word) => words.has(word));
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}
