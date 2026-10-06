#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
int main() {
    int n;
    std::cin >> n;
    std::vector<std::pair<int, std::string>> v(n);
    for (auto& p : v) {
        std::cin >> p.second >> p.first;
        p.first = -p.first;
    }
    std::sort(v.begin(), v.end());
    for (auto& p : v) std::cout << p.second << " " << -p.first << "\n";
}
