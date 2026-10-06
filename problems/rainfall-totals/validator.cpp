#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 50000, "n");
    inf.readSpace();
    int q = inf.readInt(1, 50000, "q");
    inf.readEoln();
    for (int i = 0; i < n; i++) {
        inf.readInt(-1000000000, 1000000000, "a_i");
        if (i + 1 < n) inf.readSpace();
    }
    inf.readEoln();
    for (int i = 0; i < q; i++) {
        int l = inf.readInt(1, n, "l");
        inf.readSpace();
        inf.readInt(l, n, "r");
        inf.readEoln();
    }
    inf.readEof();
}
