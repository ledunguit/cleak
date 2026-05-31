CC ?= clang
CFLAGS ?= -g -O0
all: conditional_leak
conditional_leak: main.c
	$(CC) $(CFLAGS) -o conditional_leak main.c
clean:; rm -f conditional_leak
