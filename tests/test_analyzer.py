#!/usr/bin/env python3
"""Smoke tests for analyzer.py and flowchart.py.

Run from the repo root:

    python tests/test_analyzer.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SAMPLES = os.path.join(ROOT, "samples", "python_demo")


def run_helper(script: str, payload: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "python", script)],
        input=json.dumps(payload).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return json.loads(proc.stdout.decode())


def list_sample_files() -> list:
    out = []
    for name in os.listdir(SAMPLES):
        if name.endswith(".py"):
            out.append(os.path.join(SAMPLES, name))
    return out


class AnalyzerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = run_helper("analyzer.py", {
            "command": "index", "files": list_sample_files(), "root": ROOT,
        })

    def test_no_errors(self):
        self.assertEqual(self.result["errors"], [])

    def test_modules_found(self):
        mods = self.result["modules"]
        self.assertIn("samples.python_demo.app", mods)
        self.assertIn("samples.python_demo.geometry", mods)
        self.assertIn("samples.python_demo.pipeline", mods)

    def test_class_methods_extracted(self):
        circle = self.result["symbols"]["samples.python_demo.geometry:Circle"]
        self.assertEqual(circle["kind"], "class")
        method_names = {self.result["symbols"][m]["name"] for m in circle["members"]}
        self.assertEqual(method_names, {"__init__", "area", "circumference"})

    def test_local_call_resolved(self):
        rp = self.result["symbols"]["samples.python_demo.pipeline:run_pipeline"]
        targets = {c.get("resolvedTo") for c in rp["calls"] if c.get("resolvedTo")}
        self.assertIn("samples.python_demo.pipeline:_summarize", targets)
        self.assertIn("samples.python_demo.pipeline:normalize", targets)

    def test_relative_from_import_resolved(self):
        # 'from .geometry import Circle' inside app.py
        main = self.result["symbols"]["samples.python_demo.app:main"]
        targets = {c.get("resolvedTo") for c in main["calls"] if c.get("resolvedTo")}
        self.assertIn("samples.python_demo.geometry:Circle", targets)
        self.assertIn("samples.python_demo.geometry:polygon_area", targets)
        self.assertIn("samples.python_demo.pipeline:run_pipeline", targets)

    def test_dynamic_calls_unresolved(self):
        # ValueError, len, etc. should be unresolved (not faked).
        rp = self.result["symbols"]["samples.python_demo.geometry:polygon_area"]
        kinds = {c["resolution"] for c in rp["calls"]}
        self.assertIn("unresolved", kinds)


class FlowchartTests(unittest.TestCase):
    def test_run_pipeline_flowchart(self):
        doc = run_helper("flowchart.py", {
            "file": os.path.join(SAMPLES, "pipeline.py"),
            "line": 16,
        })
        self.assertEqual(doc["graphType"], "flowchart")
        kinds = {n["kind"] for n in doc["nodes"]}
        self.assertIn("entry", kinds)
        self.assertIn("decision", kinds)   # 'if n > 100' / 'for v in ...'
        self.assertIn("return", kinds)
        # At least one edge per node-1.
        self.assertGreaterEqual(len(doc["edges"]), len(doc["nodes"]) - 1)

    def test_circle_area_flowchart(self):
        doc = run_helper("flowchart.py", {
            "file": os.path.join(SAMPLES, "geometry.py"),
            "line": 11,
        })
        self.assertEqual(doc["graphType"], "flowchart")
        kinds = [n["kind"] for n in doc["nodes"]]
        self.assertIn("error", kinds)   # 'raise ValueError'
        self.assertIn("return", kinds)


if __name__ == "__main__":
    unittest.main()
