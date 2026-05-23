CC ?= clang
CFLAGS ?= -g -O0 -Wall -Wextra -std=c11
BUILD_DIR ?= build
TARGET := $(BUILD_DIR)/early_return_leak

SOURCES := main.c
OBJECTS := $(SOURCES:%.c=$(BUILD_DIR)/%.o)

.PHONY: all clean asan

all: $(TARGET)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/%.o: %.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(TARGET): $(OBJECTS)
	$(CC) $(CFLAGS) $(OBJECTS) -o $@

asan: CFLAGS += -fsanitize=address -fno-omit-frame-pointer
asan: $(BUILD_DIR)/early_return_leak_asan

$(BUILD_DIR)/early_return_leak_asan: $(OBJECTS)
	$(CC) $(CFLAGS) $(OBJECTS) -o $@

clean:
	rm -rf $(BUILD_DIR)
