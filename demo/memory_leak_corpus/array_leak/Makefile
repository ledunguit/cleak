CC ?= clang
CFLAGS ?= -g -O0
all: array_leak
array_leak: main.c; $(CC) $(CFLAGS) -o array_leak main.c
clean:; rm -f array_leak
