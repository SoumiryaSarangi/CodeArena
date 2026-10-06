#include "testlib.h"
#include <set>
int main(int argc, char* argv[]) {
    registerValidation(argc, argv);
    int n = inf.readInt(1, 1000000, "n");
    inf.readSpace();
    int k = inf.readInt(0, std::min(n - 1, 100000), "k");
    inf.readEoln();
    std::set<int> seen;
    for (int i = 0; i < k; i++) {
        int b = inf.readInt(1, n - 1, "broken");
        ensuref(seen.insert(b).second, "broken steps must be distinct");
        if (i + 1 < k) inf.readSpace();
    }
    inf.readEoln();
    inf.readEof();
}
