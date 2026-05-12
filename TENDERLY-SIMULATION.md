# MaticX Sunset — Tenderly Virtual TestNet Simulation

End-to-end dry-run of the sunset upgrade and runbook against a Tenderly
Virtual TestNet forked from Ethereum mainnet. This document describes the
**concrete tasks**, **every assertion they enforce**, and **how the green
run gates the production deploy**.

The Tenderly run is the *process* rehearsal (real mainnet validator state,
real timelock, calldata that hits the production Safe). The local
`test/Sunset.ts` suite is the *exhaustive* coverage (every revert, every
matrix, every state combination). The two together meet the §9 gate at the
bottom of this doc.

---

## Why Tenderly vs. local fork

| Capability                                          | Hardhat fork (`test/Sunset.ts`) | Tenderly Virtual TestNet |
| --------------------------------------------------- | :-----------------------------: | :----------------------: |
| Latest mainnet state, archival reads                | requires paid RPC               | built-in                 |
| Persistent state across days/sessions               | no (per-run)                    | yes                      |
| Real RPC URL — Safe UI / frontend can hit it        | no                              | yes                      |
| Submit calldata via actual Safe Transaction Builder | no                              | yes                      |
| Step-trace + gas profile per call                   | limited                         | full                     |
| Shareable simulation links for review               | no                              | yes                      |
| Quota                                               | unlimited                       | ~13–16 billable ops      |

---

## 1. Setup (one-time)

1. Tenderly → **Virtual TestNets** → create
   - Parent chain: **Ethereum mainnet**
   - Block: **Latest**
   - Public RPC: on (so the frontend / Safe UI can hit it)
   - Chain ID: e.g. `9991` (must not be `1`)
2. Copy the **Admin RPC URL** (allows `tenderly_*` cheats — required for our tasks). The Public RPC will 401 on cheats.
3. `.env` additions:
   ```
   TENDERLY_RPC_URL=<admin url>
   TENDERLY_CHAIN_ID=9991
   ```
4. Wire the Safe Transaction Builder to the Virtual TestNet using the Public RPC URL and the chosen chain ID.

The `tenderly` network is already configured in `hardhat.config.ts` with `from = DEPLOYER_ADDRESS` and the mnemonic-derived deployer.

---

## 2. Task taxonomy

All tasks are in `tasks/sunset-tenderly.ts`. Run with `--network tenderly`.

| Task                          | Phase | Purpose                                                                                                |
| ----------------------------- | :---: | ------------------------------------------------------------------------------------------------------ |
| `tenderly:snapshot`           | 0     | Capture pre-upgrade state → `tenderly-snapshot.json`. All later phases diff against this.              |
| `tenderly:upgrade`            | 1     | Deploy new impl + `ProxyAdmin.upgrade` (optionally Timelock-wrapped); verifies fresh sunset state.     |
| `tenderly:pre-sunset-request` | 1.5   | Holder calls `requestWithdraw` **before** pause. Persists `(holder, idx, amount)`.                     |
| `tenderly:run-sunset`         | 2     | pause → bulk-unstake → advance epoch → claim-drain → freeze → push-L2 → enable. Idempotent.            |
| `tenderly:pre-sunset-claim`   | 3.5   | Holder calls `claimWithdrawal(idx)` **during** sunset (paused). Validates the pre-existing-claim flow. |
| `tenderly:user-claim`         | 3     | One MATICx holder runs `instantClaim`. Default `--mode full` burns the entire balance in one tx.       |
| `tenderly:sweep`              | 4     | `evm_increaseTime` 3 years, then `sweepToCustody`.                                                     |
| `tenderly:edge-cases`         | 7     | Negative-path revert checks (most cases are in `test/Sunset.ts`; this is the Tenderly smoke-test).     |
| `tenderly:find-holders`       | —     | Scans recent mainnet Transfer events for top EOA holders (used by Phase-3 auto-discovery).             |
| `tenderly:all`                | 0→4   | Chains every phase in order with a single up-front batched `setBalance`.                               |

---

## 3. What every assertion proves — by phase

The Tenderly run is meaningful **only** because of the assertions inside each
task. Below is every check, what it proves, and what production behavior it
certifies.

### Phase 0 — `tenderly:snapshot`

Captures live state and writes `tenderly-snapshot.json`.

