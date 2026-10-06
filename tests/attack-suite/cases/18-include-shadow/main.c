/* Attack case 18: pull a host file into the compile.
   A hostile submission can try to make the compiler read a host file with
   #include and leak its text through the compile error log. The compile box
   must not see /etc/shadow, so this ends as a compile error with no file
   contents in the log. */
#include "/etc/shadow"

int main(void) {
    return 0;
}
