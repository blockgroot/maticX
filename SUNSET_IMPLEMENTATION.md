# MaticX Sunset — Implementation Reference

This document describes the contract changes, tests, and operational scripts that implement the MaticX drain-and-hold sunset on Ethereum L1.

No changes are required on Polygon L2. The existing `ChildPool` and `FxStateChildTunnel` continue to operate against the final state pushed by `markDrainComplete()`.

---

## 1. Strategy at a glance

1. Pause new deposits (granular flag, not OZ Pausable).
2. Bulk-unstake every registered validator; in-flight legacy unbonds keep claiming through their own StakeManager nonces. Once active stake is zero, new legacy `requestWithdraw` calls revert naturally (no validator can satisfy the unstake).
3. Wait the Polygon unbond window (~80 checkpoints, ~3–4 days).
4. Claim the drained POL into the contract; mark drain complete. This computes and stores `frozenRate = drainedPolBalance * 1e18 / totalSupply`, then sends the final state to L2 over `FxStateRootTunnel`. No further L2 pushes ever occur.
5. Forever after, holders redeem via `requestWithdraw` → `claimBalanceWithdrawal`, which burns MaticX, decrements `drainedPolBalance` in lockstep, and transfers POL out of the contract balance. The frozen rate is preserved invariantly by the burn-and-decrement math.

Because Polygon's `StakeManager` enforces an unbond delay between `sellVoucher_newPOL` and `unstakeClaimTokens_newPOL`, the operational sequence on L1 is split across at least two admin transactions (T0 = pause + bulk-unstake, T0 + ~4 days = bulk-claim + mark-complete + cleanup). The smart-contract upgrade itself is a single Timelock batch.

---

## 2. Contract changes

### 2.1 MaticX.sol

**New storage (append-only, no slot reordering):**

| Slot | Variable                    | Type                                                  |
| ---- | --------------------------- | ----------------------------------------------------- |
| +0   | `depositsPaused`            | `bool` (packed with the next)                         |
| +0   | `drainComplete`             | `bool`                                                |
| +1   | `drainedPolBalance`         | `uint256`                                             |
| +2   | `frozenRate`                | `uint256` (POL per 1e18 MaticX)                       |
| +3   | `balanceModeRedeemDelay`    | `uint256` (seconds, 0–7 days)                         |
| +4   | `balanceWithdrawalRequests` | `mapping(address => BalanceWithdrawalRequest[])`      |
| +5   | `drainUnbondNonces`         | `mapping(uint256 => uint256)`                         |
| +6…+47 | `__gap_sunset`            | `uint256[42]`                                         |

OpenZeppelin's `validateUpgrade` is invoked in `sunset:deploy-implementations` and `sunset:verify-upgrade` to confirm the existing layout is preserved.

**New modifiers:**

- `whenDepositsNotPaused` — gates `submit()` and `submitPOL()`.
- `whenNotDrainComplete` — gates reward and migration paths post-drain.

**New admin functions (all `DEFAULT_ADMIN_ROLE`):**