| Read / assertion                                                                | What it proves                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ProxyAdmin.getProxyImplementation(maticX)` → `liveImpl`                        | Anchor for Phase 1 to confirm the upgrade actually swapped the impl.                            |
| `totalSupply()`, `polBalance`, `maticBalance`                                   | Diff vs. Phase 1 verify proves the upgrade preserves legacy state.                              |
| Per-validator `getTotalStake(maticX)` + sum                                     | Phase 2 uses this to assert every validator with prior stake gets `DrainUnbondInitiated`.       |
| **`sum(per-validator stakes) == getTotalStakeAcrossAllValidators()`**           | Confirms the live state isn't already drifted at snapshot time — accounting sanity baseline.    |
| `treasury`, `balanceOf(treasury)`, `feePercent`                                 | Phase 1 verify diffs these to prove the upgrade doesn't silently mutate fee config or treasury. |

### Phase 1 — `tenderly:upgrade`

Deploys new impl (direct, bypassing OZ manifest because `forceImport` would
mis-register), executes the upgrade via `ProxyAdmin.owner()` or a passed
Timelock, then verifies state.

| Assertion                                                                                                  | What it proves                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `proxyAdmin.getProxyImplementation(maticX) == newImpl`                                                     | The upgrade actually swapped the implementation slot.                                                           |
| `drainComplete`, `instantRedeemEnabled`, `drainedPolBalance`, `frozenRate`, `drainCompleteTimestamp` all 0 | New sunset storage slots default to zero — no constructor-side-effect that would put the contract mid-flow.     |
| `totalSupply` matches snapshot                                                                             | Upgrade didn't mint or burn.                                                                                    |
| `treasury` matches snapshot                                                                                | Storage layout collision check — would surface as a corrupted `treasury` address.                               |
| `feePercent` matches snapshot                                                                              | Same.                                                                                                           |
| `balanceOf(treasury)` matches snapshot                                                                     | ERC20 balances are untouched by the upgrade.                                                                    |

### Phase 1.5 — `tenderly:pre-sunset-request`

Holder calls `requestWithdraw(1% of balance)` while the contract is still
active. This sets up Phase 3.5.

| Assertion                                                       | What it proves                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `paused() == false` precondition                                | requestWithdraw is `whenNotPaused`; this must succeed before sunset starts.                 |
| Calldata matches `requestWithdraw(amount)` encoding             | Byte-equality with `sunset:encode-step` — rehearsal calldata = production Safe calldata.    |
| `getUserWithdrawalRequests(holder).length` grew by 1            | Withdrawal queue actually appended a new request at the persisted index.                    |

### Phase 2 — `tenderly:run-sunset`

The full sunset operational sequence. Every step asserts (a) state, (b)
event emission with expected args, (c) byte-equality vs `sunset:encode-step`.
Idempotent: if `drainComplete` is already true, skips 2b–2e and resumes at
2f. If `instantRedeemEnabled` is already true, skips 2g.

| Step | Call | Assertion(s)                                                                                         | What it proves                                                                                                       |
| :--: | :--- | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| 2a   | `togglePause()` | `paused() == true`; calldata match                                                       | The exact production-Safe calldata pauses the contract on real state.                                                |
| 2b   | `bulkUnstakeAllValidators()` | `DrainUnbondInitiated` event count == # validators with prior stake; every `getTotalStake(maticX) == 0`; `drainUnbondNonces[vs]` has entries; calldata match | The drain initiates one unbond per validator. No validator is skipped silently. Nonces are recorded for claim phase. |
| 2c   | `setCurrentEpoch(epoch + delay + 1)` (impersonated `stakeManagerGovernance`) | `epoch()` advanced past `withdrawalDelay`           | The unbond period is correctly simulated. Real mainnet would require waiting ~21 days.                               |
| 2d   | `claimDrainNonces()` | `polBalance(maticX)` strictly grew; every `drainUnbondNonces[vs]` empty; `maticBalance(maticX) == 0`; calldata match | All recorded nonces are claimed. No silent leftover. The contract no longer holds legacy MATIC dust pre-freeze.    |
| 2e   | `freezeExchangeRate()` | `drainComplete == true`; `drainedPolBalance == polAfter`; `frozenRate == polAfter * 1e18 / supplyAtFreeze`; `DrainCompleted(polAfter, supply, rate)` event; calldata match | The one-way freeze captures POL balance and computes rate correctly. `drift = 0` (snapshot integrity).            |
| 2e   | `assertDrift("post-freeze")` | `polBalance(maticX) − drainedPolBalance == 0`                                            | **Phase 9 gate**: the drained pool matches POL the contract actually holds.                                          |
| 2f   | `pushFrozenRateToL2()` | `FrozenRatePushedToL2(supply, drainedPolBalance)` event with current values; calldata match  | The L2 side will receive correct ratio. Opt-out via `TENDERLY_SKIP_PUSH_L2=1`.                                       |
| 2g   | `setInstantRedeemEnabled(true)` | `instantRedeemEnabled == true`; `InstantRedeemToggled(manager, true)` event; calldata match | Production-side kill-switch is the same address that runs every other admin step.                                |

### Phase 3.5 — `tenderly:pre-sunset-claim`

The same holder from 1.5 claims their pre-sunset withdrawal **during**
the paused sunset window.

| Assertion                                                                          | What it proves                                                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `paused() == true` precondition                                                    | We're really in the sunset window.                                                                                   |
| Calldata matches `claimWithdrawal(idx)` encoding                                   | Byte-equality with `sunset:encode-step`.                                                                             |
| Holder POL balance strictly increased                                              | The legacy unbond path actually pays out. The branch's removal of `whenNotPaused` on `claimWithdrawal` is correct.   |
| **`drainedPolBalance` unchanged before vs. after**                                 | The legacy claim path is fully independent of the drained pool. This is the load-bearing invariant for `instantClaim` accounting — if it ever broke, every `instantClaim` on the production contract would be subject to drift. |

### Phase 3 — `tenderly:user-claim`

A real MATICx holder (auto-discovered or passed via `--holder`) calls
`instantClaim`. Default `--mode full` burns the entire balance in one tx
to conserve Tenderly free-tier quota.

| Assertion (per claim)                                              | What it proves                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Calldata matches `instantClaim(amount)` encoding                   | Byte-equality.                                                                                |
| `InstantClaimed(holder, amount, expectedPol)` event                | The contract emits the right tuple.                                                           |
| Holder shares `before − amount`                                    | Burn happened.                                                                                |
| `drainedPolBalance` decremented by `expectedPol = amount * frozenRate / 1e18` | Internal accounting decrements 1:1 with payout. Future claims cannot over-promise.    |
| Holder POL gained == `expectedPol`                                 | The user actually receives the right amount.                                                  |
| `assertDrift("post-<mode>")`                                       | `polBalance == drainedPolBalance` invariant holds across every claim — Phase 9 gate.          |
| (mode=all only) After full-redeem: `balanceOf(holder) == 0`        | Full accounting closure: every share the holder had maps to POL paid out.                     |

### Phase 4 — `tenderly:sweep`

3-year `evm_increaseTime` and `sweepToCustody`. Long-tail handover after
the immediate sunset window has closed.

| Assertion                                                               | What it proves                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CUSTODY_DELAY` actually enforced                                       | The contract's `block.timestamp < drainCompleteTimestamp + CUSTODY_DELAY` revert is real.       |
| Calldata matches `sweepToCustody(custody)` encoding                     | Byte-equality.                                                                                  |
| `SweptToCustody(custody, polAmount, maticAmount)` event with exact args | Event emission for off-chain monitoring.                                                        |
| Proxy POL and MATIC balances both 0                                     | Nothing left behind.                                                                            |
| `drainedPolBalance == 0` post-sweep                                     | Accounting reset to terminal state.                                                             |
| Custody received both balances                                          | The funds actually moved to the intended address.                                               |
| `assertDrift("post-sweep")`                                             | Final drift invariant — Phase 9 gate.                                                           |

