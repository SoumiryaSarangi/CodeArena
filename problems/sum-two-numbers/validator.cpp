#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    const long long M = 1000000000000000000LL;
    inf.readLong(-M, M, "a");
    inf.readSpace();
    inf.readLong(-M, M, "b");
    inf.readEoln();
    inf.readEof();
}
