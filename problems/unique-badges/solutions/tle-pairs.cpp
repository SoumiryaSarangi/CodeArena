#include <iostream>
#include <vector>
int main() {
    int n;
    std::cin >> n;
    std::vector<int> v(n);
    for (int& x : v) std::cin >> x;
    int cnt = 0;
    for (int i = 0; i < n; i++) {
        bool seen = false;
        for (int j = 0; j < i && !seen; j++)
            if (v[j] == v[i]) seen = true;  // O(n^2)
        if (!seen) cnt++;
    }
    std::cout << cnt << "\n";
}