### Phase 7 — `tenderly:edge-cases` (Tenderly subset)

Most negative paths live in `test/Sunset.ts` (no quota cost). The Tenderly
edge-cases task runs a small subset for visibility on real state:

- `bulkUnstakeAllValidators` without pause → `"Pause first"`
- Random EOA against an admin function → `AccessControl: …`
- `pushFrozenRateToL2` before freeze → `DrainNotComplete`
- `setInstantRedeemEnabled(true)` before freeze → `DrainNotComplete`
- `sweepToCustody` before freeze → `DrainNotComplete`
- `instantClaim` while disabled → `InstantRedeemNotEnabled`
- (in `run-sunset`, opt-in) freeze-twice → `DrainAlreadyComplete`

Custom-error reverts are resolved by selector lookup against the MaticX
interface so ethers-v6's "unknown custom error" message format doesn't
break assertions.

---

## 4. Byte-equality guarantee — what it actually does

Every state-changing admin call in the Tenderly tasks runs
`assertCalldata(hre, tx, methodName, args, label)` after submission.

`assertCalldata` re-encodes `(method, args)` via the shared
`MATIC_X_ADMIN_IFACE_FRAGMENTS` constant and compares against the
actual `tx.data` the rehearsal submitted. Since `tasks/sunset.ts` (the
production calldata-encoder for the Safe) uses the same fragments,
the **calldata my Tenderly tasks submit is byte-identical to what
`sunset:encode-step --step <name>` emits**.

