#include <algorithm>
#include <iostream>
#include <vector>
int main() {
    int n;
    std::cin >> n;
    std::vector<int> v(n);
    for (int& x : v) std::cin >> x;
    std::sort(v.begin(), v.end());
    std::cout << std::unique(v.begin(), v.end()) - v.begin() << "\n";
}