| Function                                | Purpose                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pauseDeposits()`                       | Sets `depositsPaused = true`. Granular; does not block claims.                                                                          |
| `unpauseDeposits()`                     | Inverse.                                                                                                                                |
| `bulkUnstakeAllValidators()`            | Iterates the registered validators, calls `sellVoucher_newPOL(activeStake, MAX_UINT)` on each, stores the resulting unbond nonce on-chain. |
| `bulkClaimDrainedStake(uint256[] ids)`  | Claims POL from previously initiated bulk-unstakes; accumulates into `drainedPolBalance`.                                                |
| `markDrainComplete()`                   | Asserts all stake drained; computes `frozenRate`; sends final `(totalSupply, drainedPolBalance)` over `FxStateRootTunnel`.                |
| `setBalanceModeRedeemDelay(uint256)`    | Configurable user redeem delay, capped at 7 days. Defaults to zero (instant claim).                                                     |

**New user function:**

- `claimBalanceWithdrawal(uint256 idx)` — pops a `BalanceWithdrawalRequest` and transfers POL once `block.timestamp >= unlockTimestamp`. Uses swap-and-pop on the user's request array.

**Modified functions:**

- `submit()` / `submitPOL()` — now also gated by `whenDepositsNotPaused`.
- `requestWithdraw(uint256)` — bi-mode:
  - Pre-drain: existing validator-routed unstake (unchanged). Between `bulkUnstakeAllValidators` and `markDrainComplete`, this path reverts naturally because no validator has active stake; the burn is rolled back atomically.
  - Post-drain: calls internal `_requestBalanceWithdrawal`, which burns MaticX, decrements `drainedPolBalance` by `amount * frozenRate / 1e18`, and pushes a `BalanceWithdrawalRequest`. No L2 message is sent — the burn/decrement math preserves the frozen rate invariantly.
- `withdrawRewards`, `withdrawValidatorsReward`, `stakeRewardsAndDistributeFees`, `stakeRewardsAndDistributeFeesMatic`, `migrateDelegation` — all gated by `whenNotDrainComplete`.
- `_stakeRewardsAndDistributeFees` (private) — defense-in-depth: if `drainComplete`, the function returns silently when called with `revertOnZeroReward=false` (the `setFeePercent` path), or reverts otherwise. This guarantees `drainedPolBalance` cannot be reinterpreted as harvestable rewards.
- `getTotalPooledMatic()` — returns `drainedPolBalance` when `drainComplete`, otherwise the legacy validator sum.
- `_convertMaticXToPOL` — uses `drainedPolBalance` as the pooled amount when `drainComplete`.

**Custom errors:** all new revert paths use custom errors (`DepositsPausedError`, `DrainAlreadyComplete`, `DrainNotComplete`, `ActiveStakeRemains`, `NoDrainedPOL`, `ZeroSupply`, `DelayTooLong`, `EmptyValidatorIds`, `NoUnbondNonce`, `RequestDoesNotExist`, `RequestNotUnlocked`, `AmountInPolZero`, `DrainedPolUnderflow`, `DepositsAlreadyPaused`, `DepositsAlreadyUnpaused`). This keeps the deployed runtime size at 23.579 KiB, under the 24.576 KiB EIP-170 limit.

**`togglePause()`**: retained for ABI compatibility but should never be called during or after the sunset flow. OZ Pausable blocks `claimWithdrawal` and `claimBalanceWithdrawal`, which would brick redemptions. The function is marked `@custom:deprecated` in NatSpec.

### 2.2 ValidatorRegistry.sol

- New `__gap_sunset` of 49 slots appended.
- `removeValidator(_id, _ignoreBalance)` — the preferred-validator-id guard now runs only while at least one preferred id is non-zero. After both preferred ids are cleared, validators (including the formerly "last" preferred ones) can be removed. The balance check is unchanged.
- `clearPreferredValidators()` — new admin-only function, gated on `IMaticX(maticX).drainComplete()`. Zeroes both preferred ids. This resolves the pre-existing deadlock that would otherwise prevent removing the last validator.

### 2.3 Interfaces

- `IMaticX.sol` — adds `BalanceWithdrawalRequest`, the new function signatures, view getters, and events (`DepositsPaused`, `DepositsUnpaused`, `BulkUnstakeInitiated`, `BulkClaimCompleted`, `DrainCompleted`, `BalanceModeRedeemDelaySet`, `RequestBalanceWithdrawal`, `ClaimBalanceWithdrawal`).
- `IValidatorRegistry.sol` — adds `clearPreferredValidators()` and the `ClearPreferredValidators` event.

---

## 3. Key invariants

1. **Dedicated drain balance.** `drainedPolBalance` is a storage slot, not `polToken.balanceOf(this)`. Reward functions are blocked post-drain so the drain backing cannot leak as rewards. Defense-in-depth at the internal helper layer.
2. **Frozen rate is invariant.** For every balance-mode redemption of `N` MaticX, both `drainedPolBalance` and `totalSupply` decrement by the same ratio (`N * frozenRate / 1e18` and `N` respectively). This is checked under fuzzing in the unit tests.
3. **In-flight legacy claims survive the bulk-unstake and the drain.** `claimWithdrawal()` calls `unstakeClaimTokens_newPOL` on the stored `validatorAddress` and transfers only the diff `balanceAfter - balanceBefore`. The stored `drainedPolBalance` is untouched. User unbonds and admin bulk-unstake unbonds live in separate StakeManager nonces.
4. **Final L2 message captures the frozen state.** `markDrainComplete` sends one last `(totalSupply, drainedPolBalance)` over `FxStateRootTunnel`. Balance-mode operations never push to L2; the rate on Polygon stays static forever.
5. **Last-validator deadlock removed.** After `clearPreferredValidators`, every remaining validator can be removed via `removeValidator(id, true)`.

---

## 4. Tests

Both test files live in `test/`. The project is Hardhat with TypeScript; tests use `@nomicfoundation/hardhat-network-helpers` for forking.

### 4.1 `test/MaticXSunset.ts` — unit suite

Deploys a fresh `MaticX` and `ValidatorRegistry` proxy on an Ethereum mainnet fork, registers two real validators (`110`, `79`), seeds stake from two stakers, and then exercises each new code path in isolation.

Test groups:

| Group                                    | Coverage                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pauseDeposits / unpauseDeposits`        | Access control, double-pause/unpause reverts, `submit`/`submitPOL` blocked, claims unaffected.    |
| `In-flight legacy unbonds`               | Pre-existing user unbonds remain claimable through the bulk-unstake / drain sequence (independent StakeManager nonces). |
| `bulkUnstakeAllValidators`               | Access control; records nonces; skips validators with zero stake; active stake reads zero post-call.   |
| `Phase 3 atomic drain`                   | Bulk claim accumulates into `drainedPolBalance`; nonces cleared; `markDrainComplete` emits `DrainCompleted` with correct args; revert paths for `ActiveStakeRemains`, `NoDrainedPOL`. |
| `Balance-mode redemption`                | Burn + decrement; queued request and `unlockTimestamp`; frozen-rate invariant validated over multiple redemptions across two stakers; default-zero-delay instant claim; non-zero delay enforces `RequestNotUnlocked`; view functions reflect frozen state. |
| `Reward functions post-drain`            | `withdrawRewards`, `withdrawValidatorsReward`, `stakeRewardsAndDistributeFees`, `migrateDelegation` all revert with `DrainAlreadyComplete`. |
| `ValidatorRegistry post-drain cleanup`   | `clearPreferredValidators` reverts pre-drain; `removeValidator` reverts pre-clear; full validator removal works post-clear. |
| `Setters`                                | `setBalanceModeRedeemDelay` enforces max 7 days.                                                  |

