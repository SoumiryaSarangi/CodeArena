#include "testlib.h"
#include <string>
#include <vector>

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    int n = inf.readInt();
    long long T = inf.readLong();
    std::vector<long long> a(n);
    for (auto& x : a) x = inf.readLong();

    bool juryHasPair = ans.readToken() != "-1";

    int i = ouf.readInt(-1, n, "i");
    if (i == -1) {
        if (juryHasPair) quitf(_wa, "a valid pair exists but -1 was printed");
        quitf(_ok, "no pair");
    }
    int j = ouf.readInt(1, n, "j");
    if (i < 1 || i >= j) quitf(_wa, "need 1 <= i < j <= n, got i=%d j=%d", i, j);
    if (a[i - 1] + a[j - 1] != T)
        quitf(_wa, "a[%d] + a[%d] = %lld, not %lld", i, j, a[i - 1] + a[j - 1], T);
    if (!juryHasPair) quitf(_fail, "the participant found a pair the jury missed");
    quitf(_ok, "valid pair");
}
