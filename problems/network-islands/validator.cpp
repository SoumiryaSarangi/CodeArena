#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 50000, "n");
    inf.readSpace();
    int m = inf.readInt(0, 50000, "m");
    inf.readEoln();
    for (int i = 0; i < m; i++) {
        inf.readInt(1, n, "u");
        inf.readSpace();
        inf.readInt(1, n, "v");
        inf.readEoln();
    }
    inf.readEof();
}
