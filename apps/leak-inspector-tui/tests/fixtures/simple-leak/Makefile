CC ?= clang
CFLAGS ?= -g -O0

all: simple_leak

simple_leak: main.c
	$(CC) $(CFLAGS) -o simple_leak main.c

asan: main.c
	$(CC) $(CFLAGS) -fsanitize=address -fno-omit-frame-pointer -o simple_leak_asan main.c

clean:
	rm -f simple_leak simple_leak_asan
