#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int q = inf.readInt(1, 50000, "q");
    inf.readEoln();
    for (int i = 0; i < q; i++) {
        inf.readInt(1, 500000, "x");
        if (i + 1 < q) inf.readSpace();
    }
    inf.readEoln();
    inf.readEof();
}
