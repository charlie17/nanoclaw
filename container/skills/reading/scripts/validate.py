"""validate — check a canvas dict against JSON Canvas 1.0 plus our own rules.

Returns a list of human-readable violation strings; empty means valid.
Nothing here writes, so it is safe to run on a canvas before or after a build.

Beyond the spec we enforce two house rules:
  * no literal backslash-n in any text field (a torn escape renders as "\\n"
    in Obsidian instead of a line break);
  * no two non-group nodes overlap (groups are containers and are exempt).

python3 stdlib only.
"""

import re

PRESET_COLORS = ("1", "2", "3", "4", "5", "6")
HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
SIDES = ("top", "right", "bottom", "left")
ENDS = ("none", "arrow")
NODE_TYPES = ("text", "file", "link", "group")
BACKGROUND_STYLES = ("cover", "ratio", "repeat")

_LITERAL_NEWLINE = "\\n"


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _check_color(value, label, violations):
    if value is None:
        return
    if not isinstance(value, str):
        violations.append("%s: color must be a string, got %r" % (label, value))
        return
    if value in PRESET_COLORS:
        return
    if HEX_COLOR.match(value):
        return
    violations.append(
        "%s: color %r is not a preset \"1\"-\"6\" or a #hex value" % (label, value)
    )


def _check_text_field(value, label, violations):
    if isinstance(value, str) and _LITERAL_NEWLINE in value:
        violations.append(
            "%s: contains a literal backslash-n; use a real newline" % label
        )


def _overlaps(a, b):
    return (
        a[0] < b[0] + b[2]
        and b[0] < a[0] + a[2]
        and a[1] < b[1] + b[3]
        and b[1] < a[1] + a[3]
    )


def validate_canvas(canvas):
    """Return a list of violation strings.  Empty list = valid canvas."""
    violations = []
    if not isinstance(canvas, dict):
        return ["canvas: expected a JSON object"]

    nodes = canvas.get("nodes")
    edges = canvas.get("edges")
    if nodes is None:
        nodes = []
    if edges is None:
        edges = []
    if not isinstance(nodes, list):
        violations.append("canvas.nodes: must be an array")
        nodes = []
    if not isinstance(edges, list):
        violations.append("canvas.edges: must be an array")
        edges = []

    seen_ids = set()
    node_ids = set()
    rects = []

    for position, node in enumerate(nodes):
        label = "nodes[%d]" % position
        if not isinstance(node, dict):
            violations.append("%s: must be an object" % label)
            continue
        ident = node.get("id")
        if not isinstance(ident, str) or not ident:
            violations.append("%s: id must be a non-empty string" % label)
        else:
            label = "nodes[%d] (%s)" % (position, ident)
            if ident in seen_ids:
                violations.append("%s: duplicate id" % label)
            seen_ids.add(ident)
            node_ids.add(ident)

        node_type = node.get("type")
        if node_type not in NODE_TYPES:
            violations.append(
                "%s: type %r is not one of %s" % (label, node_type, ", ".join(NODE_TYPES))
            )

        geometry_ok = True
        for field in ("x", "y", "width", "height"):
            if not _is_int(node.get(field)):
                violations.append("%s: %s must be an integer" % (label, field))
                geometry_ok = False
        if geometry_ok:
            if node.get("width") <= 0 or node.get("height") <= 0:
                violations.append("%s: width and height must be positive" % label)

        if node_type == "text":
            if not isinstance(node.get("text"), str):
                violations.append("%s: a text node requires a \"text\" string" % label)
            _check_text_field(node.get("text"), "%s.text" % label, violations)
        elif node_type == "file":
            if not isinstance(node.get("file"), str) or not node.get("file"):
                violations.append("%s: a file node requires a \"file\" path" % label)
        elif node_type == "link":
            if not isinstance(node.get("url"), str) or not node.get("url"):
                violations.append("%s: a link node requires a \"url\"" % label)
        elif node_type == "group":
            if "label" in node and not isinstance(node.get("label"), str):
                violations.append("%s: group label must be a string" % label)
            _check_text_field(node.get("label"), "%s.label" % label, violations)
            style = node.get("backgroundStyle")
            if style is not None and style not in BACKGROUND_STYLES:
                violations.append(
                    "%s: backgroundStyle %r is not one of %s"
                    % (label, style, ", ".join(BACKGROUND_STYLES))
                )

        _check_color(node.get("color"), label, violations)

        if geometry_ok and node_type != "group":
            rects.append((
                label,
                (node["x"], node["y"], node["width"], node["height"]),
            ))

    for first in range(len(rects)):
        for second in range(first + 1, len(rects)):
            if _overlaps(rects[first][1], rects[second][1]):
                violations.append(
                    "overlap: %s and %s occupy the same space"
                    % (rects[first][0], rects[second][0])
                )

    for position, edge in enumerate(edges):
        label = "edges[%d]" % position
        if not isinstance(edge, dict):
            violations.append("%s: must be an object" % label)
            continue
        ident = edge.get("id")
        if not isinstance(ident, str) or not ident:
            violations.append("%s: id must be a non-empty string" % label)
        else:
            label = "edges[%d] (%s)" % (position, ident)
            if ident in seen_ids:
                violations.append("%s: duplicate id" % label)
            seen_ids.add(ident)

        for field in ("fromNode", "toNode"):
            value = edge.get(field)
            if not isinstance(value, str) or not value:
                violations.append("%s: %s must be a non-empty node id" % (label, field))
            elif value not in node_ids:
                violations.append(
                    "%s: %s %r resolves to no node" % (label, field, value)
                )
        for field in ("fromSide", "toSide"):
            value = edge.get(field)
            if value is not None and value not in SIDES:
                violations.append(
                    "%s: %s %r is not one of %s" % (label, field, value, ", ".join(SIDES))
                )
        for field in ("fromEnd", "toEnd"):
            value = edge.get(field)
            if value is not None and value not in ENDS:
                violations.append(
                    "%s: %s %r is not one of %s" % (label, field, value, ", ".join(ENDS))
                )
        if "label" in edge and not isinstance(edge.get("label"), str):
            violations.append("%s: label must be a string" % label)
        _check_text_field(edge.get("label"), "%s.label" % label, violations)
        _check_color(edge.get("color"), label, violations)

    return violations


def assert_valid(canvas):
    """Raise ValueError listing every violation.  Convenience for scripts."""
    violations = validate_canvas(canvas)
    if violations:
        raise ValueError(
            "canvas failed validation (%d):\n  %s"
            % (len(violations), "\n  ".join(violations))
        )
