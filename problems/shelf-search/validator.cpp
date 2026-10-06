#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 50000, "n");
    inf.readSpace();
    int q = inf.readInt(1, 50000, "q");
    inf.readEoln();
    int prev = 1;
    for (int i = 0; i < n; i++) {
        prev = inf.readInt(prev, 1000000000, "a_i");
        if (i + 1 < n) inf.readSpace();
    }
    inf.readEoln();
    for (int j = 0; j < q; j++) {
        inf.readInt(1, 1000000000, "x_j");
        if (j + 1 < q) inf.readSpace();
    }
    inf.readEoln();
    inf.readEof();
}