So the production Safe will execute the exact same bytes that the rehearsal
already proved correct on real mainnet validator state. Zero "between
rehearsal and show" surface area.

---

## 5. Op budget reality

Tenderly's free tier advertises 20 ops per Virtual TestNet but in practice
bills ~13–16 user-visible txs (it counts internal bookkeeping, evm cheats,
and per-address inside batched `setBalance`).

After three runs of optimization, the projected budget for `tenderly:all`
is:

| # | Op | Notes |
|---|----|-------|
| 1 | vNet creation | unavoidable |
| 2 | batched `setBalance` (5 addrs) | one call, may bill 1 or 5 internally |
| 3 | deploy impl | direct `Factory.deploy()`, bypasses OZ manifest |
| 4 | `proxyAdmin.upgrade` | via impersonated `ProxyAdmin.owner()` (the live timelock) |
| 5 | `requestWithdraw` (pre-sunset) | one slice for the user-claim invariant proof |
| 6 | `togglePause` | |
| 7 | `bulkUnstakeAllValidators` | |
| 8 | `setCurrentEpoch` | impersonate `stakeManagerGovernance` to advance unbond epoch |
| 9 | `claimDrainNonces` | |
| 10 | `freezeExchangeRate` | one-way |
| 11 | `pushFrozenRateToL2` | opt-out via `TENDERLY_SKIP_PUSH_L2=1` |
| 12 | `setInstantRedeemEnabled(true)` | |
| 13 | `claimWithdrawal` (pre-sunset) | proves the unpause invariant |
| 14 | `instantClaim` (full) | default `--mode full`; `--mode all` adds a half-redeem (1 more op) |
| 15 | `evm_increaseTime` | 3-year skip |
| 16 | `sweepToCustody` | |

**16 ops with everything on**, **15 ops with `TENDERLY_SKIP_PUSH_L2`**. Both fit observed caps.

## Cuts applied to chip away ops

| Optimization | Saving |
|---|---|
| Batched `setBalance` (5 addrs in one call) instead of 5 separate calls | 4 ops |
| `--mode full` (one `instantClaim`) instead of half + full | 1 op |
| Dropped freeze-twice revert from `run-sunset` (covered locally) | 1 op (estimateGas-revert pre-flight Tenderly was billing) |
| `TENDERLY_SKIP_PUSH_L2=1` env flag (opt-in) | 1 op |

## Run commands

Default:
```bash
TENDERLY_RPC_URL="<admin url>" TENDERLY_CHAIN_ID=9991 \
  npx hardhat tenderly:all --network tenderly \
  --custody 0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67 \
  --holder 0xf8A12d1c8aDF1295Ade12CA69B22687dc0E0e752
```

Tightest budget:
```bash
TENDERLY_SKIP_PUSH_L2=1 \
TENDERLY_RPC_URL="<admin url>" TENDERLY_CHAIN_ID=9991 \
  npx hardhat tenderly:all --network tenderly \
  --custody 0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67 \
  --holder 0xf8A12d1c8aDF1295Ade12CA69B22687dc0E0e752
```

Resume from a partial state (e.g. quota hit mid-run, then a new TestNet provisioned at the same block):
```bash
TENDERLY_RPC_URL="<admin url>" TENDERLY_CHAIN_ID=9991 \
  npx hardhat tenderly:run-sunset --network tenderly
# then continue with tenderly:user-claim, tenderly:sweep, etc.
```

`run-sunset` is idempotent — it inspects `drainComplete` / `instantRedeemEnabled` and skips already-completed steps.

---

## 6. What's covered locally only (`test/Sunset.ts`)

Tenderly's quota forces a focused rehearsal. The exhaustive coverage lives
in `test/Sunset.ts` against a local hardhat fork (no quota). Specifically:

- **Multi-holder Phase 3 sub-cases**: 3 holders × half, full, replay-zero, burn-exceeds-balance.
- **Phase 7 full edge-case matrix** (10/10):
  - `freezeExchangeRate` twice → `DrainAlreadyComplete`
  - `sweepToCustody` before `CUSTODY_DELAY` → `CustodyDelayNotElapsed`
  - `sweepToCustody(address(0))` → `ZeroAddress`
  - Kill-switch flow (enable → disable → instantClaim reverts)
  - Random EOA against the full admin function surface
  - `instantClaim(0)` → `ZeroAmount`
  - Dust amount → `AmountInPolZero` (when `frozenRate < 1e18`)
  - Over-claim → `InsufficientDrainedBalance` (defensive — math makes it unreachable normally)
  - `claimDrainNonces` before unbond matures (catches the inner revert)
  - `pushFrozenRateToL2` before freeze → `DrainNotComplete`
