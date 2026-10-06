/* Attack case 19: make the compiler read an endless stream.
   #include of /dev/urandom never reaches end of file, so an unprotected
   compiler would eat CPU, memory or disk without bound. The compile limits
   must stop it, and a limit hit during compilation is reported as CE. */
#include "/dev/urandom"

int main(void) {
    return 0;
}
