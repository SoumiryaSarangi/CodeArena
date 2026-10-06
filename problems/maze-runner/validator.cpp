#include "testlib.h"
#include <string>
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 500, "n");
    inf.readSpace();
    int m = inf.readInt(1, 500, "m");
    inf.readEoln();
    ensuref(n * m >= 2, "maze needs two squares");
    int s = 0, t = 0;
    for (int i = 0; i < n; i++) {
        std::string row = inf.readToken("[.#ST]{" + std::to_string(m) + "}", "row");
        for (char c : row) { s += c == 'S'; t += c == 'T'; }
        inf.readEoln();
    }
    inf.readEof();
    ensuref(s == 1 && t == 1, "need exactly one S and one T");
}
