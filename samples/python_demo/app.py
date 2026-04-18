"""Tiny demo workspace exercising flowchart + call-graph features."""

from .geometry import Circle, polygon_area
from .pipeline import run_pipeline


def main():
    c = Circle(radius=2.0)
    if c.radius <= 0:
        raise ValueError("radius must be positive")
    area = c.area()
    poly = polygon_area([(0, 0), (3, 0), (3, 4)])
    return run_pipeline(area, poly)


if __name__ == "__main__":
    print(main())
