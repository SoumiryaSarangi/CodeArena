// Like val_pair.cpp but only allows integers up to 4: it rejects an input such as "5 5".
#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    inf.readInt(1, 4, "a");
    inf.readSpace();
    inf.readInt(1, 4, "b");
    inf.readEoln();
    inf.readEof();
}
