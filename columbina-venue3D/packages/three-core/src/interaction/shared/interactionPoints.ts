export type InteractionPoint = {
  x: number;
  y: number;
  strength: number;
};

export function isWithinInteractionRadius(
  x: number,
  y: number,
  points: InteractionPoint[],
  radius: number,
): boolean {
  const radiusSq = radius * radius;

  for (const point of points) {
    const dx = x - point.x;
    const dy = y - point.y;
    if (dx * dx + dy * dy < radiusSq) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the strongest proximity weight (0–1) from any interaction point.
 */
export function nearestInteractionStrength(
  x: number,
  y: number,
  points: InteractionPoint[],
  radius: number,
): number {
  if (radius <= 0 || points.length === 0) {
    return 0;
  }

  const radiusSq = radius * radius;
  let strength = 0;

  for (const point of points) {
    const dx = x - point.x;
    const dy = y - point.y;
    const distSq = dx * dx + dy * dy;

    if (distSq >= radiusSq) {
      continue;
    }

    const falloff = 1 - Math.sqrt(distSq) / radius;
    strength = Math.max(strength, point.strength * falloff);
  }

  return strength;
}
