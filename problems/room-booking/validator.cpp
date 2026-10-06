#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 60000, "n");
    inf.readEoln();
    for (int i = 0; i < n; i++) {
        int s = inf.readInt(0, 999999, "s");
        inf.readSpace();
        inf.readInt(s + 1, 1000000, "e");
        inf.readEoln();
    }
    inf.readEof();
}
