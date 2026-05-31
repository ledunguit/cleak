CC ?= clang
CFLAGS ?= -g -O0
all: strdup_leak
strdup_leak: main.c; $(CC) $(CFLAGS) -o strdup_leak main.c
clean:; rm -f strdup_leak
