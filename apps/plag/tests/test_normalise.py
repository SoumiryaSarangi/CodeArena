"""PL-01 / FR-PLAG-01: normalisation makes copying survive renaming, reformatting and reordering, and nothing else."""

from pathlib import Path

import pytest

from plag.languages import UnsupportedLanguage, supported
from plag.normalise import normalise

PROBLEMS = Path(__file__).resolve().parents[3] / "problems"


def toks(src: str, lang: str) -> tuple[str, ...]:
    return normalise(src, lang).tokens


class TestCpp:
    BASE = """#include <bits/stdc++.h>
using namespace std;
int helper(int x) { return x * 2; }
int main() {
    int n; cin >> n; long long total = 0;
    for (int i = 0; i < n; i++) { total += helper(i); }
    cout << total << endl;
    return 0;
}
"""

    def test_comments_includes_and_formatting_do_not_matter(self):
        noisy = """#include <cstdio>
#include <iostream>
// the helper
int helper(int x)
{
    /* doubled */ return x * 2;
}

int main()
{
    int n;
    std::cin >> n;
    long long total = 0;   // running
    for (int i = 0; i < n; i++)
    {
        total += helper(i);
    }
    std::cout << total << std::endl;
    return 0;
}
"""
        assert toks(noisy, "cpp17") == toks(self.BASE, "cpp17")

    def test_renaming_variables_and_functions_does_not_matter(self):
        renamed = """#include <iostream>
using namespace std;
int twice(int y) { return y * 2; }
int main() {
    int count; cin >> count; long long answer = 0;
    for (int q = 0; q < count; q++) { answer += twice(q); }
    cout << answer << endl;
    return 0;
}
"""
        assert toks(renamed, "cpp17") == toks(self.BASE, "cpp17")

    def test_functions_are_renamed_apart_from_variables(self):
        t = toks(self.BASE, "cpp17")
        assert "f1" in t and t.count("f1") == 2  # defined once, called once
        assert "helper" not in t and "total" not in t

    def test_moving_a_function_changes_nothing(self):
        moved = """#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n; long long total = 0;
    for (int i = 0; i < n; i++) { total += helper(i); }
    cout << total << endl;
    return 0;
}
int helper(int x) { return x * 2; }
"""
        assert toks(moved, "cpp17") == toks(self.BASE, "cpp17")

    def test_dead_code_after_a_jump_is_dropped(self):
        with_dead = self.BASE.replace("return 0;", 'return 0; cout << "never" << endl; int unused = 1;')
        assert toks(with_dead, "cpp17") == toks(self.BASE, "cpp17")
        loop = "int main(){ for(;;){ if(x){ break; y++; } } }"
        plain = "int main(){ for(;;){ if(x){ break; } } }"
        assert toks(loop, "cpp17") == toks(plain, "cpp17")

    def test_literals_become_n_and_s_and_std_scope_is_ignored(self):
        t = toks("int main(){ std::string s = \"hello\"; int k = 42; char c = 'x'; }", "cpp17")
        assert "N" in t and t.count("S") == 2
        assert "hello" not in t and "42" not in t
        assert toks("int main(){ std::cin >> a; }", "cpp17") == toks(
            "using namespace std; int main(){ cin >> a; }", "cpp17"
        )

    def test_different_logic_stays_different(self):
        assert toks("int f(int a,int b){return a+b;}", "cpp17") != toks("int f(int a,int b){return a-b;}", "cpp17")
        assert toks("int f(int a){for(;a;)a--;return a;}", "cpp17") != toks(
            "int f(int a){while(a)a--;return a;}", "cpp17"
        )

    def test_c_and_cpp_share_the_pipeline(self):
        src = '#include <stdio.h>\nint main(void){ int x; scanf("%d", &x); printf("%d", x); return 0; }'
        assert toks(src, "c") == toks(src, "cpp17")

    def test_a_struct_and_its_semicolon_move_together(self):
        a = "struct P { int a; };\nint f(P p){ return p.a; }\nint main(){ return 0; }"
        b = "int main(){ return 0; }\nint f(P p){ return p.a; }\nstruct P { int a; };"
        assert toks(a, "cpp17") == toks(b, "cpp17")


