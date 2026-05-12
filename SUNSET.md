# MaticX Sunset — Engineering Guide

This document covers the sunset upgrade (`feat/sunset-v2`): what it adds, how
to test it, and the end-to-end operational runbook.

---

## 1. What's in the upgrade

The sunset upgrade adds a "drain-and-hold" flow to `contracts/MaticX.sol`. The
admin unstakes from every validator, claims the matured unbonds back into the
contract, freezes the MATICx ↔ POL exchange rate at the resulting POL balance,
and lets users redeem permanently at that frozen rate.

### New admin functions (all `onlyRole(DEFAULT_ADMIN_ROLE)`)

| Function                          | Purpose                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bulkUnstakeAllValidators()`      | Sells full voucher on every registered validator. Records unbond nonces. Requires `paused()`.    |
| `claimDrainNonces()`              | After unbond period, pops and claims each recorded nonce. Idempotent. Requires `paused()`.       |
| `freezeExchangeRate()`            | One-way. Snapshots `drainedPolBalance = polBalanceOf(this)` and `frozenRate = balance * 1e18 / totalSupply`. |
| `pushFrozenRateToL2()`            | Sends `(totalSupply, drainedPolBalance)` to the L2 ChildPool via `fxStateRootTunnel`.            |
| `setInstantRedeemEnabled(bool)`   | Toggle for user-facing redemption. Enabling requires `drainComplete`. Disable always allowed.    |
| `sweepToCustody(address)`         | After `CUSTODY_DELAY` (3 years) post-freeze, moves all POL+MATIC to a custody address.           |

### New user function

| Function                       | Purpose                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `instantClaim(uint256 amount)` | Burns `amount` MATICx and pays `amount * frozenRate / 1e18` POL. Not gated by `whenNotPaused`. Requires the redeem flag.  |

### Behavior changes on existing functions

- `claimWithdrawal` — `whenNotPaused` **removed**. Pre-sunset users can always claim previously-initiated withdrawals during the sunset window.
- `setFeePercent` — `whenNotPaused` **added** (no fee changes during sunset).

### New storage (appended after `reentrancyGuardStatus`)

```
bool    drainComplete
bool    instantRedeemEnabled
uint256 drainedPolBalance
uint256 frozenRate
uint256 drainCompleteTimestamp
mapping(address => uint256[]) drainUnbondNonces
```

There is intentionally **no `__gap_sunset`** (removed in `ad62685`). The contract is end-of-life; no further upgrades are planned.

### Constants

- `FROZEN_RATE_PRECISION = 1e18`
- `CUSTODY_DELAY = 3 * 365 days`

---

## 2. Tests

### File layout

| File              | Purpose                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `test/Sunset.ts`  | Sunset suite — end-to-end, negative cases, pause-state matrix, access control.    |
| `test/MaticX.ts`  | Existing suite (one test updated for the new pause-free `claimWithdrawal`).       |

### Prerequisites

The sunset suite forks Ethereum mainnet against the real MaticX proxy. It
needs an **archival** RPC endpoint — public endpoints (publicnode, llamarpc)
will fail with "historical state … is not available" because they prune.

`.env` must contain a real `ETHEREUM_API_KEY`. Copy from the example if not present:

```bash
cp .env.example .env
$EDITOR .env  # set ETHEREUM_API_KEY to a real Alchemy/Infura/Ankr key
```

Optional override: set `MAINNET_RPC_URL` to point at any archival HTTPS endpoint (private node, third-party archival). When this is set, the suite pins the fork to `latest` instead of `FORKING_BLOCK_NUMBER`, so an archival key is still required.

### Running

```bash
# Compile (must pass before tests)
npx hardhat compile

# Lint
npx solhint 'contracts/**/*.sol'

# Sunset suite only (fast)
npx hardhat test test/Sunset.ts

