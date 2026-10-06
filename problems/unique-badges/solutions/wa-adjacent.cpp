#include <iostream>
int main() {
    int n;
    std::cin >> n;
    int prev = 0, cnt = 0;
    for (int i = 0; i < n; i++) {
        int x;
        std::cin >> x;
        if (x != prev) cnt++;  // only compares neighbours, list is not sorted
        prev = x;
    }
    std::cout << cnt << "\n";
}
