#include <iostream>
int main() {
    int n;
    std::cin >> n;
    long long best = 0;
    int at = 0;
    for (int i = 1; i <= n; i++) {
        long long x;
        std::cin >> x;
        if (i == 1 || x > best) { best = x; at = i; }
    }
    std::cout << best << " " << at << "\n";
}
