// Accepts "a b" with both integers in [1, 100]: a validator for the two-number test sets.
#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    inf.readInt(1, 100, "a");
    inf.readSpace();
    inf.readInt(1, 100, "b");
    inf.readEoln();
    inf.readEof();
}
