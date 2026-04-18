"""A small pipeline that touches several control-flow constructs."""

from .geometry import Circle


def normalize(value):
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def run_pipeline(area, poly):
    results = []
    for v in (area, poly):
        n = normalize(v)
        if n > 100:
            results.append(n / 2)
        elif n > 10:
            results.append(n)
        else:
            results.append(n * 2)
    return _summarize(results)


def _summarize(values):
    total = 0.0
    for v in values:
        total += v
    return {
        "count": len(values),
        "total": total,
        "demo_circle": Circle(radius=1.0).area(),
    }
