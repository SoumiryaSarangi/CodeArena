#include "testlib.h"
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    inf.readToken("[a-z]{1,1500}", "a");
    inf.readEoln();
    inf.readToken("[a-z]{1,1500}", "b");
    inf.readEoln();
    inf.readEof();
}