# Full suite
npx hardhat test
```

### What the sunset suite covers

- **End-to-end happy path** — pause → bulk-unstake → claim-drain → freeze → push-L2 → enable → instant-claim → sweep. Asserts state at every step including math correctness of the frozen rate and POL transferred.
- **Pause-state matrix** — while paused mid-sunset:
  - Must revert with `"Pausable: paused"`: `submit`, `submitPOL`, `requestWithdraw`, `withdrawRewards`, `stakeRewardsAndDistributeFees`, `setFeePercent`.
  - Must succeed: `claimWithdrawal` (legacy pending request), `instantClaim` (after enable).
- **Per-function negative cases**:
  - `bulkUnstakeAllValidators` / `claimDrainNonces` / `freezeExchangeRate` revert `"Pause first"` when not paused.
  - `DrainAlreadyComplete` on second freeze / second drain.
  - `DrainNotComplete` on `pushFrozenRateToL2`, `setInstantRedeemEnabled(true)`, `sweepToCustody` before freeze.
  - `CustodyDelayNotElapsed` until 3 years post-freeze.
  - `ZeroAddress` on `sweepToCustody(0)`.
- **`instantClaim` matrix** — `InstantRedeemNotEnabled`, `ZeroAmount`, `AmountInPolZero` (dust), `InsufficientDrainedBalance` (over-claim), and math + state-mutation correctness.
- **Access control** — non-admin reverts on every admin function.
- **Pre-sunset `claimWithdrawal` during sunset** — user with a matured pre-sunset withdrawal can still claim after pause+freeze, and `drainedPolBalance` is unaffected.

### Two tests intentionally `this.skip()` when math doesn't allow

`AmountInPolZero` and `InsufficientDrainedBalance` need the frozen rate to be either `< 1e18` or for someone to over-mint MATICx post-freeze. In a fresh fixture both conditions are unreachable (rate ≈ 1e18, pause blocks mints). The tests stay in the suite as forward guards — they trigger if math or invariants change.

---

## 3. Deployment & operational tasks

All in `tasks/sunset.ts`, registered via `tasks/index.ts`. Run with `--network ethereum` (or `--network amoy` for testnet dry-runs).

| Task                                        | When                                            |
| ------------------------------------------- | ----------------------------------------------- |
| `sunset:deploy-impl`                        | Once, before any upgrade attempt.               |
| `sunset:encode-upgrade [--timelock <addr>]` | After deploy-impl, to produce multisig calldata.|
| `sunset:verify-upgrade`                     | Right after the upgrade is executed on-chain.   |
| `sunset:status`                             | Any time — read-only state dump.                |
| `sunset:encode-step --step <name> [--arg]`  | For each step of the sunset runbook.            |

### `sunset:deploy-impl`

Runs OpenZeppelin's `validateUpgrade` against the live proxy, then deploys the new implementation, and writes `eth_maticX_sunset_impl` to `mainnet-deployment-info.json`.

```bash
npx hardhat sunset:deploy-impl --network ethereum
```

If `validateUpgrade` fails, **stop**. It means the storage layout has drifted; fix the contract before re-running.

### `sunset:encode-upgrade`

Emits `ProxyAdmin.upgrade(proxy, impl)` calldata so the Safe / multisig can execute the upgrade. With `--timelock <addr>` it also emits matching `schedule(...)` and `execute(...)` calldata using the timelock's own `getMinDelay()`.

```bash
# Direct (no timelock)
npx hardhat sunset:encode-upgrade --network ethereum

