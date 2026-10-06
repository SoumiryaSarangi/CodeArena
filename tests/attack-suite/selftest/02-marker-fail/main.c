/* Self-test for the attack runner: this case is EXPECTED TO FAIL. The program
   prints the forbidden marker its case.yaml lists under outputLacks, so the
   runner must report it as a failure. It proves the harness catches a bad
   outcome; it is never counted among the real suite cases. */
#include <stdio.h>
int main(void) {
    printf("LEAK\n");
    return 0;
}
