CC ?= clang
CFLAGS ?= -g -O0
all: use_after_free
use_after_free: main.c; $(CC) $(CFLAGS) -o use_after_free main.c
clean:; rm -f use_after_free
