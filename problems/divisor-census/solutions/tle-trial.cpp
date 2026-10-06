#include <cstdio>
int main() {
    int q;
    if (std::scanf("%d", &q) != 1) return 1;
    for (int i = 0; i < q; i++) {
        int x;
        if (std::scanf("%d", &x) != 1) return 1;
        int c = 0;
        for (int d = 1; d <= x; d++)
            if (x % d == 0) c++;           // O(x) per question
        std::printf("%d%c", c, i + 1 < q ? ' ' : '\n');
    }
}
