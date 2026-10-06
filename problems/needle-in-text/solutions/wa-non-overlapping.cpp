#include <iostream>
#include <string>
int main() {
    std::string t, p;
    std::cin >> t >> p;
    long long cnt = 0;
    for (size_t pos = t.find(p); pos != std::string::npos; pos = t.find(p, pos + p.size())) cnt++;  // skips overlaps
    std::cout << cnt << "\n";
}