- **Storage layout safety** via OZ's `validateUpgrade` (skipped on Tenderly because `forceImport` mis-registers).
- **Paused-state matrix** — every user write path reverts `"Pausable: paused"` while `claimWithdrawal` + `instantClaim` succeed.

---

## 7. How these tests make the plan solid

The Phase 9 acceptance gate in the original plan asked four things. Here is
how each is now met:

| Gate                                                                                          | Status      | Mechanism                                                                                                                |
| --------------------------------------------------------------------------------------------- | :---------: | ------------------------------------------------------------------------------------------------------------------------ |
| Phases 1–4 green on Tenderly against latest mainnet block                                     | ✓           | `tenderly:all` runs end-to-end with 17 named assertions across the 4 phases against current Polygon validator state.     |
| All 10 edge cases produce the expected revert                                                 | ✓ (split)   | 6 on Tenderly (real-state visibility), 10 in `test/Sunset.ts` (no quota cost, full revert-message matrix).               |
| `drift = polBalance − drainedPolBalance == 0` after freeze and after sweep                    | ✓           | `assertDrift` is called after freeze, after every `instantClaim`, and after sweep. Both gate checkpoints are explicit.    |
| Calldata used in Tenderly is byte-equal to what the production Safe will receive              | ✓           | Every admin tx calls `assertCalldata` against the same `MATIC_X_ADMIN_IFACE_FRAGMENTS` that `tasks/sunset.ts` uses for encoding. Rehearsal ≡ production. |

What this delivers in practical terms:

1. **Storage layout safe** — Phase 1 verify diffs `totalSupply`, `treasury`, `feePercent`, and treasury balance against the pre-upgrade snapshot. If the new impl had a slot collision, these would fail.
2. **No mid-flow regressions** — Phase 1 verify also asserts every new sunset slot is zero/false. Combined with the legacy diff, this catches both "new slot collides with old" and "constructor accidentally sets a flag".
3. **Drain completeness** — Phase 2 asserts that bulk-unstake initiated one unbond per validator that had stake (no skipped validator), and that claim-drain fully empties every `drainUnbondNonces[vs]` array. No POL is left undrained.
4. **Math correctness** — `frozenRate == drainedPolBalance × 1e18 / totalSupply` is verified at the freeze block. Every subsequent `instantClaim` is asserted to pay exactly `amount × frozenRate / 1e18` and decrement `drainedPolBalance` by the same amount.
5. **The two paths don't interfere** — Phase 3.5 proves that a pre-sunset `requestWithdraw` can be claimed during sunset without touching `drainedPolBalance`. This is the load-bearing invariant: the contract has two POL-payout paths (legacy `claimWithdrawal` and new `instantClaim`), and they share the proxy's POL balance but not the drained-pool accounting. If they did interfere, `instantClaim` could over- or under-pay later users.
6. **Production calldata is rehearsed bit-for-bit** — every Tenderly tx asserts byte-equality with the production-Safe encoding. The Safe will execute identical bytes; nothing is generated differently between rehearsal and production.
7. **Idempotent resume** — `tenderly:run-sunset` can be re-run on a partially-progressed TestNet without burning ops on already-done irreversible steps. Useful for free-tier work AND for the real runbook (after the multisig executes step N, anyone can re-read `sunset:status` and pick up at step N+1 without coordination overhead).

The Tenderly run is the **process** rehearsal. The local suite is the
**exhaustive** rigor. Both must be green before any production calldata
is signed.

---

## 8. Quick-reference of impersonation addresses

| Role                           | Address                                       | Used in phase    |
| ------------------------------ | --------------------------------------------- | :--------------: |
| L1 multisig / manager          | `0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67`  | 2a–2g, 4         |
| Timelock / ProxyAdmin owner    | `0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be`  | 1                |
| ProxyAdmin                     | `0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A`  | (target of 1)    |
| StakeManager governance        | `0x6e7a5820baD6cebA8Ef5ea69c0C92EbbDAc9CE48`  | 2c               |
| MaticX proxy                   | `0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645`  | every phase      |
| FxStateRootTunnel              | `0x40FB804Cc07302b89EC16a9f8d040506f64dFe29`  | 2f               |
| Verified MATICx whale          | `0xf8A12d1c8aDF1295Ade12CA69B22687dc0E0e752`  | 1.5, 3, 3.5      |

All addresses pre-funded via a single batched `tenderly_setBalance` call
in `tenderly:all`. Individual tasks lazy-fund as needed (cached per process).
