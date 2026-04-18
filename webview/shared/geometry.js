// Bezier helpers shared by both renderers.

export function cubicPt(sx, sy, c1x, c1y, c2x, c2y, tx, ty, t) {
  const u = 1 - t;
  return {
    x: u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
    y: u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty,
  };
}

export function rectAnchor(x, y, w, h, side) {
  const cx = x + w / 2, cy = y + h / 2;
  switch (side) {
    case "top":    return { x: cx, y };
    case "bottom": return { x: cx, y: y + h };
    case "left":   return { x, y: cy };
    case "right":  return { x: x + w, y: cy };
    default:       return { x: cx, y: cy };
  }
}
