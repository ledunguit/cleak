CC ?= clang
CFLAGS ?= -g -O0
all: missing_null_check
missing_null_check: main.c; $(CC) $(CFLAGS) -o missing_null_check main.c
clean:; rm -f missing_null_check
