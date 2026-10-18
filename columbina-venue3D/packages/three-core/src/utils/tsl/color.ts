import { Fn, vec3, fract, clamp, mx_rgbtohsv, mx_hsvtorgb } from "three/tsl";

/**
 * TSL Node: Shifts color in HSV space safely.
 * Useful for procedural animations and color variations.
 * @param color - Input RGB color (vec3)
 * @param shift - Shift amount vec3(Hue, Saturation, Value)
 */
export const shiftHSV = Fn(([color, shift]: [any, any]) => {
  const hsv = mx_rgbtohsv(color);

  // Hue wraps around (0-1), while S and V are clamped
  const h = fract(hsv.x.add(shift.x)); 
  const s = clamp(hsv.y.add(shift.y), 0.0, 1.0);
  const v = clamp(hsv.z.add(shift.z), 0.0, 1.0);

  return mx_hsvtorgb(vec3(h, s, v));
});