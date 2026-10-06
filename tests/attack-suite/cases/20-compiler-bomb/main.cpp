// Attack case 20: compiler bomb.
// Template recursion far past any sane depth plus a constexpr loop that would
// run for ages. The compiler must stop with an error (or be stopped by the
// compile limits); either way the result is CE, never a built program.
template <int N>
struct Boom {
    static const int value = Boom<N - 1>::value + 1;
};
template <>
struct Boom<0> {
    static const int value = 0;
};

constexpr long long spin(long long n) {
    long long x = 0;
    for (long long i = 0; i < n; i++) x += i ^ (x << 1);
    return x;
}

static_assert(spin(1LL << 40) != 12345, "keep the compiler busy");

int main() {
    return Boom<100000>::value;
}
