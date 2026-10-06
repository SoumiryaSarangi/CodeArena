Read both numbers into 64-bit signed integers and add them. The largest possible magnitude is $2\cdot10^{18} < 9.2\cdot10^{18}$, so a 64-bit sum cannot overflow.

The common mistake is a 32-bit `int`, which fails as soon as a value passes about $2.1\cdot10^9$.
