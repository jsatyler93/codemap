"""Nested loop examples for flowchart routing demos."""


def deep_nested_scan(grid, limit):
    matches = []
    for row_index, row in enumerate(grid):
        row_total = 0
        for column_index, cell in enumerate(row):
            if cell is None:
                continue
            for candidate in cell:
                if candidate < 0:
                    continue
                if candidate > limit:
                    break
                row_total += candidate
            else:
                matches.append((row_index, column_index, row_total))
                continue
            break
        else:
            matches.append((row_index, "complete", row_total))
            continue
        if row_total > limit * 2:
            break
    else:
        matches.append(("grid", "complete", len(matches)))
    return matches


def layered_counter(levels):
    total = 0
    for outer in range(levels):
        for inner in range(outer + 1):
            for leaf in range(inner + 2):
                if leaf == 1:
                    continue
                total += outer + inner + leaf
            else:
                total += inner
        else:
            total += outer
    return total