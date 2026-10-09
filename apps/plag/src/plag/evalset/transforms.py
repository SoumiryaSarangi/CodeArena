"""Obfuscations a copier might apply (SD-§13.2: Mossad-style), written as source-to-source edits on the parse tree.

Every transform returns the new source, or `None` when it does not apply to this program or would break its syntax
(the result must parse without more errors than the original). Variants are not compiled: the eval measures what the
detector sees, and the only thing it needs from a variant is that it is the same program wearing a disguise.
Supported for C/C++ and Python, the two languages with reference solutions.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable
from dataclasses import dataclass

from tree_sitter import Node, Tree

from ..languages import LangSpec, parser_for, spec_for


@dataclass(frozen=True)
class Edit:
    start: int
    end: int
    text: str


def _apply(src: bytes, edits: list[Edit]) -> bytes:
    out = src
    for e in sorted(edits, key=lambda e: e.start, reverse=True):
        out = out[: e.start] + e.text.encode() + out[e.end :]
    return out


def _has_error(tree: Tree) -> bool:
    return bool(tree.root_node.has_error)


def _parse(src: str, lang: str) -> Tree:
    return parser_for(lang).parse(src.encode())


def _walk(node: Node):  # type: ignore[no-untyped-def]
    yield node
    for c in node.children:
        yield from _walk(c)


def _text(node: Node) -> str:
    return node.text.decode() if node.text else ""


def _checked(original: str, new: str, lang: str) -> str | None:
    """The new source, unless it is unchanged or parses worse than the original."""
    if new == original:
        return None
    if _has_error(_parse(new, lang)) and not _has_error(_parse(original, lang)):
        return None
    return new


def _is_python(lang: str) -> bool:
    return spec_for(lang).family == "python"


# ---- rename ---------------------------------------------------------------------------------------------------

_WORDS = [
    "alpha", "bravo", "delta", "echo", "foxtrot", "gamma", "hotel", "india", "juliet", "kilo", "lima", "mike",
    "nova", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "ultra", "victor", "whisky", "xray", "yankee",
]  # fmt: skip


def rename(src: str, lang: str, seed: int = 0) -> str | None:
    """Every user identifier gets a new, consistent name. Standard-library names and `main` stay."""
    spec = spec_for(lang)
    tree = _parse(src, lang)
    rnd = random.Random(seed)
    names: dict[str, str] = {}
    edits: list[Edit] = []
    for n in _walk(tree.root_node):
        if n.type not in spec.identifiers or n.child_count:
            continue
        old = _text(n)
        if old in spec.builtins:
            continue
        if n.parent is not None and n.parent.type == "qualified_identifier" and n.parent.children[0].id != n.id:
            parent_scope = _text(n.parent.children[0])
            if parent_scope in spec.strip_scopes:
                continue
        if old not in names:
            names[old] = f"{rnd.choice(_WORDS)}_{len(names) + 1}"
        edits.append(Edit(n.start_byte, n.end_byte, names[old]))
    if not edits:
        return None
    return _checked(src, _apply(src.encode(), edits).decode(), lang)


# ---- reorder --------------------------------------------------------------------------------------------------


_READS = {"cin", "scanf", "getchar", "gets", "fgets", "input", "readline", "read", "sys", "stdin"}


def _identifiers(node: Node, spec: LangSpec) -> set[str]:
    return {_text(n) for n in _walk(node) if n.type in spec.identifiers and not n.child_count} - set(
        spec.builtins - _READS
    )


def _independent(a: Node, b: Node, spec: LangSpec) -> bool:
    """Neither statement mentions a name of the other, and neither reads input (reads must keep their order)."""
    ia, ib = _identifiers(a, spec), _identifiers(b, spec)
    return not (ia & ib) and not ((ia | ib) & _READS)


def reorder(src: str, lang: str, seed: int = 0) -> str | None:
    """Swaps two neighbouring independent definitions, or two independent neighbouring declarations or assignments."""
    spec = spec_for(lang)
    tree = _parse(src, lang)
    rnd = random.Random(seed)
    py = _is_python(lang)
    pairs: list[tuple[Node, Node]] = []
    kids = [c for c in tree.root_node.children if c.is_named and c.type not in spec.comments]
    pairs += [
        (a, b)
        for a, b in zip(kids, kids[1:], strict=False)
        if a.type in spec.reorderable and b.type in spec.reorderable
    ]
    if not pairs:
        simple = "expression_statement" if py else "declaration"
        containers = [tree.root_node] + [n for n in _walk(tree.root_node) if n.type in spec.blocks]
        for c in containers:
            stmts = [x for x in c.children if x.is_named and x.type not in spec.comments]
            for x, y in zip(stmts, stmts[1:], strict=False):
                if (
                    x.type == y.type == simple
                    and (not py or ("=" in _text(x) and "=" in _text(y)))
                    and _independent(x, y, spec)
                ):
                    pairs.append((x, y))
    if not pairs:
        return None
    a, b = rnd.choice(pairs)
    raw = src.encode()
    ta, tb = raw[a.start_byte : a.end_byte], raw[b.start_byte : b.end_byte]
    edits = [Edit(a.start_byte, a.end_byte, tb.decode()), Edit(b.start_byte, b.end_byte, ta.decode())]
    return _checked(src, _apply(raw, edits).decode(), lang)


# ---- dead code ------------------------------------------------------------------------------------------------


def dead_code(src: str, lang: str, seed: int = 0) -> str | None:
    """Unused declarations, a branch that never runs and an unused function, scattered through the program."""
    spec = spec_for(lang)
    tree = _parse(src, lang)
    rnd = random.Random(seed)
    edits: list[Edit] = []
    bodies = [
        n
        for n in _walk(tree.root_node)
        if n.type in spec.blocks and n.parent is not None and n.parent.type in ("function_definition",)
    ]
    k = rnd.randrange(3, 90)
    if _is_python(lang):
        for i, body in enumerate(bodies[:3]):
            first = next((c for c in body.children if c.is_named and c.type not in spec.comments), None)
            if first is None:
                continue
            pad = " " * first.start_point.column
            edits.append(
                Edit(
                    first.start_byte,
                    first.start_byte,
                    f"unused_{i} = {k + i}\n{pad}if unused_{i} > 100000:\n{pad}    unused_{i} += 1\n{pad}",
                )
            )
        helper = f"\ndef unused_helper(value):\n    return value * {k} + 1\n\n"
        edits.append(Edit(0, 0, helper))
    else:
        for i, body in enumerate(bodies[:3]):
            brace = next((c for c in body.children if _text(c) == "{"), None)
            if brace is None:
                continue
            edits.append(
                Edit(
                    brace.end_byte,
                    brace.end_byte,
                    f" int unused_{i} = {k + i}; if (unused_{i} > 100000) {{ unused_{i} += 1; }} ",
                )
            )
        edits.append(Edit(0, 0, f"static int unused_helper(int value) {{ return value * {k} + 1; }}\n"))
    if not edits:
        return None
    return _checked(src, _apply(src.encode(), edits).decode(), lang)


# ---- loop rewrite ---------------------------------------------------------------------------------------------


def _rewrite_one_for_cpp(src: str) -> str | None:
    tree = _parse(src, "cpp17")
    for n in _walk(tree.root_node):
        if n.type != "for_statement":
            continue
        init = n.child_by_field_name("initializer")
        cond = n.child_by_field_name("condition")
        upd = n.child_by_field_name("update")
        body = n.child_by_field_name("body")
        if init is None or cond is None or upd is None or body is None:
            continue
        init_t = _text(init).rstrip()
        init_t = init_t if init_t.endswith(";") else init_t + ";"
        body_t = _text(body)
        if body.type == "compound_statement":
            inner = body_t[: body_t.rstrip().rfind("}")]
            new_body = f"{inner} {_text(upd)}; }}"
        else:
            new_body = f"{{ {body_t} {_text(upd)}; }}"
        new = f"{{ {init_t} while ({_text(cond)}) {new_body} }}"
        return (
            src[: n.start_byte] + new + src[n.end_byte :]
            if False
            else (src.encode()[: n.start_byte] + new.encode() + src.encode()[n.end_byte :]).decode()
        )
    return None


def _rewrite_one_for_python(src: str) -> str | None:
    tree = _parse(src, "python3")
    b = src.encode()
    for n in _walk(tree.root_node):
        if n.type != "for_statement":
            continue
        left = n.child_by_field_name("left")
        right = n.child_by_field_name("right")
        body = n.child_by_field_name("body")
        if left is None or right is None or body is None or left.type != "identifier":
            continue
        m = re.fullmatch(r"range\(\s*([A-Za-z_][\w]*|\d+)\s*\)", _text(right))
        if not m or "continue" in _text(body) or n.child_by_field_name("alternative") is not None:
            continue
        pad = " " * n.start_point.column
        var, limit = _text(left), m.group(1)
        lines = _text(body).split("\n")
        # keep the body's own indentation (it is already one level deeper than the `for`)
        body_block = b[body.start_byte - body.start_point.column : body.end_byte].decode()
        new = f"{var} = 0\n{pad}while {var} < {limit}:\n{body_block}\n{pad}    {var} += 1"
        del lines
        return (b[: n.start_byte] + new.encode() + b[n.end_byte :]).decode()
    return None


def loop_rewrite(src: str, lang: str, seed: int = 0) -> str | None:
    """`for` becomes `while` with the same effect (up to three loops)."""
    cur = src
    for _ in range(3):
        nxt = _rewrite_one_for_python(cur) if _is_python(lang) else _rewrite_one_for_cpp(cur)
        if nxt is None:
            break
        cur = nxt
    return _checked(src, cur, lang)


# ---- helper extraction ----------------------------------------------------------------------------------------


def extract_helper(src: str, lang: str, seed: int = 0) -> str | None:
    """The body of `main` (or a script's trailing statements) moves into a helper that `main` calls."""
    tree = _parse(src, lang)
    b = src.encode()
    if _is_python(lang):
        kids = [c for c in tree.root_node.children if c.is_named]
        tail = []
        for c in reversed(kids):
            if c.type in (
                "function_definition",
                "class_definition",
                "decorated_definition",
                "import_statement",
                "import_from_statement",
            ):
                break
            tail.append(c)
        tail.reverse()
        if not tail:
            return None
        first, last = tail[0], tail[-1]
        block = b[first.start_byte : last.end_byte].decode()
        body = "\n".join(("    " + ln) if ln.strip() else ln for ln in block.split("\n"))
        new = f"def solve_it():\n{body}\n\nsolve_it()"
        return _checked(src, (b[: first.start_byte] + new.encode() + b[last.end_byte :]).decode(), lang)
    for n in _walk(tree.root_node):
        if n.type != "function_definition":
            continue
        decl = n.child_by_field_name("declarator")
        body = n.child_by_field_name("body")
        if decl is None or body is None or not _text(decl).startswith("main"):
            continue
        new = f"int solve_it() {_text(body)}\n\nint main() {{ return solve_it(); }}"
        return _checked(src, (b[: n.start_byte] + new.encode() + b[n.end_byte :]).decode(), lang)
    return None


# ---- formatting noise -----------------------------------------------------------------------------------------


def noise(src: str, lang: str, seed: int = 0) -> str | None:
    """Comments, blank lines, and a different indentation."""
    rnd = random.Random(seed)
    py = _is_python(lang)
    mark = "#" if py else "//"
    out = []
    for ln in src.split("\n"):
        if rnd.random() < 0.15 and ln.strip():
            ln = f"{ln}  {mark} step {rnd.randrange(100)}"
        out.append(ln)
        if rnd.random() < 0.1:
            out.append("")
    text = "\n".join(out)
    if not py:  # re-indent with tabs
        text = re.sub(r"^((?:    )+)", lambda m: "\t" * (len(m.group(1)) // 4), text, flags=re.M)
    return _checked(src, f"{mark} solution\n{text}\n{mark} end\n", lang)


TRANSFORMS: dict[str, Callable[[str, str, int], str | None]] = {
    "rename": rename,
    "reorder": reorder,
    "dead": dead_code,
    "loop": loop_rewrite,
    "helper": extract_helper,
    "noise": noise,
}

#: What a copier does, from one change to everything at once.
RECIPES: list[tuple[str, ...]] = [
    ("rename",),
    ("reorder",),
    ("dead",),
    ("loop",),
    ("helper",),
    ("noise",),
    ("rename", "noise"),
    ("rename", "dead"),
    ("rename", "reorder", "loop"),
    ("rename", "dead", "helper"),
    ("rename", "reorder", "dead", "loop", "helper", "noise"),
]


def apply(src: str, lang: str, recipe: tuple[str, ...], seed: int = 0) -> tuple[str, tuple[str, ...]] | None:
    """The recipe's transforms in order, skipping those that do not apply to this program (a copier does what is
    possible). Returns the new source and the steps that really happened, or None if none of them did."""
    cur = src
    done: list[str] = []
    for i, name in enumerate(recipe):
        nxt = TRANSFORMS[name](cur, lang, seed + i)
        if nxt is not None:
            cur = nxt
            done.append(name)
    return (cur, tuple(done)) if done else None


def spec(lang: str) -> LangSpec:
    return spec_for(lang)
