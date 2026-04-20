import re
from typing import Dict, List, Optional, Tuple


class SourceLine:
    def __init__(self, text: str, line_number: int, raw_text: str):
        self.text = text
        self.line_number = line_number
        self.raw_text = raw_text
        self.is_comment = False
        self.is_blank = False


class RoutineInfo:
    def __init__(self):
        self.name = ""
        self.kind = ""
        self.params: List[str] = []
        self.keywords: List[str] = []
        self.start_line = 0
        self.end_line = 0
        self.body_lines: List[SourceLine] = []
        self.calls: List["CallSite"] = []


class CallSite:
    def __init__(self):
        self.name = ""
        self.line = 0
        self.text = ""
        self.call_type = ""
        self.resolution = "unresolved"
        self.resolved_to = None


_ROUTINE_PATTERN = re.compile(r"^(PRO|FUNCTION)\s+(\w+)\s*(,\s*(.*))?$", re.IGNORECASE)
_END_PATTERN = re.compile(r"^END\s*$", re.IGNORECASE)
_IF_PATTERN = re.compile(r"^IF\b", re.IGNORECASE)
_FOR_PATTERN = re.compile(r"^FOR\s+", re.IGNORECASE)
_FOREACH_PATTERN = re.compile(r"^FOREACH\s+", re.IGNORECASE)
_WHILE_PATTERN = re.compile(r"^WHILE\b", re.IGNORECASE)
_REPEAT_PATTERN = re.compile(r"^REPEAT\b", re.IGNORECASE)
_CASE_PATTERN = re.compile(r"^CASE\b", re.IGNORECASE)
_SWITCH_PATTERN = re.compile(r"^SWITCH\b", re.IGNORECASE)
_ELSE_PATTERN = re.compile(r"^ELSE\b", re.IGNORECASE)
_ENDIF_ELSE_PATTERN = re.compile(r"^(ENDIF|ENDELSE)\s+ELSE\b", re.IGNORECASE)
_ENDIF_PATTERN = re.compile(r"^ENDIF\b", re.IGNORECASE)
_ENDELSE_PATTERN = re.compile(r"^ENDELSE\b", re.IGNORECASE)
_ENDFOR_PATTERN = re.compile(r"^ENDFOR\b", re.IGNORECASE)
_ENDFOREACH_PATTERN = re.compile(r"^ENDFOREACH\b", re.IGNORECASE)
_ENDWHILE_PATTERN = re.compile(r"^ENDWHILE\b", re.IGNORECASE)
_ENDREP_PATTERN = re.compile(r"^ENDREP\b", re.IGNORECASE)
_ENDCASE_PATTERN = re.compile(r"^ENDCASE\b", re.IGNORECASE)
_ENDSWITCH_PATTERN = re.compile(r"^ENDSWITCH\b", re.IGNORECASE)
_FUNCTION_CALL = re.compile(r"(\w+)\s*\(", re.IGNORECASE)
_PROCEDURE_CALL = re.compile(r"^(\w+)\s*,", re.IGNORECASE)
_METHOD_CALL_ARROW = re.compile(r"(\w+)\s*->\s*(\w+)", re.IGNORECASE)
_METHOD_CALL_DOT = re.compile(r"(\w+)\s*\.\s*(\w+)\s*[,(]", re.IGNORECASE)

IDL_BUILTINS = {
    "PRINT", "PRINTF", "HELP", "STOP", "MESSAGE", "ON_ERROR",
    "OPENR", "OPENW", "OPENU", "CLOSE", "FREE_LUN",
    "READF", "READU", "WRITEU", "POINT_LUN",
    "PLOT", "OPLOT", "CONTOUR", "SURFACE", "SHADE_SURF",
    "TVSCL", "TV", "LOADCT", "DEVICE", "SET_PLOT", "WINDOW",
    "WIDGET_CONTROL", "WIDGET_BASE", "WIDGET_BUTTON", "WIDGET_TEXT",
    "CD", "FILE_MKDIR", "FILE_DELETE", "SPAWN",
    "PTR_NEW", "PTR_FREE", "OBJ_NEW", "OBJ_DESTROY",
    "CATCH", "ON_IOERROR", "RETALL", "RETURN",
}