Run:

```
npx hardhat test test/MaticXSunset.ts
```

### 4.2 `test/MaticXSunsetFork.ts` — mainnet fork upgrade

Impersonates the L1 Timelock and `ProxyAdmin` to upgrade the **live** `MaticX` and `ValidatorRegistry` proxies in place, then drives the sunset flow against real on-chain state (~106M MaticX supply, five real validators).

Test cases:

1. **Storage layout preserved** — snapshots `treasury`, `version`, `feePercent`, `totalSupply`, both preferred validator ids, the validator list and the contract's POL balance before the upgrade, then reads them all post-upgrade and asserts equality.
2. **Fresh state vars zeroed** — `depositsPaused`, `drainComplete`, `drainedPolBalance`, `frozenRate`, `balanceModeRedeemDelay` all default correctly after the implementation swap.
3. **Full Phase 1 → 2 → 3 sequence on live state** — pauses deposits, bulk-unstakes the real validators, advances stake-manager epochs via governance impersonation, claims into `drainedPolBalance`, marks drain complete, asserts `frozenRate` and the L2 message, then runs `clearPreferredValidators` + `removeValidator` ×5 and verifies an empty registry.
4. **Balance-mode redemption against a real holder** — uses an impersonated mainnet MaticX holder to call `requestWithdraw` + `claimBalanceWithdrawal`, asserting the burn/decrement math and the frozen-rate invariant on real state.

The fork test skips automatically if the chosen holder lacks balance at the fork block.

Run (requires `ETHEREUM_API_KEY` / `RPC_PROVIDER` in `.env`):

```
npx hardhat test test/MaticXSunsetFork.ts
```

---

## 5. Operational scripts

All sunset scripts are registered as Hardhat tasks under the `sunset:` namespace and live in `tasks/sunset.ts`.

### 5.1 `sunset:deploy-implementations`

```
hardhat sunset:deploy-implementations --network ethereum
```

- Runs `upgrades.validateUpgrade` against the deployed proxies to confirm storage compatibility.
- Deploys the new `MaticX` and `ValidatorRegistry` implementations.
- Persists addresses to `ethereum-deployment-info.json` under `maticX_sunset_impl` and `validator_registry_sunset_impl`.

### 5.2 `sunset:encode-timelock`

