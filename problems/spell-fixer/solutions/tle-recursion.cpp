#include <algorithm>
#include <iostream>
#include <string>
std::string a, b;
int dist(int i, int j) {   // no memoisation: exponential
    if (i == 0) return j;
    if (j == 0) return i;
    return std::min({dist(i - 1, j) + 1, dist(i, j - 1) + 1, dist(i - 1, j - 1) + (a[i - 1] != b[j - 1])});
}
int main() {
    std::cin >> a >> b;
    std::cout << dist(a.size(), b.size()) << "\n";
}
