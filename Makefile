# Build all CKB contracts (RISC-V) and stage them to build/release/ for the integration tests.
# The contract set is read from contracts.list (the single source shared with CI and docker-build.sh).
# factory-script is built first: pool-script build.rs derives FACTORY_CODE_HASH from its staged
# binary (contracts/pool-script/build.rs), so it must exist before pool-script compiles.
TARGET := riscv64imac-unknown-none-elf
OUT := build/release
CONTRACTS := $(shell grep -vE '^[[:space:]]*(#|$$)' contracts.list)
FACTORY := $(firstword $(CONTRACTS))
REST := $(filter-out $(FACTORY),$(CONTRACTS))

.PHONY: build test
build:
	mkdir -p $(OUT)
	cargo build -p $(FACTORY) --target $(TARGET) --release --locked
	cp target/$(TARGET)/release/$(FACTORY) $(OUT)/$(FACTORY)
	cargo build $(foreach c,$(REST),-p $(c)) --target $(TARGET) --release --locked
	$(foreach c,$(REST),cp target/$(TARGET)/release/$(c) $(OUT)/$(c);)
test: build
	cargo test -p integration-tests --release --features otx-tests
