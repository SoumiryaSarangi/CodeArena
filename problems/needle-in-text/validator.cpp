#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    inf.readToken("[a-z]{1,200000}", "t");
    inf.readEoln();
    inf.readToken("[a-z]{1,200000}", "p");
    inf.readEoln();
    inf.readEof();
}
