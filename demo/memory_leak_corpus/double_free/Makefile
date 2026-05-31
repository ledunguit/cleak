CC ?= clang
CFLAGS ?= -g -O0
all: double_free
double_free: main.c; $(CC) $(CFLAGS) -o double_free main.c
clean:; rm -f double_free
