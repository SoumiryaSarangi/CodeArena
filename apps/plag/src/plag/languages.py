"""Per-language settings for the normaliser: which tree-sitter grammar, and which node types mean what."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cache

import tree_sitter_c
import tree_sitter_cpp
import tree_sitter_java
import tree_sitter_javascript
import tree_sitter_python
from tree_sitter import Language, Parser


@dataclass(frozen=True)
class LangSpec:
    name: str
    #: Submissions in one family can be compared with each other (their token streams look alike).
    family: str
    grammar: object
    comments: frozenset[str]
    #: Whole subtrees that carry no solution logic (includes, imports, `using namespace`).
    dropped: frozenset[str]
    numbers: frozenset[str]
    strings: frozenset[str]
    #: Identifiers renamed to v1, v2, ... by first appearance.
    identifiers: frozenset[str]
    #: Statements after which the rest of the block is unreachable.
    jumps: frozenset[str]
    blocks: frozenset[str]
    #: Top-level nodes whose order does not matter (sorted into the slots they occupy).
    reorderable: frozenset[str]
    #: Container nodes whose members are also reordered (Java and JS class bodies).
    member_containers: frozenset[str] = frozenset()
    member_reorderable: frozenset[str] = frozenset()
    #: Standard-library names kept as they are: renaming `printf` or `sort` would only blur the signal.
    builtins: frozenset[str] = field(default_factory=frozenset)
    #: (parent type, field name) pairs that make an identifier a function name (renamed f1, f2, ...).
    function_names: frozenset[tuple[str, str]] = frozenset()
    #: Statement-sized string expressions to drop (Python docstrings).
    drop_string_statements: bool = False
    #: Namespace qualifiers that mean nothing (`std::cin` is `cin`, as after `using namespace std`).
    strip_scopes: frozenset[str] = frozenset()


def _fs(*xs: str) -> frozenset[str]:
    return frozenset(xs)


def _pairs(*xs: tuple[str, str]) -> frozenset[tuple[str, str]]:
    return frozenset(xs)


_C_BUILTINS = _fs(
    "main",
    "std",
    "cin",
    "cout",
    "cerr",
    "endl",
    "printf",
    "scanf",
    "puts",
    "getchar",
    "putchar",
    "sort",
    "min",
    "max",
    "swap",
    "abs",
    "vector",
    "string",
    "pair",
    "map",
    "set",
    "queue",
    "stack",
    "priority_queue",
    "make_pair",
    "push_back",
    "begin",
    "end",
    "size",
    "first",
    "second",
    "memset",
    "strlen",
    "sqrt",
    "NULL",
    "EOF",
    "stdin",
    "stdout",
    "fgets",
    "malloc",
    "free",
    "ios",
    "sync_with_stdio",
    "tie",
    "unordered_map",
    "deque",
    "bitset",
    "lower_bound",
    "upper_bound",
)
_C_FUNCTIONS = _pairs(("function_declarator", "declarator"), ("call_expression", "function"))
_C_REORDER = _fs(
    "function_definition",
    "declaration",
    "struct_specifier",
    "class_specifier",
    "enum_specifier",
    "template_declaration",
    "type_definition",
    "alias_declaration",
    "namespace_definition",
)


def _c_like(name: str, grammar: object, strip_scopes: frozenset[str] = frozenset()) -> LangSpec:
    """C and C++ share their node types."""
    return LangSpec(
        name=name,
        family="c",
        grammar=grammar,
        comments=_fs("comment"),
        dropped=_fs("preproc_include", "using_declaration"),
        numbers=_fs("number_literal"),
        strings=_fs("string_literal", "raw_string_literal", "concatenated_string", "char_literal", "system_lib_string"),
        identifiers=_fs("identifier", "field_identifier", "namespace_identifier"),
        jumps=_fs("return_statement", "break_statement", "continue_statement", "goto_statement", "throw_statement"),
        blocks=_fs("compound_statement"),
        reorderable=_C_REORDER,
        builtins=_C_BUILTINS,
        function_names=_C_FUNCTIONS,
        strip_scopes=strip_scopes,
    )


_CPP_SCOPES = _fs("std")

_SPECS: dict[str, LangSpec] = {}


def _register(names: tuple[str, ...], spec: LangSpec) -> None:
    for n in names:
        _SPECS[n] = spec


_register(("cpp17", "cpp20", "cpp"), _c_like("cpp", tree_sitter_cpp.language(), _CPP_SCOPES))
_register(("c",), _c_like("c", tree_sitter_c.language()))
_register(
    ("python3", "python"),
    LangSpec(
        name="python",
        family="python",
        grammar=tree_sitter_python.language(),
        comments=_fs("comment"),
        dropped=_fs("import_statement", "import_from_statement", "future_import_statement"),
        numbers=_fs("integer", "float"),
        strings=_fs("string", "concatenated_string"),
        identifiers=_fs("identifier"),
        jumps=_fs("return_statement", "break_statement", "continue_statement", "raise_statement"),
        blocks=_fs("block"),
        reorderable=_fs("function_definition", "class_definition", "decorated_definition"),
        builtins=_fs(
            "main",
            "print",
            "input",
            "range",
            "len",
            "int",
            "str",
            "float",
            "list",
            "dict",
            "set",
            "tuple",
            "sorted",
            "min",
            "max",
            "sum",
            "abs",
            "enumerate",
            "zip",
            "map",
            "sys",
            "stdin",
            "readline",
            "split",
            "append",
            "__name__",
            "__main__",
            "self",
            "True",
            "False",
            "None",
            "open",
            "join",
            "reversed",
            "any",
            "all",
        ),
        function_names=_pairs(("function_definition", "name"), ("call", "function")),
        drop_string_statements=True,
    ),
)
_register(
    ("java21", "java"),
    LangSpec(
        name="java",
        family="java",
        grammar=tree_sitter_java.language(),
        comments=_fs("line_comment", "block_comment"),
        dropped=_fs("import_declaration", "package_declaration"),
        numbers=_fs(
            "decimal_integer_literal",
            "hex_integer_literal",
            "octal_integer_literal",
            "binary_integer_literal",
            "decimal_floating_point_literal",
            "hex_floating_point_literal",
        ),
        strings=_fs("string_literal", "character_literal", "text_block"),
        identifiers=_fs("identifier"),
        jumps=_fs("return_statement", "break_statement", "continue_statement", "throw_statement"),
        blocks=_fs("block"),
        reorderable=_fs("class_declaration", "interface_declaration", "enum_declaration", "record_declaration"),
        member_containers=_fs("class_body"),
        member_reorderable=_fs(
            "method_declaration", "field_declaration", "class_declaration", "constructor_declaration"
        ),
        builtins=_fs(
            "main",
            "args",
            "System",
            "out",
            "in",
            "println",
            "print",
            "printf",
            "String",
            "Math",
            "Integer",
            "Long",
            "Scanner",
            "BufferedReader",
            "InputStreamReader",
            "StringTokenizer",
            "ArrayList",
            "List",
            "HashMap",
            "Map",
            "HashSet",
            "Set",
            "Arrays",
            "Collections",
            "sort",
            "length",
            "size",
            "add",
            "get",
            "put",
            "readLine",
            "parseInt",
            "nextInt",
            "next",
            "PrintWriter",
            "IOException",
            "Exception",
            "Deque",
            "ArrayDeque",
            "Queue",
        ),
        function_names=_pairs(
            ("method_declaration", "name"), ("method_invocation", "name"), ("constructor_declaration", "name")
        ),
    ),
)
_register(
    ("node", "javascript", "js"),
    LangSpec(
        name="javascript",
        family="javascript",
        grammar=tree_sitter_javascript.language(),
        comments=_fs("comment", "html_comment"),
        dropped=_fs("import_statement"),
        numbers=_fs("number"),
        strings=_fs("string", "template_string", "regex"),
        identifiers=_fs("identifier", "property_identifier", "shorthand_property_identifier"),
        jumps=_fs("return_statement", "break_statement", "continue_statement", "throw_statement"),
        blocks=_fs("statement_block"),
        reorderable=_fs("function_declaration", "class_declaration", "generator_function_declaration"),
        member_containers=_fs("class_body"),
        member_reorderable=_fs("method_definition", "field_definition"),
        builtins=_fs(
            "main",
            "console",
            "log",
            "require",
            "Math",
            "Number",
            "parseInt",
            "parseFloat",
            "process",
            "stdin",
            "split",
            "map",
            "push",
            "length",
            "readFileSync",
            "fs",
            "String",
            "Array",
            "Object",
            "JSON",
            "undefined",
            "this",
            "join",
            "sort",
            "slice",
            "filter",
            "reduce",
            "trim",
            "toString",
            "readline",
            "on",
        ),
        function_names=_pairs(
            ("function_declaration", "name"), ("call_expression", "function"), ("method_definition", "name")
        ),
    ),
)


class UnsupportedLanguage(ValueError):
    pass


def spec_for(language: str) -> LangSpec:
    try:
        return _SPECS[language]
    except KeyError:
        raise UnsupportedLanguage(f"no plagiarism support for language {language!r}") from None


def supported() -> list[str]:
    return sorted(_SPECS)


@cache
def parser_for(language: str) -> Parser:
    return Parser(Language(spec_for(language).grammar))
