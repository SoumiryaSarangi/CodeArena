#include "testlib.h"
int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int j = ans.readInt();
    int p = ouf.readInt();
    if (j != p) quitf(_wa, "expected %d, found %d", j, p);
    quitf(_ok, "%d", j);
}
