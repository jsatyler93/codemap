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
import tempfile
import textwrap
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SAMPLES = os.path.join(ROOT, "samples", "python_demo")
IDL_SAMPLES = os.path.join(ROOT, "samples", "idl_complex_demo")


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

        run_pipeline_call = next(c for c in main["calls"] if c["text"] == "run_pipeline")
        self.assertEqual(run_pipeline_call["resolution"], "resolved")
        self.assertEqual(run_pipeline_call["resolutionSource"], "ast-import-from")
        self.assertEqual(run_pipeline_call["confidence"], "high")

    def test_dynamic_calls_unresolved(self):
        # ValueError, len, etc. should be unresolved (not faked).
        rp = self.result["symbols"]["samples.python_demo.geometry:polygon_area"]
        kinds = {c["resolution"] for c in rp["calls"]}
        self.assertIn("unresolved", kinds)

    def test_builtin_calls_get_explicit_provenance(self):
        rp = self.result["symbols"]["samples.python_demo.geometry:polygon_area"]
        len_call = next(c for c in rp["calls"] if c["text"] == "len")
        self.assertEqual(len_call["resolution"], "unresolved")
        self.assertEqual(len_call["resolutionSource"], "builtin")
        self.assertEqual(len_call["confidence"], "high")
        self.assertEqual(len_call["externalTarget"], "len")

    def test_annotation_types_get_high_confidence(self):
        validate = self.result["symbols"]["samples.python_demo.config:AppConfig.validate"]
        self.assertEqual(validate["returnType"], "bool")
        self.assertEqual(validate["returnTypeSource"], "annotation")
        self.assertEqual(validate["returnTypeConfidence"], "high")

        material_init = self.result["symbols"]["samples.python_demo.models:Material.__init__"]
        albedo = next(p for p in material_init["params"] if p["name"] == "albedo")
        self.assertEqual(albedo["type"], "Tuple[float, ...]")
        self.assertEqual(albedo["typeSource"], "annotation")
        self.assertEqual(albedo["typeConfidence"], "high")

    def test_summary_includes_resolution_breakdown(self):
        summary = self.result["summary"]
        self.assertIn("callResolution", summary)
        self.assertGreater(summary["callResolution"]["total"], 0)
        self.assertGreater(summary["callResolution"]["builtin"], 0)


class FlowchartTests(unittest.TestCase):
    def test_run_pipeline_flowchart(self):
        doc = run_helper("flowchart.py", {
            "file": os.path.join(SAMPLES, "pipeline.py"),
            "line": 16,
        })
        self.assertEqual(doc["graphType"], "flowchart")
        kinds = {n["kind"] for n in doc["nodes"]}
        self.assertIn("entry", kinds)
        self.assertIn("decision", kinds)   # 'if n > 100'
        self.assertIn("loop", kinds)       # 'for v in ...'
        self.assertIn("return", kinds)
        self.assertTrue(any(e.get("label") == "repeat" for e in doc["edges"]))
        self.assertTrue(any(e.get("label") == "done" for e in doc["edges"]))
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

    def test_loop_control_nodes_are_distinct(self):
        source = textwrap.dedent(
            """
            def scan(values):
                found = []
                for value in values:
                    if value < 0:
                        continue
                    if value == 7:
                        break
                    found.append(value)
                else:
                    found.append(99)
                return found
            """
        )
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as handle:
            handle.write(source)
            temp_path = handle.name
        self.addCleanup(lambda: os.path.exists(temp_path) and os.remove(temp_path))

        doc = run_helper("flowchart.py", {"file": temp_path, "line": 3})
        kinds = {n["kind"] for n in doc["nodes"]}
        self.assertIn("loop", kinds)
        self.assertIn("break", kinds)
        self.assertIn("continue", kinds)
        self.assertIn("loop_else", kinds)
        labels = {e.get("label") for e in doc["edges"]}
        self.assertIn("repeat", labels)
        self.assertIn("continue", labels)
        self.assertIn("break", labels)
        self.assertIn("done", labels)

    def test_nested_loop_demo_flowchart(self):
        doc = run_helper("flowchart.py", {
            "file": os.path.join(SAMPLES, "nested_loops.py"),
            "line": 4,
        })
        self.assertEqual(doc["graphType"], "flowchart")
        kinds = [n["kind"] for n in doc["nodes"]]
        self.assertGreaterEqual(kinds.count("loop"), 3)
        self.assertIn("continue", kinds)
        self.assertIn("break", kinds)
        self.assertIn("loop_else", kinds)

    def test_flowchart_groups_metadata_is_emitted(self):
        source = textwrap.dedent(
            """
            def classify(values):
                total = 0
                for value in values:
                    if value > 0:
                        total += value
                    else:
                        total -= 1
                return total
            """
        )
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as handle:
            handle.write(source)
            temp_path = handle.name
        self.addCleanup(lambda: os.path.exists(temp_path) and os.remove(temp_path))

        doc = run_helper("flowchart.py", {"file": temp_path, "line": 3})
        groups = doc.get("metadata", {}).get("groups", [])
        self.assertGreaterEqual(len(groups), 3)
        kinds = {group["kind"] for group in groups}
        self.assertIn("function_body", kinds)
        self.assertIn("loop", kinds)
        self.assertIn("branch", kinds)
        loop_group = next(group for group in groups if group["kind"] == "loop")
        branch_group = next(group for group in groups if group["kind"] == "branch")
        self.assertEqual(branch_group["parentGroupId"], loop_group["id"])
        self.assertTrue(loop_group["nodeIds"])
        self.assertTrue(branch_group["nodeIds"])


