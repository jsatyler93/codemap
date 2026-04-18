"""Affine transform primitives: translate, rotate, scale, compose."""

import math
from typing import List, Tuple


class TransformStack:
    """Ordered stack of transforms applied sequentially."""

    def __init__(self):
        self.stack: List["Transform"] = []

    def push(self, t: "Transform"):
        self.stack.append(t)

    def pop(self) -> "Transform":
        return self.stack.pop()

    def compose_all(self):
        if not self.stack:
            return _identity()
        result = self.stack[0].matrix
        for t in self.stack[1:]:
            result = _mat_mul(result, t.matrix)
        return result


class Transform:
    """A 3×3 affine transform matrix."""

    def __init__(self, matrix):
        self.matrix = matrix

    def apply(self, point: Tuple[float, float]) -> Tuple[float, float]:
        m = self.matrix
        x = m[0][0] * point[0] + m[0][1] * point[1] + m[0][2]
        y = m[1][0] * point[0] + m[1][1] * point[1] + m[1][2]
        return (x, y)


def translate(dx: float, dy: float, dz: float = 0.0) -> Transform:
    return Transform([
        [1, 0, dx],
        [0, 1, dy],
        [0, 0, 1],
    ])


def rotate(angle_deg: float, axis: str = "z") -> Transform:
    r = math.radians(angle_deg)
    c, s = math.cos(r), math.sin(r)
    return Transform([
        [c, -s, 0],
        [s,  c, 0],
        [0,  0, 1],
    ])


def scale_transform(sx: float, sy: float, sz: float = 1.0) -> Transform:
    return Transform([
        [sx, 0, 0],
        [0, sy, 0],
        [0,  0, 1],
    ])


def compose_transforms(*transforms: Transform) -> Transform:
    if not transforms:
        return Transform(_identity())
    result = transforms[0].matrix
    for t in transforms[1:]:
        result = _mat_mul(result, t.matrix)
    return Transform(result)


def apply_to_mesh(geometry, transform: Transform):
    """Apply a transform to a geometry's vertices (if polygon-like)."""
    if hasattr(geometry, "vertices"):
        new_verts = [transform.apply(v) for v in geometry.vertices]
        geometry.vertices = new_verts
    return geometry


def _identity():
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]


def _mat_mul(a, b):
    result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for i in range(3):
        for j in range(3):
            for k in range(3):
                result[i][j] += a[i][k] * b[k][j]
    return result
