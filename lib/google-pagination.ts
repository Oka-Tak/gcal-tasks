export interface GooglePage<T> {
  items?: T[] | null;
  nextPageToken?: string | null;
}

/**
 * Fetch every page from a Google list endpoint.
 *
 * Callers intentionally receive no partial result: if any page fails, this
 * rejects so mirror sync never mistakes an incomplete page set for deletions.
 */
export async function collectGooglePages<T>(
  load: (pageToken?: string) => Promise<GooglePage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  do {
    const page = await load(pageToken);
    items.push(...(page.items ?? []));

    const next = page.nextPageToken ?? undefined;
    if (next) {
      if (seenTokens.has(next)) {
        throw new Error("Google API returned a repeated nextPageToken");
      }
      seenTokens.add(next);
    }
    pageToken = next;
  } while (pageToken);

  return items;
}