class IdlFlowchartTests(unittest.TestCase):
    def test_idl_case_branches_are_emitted_as_distinct_nodes(self):
        doc = run_helper("idl_flowchart.py", {
            "file": os.path.join(IDL_SAMPLES, "codemap_demo_anomaly.pro"),
            "line": 38,
        })
        labels = [node["label"] for node in doc["nodes"]]
        self.assertIn("case alert.status of", labels)
        self.assertIn("'critical'", labels)
        self.assertIn("summary.critical = summary.critical + 1L", labels)
        self.assertIn("ELSE", labels)
        self.assertIn("summary.stable = summary.stable + 1L", labels)

    def test_idl_inline_if_emits_body_and_fallthrough_edges(self):
        doc = run_helper("idl_flowchart.py", {
            "file": os.path.join(IDL_SAMPLES, "codemap_demo_anomaly.pro"),
            "line": 38,
        })
        labels = [node["label"] for node in doc["nodes"]]
        self.assertIn("IF alert.score gt summary.max_score", labels)
        self.assertIn("summary.max_score = alert.score", labels)

        edges = {(edge["from"], edge["to"], edge.get("label")) for edge in doc["edges"]}
        decision_id = next(node["id"] for node in doc["nodes"] if node["label"] == "IF alert.score gt summary.max_score")
        body_id = next(node["id"] for node in doc["nodes"] if node["label"] == "summary.max_score = alert.score")
        end_loop_id = next(node["id"] for node in doc["nodes"] if node["label"] == "ENDFOREACH")

        self.assertIn((decision_id, body_id, "yes"), edges)
        self.assertIn((decision_id, end_loop_id, "no"), edges)

    def test_idl_flowchart_emits_groups_and_indent_metadata(self):
        doc = run_helper("idl_flowchart.py", {
            "file": os.path.join(IDL_SAMPLES, "codemap_demo_anomaly.pro"),
            "line": 38,
        })
        groups = doc.get("metadata", {}).get("groups", [])
        self.assertTrue(groups)
        kinds = {group["kind"] for group in groups}
        self.assertIn("function_body", kinds)
        self.assertIn("loop", kinds)
        self.assertIn("branch", kinds)

        nodes_by_label = {node["label"]: node for node in doc["nodes"]}
        loop_meta = nodes_by_label["foreach alert, alerts do begin"]["metadata"]
        case_meta = nodes_by_label["case alert.status of"]["metadata"]
        action_meta = nodes_by_label["summary.critical = summary.critical + 1L"]["metadata"]

        self.assertLess(loop_meta["indentLevel"], case_meta["indentLevel"])
        self.assertLess(case_meta["indentLevel"], action_meta["indentLevel"])

        # Verify statement-run collapsing produced at least one node with multiple display lines
        multi = [node for node in doc["nodes"] if len(node.get("metadata", {}).get("displayLines", [])) > 1]
        self.assertTrue(multi, "Expected at least one collapsed statement run")


if __name__ == "__main__":
    unittest.main()