# Via timelock (production)
npx hardhat sunset:encode-upgrade --network ethereum --timelock 0x...
```

Paste the printed `schedule` calldata into the Safe Transaction Builder, run it, wait the delay, then execute.

### `sunset:verify-upgrade`

Reads the proxy's current implementation, confirms it matches `eth_maticX_sunset_impl`, and asserts that every new sunset state variable is zero/false. Throws if not. **Run this immediately after the upgrade tx confirms.**

```bash
npx hardhat sunset:verify-upgrade --network ethereum
```

### `sunset:status`

The ops check at every step. Prints:

- `paused`, `drainComplete`, `instantRedeemEnabled`
- `drainedPolBalance`, `frozenRate`, `drainCompleteTimestamp`
- `totalSupply` (MATICx), on-chain POL and MATIC balances of the proxy
- **Drift** = `polBalance − drainedPolBalance`. Should be `0` post-freeze unless legacy `claimWithdrawal` flows briefly net to zero between observations.

```bash
npx hardhat sunset:status --network ethereum
```

### `sunset:encode-step`

Produces MaticX calldata for any single admin step. The multisig submits each one separately. The `--step` value maps to:

| `--step`                   | MaticX call                          | Extra `--arg`              |
| -------------------------- | ------------------------------------ | -------------------------- |
| `pause`                    | `togglePause()`                      | —                          |
| `bulk-unstake`             | `bulkUnstakeAllValidators()`         | —                          |
| `claim-drain`              | `claimDrainNonces()`                 | —                          |
| `freeze`                   | `freezeExchangeRate()`               | —                          |
| `push-l2`                  | `pushFrozenRateToL2()`               | —                          |
| `enable-instant-redeem`    | `setInstantRedeemEnabled(true)`      | —                          |
| `disable-instant-redeem`   | `setInstantRedeemEnabled(false)`     | —                          |
| `sweep`                    | `sweepToCustody(_custody)`           | `--arg <custodyAddress>`   |

```bash
npx hardhat sunset:encode-step --step pause          --network ethereum
npx hardhat sunset:encode-step --step bulk-unstake   --network ethereum
npx hardhat sunset:encode-step --step claim-drain    --network ethereum
npx hardhat sunset:encode-step --step freeze         --network ethereum
npx hardhat sunset:encode-step --step push-l2        --network ethereum
npx hardhat sunset:encode-step --step enable-instant-redeem --network ethereum
npx hardhat sunset:encode-step --step sweep --arg 0xCustodyAddress --network ethereum
```

Each invocation prints:

```
Target (MaticX proxy): 0x...
Step: <name>
Calldata: 0x...
```

Paste the target and calldata into the Safe Transaction Builder.

---

## 4. End-to-end runbook

Reference timeline. Each step is a separate multisig session.

### Pre-flight (off-chain, one-time)

1. `npx hardhat compile` — clean.
2. `npx hardhat test test/Sunset.ts` — all green (requires archival RPC, see §2).
3. `npx hardhat sunset:deploy-impl --network ethereum` — deploys impl, writes address.
4. `npx hardhat sunset:encode-upgrade --network ethereum --timelock <timelockAddr>` — copy the schedule calldata.
5. Multisig: `schedule` the upgrade via the timelock.
6. Wait `getMinDelay()` (typically 24h).
7. Multisig: `execute` the upgrade.
8. `npx hardhat sunset:verify-upgrade --network ethereum` — must report "state is fresh".

### Sunset operations

| T              | Step                                                       | How                                          |
| -------------- | ---------------------------------------------------------- | -------------------------------------------- |
| **T0**         | `pause()`                                                  | `sunset:encode-step --step pause` → multisig |
| T0 + 5 min     | `bulkUnstakeAllValidators()`                               | `--step bulk-unstake`                        |
| T0 + ~21 days  | `claimDrainNonces()` — retry until all stakes are 0        | `--step claim-drain`                         |
| T0 + ~21 days  | Verify: every validator's `getTotalStake(maticX) == 0`, every `drainUnbondNonces[vs].length == 0`, `maticToken.balanceOf(maticX) == 0` | manual / `sunset:status`     |
| **One-way** | `freezeExchangeRate()` — irreversible, separate sign-off  | `--step freeze`                              |
| (after L2 coord) | `pushFrozenRateToL2()`                                   | `--step push-l2`                             |
| announce         | `setInstantRedeemEnabled(true)`                           | `--step enable-instant-redeem`               |
| **T0 + 3 years** | `sweepToCustody(safe)`                                    | `--step sweep --arg <custodySafe>`           |

At every step, run `sunset:status` to confirm the state advanced as expected before moving on.

### Emergency kill-switch

If `instantClaim` ever needs to be halted after enable:

```bash
npx hardhat sunset:encode-step --step disable-instant-redeem --network ethereum
```

`setInstantRedeemEnabled(false)` is always callable by admin and does not require `drainComplete`. It only blocks `instantClaim`; `claimWithdrawal` continues to work for any legacy pending withdrawals.

---

## 5. Monitoring

- **Drift alert** — `polBalanceOf(maticX) − drainedPolBalance`. Should be `0` after freeze. A non-zero drift means POL is moving through the contract via legacy `claimWithdrawal`; expected briefly during a claim but not as a steady state.
- **Event subscriptions** — alert on:
  - `DrainCompleted(polBalance, supplyAtFreeze, frozenRate)` — the irreversible event. Expect exactly one ever.
  - `FrozenRatePushedToL2(supplyAtPush, drainedPolBalance)` — confirms L2 sync.
  - `InstantClaimed(user, amountInMaticX, amountInPol)` — user activity baseline.
  - `SweptToCustody(custody, polAmount, maticAmount)` — final shutdown.
- **Pause health** — alert if `paused()` flips off between T0 and `freezeExchangeRate`. Anyone re-enabling deposits mid-sunset would break the freeze snapshot.

---

## 6. Quick reference

| Item                                            | Value                                          |
| ----------------------------------------------- | ---------------------------------------------- |
| MaticX proxy (Ethereum)                         | `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645`   |
| ProxyAdmin (Ethereum)                           | `0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A`   |
| L1 multisig / manager                           | `0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67`   |
| FxStateRootTunnel                               | `0x40FB804Cc07302b89EC16a9f8d040506f64dFe29`   |
| POL token                                       | `0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6`   |
| MATIC token                                     | `0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0`   |
| `FROZEN_RATE_PRECISION`                         | `1e18`                                         |
| `CUSTODY_DELAY`                                 | `3 * 365 days` = 94 608 000 s                  |
| Unbond period (Polygon StakeManager)            | ~80 checkpoints ≈ 21 days                      |

Addresses are sourced from `mainnet-deployment-info.json`; update both if any deployment value changes.
