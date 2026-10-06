// Attack case 22: JVM thread flood.
// Starts up to 20000 parked daemon threads. The process limit (and memory
// limit) must stop it: thread creation fails with an OutOfMemoryError that we
// catch and report, or the box kills the JVM. Starting them all is a failure.
public class Main {
    public static void main(String[] args) throws Exception {
        int started = 0;
        try {
            for (int i = 0; i < 20000; i++) {
                Thread t = new Thread(() -> {
                    try {
                        Thread.sleep(60000);
                    } catch (InterruptedException e) {
                        // ignored
                    }
                });
                t.setDaemon(true);
                t.start();
                started++;
            }
            System.out.println("ESCAPED started " + started + " threads");
        } catch (Throwable e) {
            System.out.println("BLOCKED thread creation stopped after " + started + " threads: "
                    + e.getClass().getSimpleName());
        }
        System.out.flush();
        System.exit(0);
    }
}
