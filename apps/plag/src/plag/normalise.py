"""Source code → a canonical token stream, so that copying survives renaming, reformatting and reordering.

SD-§13.1 step 2. Drops comments, includes and imports, `using namespace`, Python docstrings, and code that can
never run (after `return`, `break`, `continue`, `throw` in the same block). Renames identifiers to `v1, v2, ...`
by first appearance and function names to `f1, f2, ...`; literals become `N` and `S`; types, keywords, operators
and well-known library names stay. Independent top-level definitions (and the members of a Java or JavaScript
class) are put in a canonical order, and each of those is numbered on its own, so moving a function does not
change a single token of it.
"""

from __future__ import annotations

from dataclasses import dataclass

from tree_sitter import Node

from .languages import LangSpec, parser_for, spec_for


@dataclass(frozen=True)
class Normalised:
    tokens: tuple[str, ...]
    #: The 1-based source line each token came from (for showing evidence next to the original).
    lines: tuple[int, ...]

    @property
    def text(self) -> str:
        return " ".join(self.tokens)


class _Names:
    """First-appearance numbering: variables `v1..`, functions `f1..`; one map per scope."""

    def __init__(self) -> None:
        self._seen: dict[str, str] = {}
        self._vars = 0
        self._funcs = 0

    def name(self, text: str, is_function: bool) -> str:
        known = self._seen.get(text)
        if known is not None:
            return known
        if is_function:
            self._funcs += 1
            label = f"f{self._funcs}"
        else:
            self._vars += 1
            label = f"v{self._vars}"
        self._seen[text] = label
        return label


Tok = tuple[str, int]


def _is_function_name(node: Node, spec: LangSpec) -> bool:
    parent = node.parent
    if parent is None:
        return False
    for ptype, field_name in spec.function_names:
        if parent.type != ptype:
            continue
        target = parent.child_by_field_name(field_name)
        if target is not None and target.id == node.id:
            return True
    return False


def _line(node: Node) -> int:
    return node.start_point.row + 1


def _emit(node: Node, names: _Names, out: list[Tok], spec: LangSpec) -> None:
    t = node.type
    if t in spec.comments or t in spec.dropped:
        return
    if spec.drop_string_statements and t == "expression_statement" and node.child_count == 1:
        if node.children[0].type in spec.strings:
            return
    if t in spec.strings:
        out.append(("S", _line(node)))
        return
    if t in spec.numbers:
        out.append(("N", _line(node)))
        return
    if t == "preproc_arg":
        out.append(("P", _line(node)))
        return
    if node.child_count == 0:
        text = node.text.decode("utf-8", "replace") if node.text else ""
        if t in spec.identifiers and text not in spec.builtins:
            out.append((names.name(text, _is_function_name(node, spec)), _line(node)))
        elif text:
            out.append((text, _line(node)))
        return
    if t == "qualified_identifier" and spec.strip_scopes and node.child_count >= 3:
        scope = node.children[0]
        if scope.type == "namespace_identifier" and scope.text and scope.text.decode() in spec.strip_scopes:
            for child in node.children[2:]:
                _emit(child, names, out, spec)
            return
    if t in spec.blocks:
        dead = False
        for child in node.children:
            if dead and child.is_named:
                continue  # unreachable: after a jump in the same block
            _emit(child, names, out, spec)
            if child.type in spec.jumps:
                dead = True
        return
    if t in spec.member_containers:
        _emit_members(node, names, out, spec)
        return
    for child in node.children:
        _emit(child, names, out, spec)


def _sorted_slots(items: list[tuple[bool, list[Tok]]]) -> list[Tok]:
    """Flattens items, with the reorderable ones sorted among the places the reorderable ones occupy."""
    slots = [i for i, (movable, _) in enumerate(items) if movable]
    ordered = sorted((items[i] for i in slots), key=lambda it: " ".join(tok for tok, _ in it[1]))
    for slot, item in zip(slots, ordered, strict=True):
        items[slot] = item
    return [tok for _, toks in items for tok in toks]


def _leaf_text(node: Node) -> str:
    return node.text.decode("utf-8", "replace") if node.text else node.type


def _emit_members(node: Node, names: _Names, out: list[Tok], spec: LangSpec) -> None:
    """A class body: the braces stay, members that may be reordered are numbered on their own and sorted."""
    items: list[tuple[bool, list[Tok]]] = []
    children = node.children
    last = len(children) - 1
    head: list[Tok] = []
    tail: list[Tok] = []
    for i, child in enumerate(children):
        if child.type in spec.comments or child.type in spec.dropped:
            continue
        if not child.is_named:
            tok = (_leaf_text(child), _line(child))
            if i == 0:
                head.append(tok)
            elif i == last:
                tail.append(tok)
            elif items:
                items[-1][1].append(tok)  # a stray `;` belongs to the member before it
            else:
                head.append(tok)
            continue
        movable = child.type in spec.member_reorderable
        toks: list[Tok] = []
        _emit(child, _Names() if movable else names, toks, spec)
        if toks:
            items.append((movable, toks))
    out.extend(head)
    out.extend(_sorted_slots(items))
    out.extend(tail)


def normalise(source: str, language: str) -> Normalised:
    """The canonical token stream of a program. Raises `UnsupportedLanguage` for a language without a grammar."""
    spec = spec_for(language)
    tree = parser_for(language).parse(source.encode("utf-8"))
    shared = _Names()
    items: list[tuple[bool, list[Tok]]] = []
    for child in tree.root_node.children:
        if child.type in spec.comments or child.type in spec.dropped:
            continue
        if not child.is_named:
            # a stray `;` after a struct or class belongs to the item before it
            text = child.text.decode("utf-8", "replace") if child.text else child.type
            if items:
                items[-1][1].append((text, _line(child)))
            else:
                items.append((False, [(text, _line(child))]))
            continue
        movable = child.type in spec.reorderable
        toks: list[Tok] = []
        _emit(child, _Names() if movable else shared, toks, spec)
        if toks:
            items.append((movable, toks))
    flat = _sorted_slots(items)
    return Normalised(tuple(t for t, _ in flat), tuple(line for _, line in flat))
