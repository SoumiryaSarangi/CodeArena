#include <iostream>
#include <string>
int main() {
    std::string t, p;
    std::cin >> t >> p;
    long long cnt = 0;
    int n = t.size(), m = p.size();
    for (int i = 0; i + m <= n; i++) {
        int j = 0;
        while (j < m && t[i + j] == p[j]) j++;   // restarts from scratch at every position
        if (j == m) cnt++;
    }
    std::cout << cnt << "\n";
}
