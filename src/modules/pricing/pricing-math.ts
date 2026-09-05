/** Excel ROUND for positive USD prices, using decimal integers at four places. */
export function calculateSuggestedPriceCents(partsCost: number, markup: number, laborFeeCents: number): number {
  if (!Number.isFinite(partsCost) || partsCost < 0 || !Number.isFinite(markup) || markup <= 0 ||
      !Number.isSafeInteger(laborFeeCents) || laborFeeCents < 0) {
    throw new Error('Invalid parts, markup, or labor value');
  }
  const parts = BigInt(Math.round(partsCost * 10000));
  const multiplier = BigInt(Math.round(markup * 10000));
  const total = parts * multiplier + BigInt(laborFeeCents) * 1000000n;
  const cents = Number(((total + 50000000n) / 100000000n) * 100n);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 2147483647) {
    throw new Error('Suggested price is outside the supported range');
  }
  return cents;
}

export function median(values: number[]): number {
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error('Invalid median inputs');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function issueId(repairType: string): string {
  return repairType.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}
