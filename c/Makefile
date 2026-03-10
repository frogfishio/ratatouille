CC ?= cc
AR ?= ar
CFLAGS ?= -O3 -std=c11 -Wall -Wextra -Wpedantic
CPPFLAGS ?= -Iinclude

BUILD_DIR := build
LIB := $(BUILD_DIR)/libratatouille.a
EXAMPLE := $(BUILD_DIR)/basic

LIB_SRC := src/ratatouille.c src/filter.c src/format.c src/http_sink.c src/http_relay.c
LIB_OBJ := $(LIB_SRC:src/%.c=$(BUILD_DIR)/%.o)
EXAMPLE_OBJ := $(BUILD_DIR)/basic.o
HTTP_EXAMPLE_OBJ := $(BUILD_DIR)/http_sink_example.o
HTTP_EXAMPLE := $(BUILD_DIR)/http_sink_example
RELAY_EXAMPLE_OBJ := $(BUILD_DIR)/http_relay_example.o
RELAY_EXAMPLE := $(BUILD_DIR)/http_relay_example
CONTRACT_OBJ := $(BUILD_DIR)/contract_runner.o
CONTRACT_RUNNER := $(BUILD_DIR)/contract_runner

.PHONY: all example clean

all: $(LIB)

example: $(EXAMPLE) $(HTTP_EXAMPLE) $(RELAY_EXAMPLE) $(CONTRACT_RUNNER)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/%.o: src/%.c include/ratatouille.h src/internal.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(EXAMPLE_OBJ): examples/basic.c include/ratatouille.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(HTTP_EXAMPLE_OBJ): examples/http_sink.c include/ratatouille.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(RELAY_EXAMPLE_OBJ): examples/http_relay.c include/ratatouille.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(CONTRACT_OBJ): examples/contract_runner.c include/ratatouille.h | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(LIB): $(LIB_OBJ)
	$(AR) rcs $@ $^

$(EXAMPLE): $(EXAMPLE_OBJ) $(LIB)
	$(CC) $(CFLAGS) $^ -o $@

$(HTTP_EXAMPLE): $(HTTP_EXAMPLE_OBJ) $(LIB)
	$(CC) $(CFLAGS) $^ -o $@

$(RELAY_EXAMPLE): $(RELAY_EXAMPLE_OBJ) $(LIB)
	$(CC) $(CFLAGS) $^ -o $@

$(CONTRACT_RUNNER): $(CONTRACT_OBJ) $(LIB)
	$(CC) $(CFLAGS) $^ -o $@

clean:
	rm -rf $(BUILD_DIR)