IDL_BUILTIN_FUNCTIONS = {
    "WHERE", "N_ELEMENTS", "SIZE", "STRLEN", "STRMID", "STRTRIM",
    "STRPOS", "STRCOMPRESS", "STRING", "STRSPLIT", "STRUPCASE", "STRLOWCASE",
    "FIX", "FLOAT", "DOUBLE", "LONG", "BYTE", "COMPLEX", "UINT", "ULONG",
    "FINDGEN", "INDGEN", "LINDGEN", "DINDGEN", "FLTARR", "DBLARR",
    "INTARR", "LONARR", "BYTARR", "STRARR", "COMPLEXARR", "OBJARR",
    "MAKE_ARRAY", "REPLICATE", "REFORM", "REBIN", "CONGRID",
    "TOTAL", "MEAN", "MEDIAN", "MIN", "MAX", "SORT", "UNIQ", "REVERSE",
    "SHIFT", "ROTATE", "TRANSPOSE", "DIAG_MATRIX",
    "ABS", "SQRT", "ALOG", "ALOG10", "EXP", "SIN", "COS", "TAN",
    "ASIN", "ACOS", "ATAN", "CEIL", "FLOOR", "ROUND",
    "FFT", "CONVOL", "SMOOTH", "INTERPOLATE", "INTERPOL",
    "POLY_FIT", "CURVEFIT", "GAUSSFIT", "REGRESS",
    "FILE_SEARCH", "FILE_TEST", "FILE_INFO", "FILE_LINES",
    "DIALOG_PICKFILE", "DIALOG_MESSAGE",
    "SYSTIME", "KEYWORD_SET", "N_PARAMS", "ARG_PRESENT",
    "TAG_NAMES", "CREATE_STRUCT", "N_TAGS",
    "PTR_VALID", "OBJ_VALID", "OBJ_ISA", "OBJ_CLASS",
    "EXECUTE", "CALL_FUNCTION", "CALL_PROCEDURE",
    "FINITE", "ISHFT", "BYTSCL",
    "READ_ASCII", "READ_BINARY", "READ_CSV",
    "MRDFITS", "READFITS", "SXPAR", "FXPAR",
}


def preprocess_source(source: str) -> List[SourceLine]:
    raw_lines = source.splitlines()
    result: List[SourceLine] = []
    index = 0
    while index < len(raw_lines):
        raw = raw_lines[index]
        line_number = index + 1
        stripped = raw.strip()
        if not stripped:
            sl = SourceLine("", line_number, raw)
            sl.is_blank = True
            result.append(sl)
            index += 1
            continue
        if stripped.startswith(";"):
            sl = SourceLine(stripped, line_number, raw)
            sl.is_comment = True
            result.append(sl)
            index += 1
            continue

        code_part = _strip_inline_comment(raw)
        merged = code_part.rstrip()
        raw_merged = raw
        while merged.endswith("$") and index + 1 < len(raw_lines):
            merged = merged[:-1].rstrip()
            index += 1
            next_raw = raw_lines[index]
            next_code = _strip_inline_comment(next_raw).strip()
            merged = (merged + " " + next_code).strip()
            raw_merged = raw_merged + "\n" + next_raw

        result.append(SourceLine(merged.strip(), line_number, raw_merged))
        index += 1
    return result


def _strip_inline_comment(line: str) -> str:
    in_single = False
    in_double = False
    for idx, ch in enumerate(line):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == ";" and not in_single and not in_double:
            return line[:idx].rstrip()
    return line.rstrip()


def find_routines(lines: List[SourceLine]) -> List[RoutineInfo]:
    routines: List[RoutineInfo] = []
    current: Optional[RoutineInfo] = None
    for sl in lines:
        if sl.is_blank or sl.is_comment:
            if current:
                current.body_lines.append(sl)
            continue

        m = _ROUTINE_PATTERN.match(sl.text.strip())
        if m:
            if current:
                current.end_line = sl.line_number - 1
                routines.append(current)
            current = RoutineInfo()
            kind = m.group(1).upper()
            current.kind = "function" if kind == "FUNCTION" else "pro"
            current.name = m.group(2).strip()
            current.start_line = sl.line_number
            params = m.group(4)
            if params:
                current.params, current.keywords = _parse_params(params)
            continue

        if _END_PATTERN.match(sl.text.strip()) or sl.text.upper().strip().startswith("END;"):
            if current:
                current.end_line = sl.line_number
                routines.append(current)
                current = None
            continue

        if current:
            current.body_lines.append(sl)

    if current:
        current.end_line = lines[-1].line_number if lines else current.start_line
        routines.append(current)
    return routines


def _parse_params(param_str: str) -> Tuple[List[str], List[str]]:
    positional: List[str] = []
    keywords: List[str] = []
    for part in [piece.strip() for piece in param_str.split(",")]:
        if not part:
            continue
        if part.startswith("/"):
            keywords.append(part[1:].strip().upper())
        elif "=" in part:
            keywords.append(part.split("=", 1)[0].strip().upper())
        else:
            positional.append(part.strip())
    return positional, keywords


