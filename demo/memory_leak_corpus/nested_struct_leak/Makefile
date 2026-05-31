CC ?= clang
CFLAGS ?= -g -O0
all: nested_struct_leak
nested_struct_leak: main.c; $(CC) $(CFLAGS) -o nested_struct_leak main.c
clean:; rm -f nested_struct_leak
