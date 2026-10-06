#include <cstdio>
#include <vector>
int main() {
    std::vector<char> v(1u << 30, 1);
    long long s = 0;
    for (size_t i = 0; i < v.size(); i += 4096) s += v[i];
    std::printf("%lld\n", s);
    return 0;
}
