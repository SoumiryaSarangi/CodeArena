#include <iostream>
#include <string>
#include <vector>
int main() {
    std::string t, p;
    std::cin >> t >> p;
    int m = p.size();
    std::vector<int> pi(m, 0);
    for (int i = 1; i < m; i++) {
        int k = pi[i - 1];
        while (k > 0 && p[i] != p[k]) k = pi[k - 1];
        if (p[i] == p[k]) k++;
        pi[i] = k;
    }
    long long cnt = 0;
    int k = 0;
    for (char c : t) {
        while (k > 0 && (k == m || c != p[k])) k = pi[k - 1];
        if (c == p[k]) k++;
        if (k == m) cnt++;
    }
    std::cout << cnt << "\n";
}
