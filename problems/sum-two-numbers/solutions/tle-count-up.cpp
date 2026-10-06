#include <iostream>
int main() {
    long long a, b;
    std::cin >> a >> b;
    volatile long long s = b;
    // adds one at a time: hopeless for a = 10^18
    if (a >= 0) for (long long i = 0; i < a; i++) s = s + 1;
    else for (long long i = 0; i > a; i--) s = s - 1;
    std::cout << s << "\n";
}
