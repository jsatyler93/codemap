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
    case_depth = 0

    def append_node(
        kind: str,
        label: str,
        line: int,
        structure: Optional[str] = None,
        indent_column: int = 0,
        indent_offset: int = 0,
        display_lines: Optional[List[str]] = None,
    ) -> None:
        nonlocal node_id
        node_id += 1
        node: Dict[str, object] = {
            "id": f"n{node_id}",
            "kind": kind,
            "label": label,
            "line": line,
            "indentColumn": indent_column,
            "indentOffset": indent_offset,
            "displayLines": display_lines or [label],
        }
        if structure:
            node["structure"] = structure
        nodes.append(node)

    for sl in body_lines:
        if sl.is_blank or sl.is_comment:
            continue
        text = sl.text.strip()
        upper = text.upper()
        indent_column = _count_indent_columns(sl.raw_text)
        source_lines = _source_display_lines(sl.raw_text)

        inline_if = _parse_inline_if(text)
        if inline_if and not _is_begin_clause(inline_if["then_clause"]):
            append_node(
                "decision",
                f"IF {inline_if['condition']}",
                sl.line_number,
                "inline_if",
                indent_column=indent_column,
                display_lines=[f"if {inline_if['condition']}"]
            )
            then_kind, then_label = _classify_statement_node(inline_if["then_clause"])
            append_node(
                then_kind,
                then_label,
                sl.line_number,
                "if_then",
                indent_column=indent_column,
                indent_offset=1,
                display_lines=[inline_if["then_clause"]],
            )
            else_clause = inline_if.get("else_clause")
            if else_clause and not _is_begin_clause(else_clause):
                else_kind, else_label = _classify_statement_node(else_clause)
                append_node(
                    else_kind,
                    else_label,
                    sl.line_number,
                    "if_else",
                    indent_column=indent_column,
                    indent_offset=1,
                    display_lines=[else_clause],
                )
            continue

        if _IF_PATTERN.match(upper):
            append_node("decision", text, sl.line_number, "if", indent_column=indent_column, display_lines=source_lines)
            continue
        if _FOR_PATTERN.match(upper) or _FOREACH_PATTERN.match(upper):
            append_node("loop", text, sl.line_number, "loop", indent_column=indent_column, display_lines=source_lines)
            continue
        if _WHILE_PATTERN.match(upper):
            append_node("loop", text, sl.line_number, "loop", indent_column=indent_column, display_lines=source_lines)
            continue
        if _REPEAT_PATTERN.match(upper):
            append_node("loop", text, sl.line_number, "repeat", indent_column=indent_column, display_lines=source_lines)
            continue
        if _CASE_PATTERN.match(upper) or _SWITCH_PATTERN.match(upper):
            append_node("decision", text, sl.line_number, "case", indent_column=indent_column, display_lines=source_lines)
            case_depth += 1
            continue
        if case_depth > 0:
            case_branch = _parse_case_branch(text)
            if case_branch:
                branch_kind = "case_else" if case_branch["is_else"] else "case_branch"
                append_node(
                    "decision",
                    case_branch["label"],
                    sl.line_number,
                    branch_kind,
                    indent_column=indent_column,
                    display_lines=[case_branch["displayLabel"]],
                )
                action = case_branch.get("action", "")
                if action and not _is_begin_clause(action):
                    action_kind, action_label = _classify_statement_node(action)
                    append_node(
                        action_kind,
                        action_label,
                        sl.line_number,
                        "case_action",
                        indent_column=indent_column,
                        indent_offset=1,
                        display_lines=[action],
                    )
                continue
        if _ENDIF_ELSE_PATTERN.match(upper):
            append_node("decision", "ELSE", sl.line_number, "else", indent_column=indent_column, display_lines=["else"])
            continue
        if _ELSE_PATTERN.match(upper):
            append_node("decision", "ELSE", sl.line_number, "else", indent_column=indent_column, display_lines=source_lines)
            continue
        if _ENDIF_PATTERN.match(upper) or _ENDELSE_PATTERN.match(upper):
            append_node("process", upper.split(";")[0].strip(), sl.line_number, "end_if", indent_column=indent_column, display_lines=[upper.split(";")[0].strip()])
            continue
        if _ENDFOR_PATTERN.match(upper) or _ENDFOREACH_PATTERN.match(upper) or _ENDWHILE_PATTERN.match(upper):
            append_node("process", upper.split(";")[0].strip(), sl.line_number, "end_loop", indent_column=indent_column, display_lines=[upper.split(";")[0].strip()])
            continue
        if _ENDREP_PATTERN.match(upper):
            append_node("process", upper.split(";")[0].strip(), sl.line_number, "end_repeat", indent_column=indent_column, display_lines=[upper.split(";")[0].strip()])
            continue
        if _ENDCASE_PATTERN.match(upper) or _ENDSWITCH_PATTERN.match(upper):
            case_depth = max(0, case_depth - 1)
            append_node("process", upper.split(";")[0].strip(), sl.line_number, "end_case", indent_column=indent_column, display_lines=[upper.split(";")[0].strip()])
            continue
        if upper.startswith("RETURN"):
            append_node("return", text, sl.line_number, indent_column=indent_column, display_lines=source_lines)
            continue
        if upper.startswith("BREAK"):
            append_node("break", "BREAK", sl.line_number, indent_column=indent_column, display_lines=["break"])
            continue
        if upper.startswith("CONTINUE"):
            append_node("continue", "CONTINUE", sl.line_number, indent_column=indent_column, display_lines=["continue"])
            continue
        if upper.startswith("GOTO"):
            target_label = text[4:].strip().lstrip(",").strip()
            append_node("process", f"GOTO {target_label}", sl.line_number, "goto", indent_column=indent_column, display_lines=[f"goto {target_label}"])
            continue

        kind, label = _classify_statement_node(text)
        append_node(kind, label, sl.line_number, indent_column=indent_column, display_lines=source_lines)
    return nodes


