export type LibraryReading = { key: string; ids: string[] };

/** Keep the reading cohort until user intent changes; only full-inventory absence removes an ID. */
export function reconcileLibraryReading(previous: LibraryReading | null, allIds: readonly string[], candidateIds: readonly string[], key: string): LibraryReading & { pending: boolean } {
  if (!previous || previous.key !== key) return { key, ids: [...candidateIds], pending: false };
  const available = new Set(allIds);
  const ids = previous.ids.filter(id => available.has(id));
  const retained = new Set(ids);
  for (const id of candidateIds) {
    if (available.has(id) && !retained.has(id)) { ids.push(id); retained.add(id); }
  }
  const pending = ids.length !== candidateIds.length || ids.some((id, index) => id !== candidateIds[index]);
  return { key, ids, pending };
}

/** On real deletion, keep the closest following survivor, then the preceding survivor. */
export function nearestSurvivingId(previousIds: readonly string[], currentIds: readonly string[], selectedId: string): string {
  const current = new Set(currentIds);
  if (current.has(selectedId)) return selectedId;
  const index = previousIds.indexOf(selectedId);
  if (index >= 0) {
    for (let next = index + 1; next < previousIds.length; next++) if (current.has(previousIds[next])) return previousIds[next];
    for (let prior = index - 1; prior >= 0; prior--) if (current.has(previousIds[prior])) return previousIds[prior];
  }
  return currentIds[0] || '';
}
