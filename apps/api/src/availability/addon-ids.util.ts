export function normalizeAddonIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [input];

  const parts = raw.flatMap((value) =>
    String(value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return [...new Set(parts)].sort();
}