def _parse_inline_if(text: str) -> Optional[Dict[str, str]]:
    """Parse inline IF statements: IF cond THEN body [ELSE body].

    Uses token-aware splitting to handle function calls, parenthesised
    expressions and string literals in the condition and clauses.
    """
    upper = text.upper()
    if not upper.startswith("IF "):
        return None

    # Locate THEN at the top level (not inside parens/quotes).
    then_pos = _find_keyword(text, "THEN", 2)
    if then_pos == -1:
        return None

    condition = text[3:then_pos].strip()
    rest = text[then_pos + 4:].strip()
    if not rest:
        return None

    # Locate ELSE at the top level in the rest.
    else_pos = _find_keyword(rest, "ELSE", 0)
    if else_pos == -1:
        then_clause = rest
        else_clause = ""
    else:
        then_clause = rest[:else_pos].strip()
        else_clause = rest[else_pos + 4:].strip()

    return {
        "condition": condition,
        "then_clause": then_clause,
        "else_clause": else_clause,
    }


def _find_keyword(text: str, keyword: str, start: int) -> int:
    """Find *keyword* at word boundaries in *text*, skipping quoted/nested regions."""
    klen = len(keyword)
    in_single = False
    in_double = False
    depth = 0
    i = start
    while i <= len(text) - klen:
        ch = text[i]
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif in_single or in_double:
            i += 1
            continue
        elif ch in "([":
            depth += 1
        elif ch in ")]":
            depth = max(0, depth - 1)
        elif depth == 0 and text[i:i + klen].upper() == keyword:
            # Check word boundaries.
            before_ok = i == 0 or not text[i - 1].isalnum()
            after_ok = (i + klen >= len(text)) or not text[i + klen].isalnum()
            if before_ok and after_ok:
                return i
        i += 1
    return -1


def _parse_case_branch(text: str) -> Optional[Dict[str, str]]:
    if ":" not in text:
        return None

    # Find the first colon that isn't inside quotes or parentheses/brackets.
    depth_paren = 0
    depth_bracket = 0
    in_single = False
    in_double = False
    colon_pos = -1
    for idx, ch in enumerate(text):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif in_single or in_double:
            continue
        elif ch == "(":
            depth_paren += 1
        elif ch == ")":
            depth_paren = max(0, depth_paren - 1)
        elif ch == "[":
            depth_bracket += 1
        elif ch == "]":
            depth_bracket = max(0, depth_bracket - 1)
        elif ch == ":" and depth_paren == 0 and depth_bracket == 0:
            colon_pos = idx
            break

    if colon_pos < 1:
        return None

    label = text[:colon_pos].strip()
    tail = text[colon_pos + 1:].strip()

    if not label:
        return None

    # Reject lines that look like assignments (key = value) before the colon
    if "=" in label:
        upper_label = label.upper()
        # Allow relational operators used in case expressions
        if not any(op in upper_label for op in [" EQ ", " NE ", " GE ", " LE ", " GT ", " LT "]):
            return None

    return {
        "label": "ELSE" if label.upper() == "ELSE" else label,
        "displayLabel": "else:" if label.upper() == "ELSE" else label + ":",
        "action": tail,
        "is_else": "true" if label.upper() == "ELSE" else "false",
    }


def _is_begin_clause(text: str) -> bool:
    return text.upper().strip().endswith("BEGIN")


def _classify_statement_node(text: str) -> Tuple[str, str]:
    upper = text.upper().strip()
    if upper.startswith("RETURN"):
        return "return", text.strip()
    if upper.startswith("BREAK"):
        return "break", "BREAK"
    if upper.startswith("CONTINUE"):
        return "continue", "CONTINUE"
    if _looks_like_assignment(text):
        return "compute", text.strip()
    return "process", text.strip()


def _count_indent_columns(raw_text: str) -> int:
    for raw_line in raw_text.splitlines():
        if not raw_line.strip():
            continue
        indent = 0
        for char in raw_line:
            if char == " ":
                indent += 1
            elif char == "\t":
                indent += 2
            else:
                return indent
        return indent
    return 0


def _source_display_lines(raw_text: str) -> List[str]:
    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    return lines or [raw_text.strip()]


def _looks_like_assignment(text: str) -> bool:
    upper = text.upper()
    if "=" not in text:
        return False
    return not any(op in upper for op in [" EQ ", " NE ", " GE ", " LE ", " GT ", " LT "])
