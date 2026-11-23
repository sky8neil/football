export function formatSeasonLabel(seasonId: string): string {
  const crossYear = /^(\d{4})_(\d{4})$/.exec(seasonId);
  if (crossYear !== null) {
    return `${crossYear[1]}/${crossYear[2]}`;
  }
  return seasonId;
}
