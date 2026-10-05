#include "testlib.h"
int main(int argc, char* argv[]) { registerTestlibCmd(argc, argv); volatile int* p = 0; *p = 1; }