class TestPython:
    BASE = '''import sys
def helper(a):
    """double it"""
    return a * 2
    print("dead")

n = int(input())
total = 0
for i in range(n):
    total += helper(i)
print(total)
'''

    def test_renaming_comments_docstrings_and_imports(self):
        other = """def twice(z):
    return z * 2  # twice

count = int(input())
answer = 0
for q in range(count):
    answer += twice(q)
print(answer)
"""
        assert toks(other, "python3") == toks(self.BASE, "python3")

    def test_function_order_is_free_but_a_script_keeps_its_order(self):
        reordered = """def helper(a):
    return a * 2

n = int(input())
total = 0
for i in range(n):
    total += helper(i)
print(total)
"""
        assert toks(reordered, "python3") == toks(self.BASE, "python3")
        # statements of a script are not shuffled: swapping two dependent lines is a different program
        assert toks("a = 1\nb = a + 2\nprint(b)", "python3") != toks("b = a + 2\na = 1\nprint(b)", "python3")

    def test_names_are_numbered_across_the_script_so_two_variables_stay_two(self):
        t = toks("x = 1\ny = x + 2\nprint(y)", "python3")
        assert t == ("v1", "=", "N", "v2", "=", "v1", "+", "N", "print", "(", "v2", ")")


class TestJavaAndJavaScript:
    JAVA = """import java.util.*;
public class Main {
    static int helper(int x) { return x * 2; }
    static int base = 3;
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        System.out.println(helper(n) + base);
    }
}
"""

    def test_java_rename_and_member_order(self):
        other = """import java.io.*;
public class Main {
    static int base = 3;
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int count = in.nextInt();
        System.out.println(twice(count) + base);
    }
    static int twice(int y) { return y * 2; }
}
"""
        assert toks(other, "java21") == toks(self.JAVA, "java21")

    def test_java_dead_code(self):
        a = "class A { int f(){ return 1; } }"
        b = "class A { int f(){ return 1; int z = 2; } }"
        assert toks(a, "java21") == toks(b, "java21")

    JS = """const fs = require("fs");
function helper(x) { return x * 2; }
class Box { get(v) { return v; } put(v) { return v + 1; } }
const n = parseInt(fs.readFileSync(0, "utf8"));
console.log(helper(n));
"""

    def test_javascript_rename_member_order_and_dead_code(self):
        # the class and the function swap places (both reorderable), everything is renamed, dead code is added
        other = """const fs = require("fs");
class Crate { put(w) { return w + 1; } get(w) { return w; } }
function twice(y) { return y * 2; throw new Error("x"); }
const count = parseInt(fs.readFileSync(0, "utf8"));
console.log(twice(count));
"""
        assert toks(other, "node") == toks(self.JS, "node")

    def test_javascript_template_and_regex_literals_are_s(self):
        t = toks("let s = `a${1}`; let r = /x+/g;", "node")
        assert t.count("S") == 2


class TestEdges:
    def test_unsupported_language_is_an_error_not_a_guess(self):
        with pytest.raises(UnsupportedLanguage):
            normalise("print 1", "brainfuck")
        assert {"cpp17", "cpp20", "c", "python3", "java21", "node"} <= set(supported())

    def test_broken_code_still_normalises(self):
        assert len(toks("int main( { return ; ", "cpp17")) > 3
        assert toks("", "python3") == ()

    def test_lines_point_into_the_source(self):
        n = normalise("int a;\n\n\nint b;\n", "cpp17")
        assert len(n.lines) == len(n.tokens)
        assert set(n.lines) <= {1, 4}
        assert n.text.startswith("int v1 ;")

    def test_every_reference_solution_normalises_deterministically(self):
        checked = 0
        for path in sorted(PROBLEMS.glob("*/solutions/*")):
            lang = {".cpp": "cpp17", ".py": "python3", ".java": "java21", ".js": "node", ".c": "c"}.get(path.suffix)
            if lang is None:
                continue
            src = path.read_text()
            first = normalise(src, lang)
            assert first == normalise(src, lang), path
            assert len(first.tokens) >= 5, path
            checked += 1
        assert checked >= 100  # 20 problems x 7 solutions