def extract_calls(body_lines: List[SourceLine]) -> List[CallSite]:
    calls: List[CallSite] = []
    for sl in body_lines:
        if sl.is_blank or sl.is_comment:
            continue
        text = sl.text.strip()
        upper = text.upper()
        if any(upper.startswith(prefix) for prefix in [
            "IF ", "ENDIF", "ELSE", "FOR ", "ENDFOR", "FOREACH ", "ENDFOREACH",
            "WHILE ", "ENDWHILE", "REPEAT", "ENDREP", "CASE ", "ENDCASE", "SWITCH ",
            "ENDSWITCH", "BEGIN", "END", "RETURN", "BREAK", "CONTINUE", "GOTO",
            "COMMON", "FORWARD_FUNCTION", "COMPILE_OPT", "ON_ERROR",
        ]):
            _extract_function_calls_from_expr(text, sl.line_number, calls)
            continue

        proc_match = _PROCEDURE_CALL.match(text)
        if proc_match:
            name = proc_match.group(1).upper()
            if name not in IDL_BUILTINS and not name.startswith("!"):
                cs = CallSite()
                cs.name = name
                cs.line = sl.line_number
                cs.text = text
                cs.call_type = "procedure"
                calls.append(cs)

        for matcher in _METHOD_CALL_ARROW.finditer(text):
            cs = CallSite()
            cs.name = matcher.group(2).upper()
            cs.line = sl.line_number
            cs.text = matcher.group(0)
            cs.call_type = "method"
            calls.append(cs)

        for matcher in _METHOD_CALL_DOT.finditer(text):
            cs = CallSite()
            cs.name = matcher.group(2).upper()
            cs.line = sl.line_number
            cs.text = matcher.group(0)
            cs.call_type = "method"
            calls.append(cs)

        _extract_function_calls_from_expr(text, sl.line_number, calls)
    return calls


def _extract_function_calls_from_expr(text: str, line_number: int, calls: List[CallSite]) -> None:
    for matcher in _FUNCTION_CALL.finditer(text):
        name = matcher.group(1).upper()
        if name in {"IF", "WHILE", "CASE", "SWITCH", "FOR", "FOREACH", "REPEAT"}:
            continue
        if name in IDL_BUILTIN_FUNCTIONS:
            continue
        if any(call.name == name and call.line == line_number for call in calls):
            continue
        cs = CallSite()
        cs.name = name
        cs.line = line_number
        cs.text = matcher.group(0)
        cs.call_type = "function"
        calls.append(cs)


def detect_control_flow(body_lines: List[SourceLine]) -> List[Dict[str, object]]:
    nodes: List[Dict[str, object]] = []
    node_id = 0
    for sl in body_lines:
        if sl.is_blank or sl.is_comment:
            continue
        upper = sl.text.upper().strip()
        node_id += 1
        nid = f"n{node_id}"

        if _IF_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "decision", "label": sl.text.strip(), "line": sl.line_number, "structure": "if"})
            continue
        if _FOR_PATTERN.match(upper) or _FOREACH_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "loop", "label": sl.text.strip(), "line": sl.line_number, "structure": "loop"})
            continue
        if _WHILE_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "loop", "label": sl.text.strip(), "line": sl.line_number, "structure": "loop"})
            continue
        if _REPEAT_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "loop", "label": sl.text.strip(), "line": sl.line_number, "structure": "repeat"})
            continue
        if _CASE_PATTERN.match(upper) or _SWITCH_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "decision", "label": sl.text.strip(), "line": sl.line_number, "structure": "case"})
            continue
        if _ENDIF_ELSE_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "decision", "label": "ELSE", "line": sl.line_number, "structure": "else"})
            continue
        if _ELSE_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "decision", "label": "ELSE", "line": sl.line_number, "structure": "else"})
            continue
        if _ENDIF_PATTERN.match(upper) or _ENDELSE_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(";")[0].strip(), "line": sl.line_number, "structure": "end_if"})
            continue
        if _ENDFOR_PATTERN.match(upper) or _ENDFOREACH_PATTERN.match(upper) or _ENDWHILE_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(";")[0].strip(), "line": sl.line_number, "structure": "end_loop"})
            continue
        if _ENDREP_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(";")[0].strip(), "line": sl.line_number, "structure": "end_repeat"})
            continue
        if _ENDCASE_PATTERN.match(upper) or _ENDSWITCH_PATTERN.match(upper):
            nodes.append({"id": nid, "kind": "process", "label": upper.split(";")[0].strip(), "line": sl.line_number, "structure": "end_case"})
            continue
        if upper.startswith("RETURN"):
            nodes.append({"id": nid, "kind": "return", "label": sl.text.strip(), "line": sl.line_number})
            continue
        if upper.startswith("BREAK"):
            nodes.append({"id": nid, "kind": "break", "label": "BREAK", "line": sl.line_number})
            continue
        if upper.startswith("CONTINUE"):
            nodes.append({"id": nid, "kind": "continue", "label": "CONTINUE", "line": sl.line_number})
            continue

        kind = "compute" if _looks_like_assignment(sl.text) else "process"
        nodes.append({"id": nid, "kind": kind, "label": sl.text.strip(), "line": sl.line_number})
    return nodes


def _looks_like_assignment(text: str) -> bool:
    upper = text.upper()
    if "=" not in text:
        return False
    return not any(op in upper for op in [" EQ ", " NE ", " GE ", " LE ", " GT ", " LT "])
