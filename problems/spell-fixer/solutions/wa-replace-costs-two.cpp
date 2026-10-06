#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
int main() {
    std::string a, b;
    std::cin >> a >> b;
    int n = a.size(), m = b.size();
    std::vector<int> prev(m + 1), cur(m + 1);
    for (int j = 0; j <= m; j++) prev[j] = j;
    for (int i = 1; i <= n; i++) {
        cur[0] = i;
        for (int j = 1; j <= m; j++)
            cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]) * 2});  // replace costs 2
        std::swap(prev, cur);
    }
    std::cout << prev[m] << "\n";
}
