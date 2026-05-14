import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
	getStorageAt,
	loadFixture,
	reset,
	setBalance,
	setStorageAt,
	time,
} from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
	FxStateRootTunnel,
	IERC20,
	IFxStateRootTunnel,
	IStakeManager,
	MaticX,
	ValidatorRegistry,
} from "../typechain-types";
import { extractEnvironmentVariables } from "../utils/environment";
import { getProviderUrl, Network } from "../utils/network";

const envVars = extractEnvironmentVariables();
// Allow MAINNET_RPC_URL to override the constructed provider URL so the
// suite can run against a private node or a free public endpoint without
// rewiring utils/network.ts.
const providerUrl =
	process.env.MAINNET_RPC_URL ||
	getProviderUrl(
		Network.Ethereum,
		envVars.RPC_PROVIDER,
		envVars.ETHEREUM_API_KEY
	);

describe("MaticX sunset", function () {
	const stakeAmount = ethers.parseUnits("100", 18);
	const CUSTODY_DELAY = 3n * 365n * 24n * 60n * 60n;
	const TERMINAL_RATE_PRECISION = 10n ** 18n;

	async function impersonate(address: string): Promise<SignerWithAddress> {
		await setBalance(address, ethers.parseEther("10000"));
		return await ethers.getImpersonatedSigner(address);
	}

	async function deployFixture() {
		// When using a public RPC (no archival), pin to latest so historical
		// state queries don't fail. Archival nodes (paid Alchemy/Infura) can
		// honor the env's FORKING_BLOCK_NUMBER.
		const forkBlock = process.env.MAINNET_RPC_URL
			? undefined
			: envVars.FORKING_BLOCK_NUMBER;
		await reset(providerUrl, forkBlock);

		const manager = await impersonate(
			"0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67"
		);
		const polygonTreasury = await impersonate(
			"0xcD6507d87F605F5E95C12F7c4B1fC3279dc944aB"
		);
		const stakeManagerGovernance = await impersonate(
			"0x6e7a5820baD6cebA8Ef5ea69c0C92EbbDAc9CE48"
		);

		const [, bot, treasury, stakerA, stakerB, custody, attacker] =
			await ethers.getSigners();

		const validatorRegistry = (await ethers.getContractAt(
			"ValidatorRegistry",
			"0xf556442D5B77A4B0252630E15d8BbE2160870d77",
			manager
		)) as unknown as ValidatorRegistry;

		const fxStateRootTunnel = (await ethers.getContractAt(
			"IFxStateRootTunnel",
			"0x40FB804Cc07302b89EC16a9f8d040506f64dFe29",
			manager
		)) as IFxStateRootTunnel;

		const stakeManager = (await ethers.getContractAt(
			"IStakeManager",
			"0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908"
		)) as IStakeManager;

		const matic = (await ethers.getContractAt(
			"IERC20",
			"0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0"
		)) as IERC20;

		const pol = (await ethers.getContractAt(
			"IERC20",
			"0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6"
		)) as IERC20;

		const MaticXFactory = await ethers.getContractFactory("MaticX");
		const maticXContract = await upgrades.deployProxy(MaticXFactory, [
			await validatorRegistry.getAddress(),
			await stakeManager.getAddress(),
			await matic.getAddress(),
			manager.address,
			treasury.address,
		]);
		const maticX = maticXContract as unknown as MaticX;
		const maticXAddress = await maticX.getAddress();

		const [preferredDepositValidatorId, preferredWithdrawalValidatorId] =
			await validatorRegistry.getValidators();
		await validatorRegistry
			.connect(manager)
			.setPreferredDepositValidatorId(preferredDepositValidatorId);
		await validatorRegistry
			.connect(manager)
			.setPreferredWithdrawalValidatorId(preferredWithdrawalValidatorId);

		await (
			fxStateRootTunnel.connect(manager) as FxStateRootTunnel
		).setMaticX(maticXAddress);

		await (maticX.connect(manager) as MaticX).initializeV2(
			await pol.getAddress()
		);
		// Fixture pre-configures the sweep window: setCustodyDelay stores
		// `block.timestamp + CUSTODY_DELAY` as sweepToCustodyTimestamp.
		await (maticX.connect(manager) as MaticX).setCustodyDelay(
			CUSTODY_DELAY
		);
		await (maticX.connect(manager) as MaticX).setFxStateRootTunnel(
			await fxStateRootTunnel.getAddress()
		);

		const botRole = await maticX.BOT();
		await (maticX.connect(manager) as MaticX).grantRole(
			botRole,
			bot.address
		);

		for (const staker of [stakerA, stakerB]) {
			await pol
				.connect(polygonTreasury)
				.transfer(staker.address, stakeAmount * 3n);
			await pol.connect(staker).approve(maticXAddress, stakeAmount * 3n);
			await (maticX.connect(staker) as MaticX).submitPOL(stakeAmount);
		}

		return {
			maticX,
			maticXAddress,
			stakeManager,
			stakeManagerGovernance,
			validatorRegistry,
			fxStateRootTunnel,
			matic,
			pol,
			manager,
			bot,
			treasury,
			stakerA,
			stakerB,
			custody,
			attacker,
			polygonTreasury,
		};
	}

	async function advanceUnbond(
		stakeManager: IStakeManager,
		stakeManagerGovernance: SignerWithAddress
	) {
		const currentEpoch = await stakeManager.epoch();
		const withdrawalDelay = await stakeManager.withdrawalDelay();
		await stakeManager
			.connect(stakeManagerGovernance)
			.setCurrentEpoch(currentEpoch + withdrawalDelay + 1n);
	}

	async function pauseRecallAndFinalize(
		fx: Awaited<ReturnType<typeof deployFixture>>
	) {
		const { maticX, manager, stakeManager, stakeManagerGovernance } = fx;
		await (maticX.connect(manager) as MaticX).togglePause();
		await (maticX.connect(manager) as MaticX).bulkUnstakeAllValidators();
		await advanceUnbond(stakeManager, stakeManagerGovernance);
		await (maticX.connect(manager) as MaticX).claimAssetRecallNonces();
		await (maticX.connect(manager) as MaticX).finalizeTerminalRate();
	}

	async function findScalarStorageSlot(
		address: string,
		expectedValue: bigint,
		readValue: () => Promise<bigint>,
		probeValue: bigint,
		maxSlots = 1000
	): Promise<number> {
		const target = ethers.toBeHex(expectedValue, 32).toLowerCase();
		for (let slot = 0; slot < maxSlots; slot++) {
			const value = (await getStorageAt(address, slot)).toLowerCase();
			if (value !== target) continue;

			await setStorageAt(address, slot, probeValue);
			const observed = await readValue();
			await setStorageAt(address, slot, expectedValue);

			if (observed === probeValue) return slot;
		}
		throw new Error(
			`Could not find storage slot for ${expectedValue.toString()}`
		);
	}

	// Probe to find the slot index of a mapping(address => uint256) so we can
	// write to mapping[key] via setStorageAt. Returns the *mapping slot index*
	// (S) — actual storage at `keccak256(abi.encode(key, S))`.
	async function findMappingSlot(
		contractAddress: string,
		key: string,
		readValue: () => Promise<bigint>,
		probeValue: bigint,
		maxSlots = 1000
	): Promise<number> {
		const abiCoder = ethers.AbiCoder.defaultAbiCoder();
		for (let s = 0; s < maxSlots; s++) {
			const valueSlot = ethers.keccak256(
				abiCoder.encode(["address", "uint256"], [key, s])
			);
			const original = await getStorageAt(contractAddress, valueSlot);
			await setStorageAt(contractAddress, valueSlot, probeValue);
			const observed = await readValue();
			await setStorageAt(contractAddress, valueSlot, original);
			if (observed === probeValue) return s;
		}
		throw new Error(
			`Could not find mapping slot for key ${key} on ${contractAddress}`
		);
	}

	// Write a uint256 directly into mapping[key] at the discovered slot index.
	async function writeMappingValue(
		contractAddress: string,
		mappingSlot: number,
		key: string,
		value: bigint
	): Promise<void> {
		const abiCoder = ethers.AbiCoder.defaultAbiCoder();
		const valueSlot = ethers.keccak256(
			abiCoder.encode(["address", "uint256"], [key, mappingSlot])
		);
		await setStorageAt(contractAddress, valueSlot, value);
	}

	describe("End-to-end happy path", function () {
		it("runs the full sunset sequence and lets users redeem at the terminal rate", async function () {
			const fx = await loadFixture(deployFixture);
			const {
				maticX,
				maticXAddress,
				manager,
				pol,
				stakerA,
				stakerB,
				custody,
				stakeManager,
				stakeManagerGovernance,
			} = fx;

			// 1. Pause
			await (maticX.connect(manager) as MaticX).togglePause();
			expect(await maticX.paused()).to.equal(true);

			// 2. Bulk unstake — assert AssetRecallInitiated event args on the
			// preferred deposit validator (the only one with stake in this
			// fresh-proxy fixture).
			const [preferredId] =
				await fx.validatorRegistry.getValidators();
			const preferredShare = await stakeManager.getValidatorContract(
				preferredId
			);
			const vs = await ethers.getContractAt(
				[
					"function getTotalStake(address) view returns (uint256, uint256)",
					"function unbondNonces(address) view returns (uint256)",
				],
				preferredShare
			);
			const [stakeBefore] = (await vs.getTotalStake(maticXAddress)) as [
				bigint,
				bigint,
			];
			const nonceBefore = (await vs.unbondNonces(maticXAddress)) as bigint;
			await expect(
				(maticX.connect(manager) as MaticX).bulkUnstakeAllValidators()
			)
				.to.emit(maticX, "AssetRecallInitiated")
				.withArgs(preferredShare, nonceBefore + 1n, stakeBefore);

			// 3. Advance epoch past unbond
			await advanceUnbond(stakeManager, stakeManagerGovernance);

			// 4. Claim asset-recall nonces — must net positive POL to the contract
			const polBalBefore = await pol.balanceOf(maticXAddress);
			await (maticX.connect(manager) as MaticX).claimAssetRecallNonces();
			const polBalAfter = await pol.balanceOf(maticXAddress);
			expect(polBalAfter).to.be.gt(polBalBefore);

			// 5. Freeze
			const supply = await maticX.totalSupply();
			const expectedRate =
				(polBalAfter * TERMINAL_RATE_PRECISION) / supply;
			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			)
				.to.emit(maticX, "AssetRecallCompleted")
				.withArgs(polBalAfter, supply, expectedRate);

			expect(await maticX.terminalRateLocked()).to.equal(true);
			expect(await maticX.terminalRate()).to.equal(expectedRate);
			expect(await maticX.recalledPolBalance()).to.equal(polBalAfter);

			// 6. Push to L2
			await expect(
				(maticX.connect(manager) as MaticX).pushTerminalRateToL2()
			)
				.to.emit(maticX, "TerminalRatePushedToL2")
				.withArgs(supply, polBalAfter);

			// 7. Enable instant redeem
			await expect(
				(maticX.connect(manager) as MaticX).setInstantRedeemEnabled(
					true
				)
			)
				.to.emit(maticX, "InstantRedeemToggled")
				.withArgs(manager.address, true);

			// 8. Staker A instant-claims their full position
			const stakerAShares = await maticX.balanceOf(stakerA.address);
			const expectedPol =
				(stakerAShares * expectedRate) / TERMINAL_RATE_PRECISION;

			const recalledBefore = await maticX.recalledPolBalance();
			await expect((maticX.connect(stakerA) as MaticX).instantClaim())
				.to.emit(maticX, "InstantClaimed")
				.withArgs(stakerA.address, stakerAShares, expectedPol);

			expect(await maticX.balanceOf(stakerA.address)).to.equal(0n);
			expect(await maticX.recalledPolBalance()).to.equal(
				recalledBefore - expectedPol
			);
			expect(await pol.balanceOf(stakerA.address)).to.be.gte(expectedPol);

			// 9. Sweep — must wait the full custody delay
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.be.revertedWithCustomError(maticX, "CustodyDelayNotElapsed");

			await time.increase(CUSTODY_DELAY + 1n);

			const polBeforeSweep = await pol.balanceOf(maticXAddress);
			const maticBeforeSweep = await fx.matic.balanceOf(maticXAddress);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			)
				.to.emit(maticX, "SweptToCustody")
				.withArgs(custody.address, polBeforeSweep, maticBeforeSweep);

			expect(await pol.balanceOf(maticXAddress)).to.equal(0);
			expect(await pol.balanceOf(custody.address)).to.equal(
				polBeforeSweep
			);
			expect(await maticX.recalledPolBalance()).to.equal(0);

			// Staker B still holds their MATICx but no POL left to redeem
			void stakerB;
		});
	});

	describe("Paused-state matrix", function () {
		it("blocks user write paths while paused but lets claimWithdrawal and instantClaim through", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, bot, pol, stakerA } = fx;

			await pauseRecallAndFinalize(fx);
			await (maticX.connect(manager) as MaticX).setInstantRedeemEnabled(
				true
			);

			// Must revert with Pausable:paused
			await expect(
				(maticX.connect(stakerA) as MaticX).submit(stakeAmount)
			).to.be.revertedWith("Pausable: paused");
			await expect(
				(maticX.connect(stakerA) as MaticX).submitPOL(stakeAmount)
			).to.be.revertedWith("Pausable: paused");
			await expect(
				(maticX.connect(stakerA) as MaticX).requestWithdraw(stakeAmount)
			).to.be.revertedWith("Pausable: paused");
			await expect(
				(maticX.connect(stakerA) as MaticX).withdrawRewards(1n)
			).to.be.revertedWith("Pausable: paused");
			await expect(
				(maticX.connect(bot) as MaticX).stakeRewardsAndDistributeFees(
					1n
				)
			).to.be.revertedWith("Pausable: paused");
			await expect(
				(maticX.connect(manager) as MaticX).setFeePercent(100)
			).to.be.revertedWith("Pausable: paused");

			// instantClaim still works (always redeems caller's full balance)
			await expect(
				(maticX.connect(stakerA) as MaticX).instantClaim()
			).to.emit(maticX, "InstantClaimed");

			void pol;
		});
	});

	describe("bulkUnstakeAllValidators", function () {
		it("reverts without pause", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).bulkUnstakeAllValidators()
			).to.be.revertedWith("Pause first");
		});

		it("reverts for non-admin even when paused", async function () {
			const { maticX, manager, attacker } =
				await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await expect(
				(maticX.connect(attacker) as MaticX).bulkUnstakeAllValidators()
			).to.be.reverted;
		});

		it("reverts on the second call with RecallAlreadyInitiated", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await expect(
				(maticX.connect(manager) as MaticX).bulkUnstakeAllValidators()
			).to.be.revertedWithCustomError(maticX, "RecallAlreadyInitiated");
		});

		it("reverts after terminalRateLocked", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager } = fx;
			await pauseRecallAndFinalize(fx);
			await expect(
				(maticX.connect(manager) as MaticX).bulkUnstakeAllValidators()
			).to.be.revertedWithCustomError(maticX, "RecallAlreadyInitiated");
		});

		it("skips validators with zero stake (no nonce, no event)", async function () {
			// In the fresh-proxy fixture, only the preferred deposit validator
			// has stake from the test stakers' submitPOL. The other 4 registered
			// validators have stake == 0 for THIS proxy. The `if (stake > 0)`
			// branch must skip them — no nonce, no event.
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, stakeManager, validatorRegistry } = fx;
			await (maticX.connect(manager) as MaticX).togglePause();

			const validatorIds = await validatorRegistry.getValidators();
			const sharesWithStake: string[] = [];
			const sharesWithoutStake: string[] = [];
			for (const id of validatorIds) {
				const share = await stakeManager.getValidatorContract(id);
				const vs = await ethers.getContractAt(
					[
						"function getTotalStake(address) view returns (uint256, uint256)",
					],
					share
				);
				const [stake] = (await vs.getTotalStake(
					await maticX.getAddress()
				)) as [bigint, bigint];
				if (stake > 0n) sharesWithStake.push(share);
				else sharesWithoutStake.push(share);
			}
			expect(sharesWithStake.length).to.be.gt(0);
			expect(sharesWithoutStake.length).to.be.gt(0);

			const tx = await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			const receipt = await tx.wait();
			const topic =
				maticX.interface.getEvent("AssetRecallInitiated")!.topicHash;
			const emitted =
				receipt?.logs.filter((l) => l.topics[0] === topic).length ?? 0;
			expect(emitted).to.equal(sharesWithStake.length);

			for (const share of sharesWithStake) {
				expect(await maticX.assetRecallNonces(share)).to.be.gt(0n);
			}
			for (const share of sharesWithoutStake) {
				expect(await maticX.assetRecallNonces(share)).to.equal(0n);
			}
		});
	});

	describe("claimAssetRecallNonces", function () {
		it("reverts without pause", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).claimAssetRecallNonces()
			).to.be.revertedWith("Pause first");
		});

		it("reverts after terminalRateLocked", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager } = fx;
			await pauseRecallAndFinalize(fx);
			await expect(
				(maticX.connect(manager) as MaticX).claimAssetRecallNonces()
			).to.be.revertedWithCustomError(
				maticX,
				"TerminalRateAlreadyLocked"
			);
		});

		it("reverts with RecallNotInitiated when called before bulkUnstake", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await expect(
				(maticX.connect(manager) as MaticX).claimAssetRecallNonces()
			).to.be.revertedWithCustomError(maticX, "RecallNotInitiated");
		});

		it("is a no-op (no nonces, no revert) when called twice before the unbond matures", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, stakeManager } = fx;
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			// Capture per-validator nonces before the failed retry so we
			// can confirm the tx-level revert rolls them back intact.
			const validatorIds =
				await fx.validatorRegistry.getValidators();
			const shareAddrs = await Promise.all(
				validatorIds.map((id) =>
					stakeManager.getValidatorContract(id)
				)
			);
			const noncesBefore = await Promise.all(
				shareAddrs.map((vs) => maticX.assetRecallNonces(vs))
			);
			// Sanity: at least one nonce must be non-zero (bulk-unstake ran).
			expect(noncesBefore.some((n) => n > 0n)).to.equal(true);

			// Without epoch advance: nonces are immature; the inner
			// unstakeClaimTokens_newPOL reverts and the whole tx rolls back.
			await (maticX.connect(manager) as MaticX)
				.claimAssetRecallNonces()
				.catch(() => {
					// Expected — validator unbond is not matured yet.
				});

			// Rollback contract: every per-validator nonce is preserved,
			// and the recallClaimsComplete flag must NOT have been set
			// since the loop never completed.
			const noncesAfter = await Promise.all(
				shareAddrs.map((vs) => maticX.assetRecallNonces(vs))
			);
			expect(noncesAfter).to.deep.equal(noncesBefore);
			expect(await maticX.recallClaimsComplete()).to.equal(false);
			expect(await maticX.terminalRateLocked()).to.equal(false);
		});

		it("sets recallClaimsComplete = true after a successful claim", async function () {
			const fx = await loadFixture(deployFixture);
			const {
				maticX,
				manager,
				stakeManager,
				stakeManagerGovernance,
			} = fx;
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await advanceUnbond(stakeManager, stakeManagerGovernance);

			expect(await maticX.recallClaimsComplete()).to.equal(false);
			await (
				maticX.connect(manager) as MaticX
			).claimAssetRecallNonces();
			expect(await maticX.recallClaimsComplete()).to.equal(true);

			// Every per-validator nonce is cleared post-claim.
			const validatorIds =
				await fx.validatorRegistry.getValidators();
			for (const id of validatorIds) {
				const vs = await stakeManager.getValidatorContract(id);
				expect(await maticX.assetRecallNonces(vs)).to.equal(0n);
			}
		});
	});

	describe("finalizeTerminalRate", function () {
		it("reverts without pause", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			).to.be.revertedWith("Pause first");
		});

		it("reverts on the second call", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager } = fx;
			await pauseRecallAndFinalize(fx);
			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			).to.be.revertedWithCustomError(
				maticX,
				"TerminalRateAlreadyLocked"
			);
		});

		it("reverts with RecallClaimsNotComplete when finalize runs before claim", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			).to.be.revertedWithCustomError(maticX, "RecallClaimsNotComplete");
		});

		it("reverts EmptyContract when totalSupply is zero at finalize", async function () {
			// Run the recall flow through claim, then zero `totalSupply` via
			// direct storage manipulation right before finalize. This is the
			// only realistic way to exercise the defensive branch — the
			// contract's own happy path always has supply > 0.
			const fx = await loadFixture(deployFixture);
			const {
				maticX,
				maticXAddress,
				manager,
				stakeManager,
				stakeManagerGovernance,
			} = fx;
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await advanceUnbond(stakeManager, stakeManagerGovernance);
			await (
				maticX.connect(manager) as MaticX
			).claimAssetRecallNonces();

			const supplyBefore = await maticX.totalSupply();
			expect(supplyBefore).to.be.gt(0n);
			const supplySlot = await findScalarStorageSlot(
				maticXAddress,
				supplyBefore,
				() => maticX.totalSupply(),
				123456789n
			);
			await setStorageAt(maticXAddress, supplySlot, 0n);
			expect(await maticX.totalSupply()).to.equal(0n);

			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			).to.be.revertedWithCustomError(maticX, "EmptyContract");
		});

		it("reverts EmptyContract when polBalance is zero at finalize", async function () {
			// Same gate, different branch of the `||`. Force the proxy's POL
			// balance to 0 by writing to the POL token's balances mapping for
			// this contract before finalize.
			const fx = await loadFixture(deployFixture);
			const {
				maticX,
				maticXAddress,
				manager,
				pol,
				stakeManager,
				stakeManagerGovernance,
			} = fx;
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await advanceUnbond(stakeManager, stakeManagerGovernance);
			await (
				maticX.connect(manager) as MaticX
			).claimAssetRecallNonces();

			const polAddr = await pol.getAddress();
			const before = await pol.balanceOf(maticXAddress);
			expect(before).to.be.gt(0n);
			const balancesSlot = await findMappingSlot(
				polAddr,
				maticXAddress,
				async () => pol.balanceOf(maticXAddress),
				123456789n
			);
			await writeMappingValue(
				polAddr,
				balancesSlot,
				maticXAddress,
				0n
			);
			expect(await pol.balanceOf(maticXAddress)).to.equal(0n);

			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			).to.be.revertedWithCustomError(maticX, "EmptyContract");
		});
	});

	describe("pushTerminalRateToL2", function () {
		it("reverts before freeze", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).pushTerminalRateToL2()
			).to.be.revertedWithCustomError(maticX, "TerminalRateNotLocked");
		});

		it("is idempotent (can be called twice after freeze)", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager } = fx;
			await pauseRecallAndFinalize(fx);
			await (maticX.connect(manager) as MaticX).pushTerminalRateToL2();
			await expect(
				(maticX.connect(manager) as MaticX).pushTerminalRateToL2()
			).to.emit(maticX, "TerminalRatePushedToL2");
		});
	});

	describe("setInstantRedeemEnabled", function () {
		it("reverts when enabling pre-freeze", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).setInstantRedeemEnabled(
					true
				)
			).to.be.revertedWithCustomError(maticX, "TerminalRateNotLocked");
		});

		it("allows disabling pre-freeze (kill-switch is unconditional)", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).setInstantRedeemEnabled(
					false
				)
			)
				.to.emit(maticX, "InstantRedeemToggled")
				.withArgs(manager.address, false);
		});

		it("admin can toggle on then off post-freeze", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager } = fx;
			await pauseRecallAndFinalize(fx);
			await (maticX.connect(manager) as MaticX).setInstantRedeemEnabled(
				true
			);
			expect(await maticX.instantRedeemEnabled()).to.equal(true);
			await (maticX.connect(manager) as MaticX).setInstantRedeemEnabled(
				false
			);
			expect(await maticX.instantRedeemEnabled()).to.equal(false);
		});
	});

	describe("instantClaim", function () {
		async function freezeAndEnable(
			fx: Awaited<ReturnType<typeof deployFixture>>
		) {
			await pauseRecallAndFinalize(fx);
			await (
				fx.maticX.connect(fx.manager) as MaticX
			).setInstantRedeemEnabled(true);
		}

		it("reverts if redeem flag is off", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, stakerA } = fx;
			await pauseRecallAndFinalize(fx);
			await expect(
				(maticX.connect(stakerA) as MaticX).instantClaim()
			).to.be.revertedWithCustomError(maticX, "InstantRedeemNotEnabled");
		});

		it("reverts ZeroAmount when caller holds no MATICx", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, attacker } = fx;
			await freezeAndEnable(fx);
			expect(await maticX.balanceOf(attacker.address)).to.equal(0n);
			await expect(
				(maticX.connect(attacker) as MaticX).instantClaim()
			).to.be.revertedWithCustomError(maticX, "ZeroAmount");
		});

		it("reverts AmountInPolZero when terminalRate is degenerate (defensive)", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, maticXAddress, stakerA } = fx;
			await freezeAndEnable(fx);

			// `finalizeTerminalRate` guarantees `terminalRate > 0` whenever
			// `polBalance > 0` and `supply > 0`. Force it to 0 via storage so
			// `_convertMaticXToPOL` falls through to the sentinel `rate = 1`
			// branch. Then shrink the holder's MATICx balance below
			// `TERMINAL_RATE_PRECISION` so `(balance * 1) / 1e18` floors to
			// zero and triggers the AmountInPolZero guard.
			const rateSlot = await findScalarStorageSlot(
				maticXAddress,
				await maticX.terminalRate(),
				() => maticX.terminalRate(),
				123456789n
			);
			await setStorageAt(maticXAddress, rateSlot, 0n);
			expect(await maticX.terminalRate()).to.equal(0n);

			const balanceSlot = await findMappingSlot(
				maticXAddress,
				stakerA.address,
				() => maticX.balanceOf(stakerA.address),
				123456789n
			);
			// 1 wei MATICx; with sentinel rate=1: 1 * 1 / 1e18 = 0.
			await writeMappingValue(
				maticXAddress,
				balanceSlot,
				stakerA.address,
				1n
			);
			expect(await maticX.balanceOf(stakerA.address)).to.equal(1n);

			await expect(
				(maticX.connect(stakerA) as MaticX).instantClaim()
			).to.be.revertedWithCustomError(maticX, "AmountInPolZero");
		});

		it("reverts InsufficientRecalledBalance when the pool is below the payout", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, maticXAddress, stakerA } = fx;
			await freezeAndEnable(fx);

			// Normal accounting makes over-claim unreachable. Force the stored
			// pool to zero after freeze to exercise the defensive guard.
			const recalledSlot = await findScalarStorageSlot(
				maticXAddress,
				await maticX.recalledPolBalance(),
				() => maticX.recalledPolBalance(),
				123456789n
			);
			await setStorageAt(maticXAddress, recalledSlot, 0n);
			expect(await maticX.recalledPolBalance()).to.equal(0n);

			await expect(
				(maticX.connect(stakerA) as MaticX).instantClaim()
			).to.be.revertedWithCustomError(
				maticX,
				"InsufficientRecalledBalance"
			);
		});

		it("redeems the caller's full balance and zeroes their shares", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, pol, stakerA } = fx;
			await freezeAndEnable(fx);

			const rate = await maticX.terminalRate();
			const sharesBefore = await maticX.balanceOf(stakerA.address);
			const recalledBefore = await maticX.recalledPolBalance();
			const polBefore = await pol.balanceOf(stakerA.address);
			const expectedPol = (sharesBefore * rate) / TERMINAL_RATE_PRECISION;

			await (maticX.connect(stakerA) as MaticX).instantClaim();

			expect(await maticX.balanceOf(stakerA.address)).to.equal(0n);
			expect(await maticX.recalledPolBalance()).to.equal(
				recalledBefore - expectedPol
			);
			expect(await pol.balanceOf(stakerA.address)).to.equal(
				polBefore + expectedPol
			);
		});

		it("emits InstantClaimed with the caller's full balance", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, stakerA } = fx;
			await freezeAndEnable(fx);

			const rate = await maticX.terminalRate();
			const shares = await maticX.balanceOf(stakerA.address);
			const expectedPol = (shares * rate) / TERMINAL_RATE_PRECISION;

			await expect((maticX.connect(stakerA) as MaticX).instantClaim())
				.to.emit(maticX, "InstantClaimed")
				.withArgs(stakerA.address, shares, expectedPol);
		});
	});

	describe("sweepToCustody", function () {
		it("reverts before freeze", async function () {
			const { maticX, manager, custody } =
				await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.be.revertedWithCustomError(maticX, "TerminalRateNotLocked");
		});

		it("reverts before the custody delay elapses", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, custody } = fx;
			await pauseRecallAndFinalize(fx);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.be.revertedWithCustomError(maticX, "CustodyDelayNotElapsed");
		});

		it("reverts on zero custody address", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager } = fx;
			await pauseRecallAndFinalize(fx);
			await time.increase(CUSTODY_DELAY + 1n);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					ethers.ZeroAddress
				)
			).to.be.revertedWithCustomError(maticX, "ZeroAddress");
		});

		it("moves the entire POL+MATIC balance and zeroes recalledPolBalance", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, maticXAddress, manager, pol, matic, custody } = fx;
			await pauseRecallAndFinalize(fx);
			await time.increase(CUSTODY_DELAY + 1n);

			const polBefore = await pol.balanceOf(maticXAddress);
			const maticBefore = await matic.balanceOf(maticXAddress);

			await (maticX.connect(manager) as MaticX).sweepToCustody(
				custody.address
			);

			expect(await pol.balanceOf(maticXAddress)).to.equal(0);
			expect(await matic.balanceOf(maticXAddress)).to.equal(0);
			expect(await maticX.recalledPolBalance()).to.equal(0);
			expect(await pol.balanceOf(custody.address)).to.equal(polBefore);
			expect(await matic.balanceOf(custody.address)).to.equal(
				maticBefore
			);
		});

		it("succeeds at the exact sweepToCustodyTimestamp boundary (< vs <= check)", async function () {
			// Contract uses `block.timestamp < sweepToCustodyTimestamp` so
			// at exactly that timestamp the condition is false and sweep
			// must succeed. Guards against off-by-one regressions.
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, custody } = fx;
			await pauseRecallAndFinalize(fx);

			const sweepTs = await maticX.sweepToCustodyTimestamp();
			await time.increaseTo(sweepTs);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.emit(maticX, "SweptToCustody");
		});

		it("sweeps non-zero MATIC dust to custody", async function () {
			// The fixture's MATIC balance on the proxy is 0; production may
			// accumulate legacy MATIC dust from auto-claim rewards before
			// the sunset commit point. Force a non-zero MATIC balance via
			// the MATIC token's storage and confirm sweep moves it.
			const fx = await loadFixture(deployFixture);
			const { maticX, maticXAddress, manager, matic, custody } = fx;
			await pauseRecallAndFinalize(fx);
			await time.increase(CUSTODY_DELAY + 1n);

			const maticAddr = await matic.getAddress();
			const dust = ethers.parseUnits("123", 18);
			const balancesSlot = await findMappingSlot(
				maticAddr,
				maticXAddress,
				async () => matic.balanceOf(maticXAddress),
				123456789n
			);
			await writeMappingValue(
				maticAddr,
				balancesSlot,
				maticXAddress,
				dust
			);
			expect(await matic.balanceOf(maticXAddress)).to.equal(dust);

			const maticBeforeCustody = await matic.balanceOf(custody.address);
			await (maticX.connect(manager) as MaticX).sweepToCustody(
				custody.address
			);
			expect(await matic.balanceOf(maticXAddress)).to.equal(0n);
			expect(await matic.balanceOf(custody.address)).to.equal(
				maticBeforeCustody + dust
			);
		});
	});

	describe("Access control", function () {
		it("non-admin cannot call any sunset admin function", async function () {
			const { maticX, attacker, custody } =
				await loadFixture(deployFixture);
			await expect(
				(maticX.connect(attacker) as MaticX).bulkUnstakeAllValidators()
			).to.be.reverted;
			await expect(
				(maticX.connect(attacker) as MaticX).claimAssetRecallNonces()
			).to.be.reverted;
			await expect(
				(maticX.connect(attacker) as MaticX).finalizeTerminalRate()
			).to.be.reverted;
			await expect(
				(maticX.connect(attacker) as MaticX).pushTerminalRateToL2()
			).to.be.reverted;
			await expect(
				(maticX.connect(attacker) as MaticX).setInstantRedeemEnabled(
					true
				)
			).to.be.reverted;
			await expect(
				(maticX.connect(attacker) as MaticX).sweepToCustody(
					custody.address
				)
			).to.be.reverted;
		});
	});

	describe("Pre-sunset claimWithdrawal during sunset", function () {
		it("user with a matured withdrawal request can still claim after pause and freeze", async function () {
			const fx = await loadFixture(deployFixture);
			const {
				maticX,
				manager,
				pol,
				stakerA,
				stakeManager,
				stakeManagerGovernance,
			} = fx;

			// stakerA requests withdrawal pre-sunset
			await (maticX.connect(stakerA) as MaticX).requestWithdraw(
				stakeAmount / 2n
			);
			const requests = await maticX.getUserWithdrawalRequests(
				stakerA.address
			);
			const { requestEpoch } = requests[0];

			// Sunset proceeds
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			// Advance epoch past user's request delay
			const withdrawalDelay = await stakeManager.withdrawalDelay();
			await stakeManager
				.connect(stakeManagerGovernance)
				.setCurrentEpoch(BigInt(requestEpoch) + withdrawalDelay + 1n);

			await (maticX.connect(manager) as MaticX).claimAssetRecallNonces();
			await (maticX.connect(manager) as MaticX).finalizeTerminalRate();

			// Snapshot recalledPolBalance BEFORE user claim
			const recalledBefore = await maticX.recalledPolBalance();
			const polBeforeUser = await pol.balanceOf(stakerA.address);

			// User claims their pre-sunset request — must succeed while paused
			await (maticX.connect(stakerA) as MaticX).claimWithdrawal(0);

			// User received POL; recalledPolBalance is unaffected (independent pool)
			expect(await pol.balanceOf(stakerA.address)).to.be.gt(
				polBeforeUser
			);
			expect(await maticX.recalledPolBalance()).to.equal(recalledBefore);
		});
	});

	describe("togglePause one-way after recall", function () {
		it("reverts unpause with UnpauseLockedAfterRecall once recallInitiated", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			expect(await maticX.paused()).to.equal(true);
			expect(await maticX.recallInitiated()).to.equal(true);
			await expect(
				(maticX.connect(manager) as MaticX).togglePause()
			).to.be.revertedWithCustomError(maticX, "UnpauseLockedAfterRecall");
		});
	});

	describe("Oracle freeze during recall", function () {
		it("serves preFinalizeRate between bulkUnstake and finalize", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			const snap = await maticX.preFinalizeRate();
			expect(snap).to.be.gt(0n);

			// Read oracle while in recall window — must serve preFinalizeRate,
			// not the legacy live rate (which would drift to 0 as stake leaves).
			const [polOut] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(polOut).to.equal(snap);
		});
	});

	describe("Recall-gated setters", function () {
		it("setValidatorRegistry reverts with RecallAlreadyInitiated post-bulkUnstake", async function () {
			const { maticX, manager, validatorRegistry } =
				await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await expect(
				(maticX.connect(manager) as MaticX).setValidatorRegistry(
					await validatorRegistry.getAddress()
				)
			).to.be.revertedWithCustomError(maticX, "RecallAlreadyInitiated");
		});

		it("setFxStateRootTunnel reverts with RecallAlreadyInitiated post-bulkUnstake", async function () {
			const { maticX, manager, fxStateRootTunnel } =
				await loadFixture(deployFixture);
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await expect(
				(maticX.connect(manager) as MaticX).setFxStateRootTunnel(
					await fxStateRootTunnel.getAddress()
				)
			).to.be.revertedWithCustomError(maticX, "RecallAlreadyInitiated");
		});
	});

	describe("Oracle three-tier behavior", function () {
		it("pre-recall: serves the live computed rate from validator stakes", async function () {
			const { maticX } = await loadFixture(deployFixture);
			// Before any recall flag flips, the read path goes through
			// totalSupply() / getTotalStakeAcrossAllValidators().
			const supply = await maticX.totalSupply();
			const [polFor1e18, returnedSupply, returnedPooled] =
				await maticX.convertMaticXToPOL(TERMINAL_RATE_PRECISION);
			// The 2nd/3rd return values mirror the legacy computation
			// (totalShares / totalPooled), not TERMINAL_RATE_PRECISION.
			expect(returnedSupply).to.equal(supply);
			expect(returnedPooled).to.be.gt(0n);
			expect(polFor1e18).to.be.gt(0n);
		});

		it("during recall: preFinalizeRate matches the pre-recall live rate exactly", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);

			// Capture the live rate one block before bulkUnstake, then
			// confirm the snapshot equals it.
			const [liveRateBefore] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);

			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			const snap = await maticX.preFinalizeRate();
			expect(snap).to.equal(liveRateBefore);
		});

		it("post-finalize: serves the locked terminalRate (3rd tier)", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX } = fx;
			await pauseRecallAndFinalize(fx);

			const terminal = await maticX.terminalRate();
			expect(terminal).to.be.gt(0n);

			const [polFor1e18, retPrecision, retRate] =
				await maticX.convertMaticXToPOL(TERMINAL_RATE_PRECISION);
			// Post-finalize the return signature returns
			// (balanceInPOL, TERMINAL_RATE_PRECISION, terminalRate).
			expect(retPrecision).to.equal(TERMINAL_RATE_PRECISION);
			expect(retRate).to.equal(terminal);
			expect(polFor1e18).to.equal(terminal);
		});

		it("convertPOLToMaticX mirrors the 3-tier oracle (during recall + post-finalize)", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);

			// Pre-recall — live path, non-zero result.
			const [livePre] = await maticX.convertPOLToMaticX(
				TERMINAL_RATE_PRECISION
			);
			expect(livePre).to.be.gt(0n);

			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			// During recall — must be the inverse of preFinalizeRate.
			const snap = await maticX.preFinalizeRate();
			const [maticXOutDuringRecall, , rateDuringRecall] =
				await maticX.convertPOLToMaticX(TERMINAL_RATE_PRECISION);
			expect(rateDuringRecall).to.equal(snap);
			expect(maticXOutDuringRecall).to.equal(
				(TERMINAL_RATE_PRECISION * TERMINAL_RATE_PRECISION) / snap
			);
		});

		it("POL donations during recall do NOT move the oracle (manipulation immunity)", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, pol, stakerA } = fx;

			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			const snapBefore = await maticX.preFinalizeRate();
			const [oracleBefore] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(oracleBefore).to.equal(snapBefore);

			// Donor sends POL straight to the proxy. Under the legacy live
			// computation this would have inflated the rate. The snapshot
			// path must ignore the donation.
			//
			// stakerA was funded with stakeAmount*3 in the fixture and has
			// stakeAmount*2 left after submitPOL. Donate stakeAmount (100 POL).
			const donation = stakeAmount;
			expect(await pol.balanceOf(stakerA.address)).to.be.gte(donation);
			await pol
				.connect(stakerA)
				.transfer(await maticX.getAddress(), donation);

			const [oracleAfter] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(oracleAfter).to.equal(oracleBefore);
			expect(await maticX.preFinalizeRate()).to.equal(snapBefore);
		});

		it("POL donations post-finalize do NOT move the oracle either", async function () {
			const fx = await loadFixture(deployFixture);
			const { maticX, pol, stakerA } = fx;
			await pauseRecallAndFinalize(fx);

			const terminalBefore = await maticX.terminalRate();
			const [oracleBefore] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(oracleBefore).to.equal(terminalBefore);

			const donation = stakeAmount;
			expect(await pol.balanceOf(stakerA.address)).to.be.gte(donation);
			await pol
				.connect(stakerA)
				.transfer(await maticX.getAddress(), donation);

			const [oracleAfter] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(oracleAfter).to.equal(oracleBefore);
			expect(await maticX.terminalRate()).to.equal(terminalBefore);
		});

		it("during-recall sentinel: rate==1 when preFinalizeRate is 0", async function () {
			// Force preFinalizeRate == 0 via storage manipulation post-bulkUnstake.
			// Oracle must return rate = 1 (sentinel for "rate not snapshotable yet")
			// instead of dividing by zero.
			const fx = await loadFixture(deployFixture);
			const { maticX, maticXAddress, manager } = fx;
			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();

			const before = await maticX.preFinalizeRate();
			expect(before).to.be.gt(0n);
			const slot = await findScalarStorageSlot(
				maticXAddress,
				before,
				() => maticX.preFinalizeRate(),
				123456789n
			);
			await setStorageAt(maticXAddress, slot, 0n);
			expect(await maticX.preFinalizeRate()).to.equal(0n);

			const [, retPrecision, retRate] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(retPrecision).to.equal(TERMINAL_RATE_PRECISION);
			expect(retRate).to.equal(1n);
		});

		it("post-finalize sentinel: rate==1 when terminalRate is 0", async function () {
			// Defensive: if terminalRate were somehow 0 post-finalize, oracle
			// must still return a safe `rate = 1` instead of dividing by zero.
			const fx = await loadFixture(deployFixture);
			const { maticX, maticXAddress } = fx;
			await pauseRecallAndFinalize(fx);

			const before = await maticX.terminalRate();
			expect(before).to.be.gt(0n);
			const slot = await findScalarStorageSlot(
				maticXAddress,
				before,
				() => maticX.terminalRate(),
				123456789n
			);
			await setStorageAt(maticXAddress, slot, 0n);
			expect(await maticX.terminalRate()).to.equal(0n);

			const [, retPrecision, retRate] = await maticX.convertMaticXToPOL(
				TERMINAL_RATE_PRECISION
			);
			expect(retPrecision).to.equal(TERMINAL_RATE_PRECISION);
			expect(retRate).to.equal(1n);
		});
	});

	describe("setCustodyDelay (sweep window setter)", function () {
		it("updates sweepToCustodyTimestamp = block.timestamp + _custodyDelay and emits the absolute value", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			const newDelay = 7n * 24n * 60n * 60n; // 7 days
			const tx = await (
				maticX.connect(manager) as MaticX
			).setCustodyDelay(newDelay);
			const block = await ethers.provider.getBlock(tx.blockNumber!);
			const expectedTs = BigInt(block!.timestamp) + newDelay;
			await expect(tx)
				.to.emit(maticX, "SetCustodyDelay")
				.withArgs(expectedTs);
			expect(await maticX.sweepToCustodyTimestamp()).to.equal(
				expectedTs
			);
		});

		it("reverts with ZeroAmount on zero delay", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(manager) as MaticX).setCustodyDelay(0)
			).to.be.revertedWithCustomError(maticX, "ZeroAmount");
		});

		it("reverts for non-admin", async function () {
			const { maticX, attacker } = await loadFixture(deployFixture);
			await expect(
				(maticX.connect(attacker) as MaticX).setCustodyDelay(1n)
			).to.be.reverted;
		});

		it("finalizeTerminalRate reverts when sweepToCustodyTimestamp is in the past (footgun guard)", async function () {
			// Force sweepToCustodyTimestamp to 0 via storage manipulation so
			// we don't have to rebuild the fixture. Models the production
			// footgun: admin upgrades but forgets to set a delay before
			// finalizing, OR a previously-set delay has already elapsed by
			// the time finalize runs.
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, stakeManager, stakeManagerGovernance } =
				fx;

			const slot = await findScalarStorageSlot(
				await maticX.getAddress(),
				await maticX.sweepToCustodyTimestamp(),
				() => maticX.sweepToCustodyTimestamp(),
				123456789n
			);
			await setStorageAt(await maticX.getAddress(), slot, 0n);
			expect(await maticX.sweepToCustodyTimestamp()).to.equal(0n);

			await (maticX.connect(manager) as MaticX).togglePause();
			await (
				maticX.connect(manager) as MaticX
			).bulkUnstakeAllValidators();
			await advanceUnbond(stakeManager, stakeManagerGovernance);
			await (
				maticX.connect(manager) as MaticX
			).claimAssetRecallNonces();
			await expect(
				(maticX.connect(manager) as MaticX).finalizeTerminalRate()
			).to.be.revertedWith("Sweep timestamp not in future");
		});

		it("sweepToCustody respects an admin-shortened delay (post-finalize reconfig)", async function () {
			// Admin shrinks the delay post-finalize. setCustodyDelay
			// recomputes sweepToCustodyTimestamp = now + shortDelay, so the
			// new anchor is the moment of the reconfiguration. Sweep must
			// wait the full shortDelay from that moment.
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, custody } = fx;
			await pauseRecallAndFinalize(fx);

			const shortDelay = 60n * 60n; // 1 hour
			await (maticX.connect(manager) as MaticX).setCustodyDelay(
				shortDelay
			);
			const sweepTs = await maticX.sweepToCustodyTimestamp();

			// Below the new boundary -> revert.
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.be.revertedWithCustomError(maticX, "CustodyDelayNotElapsed");

			// At/after the new boundary -> success.
			await time.increaseTo(sweepTs);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.emit(maticX, "SweptToCustody");
		});

		it("sweepToCustody respects an admin-extended delay (reconfig restarts the clock)", async function () {
			// Admin extends delay AFTER the original 3-year window passes.
			// Because setCustodyDelay computes `now + delay`, the new
			// sweepToCustodyTimestamp is anchored to the reconfig moment
			// — sweep must wait the full extendedDelay from that point.
			const fx = await loadFixture(deployFixture);
			const { maticX, manager, custody } = fx;
			await pauseRecallAndFinalize(fx);

			const originalSweepTs =
				await maticX.sweepToCustodyTimestamp();
			// Advance past the original 3-year window so the old gate would
			// have opened.
			await time.increaseTo(originalSweepTs + 100n);

			const extendedDelay = 5n * 365n * 24n * 60n * 60n;
			await (maticX.connect(manager) as MaticX).setCustodyDelay(
				extendedDelay
			);

			// New anchor: now + 5y; sweep should revert until that point.
			const newSweepTs = await maticX.sweepToCustodyTimestamp();
			expect(newSweepTs).to.be.gt(originalSweepTs);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.be.revertedWithCustomError(maticX, "CustodyDelayNotElapsed");

			// Advance to the new boundary exactly -> succeeds.
			await time.increaseTo(newSweepTs);
			await expect(
				(maticX.connect(manager) as MaticX).sweepToCustody(
					custody.address
				)
			).to.emit(maticX, "SweptToCustody");
		});
	});
});