```
hardhat 
:encode-timelock --network ethereum
```

Reads the persisted implementation addresses and emits two pieces of calldata:

- **Schedule calldata** — a `TimelockController.scheduleBatch` payload to upgrade both proxies, with a 24-hour delay, predecessor `0x0`, and salt `keccak256("MATICX_SUNSET_UPGRADE")`. The Old-Admin-Safe submits this.
- **Execute calldata** — the matching `executeBatch` payload, callable by anyone once the 24-hour delay elapses.

Targets are printed alongside the calldata for direct paste into the executing wallet.

### 5.3 `sunset:verify-upgrade`

```
hardhat sunset:verify-upgrade --network ethereum
```

Post-upgrade sanity check. Reads the on-chain implementation pointers, the new state variables, and reverts if anything is unexpectedly non-zero/non-fresh. Use this immediately after `executeBatch` to confirm the upgrade landed correctly.

### 5.4 `sunset:encode-phase1`

```
hardhat sunset:encode-phase1
```

Emits Safe Transaction Builder JSON for **Phase 1** at T0:

1. `setBalanceModeRedeemDelay(0)` — instant balance-mode redemption.
2. `pauseDeposits()`.

Import the JSON into the L1 multisig's transaction builder. Both transactions target the MaticX proxy.

### 5.5 `sunset:encode-phase2`

```
hardhat sunset:encode-phase2
```

Emits Safe JSON for **Phase 2** at T0 + comms window (zero if you elected no warning window):

1. `bulkUnstakeAllValidators()`.

After this batch executes, monitor the `BulkUnstakeInitiated` events and confirm `getDrainUnbondNonce(id)` is non-zero for every validator that had active stake. The on-chain nonces are the source of truth for Phase 3. New legacy `requestWithdraw` calls revert from this point onward because no validator has active stake to satisfy the unstake.

### 5.6 `sunset:encode-phase3`

```
hardhat sunset:encode-phase3
```

Emits Safe JSON for **Phase 3** (T0 + comms window + ~4 days for unbond maturation):

1. `bulkClaimDrainedStake([110, 79, 117, 121, 32])` on MaticX.
2. `markDrainComplete()` on MaticX.
3. `clearPreferredValidators()` on ValidatorRegistry.
4. `removeValidator(id, true)` on ValidatorRegistry, once per id.

All eight transactions are bundled into one atomic Safe multicall. The validator id list is hard-coded at the top of `tasks/sunset.ts`; update it if the registry changes before Phase 2 fires.

---

## 6. Phase-by-phase operational checklist

### Phase 0 — Audit and deployment (T0 − 8 weeks to T0 − 1 day)

1. Audit the contracts (sunset scope) with the chosen firm.
2. `hardhat sunset:deploy-implementations --network ethereum` — captures both impl addresses.
3. Submit the schedule calldata from `sunset:encode-timelock` through the Old-Admin-Safe.
4. After the 24-hour Timelock delay elapses, anyone executes the matching `executeBatch`.
5. Run `hardhat sunset:verify-upgrade --network ethereum`. Expected: implementations match deployed addresses, all new state variables zero/false.

### Phase 1 — Pause (T0)

1. L1-Multisig executes the `sunset:encode-phase1` batch.
2. Disable the off-chain bots (`stakeRewardsJob`, `preferredValidatorJob`, `withdrawRewardsJob`).
3. Frontend publishes the deposit-disabled banner and L2 redemption guide.
4. L2-Multisig drains `ChildPool` instant pools via the existing `withdrawInstantPoolMatic` / `withdrawInstantPoolMaticX` functions. No L2 contract change needed.

In-flight legacy `requestWithdraw` calls continue working through this phase. Communication strategy determines how long to wait before Phase 2.

### Phase 2 — Bulk unstake (T0 + comms window)

1. L1-Multisig executes the `sunset:encode-phase2` batch.
2. Inspect the `BulkUnstakeInitiated` events; record `{ validatorId: unbondNonce }` for the operations log (the nonces are also stored on-chain via `getDrainUnbondNonce`).
3. Wait approximately 80 Polygon checkpoints (≈3–4 days) for unbond maturation.

Active stake on every registered validator is now zero. In-flight legacy `claimWithdrawal` calls remain serviceable. New legacy `requestWithdraw` calls revert (atomic — the burn is rolled back).

### Phase 3 — Drain and freeze rate (T0 + comms window + ~4 days)

