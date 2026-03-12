SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

DEPLOY_DIR := deployment
BIN_DIR := $(DEPLOY_DIR)/bin
DIST_DIR := $(DEPLOY_DIR)/dist

POWERSHELL ?= powershell
SEA_LITE ?= 1
SEA_STRIP_RUNTIME ?= 0
SEA_KEEP_TEMP ?= 0

SEA_ARGS := $(if $(filter 1,$(SEA_LITE)),--lite,) \
	$(if $(filter 1,$(SEA_STRIP_RUNTIME)),--strip-runtime,) \
	$(if $(filter 1,$(SEA_KEEP_TEMP)),--keep-temp,)

.PHONY: help all macos windows runtime-macos runtime-win sea-macos sea-win package-macos package-win clean-runtime clean-sea clean-dist clean

help:
	@echo "OpenClaw runtime packaging (macOS / Windows)"
	@echo ""
	@echo "Targets:"
	@echo "  macos          Build runtime + SEA + archive for macOS (current machine)"
	@echo "  windows        Build runtime + SEA + archive for Windows (current machine)"
	@echo "  runtime-macos  Build deployment runtime for macOS"
	@echo "  runtime-win    Build deployment runtime for Windows (PowerShell)"
	@echo "  sea-macos      Build macOS SEA binary (uses SEA_LITE/SEA_STRIP_RUNTIME/SEA_KEEP_TEMP)"
	@echo "  sea-win        Build Windows SEA binary (uses SEA_LITE/SEA_STRIP_RUNTIME/SEA_KEEP_TEMP)"
	@echo "  package-macos  Create deployment/dist/openclaw-macos-runtime-<arch>.tar.gz"
	@echo "  package-win    Create deployment/dist/openclaw-win-runtime-<arch>.zip"
	@echo "  clean          Remove generated runtime/SEA/dist artifacts"
	@echo ""
	@echo "Examples:"
	@echo "  make -f deployment/Makefile macos"
	@echo "  make -f deployment/Makefile windows"
	@echo "  make -f deployment/Makefile sea-macos SEA_LITE=0"
	@echo "  make -f deployment/Makefile sea-win SEA_STRIP_RUNTIME=1"

all: help

macos: package-macos

windows: package-win

runtime-macos:
	@command -v pnpm >/dev/null
	@command -v node >/dev/null
	@chmod +x $(DEPLOY_DIR)/build-local-runtime.sh
	@./$(DEPLOY_DIR)/build-local-runtime.sh

runtime-win:
	@$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File .\$(DEPLOY_DIR)\build-local-runtime.ps1

sea-macos: runtime-macos
	@command -v node >/dev/null
	@chmod +x $(DEPLOY_DIR)/build-sea-binary.sh
	@./$(DEPLOY_DIR)/build-sea-binary.sh $(SEA_ARGS)
	@cd $(DEPLOY_DIR) && tar -czf portable-runtime-mac.tgz bin/* usb-openclaw-mac.sh

sea-win: runtime-win
	@$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File .\$(DEPLOY_DIR)\build-sea-binary.ps1 \
		$(if $(filter 1,$(SEA_LITE)),-Lite,) \
		$(if $(filter 1,$(SEA_STRIP_RUNTIME)),-StripRuntime,) \
		$(if $(filter 1,$(SEA_KEEP_TEMP)),-KeepTemp,)
	@$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -Command "tar -a -c -f .\deployment\openclaw-win-package.zip -C . deployment/bin deployment/usb-openclaw-win.ps1 deployment/usb-openclaw-win-native.ps1"

package-macos: sea-macos
	@mkdir -p $(DIST_DIR)
	@arch="$$(uname -m)"; \
	case "$$arch" in \
		x86_64|amd64) norm_arch="x86_64" ;; \
		arm64|aarch64) norm_arch="arm64" ;; \
		*) echo "[error] unsupported macOS arch: $$arch" >&2; exit 1 ;; \
	esac; \
	out="$(DIST_DIR)/openclaw-macos-runtime-$$norm_arch.tar.gz"; \
	tar -czf "$$out" \
		$(DEPLOY_DIR)/README.md \
		$(DEPLOY_DIR)/bin \
		$(DEPLOY_DIR)/config \
		$(DEPLOY_DIR)/migrate-local-mac.sh \
		$(DEPLOY_DIR)/usb-openclaw-mac.sh \
		$(DEPLOY_DIR)/verify-env.sh; \
	echo "[package] $$out"

# make -f deployment/Makefile sea-win SEA_STRIP_RUNTIME=1 SEA_LITE=1
package-win: sea-win
	@$(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='Stop'; $$rawArch=if($$env:PROCESSOR_ARCHITEW6432){$$env:PROCESSOR_ARCHITEW6432}else{$$env:PROCESSOR_ARCHITECTURE}; $$arch=switch($$rawArch.ToUpperInvariant()){ 'AMD64'{'x86_64'} 'X86_64'{'x86_64'} 'ARM64'{'arm64'} default{$$null} }; if(-not $$arch){throw \"unsupported architecture: $$rawArch\"}; $$dist='deployment\\dist'; if(!(Test-Path $$dist)){New-Item -ItemType Directory -Path $$dist -Force | Out-Null}; $$out=Join-Path $$dist ('openclaw-win-runtime-' + $$arch + '.zip'); if(Test-Path $$out){Remove-Item $$out -Force}; $$items=@('deployment\\README.md','deployment\\bin','deployment\\config','deployment\\build-local-runtime.ps1','deployment\\build-sea-binary.ps1','deployment\\build-sea-binary.mjs','deployment\\usb-openclaw-win.ps1','deployment\\usb-openclaw-win-native.ps1','deployment\\verify-env.sh'); Compress-Archive -Path $$items -DestinationPath $$out -CompressionLevel Optimal; Write-Host \"[package] $$out\""

clean-runtime:
	@rm -rf $(BIN_DIR)/runtime

clean-sea:
	@rm -f $(BIN_DIR)/openclaw-sea-darwin-x86_64 $(BIN_DIR)/openclaw-sea-darwin-arm64 $(BIN_DIR)/openclaw-sea-linux-x86_64 $(BIN_DIR)/openclaw-sea-linux-arm64 $(BIN_DIR)/openclaw-sea-win-x86_64.exe $(BIN_DIR)/openclaw-sea-win-arm64.exe

clean-dist:
	@rm -rf $(DIST_DIR)

clean: clean-runtime clean-sea clean-dist
