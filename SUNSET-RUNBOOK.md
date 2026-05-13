# MaticX Sunset — Mainnet Execution Runbook

Production runbook for executing the sunset upgrade on Ethereum mainnet
(chain id `1`). One step per row, each with target, function, inputs,
signer, calldata source, preconditions, postconditions.

---

## 1. Roles & signers

| Role | Address | Type | Min delay |
|---|---|---|---|
| Deployer (EOA) | `0x75db63125A4f04E59A1A2Ab4aCC4FC1Cd5Daddd5` | EOA | — |
| Manager / DEFAULT_ADMIN_ROLE | `0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67` | Gnosis Safe | — |
| Timelock (ProxyAdmin.owner) | `0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be` | OZ TimelockController | `86400s` (24h) |
| ProxyAdmin | `0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A` | OZ ProxyAdmin | — |
| Treasury | `0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67` | Same Safe | — |
| Custody (step 10) | TBD | Safe / multisig | — |

---

## 2. Contract ledger

| Name | Address |
|---|---|
| MaticX proxy | `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| MaticX current impl | `0x5a78f4BD60C92FCbbf1C941Bc1136491D2896b35` |
| MaticX sunset impl | `0x2FeaC44BaeB5E5c68A752b75cb9C690001AFAa5e` |
| ProxyAdmin | `0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A` |
| Timelock | `0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be` |
| StakeManager | `0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908` |
| ValidatorRegistry | `0xf556442D5B77A4B0252630E15d8BbE2160870d77` |
| FxStateRootTunnel | `0x40FB804Cc07302b89EC16a9f8d040506f64dFe29` |
| POL | `0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6` |
| MATIC | `0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0` |

Source of truth: `mainnet-deployment-info.json`.

---

## 3. Timeline

| Mark | Event |
|---|---|
| `T - 3d` | Step 0a (deploy implementation) |
| `T - 2d` | Step 0b (verify implementation on Etherscan) |
| `T - 1d` | Pre-flight checklist passed |
| `T` | Step 1a (Timelock schedule) |
| `T + 24h` | Step 1b (Timelock execute) → Step 2 → Step 3 |
| `T + ~21d` | Step 5 (claim unbonds) → Step 6 (freeze) → Step 7 → Step 8 |
| `T + 21d → T + 3y` | User redemption window |
| `T + 3y` | Step 10 (sweep) |

---

## 4. Pre-flight checklist

| # | Check | How |
|---|---|---|
| 1 | Steps 0a and 0b complete | `mainnet-deployment-info.json :: eth_maticX_sunset_impl` set; Etherscan shows verified source |
| 2 | `Timelock.getMinDelay() == 86400` | Etherscan / RPC read |
| 3 | Manager Safe holds `DEFAULT_ADMIN_ROLE` on MaticX | `MaticX.hasRole(0x00…00, manager) == true` |
| 4 | Sunset state is fresh (all zero / false) | `npx hardhat sunset:status --network ethereum` |
| 5 | Contract has live stake to recall | `getTotalStakeAcrossAllValidators() > 0` |
| 6 | FxStateRootTunnel + L2 ChildPool reachable | Last `MessageSent` processed on L2 |

---

## 5. Execution sequence

### Step 0a — Deploy sunset implementation

| | |
|---|---|
| Target | OZ Upgrades plugin (no fixed `to`; CREATE-style deployment) |
| Function | `npx hardhat sunset:deploy-impl --network ethereum` |
| Inputs | — (reads `MaticX` factory from `contracts/MaticX.sol`) |
| Signer | Deployer EOA `0x75db63125A4f04E59A1A2Ab4aCC4FC1Cd5Daddd5` |
| Preconditions | Local repo on the audited release commit; `MAINNET_RPC_URL` archival; deployer EOA funded (~0.05 ETH) |
| What it does | (1) `hre.upgrades.validateUpgrade(proxy, MaticX, { kind: "transparent" })` — reverts on storage-layout drift. (2) `hre.upgrades.deployImplementation(MaticX, { kind: "transparent" })` — broadcasts the implementation deployment. (3) Writes `eth_maticX_sunset_impl = <addr>` to `mainnet-deployment-info.json` |
| Postconditions | New implementation contract at the printed address; `eth_maticX_sunset_impl` set; tx hash recorded |
| Verification | Etherscan shows the new contract at the printed address; matches local bytecode via `npx hardhat verify --network ethereum <addr>` (next step) |
| Reversible | Yes (re-run with a fresh build to deploy another implementation; the proxy is not touched yet) |

### Step 0b — Verify implementation on Etherscan

| | |
|---|---|
| Target | Etherscan source verification service |
| Function | `npx hardhat verify --network ethereum <implementationAddress>` |
| Inputs | `<implementationAddress>` = output of Step 0a (and `eth_maticX_sunset_impl` in the JSON) |
| Signer | Anyone (read-only off-chain operation; requires `ETHERSCAN_API_KEY`) |
| Preconditions | Step 0a complete; same Solidity version + optimiser settings as Hardhat config |
| Postconditions | Etherscan shows "Contract Source Code Verified" on the implementation address; ABI publicly available |
| Reversible | n/a |

### Step 1a — Schedule upgrade (Timelock)

| | |
|---|---|
| Target | Timelock `0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be` |
| Function | `schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)` |
| Inputs | `target` = `0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A`<br>`value` = `0`<br>`data` = ProxyAdmin `upgrade(0xf03A7Eb…6B645, 0x2FeaC44…aAa5e)` calldata<br>`predecessor` = `0x0000…0000`<br>`salt` = `keccak256("MATICX_SUNSET_V2_UPGRADE")`<br>`delay` = `86400` |
| Signer | Timelock `PROPOSER_ROLE` |
| Calldata | `npx hardhat sunset:encode-upgrade --timelock 0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be --network ethereum` |
| Preconditions | Pre-flight passed |
| Postconditions | `CallScheduled(id, …)` emitted; `Timelock.getTimestamp(id) = block.timestamp + 86400` |
| Reversible | Yes — `Timelock.cancel(id)` |

### Step 1b — Execute upgrade (Timelock)

| | |
|---|---|
| Target | Timelock `0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be` |
| Function | `execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt)` |
| Inputs | Identical to step 1a, no `delay` |
| Signer | Timelock `EXECUTOR_ROLE` |
| Calldata | Same task as step 1a; second printed payload |
| Preconditions | `Timelock.isOperationReady(id) == true` |
| Postconditions | `ProxyAdmin.Upgraded(0x2FeaC44…aAa5e)`; `npx hardhat sunset:verify-upgrade --network ethereum` reports fresh state |

### Step 2 — `togglePause()`

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `togglePause()` |
| Inputs | — |
| Signer | Manager Safe `0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67` |
| Calldata | `0xc4ae3168` |
| Preconditions | `paused() == false` |
| Postconditions | `paused() == true` |

### Step 3 — `bulkUnstakeAllValidators()`

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `bulkUnstakeAllValidators()` |
| Inputs | — |
| Signer | Manager Safe |
| Calldata | `0xaca5f56a` |
| Gas | ≥ 30,000,000 |
| Preconditions | `paused() == true`, `recallInitiated == false`, `getTotalStakeAcrossAllValidators() > 0` |
| Postconditions | `recallInitiated == true`; `preFinalizeRate > 0`; one `AssetRecallInitiated(vs, nonce, stake)` per active validator; `assetRecallNonces[vs] != 0` |

### Step 4 — Wait for unbond maturity

| | |
|---|---|
| Target | — (off-chain) |
| Duration | ≈ 21 days (`withdrawalDelay` checkpoints) |
| Monitor | `StakeManager.epoch()` ≥ `bulkUnstakeEpoch + withdrawalDelay` |
| Postconditions | Every `assetRecallNonces[vs]` is matured on its validator share |

### Step 5 — `claimAssetRecallNonces()`

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `claimAssetRecallNonces()` |
| Inputs | — |
| Signer | Manager Safe |
| Calldata | `0xab7d7439` |
| Gas | ≥ 30,000,000 |
| Preconditions | `paused() == true`, `recallInitiated == true`, `recallClaimsComplete == false`, every nonce matured |
| Postconditions | `recallClaimsComplete == true`; `assetRecallNonces[vs] == 0` for all `vs`; `POL.balanceOf(MaticX)` increased by total unbonded amount |

### Step 6 — `finalizeTerminalRate()` *(one-shot, separate sign-off)*

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `finalizeTerminalRate()` |
| Inputs | — |
| Signer | Manager Safe — full quorum, fresh sign-off |
| Calldata | `0x6a06a558` |
| Preconditions | `paused() == true`, `recallInitiated == true`, `recallClaimsComplete == true`, `terminalRateLocked == false`, `POL.balanceOf(MaticX) > 0`, `totalSupply > 0` |
| Verification before signing | Run `npx hardhat sunset:status --network ethereum`; snapshot output; confirm drift = 0 |
| Postconditions | `AssetRecallCompleted(polBalance, totalSupply, terminalRate)`; `terminalRateLocked == true`; `terminalRate = polBalance * 1e18 / totalSupply` (exact, within 1 wei); `recalledPolBalance == POL.balanceOf(MaticX)`; `terminalRateLockTimestamp = block.timestamp` |

### Step 7 — `pushTerminalRateToL2()`

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `pushTerminalRateToL2()` |
| Inputs | — |
| Signer | Manager Safe |
| Calldata | `0xff033308` |
| Preconditions | `terminalRateLocked == true` |
| Postconditions | `TerminalRatePushedToL2(supply, recalledPolBalance)`; FxPortal checkpoint within ~30–60 min; L2 `ChildPool` ratio updated |

### Step 8 — `setInstantRedeemEnabled(true)`

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `setInstantRedeemEnabled(bool _enabled)` |
| Inputs | `_enabled = true` |
| Signer | Manager Safe |
| Calldata | `0xc9e6f05b0000000000000000000000000000000000000000000000000000000000000001` |
| Preconditions | `terminalRateLocked == true`; L2 push confirmed |
| Postconditions | `instantRedeemEnabled == true`; `InstantRedeemToggled(admin, true)` |
| Emergency disable | `setInstantRedeemEnabled(false)` — calldata `0xc9e6f05b00…0000` |

### Optional Step — `sweepToCustody(custody)` *(Execute few years after enabling instant redeem)*

| | |
|---|---|
| Target | MaticX `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645` |
| Function | `sweepToCustody(address _custody)` |
| Inputs | `_custody` = custody Safe (TBD) |
| Signer | Manager Safe |
| Calldata | `npx hardhat sunset:encode-step --step sweep --arg <custody> --network ethereum` |
| Preconditions | `block.timestamp >= terminalRateLockTimestamp + 94_608_000` (3y); `_custody != 0x0` |
| Postconditions | `SweptToCustody(custody, polAmount, maticAmount)`; `POL.balanceOf(MaticX) == 0`; `MATIC.balanceOf(MaticX) == 0`; `recalledPolBalance == 0` |

---

## 6. Calldata cheat-sheet

### Prerequisites

`.env` (copy from `.env.example`):

- `RPC_PROVIDER` + `ETHEREUM_API_KEY` — archival mainnet RPC, all tasks.
- `ETHERSCAN_API_KEY` — Step 0b (`hardhat verify`).
- `DEPLOYER_MNEMONIC` + `DEPLOYER_ADDRESS=0x75db…ddd5` (path `m/44'/60'/0'/0`, EOA funded ~0.05 ETH) — Step 0a only.

`encode-*`, `status`, `verify-upgrade` are read-only. Only `sunset:deploy-impl` broadcasts.

### Commands

```bash
# Steps 0a + 0b
npx hardhat sunset:deploy-impl --network ethereum
npx hardhat verify --network ethereum <implementationAddress>

# Steps 1a + 1b
npx hardhat sunset:encode-upgrade \
  --timelock 0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be \
  --network ethereum

# Steps 2–8
npx hardhat sunset:encode-step --step pause                  --network ethereum
npx hardhat sunset:encode-step --step bulk-unstake           --network ethereum
npx hardhat sunset:encode-step --step claim-recall           --network ethereum
npx hardhat sunset:encode-step --step freeze                 --network ethereum
npx hardhat sunset:encode-step --step push-l2                --network ethereum
npx hardhat sunset:encode-step --step enable-instant-redeem  --network ethereum

# Optional Step 
npx hardhat sunset:encode-step --step sweep --arg <custodyAddress> --network ethereum

# Verification
npx hardhat sunset:status         --network ethereum
npx hardhat sunset:verify-upgrade --network ethereum
```

---