1. Verify each unbond is past `withdrawalDelay` (helpful via a forked dry-run beforehand).
2. L1-Multisig executes the `sunset:encode-phase3` atomic batch.
3. Assert:
   - `drainComplete == true`
   - `frozenRate > 0`
   - `drainedPolBalance > 0`
   - `preferredDepositValidatorId == 0` and `preferredWithdrawalValidatorId == 0`
   - `getValidators().length == 0`
   - The L2 `FxStateChildTunnel` has received the final `(totalSupply, drainedPolBalance)` push.
4. Optional smoke test: `requestWithdraw(1)` + `claimBalanceWithdrawal(0)` from an EOA holder, verify 1 wei `frozenRate / 1e18` POL received.

### Phase 4 — Steady state and cleanup

- Holders redeem indefinitely via `requestWithdraw` → `claimBalanceWithdrawal` (instant if `balanceModeRedeemDelay == 0`).
- For the L2 leg, Stader runs the circular replenishment (bridge accumulated MaticX L2 → L1 over the 7-day Polygon PoS exit, redeem in balance-mode on L1, bridge POL L1 → L2 in minutes, call `ChildPool.provideInstantPoolMatic`). No contract changes required.
- Approximately day 60: revoke the `BOT` role from the bot EOAs on both MaticX and ValidatorRegistry; decommission the off-chain orchestrators.

### Emergency response

`setBalanceModeRedeemDelay(uint256)` is the primary emergency lever for the post-drain steady state. It accepts any value between zero and seven days and applies only to `BalanceWithdrawalRequest`s created after the call; previously queued requests keep their original `unlockTimestamp`.

Use it in the following situations:

- **Suspected exploit or anomalous withdrawal pattern** — the admin (`DEFAULT_ADMIN_ROLE`) calls `setBalanceModeRedeemDelay(<delay>)` (max `7 days = 604800`) to introduce a cooling-off window. New `requestWithdraw` calls still succeed and still burn MaticX in lockstep with `drainedPolBalance`, so the rate invariant is preserved; only the claim is delayed.
- **Drain backing accounting needs reconciliation** — for example, after a Polygon-side incident affecting the circular replenishment, the delay buys time to audit `drainedPolBalance` versus `totalSupply` before claims are paid.
- **Targeted incident response** — the admin can raise the delay, investigate, and then lower it back to zero with another `setBalanceModeRedeemDelay(0)` call to restore instant claims. There is no cooldown on the setter itself.

Do **not** use `togglePause()` (OZ Pausable) for emergencies — it blocks `claimBalanceWithdrawal` and `claimWithdrawal` and would freeze all redemptions. The granular `setBalanceModeRedeemDelay` lever is the correct primitive.

---

## 7. Quick reference

| Concern                            | Where to look                                                |
| ---------------------------------- | ------------------------------------------------------------ |
| Contract changes                   | `contracts/MaticX.sol`, `contracts/ValidatorRegistry.sol`     |
| Interfaces                         | `contracts/interfaces/IMaticX.sol`, `IValidatorRegistry.sol` |
| Unit tests                         | `test/MaticXSunset.ts`                                       |
| Mainnet fork test                  | `test/MaticXSunsetFork.ts`                                   |
| Deployment / encoding scripts      | `tasks/sunset.ts`                                            |
| Plan / risk register / decisions   | `MATICX_SUNSET_PLAN.md`                                      |

---

## 8. Known limitations and follow-ups

- **Validator id list is hard-coded** in `tasks/sunset.ts` (`SUNSET_VALIDATOR_IDS`). Re-confirm against `validatorRegistry.getValidators()` before Phase 2.
- **`togglePause()` retained**. Should never be invoked on mainnet; documented as deprecated. Consider revoking the `DEFAULT_ADMIN_ROLE` ability to pause after Phase 3 if leadership wants to enforce this at the role layer.
- **Pre-existing TypeScript errors** in `scripts/deployers.ts`, `scripts/tasks.ts`, `scripts/utils.ts` are from an earlier ethers v5 → v6 migration and are unrelated to the sunset work. New code in `tasks/sunset.ts` and `test/MaticX*Sunset*.ts` is fully ethers v6 and type-clean.
- **No real RPC key in this checkout** — fork tests require `ETHEREUM_API_KEY` and `RPC_PROVIDER` in `.env` (use `.env.example` as a template).
