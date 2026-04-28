#!/usr/bin/env python3
import json
import os
import sys

from idl_parser import IDL_BUILTINS, IDL_BUILTIN_FUNCTIONS, extract_calls, find_routines, preprocess_source


def main() -> None:
    request = json.loads(sys.stdin.read())
    command = request.get("command", "index")
    files = request.get("files", [])
    root = request.get("root", "")

    if command != "index":
        print(json.dumps({"error": f"Unknown command: {command}"}))
        return

    all_symbols = {}
    all_modules = {}
    errors = []
    all_routines = {}
    total_functions = 0
    total_files = len(files)

    for file_path in files:
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
                source = handle.read()
        except Exception as exc:  # pragma: no cover - surface filesystem issues directly
            errors.append({"file": file_path, "message": str(exc)})
            continue

        try:
            rel_path = os.path.relpath(file_path, root) if root else file_path
            module_name = rel_path.replace(os.sep, ".")
            if module_name.lower().endswith(".pro"):
                module_name = module_name[:-4]
            module_id = f"{module_name}:<module>"
            lines = preprocess_source(source)
            routines = find_routines(lines)
            all_modules[module_name] = module_id
            all_symbols[module_id] = {
                "id": module_id,
                "kind": "module",
                "name": os.path.basename(module_name),
                "qualifiedName": module_name,
                "module": module_name,
                "file": file_path,
                "source": {"file": file_path, "line": 1, "column": 0, "endLine": max(1, len(source.splitlines())), "endColumn": 0},
                "calls": [],
                "topLevel": [],
                "imports": [],
            }

            for routine in routines:
                total_functions += 1
                sym_id = f"{module_name}:{routine.name}"
                routine.calls = extract_calls(routine.body_lines)
                symbol = {
                    "id": sym_id,
                    "kind": "function",
                    "name": routine.name,
                    "qualifiedName": f"{module_name}.{routine.name}",
                    "module": module_name,
                    "file": file_path,
                    "source": {
                        "file": file_path,
                        "line": routine.start_line,
                        "column": 0,
                        "endLine": routine.end_line,
                        "endColumn": 0,
                    },
                    "params": [{"name": p} for p in routine.params] + [{"name": kw.lower(), "kwOnly": True} for kw in routine.keywords],
                    "calls": [],
                    "decorators": [],
                    "isAsync": False,
                }
                for callsite in routine.calls:
                    symbol["calls"].append({
                        "text": callsite.text,
                        "line": callsite.line,
                        "column": 0,
                        "resolution": callsite.resolution,
                        "_targetName": callsite.name,
                        "_targetDisplay": callsite.name.lower(),
                        "_callType": callsite.call_type,
                    })
                all_symbols[sym_id] = symbol
                all_symbols[module_id]["topLevel"].append(sym_id)
                all_routines[routine.name.upper()] = sym_id
        except Exception as exc:
            errors.append({"file": file_path, "message": str(exc)})

    resolved_count = 0
    unresolved_count = 0
    builtin_count = 0
    out_of_scope_count = 0

    for symbol in all_symbols.values():
        for call in symbol.get("calls", []):
            target_name = str(call.pop("_targetName", "")).upper()
            display_name = str(call.pop("_targetDisplay", target_name.lower()))
            call_type = str(call.pop("_callType", ""))
            if not target_name:
                continue
            if target_name in all_routines:
                call["resolvedTo"] = all_routines[target_name]
                call["resolution"] = "resolved"
                call["resolutionSource"] = "idl-local"
                call["confidence"] = "high"
                resolved_count += 1
            elif target_name in IDL_BUILTINS or target_name in IDL_BUILTIN_FUNCTIONS:
                call["resolution"] = "unresolved"
                call["resolutionSource"] = "builtin"
                call["confidence"] = "high"
                call["externalTarget"] = display_name
                builtin_count += 1
            else:
                # Unknown target — treat as out-of-scope external dependency.
                call["resolution"] = "unresolved"
                call["resolutionSource"] = (
                    "idl-method" if call_type == "method" else "idl-external"
                )
                call["confidence"] = "low" if call_type == "method" else "medium"
                call["externalTarget"] = display_name
                unresolved_count += 1
                out_of_scope_count += 1

    result = {
        "symbols": all_symbols,
        "modules": all_modules,
        "errors": errors,
        "summary": {
            "totalFiles": total_files,
            "totalFunctions": total_functions,
            "totalClasses": 0,
            "totalTypeSlots": 0,
            "typedSlots": 0,
            "typeCoveragePct": 0.0,
            "jediEnabled": False,
            "jediResolved": 0,
            "callResolution": {
                "total": resolved_count + unresolved_count + builtin_count,
                "resolved": resolved_count,
                "likely": 0,
                "unresolved": unresolved_count,
                "builtin": builtin_count,
                "outOfScope": out_of_scope_count,
                "jedi": 0,
            },
        },
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
