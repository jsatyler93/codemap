"""Geometry helpers used by the demo workspace."""

import math


class Circle:
    def __init__(self, radius):
        self.radius = radius

    def area(self):
        if self.radius < 0:
            raise ValueError("negative radius")
        return math.pi * self.radius * self.radius

    def circumference(self):
        return 2 * math.pi * self.radius


def polygon_area(points):
    n = len(points)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


if __name__ == "__main__":
    c = Circle(radius=2.0)
    print("Circle area:", c.area())
    print("Circle circumference:", c.circumference())
    print("Polygon area:", polygon_area([(0, 0), (3, 0), (3, 4)]))