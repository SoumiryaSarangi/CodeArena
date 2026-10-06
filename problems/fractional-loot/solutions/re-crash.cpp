#include <cstdio>
int main() {
    volatile int* p = nullptr;
    *p = 1;
    return 0;
}
