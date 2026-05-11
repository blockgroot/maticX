import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
	loadFixture,
	reset,
	setBalance,
} from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
	FxStateChildTunnel,
	FxStateRootTunnel,
	IERC20,
	IFxStateRootTunnel,
	IStakeManager,
	IValidatorShare,
	MaticX,
	ValidatorRegistry,
} from "../typechain-types";
import { extractEnvironmentVariables } from "../utils/environment";
import { getProviderUrl, Network } from "../utils/network";

const envVars = extractEnvironmentVariables();
const providerUrl = getProviderUrl(
	Network.Ethereum,
	envVars.RPC_PROVIDER,
	envVars.ETHEREUM_API_KEY
);

const POL_PRECISION = 10n ** 18n;
const FROZEN_RATE_PRECISION = 10n ** 18n;

/**
 * Drain-and-hold sunset flow.
 * Tests fresh MaticX/ValidatorRegistry deployments against the real Polygon
 * StakeManager + validator shares on a mainnet fork. The fresh proxies let the
 * test control the entire lifecycle (stake → bulk-unstake → drain → freeze
 * → balance-mode redemption) without touching the live ~106M MaticX state.
 *
 * For the upgrade-the-real-proxies scenario see MaticXSunsetFork.ts.
 */
describe("MaticX Sunset", function () {
	const stakeAmount = ethers.parseUnits("100", 18);
	const tripleStakeAmount = stakeAmount * 3n;

	async function deployFixture() {
		await reset(providerUrl, envVars.FORKING_BLOCK_NUMBER);

		const manager = await impersonateAccount(
			"0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67"
		);
		const polygonTreasury = await impersonateAccount(
			"0xcD6507d87F605F5E95C12F7c4B1fC3279dc944aB"
		);
		const stakeManagerGovernance = await impersonateAccount(
			"0x6e7a5820baD6cebA8Ef5ea69c0C92EbbDAc9CE48"
		);

		const [executor, bot, treasury, stakerA, stakerB] =
			await ethers.getSigners();
		const stakers = [stakerA, stakerB];

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

		const stakeManagerAddress = await stakeManager.getAddress();
		const maticAddress = await matic.getAddress();
		const polAddress = await pol.getAddress();

		// Fresh proxies — isolated from the live MaticX state.
		const ValidatorRegistryFactory = await ethers.getContractFactory(
			"ValidatorRegistry"
		);
		const validatorRegistry = (await upgrades.deployProxy(
			ValidatorRegistryFactory,
			[stakeManagerAddress, maticAddress, ethers.ZeroAddress, manager.address]
		)) as unknown as ValidatorRegistry;
		const validatorRegistryAddress = await validatorRegistry.getAddress();

		const MaticXFactory = await ethers.getContractFactory("MaticX");
		const maticX = (await upgrades.deployProxy(MaticXFactory, [
			validatorRegistryAddress,
			stakeManagerAddress,
			maticAddress,
			manager.address,
			treasury.address,
		])) as unknown as MaticX;
		const maticXAddress = await maticX.getAddress();

		// Link maticX back-reference, initialize V2 for POL approvals.
		await validatorRegistry.connect(manager).setMaticX(maticXAddress);
		await validatorRegistry.connect(manager).initializeV2(polAddress);
		await validatorRegistry
			.connect(manager)
			.grantRole(await validatorRegistry.BOT(), manager.address);
		await maticX.connect(manager).initializeV2(polAddress);

		// Wire FxStateRootTunnel via a deployed mock target — the live tunnel
		// expects a specific MaticX. We deploy a thin mock that only
		// implements sendMessageToChild so we can assert the final L2 push.
		const FxRootMock = await ethers.getContractFactory("FxRootMock");
		const fxRootMock = await FxRootMock.deploy();
		const FxStateChildTunnel = await ethers.getContractFactory(
			"FxStateChildTunnel"
		);
		const fxStateChildTunnel = (await FxStateChildTunnel.deploy(
			await fxRootMock.getAddress()
		)) as unknown as FxStateChildTunnel;
		const FxStateRootTunnel = await ethers.getContractFactory(
			"FxStateRootTunnel"
		);
		// FxStateRootTunnel(checkpointManager, fxRoot, maticX) — only outbound
		// L1→L2 messages are tested here, so checkpointManager can be the
		// zero address.
		const fxStateRootTunnel = (await FxStateRootTunnel.deploy(
			ethers.ZeroAddress,
			await fxRootMock.getAddress(),
			maticXAddress
		)) as unknown as FxStateRootTunnel;
		await maticX
			.connect(manager)
			.setFxStateRootTunnel(await fxStateRootTunnel.getAddress());
		await fxStateRootTunnel.setFxChildTunnel(
			await fxStateChildTunnel.getAddress()
		);
		await fxStateChildTunnel.setFxRootTunnel(
			await fxStateRootTunnel.getAddress()
		);

		// Register a small set of real-mainnet validators on our fresh
		// registry so we can exercise validator share contracts in the fork.
		const validatorIds = [110n, 79n];
		for (const id of validatorIds) {
			await validatorRegistry.connect(manager).addValidator(id);
		}
		await validatorRegistry
			.connect(manager)
			.setPreferredDepositValidatorId(validatorIds[0]);
		await validatorRegistry
			.connect(manager)
			.setPreferredWithdrawalValidatorId(validatorIds[1]);

		// Fund stakers with POL.
		for (const staker of stakers) {
			await pol
				.connect(polygonTreasury)
				.transfer(staker.address, tripleStakeAmount);
		}

		// Each staker submits POL on the fresh MaticX so the protocol has
		// real active stake on validator 110 (the deposit-preferred id).
		for (const staker of stakers) {
			await pol
				.connect(staker)
				.approve(maticXAddress, ethers.MaxUint256);
			await maticX.connect(staker).submitPOL(stakeAmount);
		}

		return {
			maticX,
			maticXAddress,
			validatorRegistry,
			validatorRegistryAddress,
			stakeManager,
			stakeManagerAddress,
			pol,
			polAddress,
			fxStateRootTunnel,
			manager,
			bot,
			treasury,
			stakers,
			stakerA,
			stakerB,
			stakeManagerGovernance,
			validatorIds,
		};
	}

	async function impersonateAccount(
		address: string
	): Promise<SignerWithAddress> {
		setBalance(address, ethers.parseEther("10000"));
		return await ethers.getImpersonatedSigner(address);
	}

	async function advancePastWithdrawalDelay(
		stakeManager: IStakeManager,
		stakeManagerGovernance: SignerWithAddress
	) {
		const epoch = await stakeManager.epoch();
		const delay = await stakeManager.withdrawalDelay();
		await stakeManager
			.connect(stakeManagerGovernance)
			.setCurrentEpoch(epoch + delay + 1n);
	}

	async function getValidatorShare(
		stakeManager: IStakeManager,
		validatorId: bigint
	): Promise<IValidatorShare> {
		const addr = await stakeManager.getValidatorContract(validatorId);
		return (await ethers.getContractAt(
			"IValidatorShare",
			addr
		)) as IValidatorShare;
	}

	// -------------------------- pauseDeposits ------------------------------

	describe("pauseDeposits / unpauseDeposits", function () {
		it("Reverts for non-admin", async function () {
			const { maticX, stakerA } = await loadFixture(deployFixture);
			await expect(
				maticX.connect(stakerA).pauseDeposits()
			).to.be.revertedWith(/AccessControl: account/);
		});

		it("Sets the flag and blocks new submits", async function () {
			const { maticX, manager, pol, stakerA, maticXAddress } =
				await loadFixture(deployFixture);
			await expect(maticX.connect(manager).pauseDeposits()).to.emit(
				maticX,
				"DepositsPaused"
			);
			expect(await maticX.depositsPaused()).to.equal(true);

			await pol.connect(stakerA).approve(maticXAddress, stakeAmount);
			await expect(
				maticX.connect(stakerA).submitPOL(stakeAmount)
			).to.be.revertedWithCustomError(maticX, "DepositsPausedError");
			await expect(
				maticX.connect(stakerA).submit(stakeAmount)
			).to.be.revertedWithCustomError(maticX, "DepositsPausedError");
		});

		it("Reverts on double-pause", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await maticX.connect(manager).pauseDeposits();
			await expect(
				maticX.connect(manager).pauseDeposits()
			).to.be.revertedWithCustomError(maticX, "DepositsAlreadyPaused");
		});

		it("Unpause restores deposits", async function () {
			const { maticX, manager, pol, stakerA, maticXAddress } =
				await loadFixture(deployFixture);
			await maticX.connect(manager).pauseDeposits();
			await expect(maticX.connect(manager).unpauseDeposits()).to.emit(
				maticX,
				"DepositsUnpaused"
			);
			expect(await maticX.depositsPaused()).to.equal(false);

			await pol.connect(stakerA).approve(maticXAddress, stakeAmount);
			await expect(maticX.connect(stakerA).submitPOL(stakeAmount)).to
				.not.be.reverted;
		});

		it("Reverts on unpause when not paused", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				maticX.connect(manager).unpauseDeposits()
			).to.be.revertedWithCustomError(
				maticX,
				"DepositsAlreadyUnpaused"
			);
		});
	});

	// ----------------------- legacy claim survival -------------------------

	describe("In-flight legacy unbonds", function () {
		it("Remain claimable after bulk-unstake / drain", async function () {
			const {
				maticX,
				manager,
				stakerA,
				stakeManager,
				stakeManagerGovernance,
				pol,
			} = await loadFixture(deployFixture);

			await maticX.connect(stakerA).requestWithdraw(stakeAmount);
			const requestsBefore = await maticX.getUserWithdrawalRequests(
				stakerA.address
			);
			expect(requestsBefore.length).to.equal(1);

			await maticX.connect(manager).bulkUnstakeAllValidators();

			await advancePastWithdrawalDelay(
				stakeManager,
				stakeManagerGovernance
			);

			const balBefore = await pol.balanceOf(stakerA.address);
			await maticX.connect(stakerA).claimWithdrawal(0n);
			const balAfter = await pol.balanceOf(stakerA.address);
			expect(balAfter - balBefore).to.be.gt(0n);
		});
	});

	// ----------------------- bulkUnstakeAllValidators -----------------------

	describe("bulkUnstakeAllValidators", function () {
		it("Reverts for non-admin", async function () {
			const { maticX, stakerA } = await loadFixture(deployFixture);
			await expect(
				maticX.connect(stakerA).bulkUnstakeAllValidators()
			).to.be.revertedWith(/AccessControl: account/);
		});

		it("Records nonces and drains active stake", async function () {
			const {
				maticX,
				maticXAddress,
				manager,
				stakeManager,
				validatorIds,
			} = await loadFixture(deployFixture);

			const sharesByValidator = await Promise.all(
				validatorIds.map((id) =>
					getValidatorShare(stakeManager, id)
				)
			);
			const activeBefore = await Promise.all(
				sharesByValidator.map((s) => s.getTotalStake(maticXAddress))
			);
			const totalActiveBefore = activeBefore.reduce(
				(acc, [v]) => acc + v,
				0n
			);
			expect(totalActiveBefore).to.be.gt(0n);

			await expect(
				maticX.connect(manager).bulkUnstakeAllValidators()
			).to.emit(maticX, "BulkUnstakeInitiated");

			for (let i = 0; i < validatorIds.length; i++) {
				const id = validatorIds[i];
				const nonce = await maticX.getDrainUnbondNonce(id);
				// validator 79 had no stake (only 110 received deposits) so
				// its nonce stays zero.
				if (activeBefore[i][0] > 0n) {
					expect(nonce).to.be.gt(0n);
				} else {
					expect(nonce).to.equal(0n);
				}
				const [activeAfter] = await sharesByValidator[i].getTotalStake(
					maticXAddress
				);
				expect(activeAfter).to.equal(0n);
			}
		});
	});

	// ------------------- bulkClaimDrainedStake + markDrainComplete ---------

	describe("Phase 3 atomic drain", function () {
		it("Claims POL into drainedPolBalance, then marks complete", async function () {
			const {
				maticX,
				maticXAddress,
				manager,
				pol,
				stakeManager,
				stakeManagerGovernance,
				validatorIds,
			} = await loadFixture(deployFixture);

			await maticX.connect(manager).bulkUnstakeAllValidators();
			await advancePastWithdrawalDelay(
				stakeManager,
				stakeManagerGovernance
			);

			// Only validators with non-zero nonces should be claimed.
			const claimable: bigint[] = [];
			for (const id of validatorIds) {
				const nonce = await maticX.getDrainUnbondNonce(id);
				if (nonce !== 0n) claimable.push(id);
			}
			expect(claimable.length).to.be.gt(0);

			const balBefore = await pol.balanceOf(maticXAddress);
			await maticX.connect(manager).bulkClaimDrainedStake(claimable);
			const balAfter = await pol.balanceOf(maticXAddress);
			const claimed = balAfter - balBefore;
			expect(claimed).to.be.gt(0n);
			expect(await maticX.drainedPolBalance()).to.equal(claimed);

			// Nonces are cleared after claim.
			for (const id of claimable) {
				expect(await maticX.getDrainUnbondNonce(id)).to.equal(0n);
			}

			// Mark drain complete — freezes rate.
			const supply = await maticX.totalSupply();
			const expectedRate =
				(claimed * FROZEN_RATE_PRECISION) / supply;
			await expect(maticX.connect(manager).markDrainComplete())
				.to.emit(maticX, "DrainCompleted")
				.withArgs(claimed, supply, expectedRate);

			expect(await maticX.drainComplete()).to.equal(true);
			expect(await maticX.frozenRate()).to.equal(expectedRate);
		});

		it("markDrainComplete reverts if active stake remains", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await expect(
				maticX.connect(manager).markDrainComplete()
			).to.be.revertedWithCustomError(maticX, "ActiveStakeRemains");
		});

		it("markDrainComplete reverts if no POL claimed", async function () {
			const {
				maticX,
				maticXAddress,
				manager,
				stakeManager,
				stakeManagerGovernance,
				validatorIds,
			} = await loadFixture(deployFixture);

			await maticX.connect(manager).bulkUnstakeAllValidators();
			await advancePastWithdrawalDelay(
				stakeManager,
				stakeManagerGovernance
			);

			// Skip the bulkClaim — drainedPolBalance stays zero, active stake
			// is also zero, so we hit the NoDrainedPOL branch.
			// But getTotalStakeAcrossAllValidators is already zero, so the
			// invariant ordering will surface NoDrainedPOL.
			void maticXAddress;
			void validatorIds;
			await expect(
				maticX.connect(manager).markDrainComplete()
			).to.be.revertedWithCustomError(maticX, "NoDrainedPOL");
		});
	});

	// ------------------- balance-mode requestWithdraw + claim --------------

	describe("Balance-mode redemption", function () {
		async function fullySunsetFixture() {
			const ctx = await deployFixture();
			await ctx.maticX.connect(ctx.manager).bulkUnstakeAllValidators();
			await advancePastWithdrawalDelay(
				ctx.stakeManager,
				ctx.stakeManagerGovernance
			);
			const claimable: bigint[] = [];
			for (const id of ctx.validatorIds) {
				const nonce = await ctx.maticX.getDrainUnbondNonce(id);
				if (nonce !== 0n) claimable.push(id);
			}
			await ctx.maticX
				.connect(ctx.manager)
				.bulkClaimDrainedStake(claimable);
			await ctx.maticX.connect(ctx.manager).markDrainComplete();
			return ctx;
		}

		it("Burns MaticX, decrements drainedPolBalance, queues claim", async function () {
			const { maticX, stakerA, pol } = await loadFixture(
				fullySunsetFixture
			);

			const supplyBefore = await maticX.totalSupply();
			const drainedBefore = await maticX.drainedPolBalance();
			const rate = await maticX.frozenRate();
			const burnAmount = stakeAmount;
			const expectedPol = (burnAmount * rate) / FROZEN_RATE_PRECISION;

			await expect(maticX.connect(stakerA).requestWithdraw(burnAmount))
				.to.emit(maticX, "RequestBalanceWithdrawal")
				.and.to.emit(maticX, "Transfer")
				.withArgs(stakerA.address, ethers.ZeroAddress, burnAmount);

			expect(await maticX.totalSupply()).to.equal(
				supplyBefore - burnAmount
			);
			expect(await maticX.drainedPolBalance()).to.equal(
				drainedBefore - expectedPol
			);

			const requests = await maticX.getBalanceWithdrawalRequests(
				stakerA.address
			);
			expect(requests.length).to.equal(1);
			expect(requests[0].amountInPol).to.equal(expectedPol);
			void pol;
		});

		it("Frozen-rate invariant: drainedPolBalance / totalSupply stays constant", async function () {
			const { maticX, stakerA, stakerB } = await loadFixture(
				fullySunsetFixture
			);

			const rate = await maticX.frozenRate();
			for (const staker of [stakerA, stakerB, stakerA, stakerB]) {
				await maticX
					.connect(staker)
					.requestWithdraw(stakeAmount / 4n);
				const drained = await maticX.drainedPolBalance();
				const supply = await maticX.totalSupply();
				expect((drained * FROZEN_RATE_PRECISION) / supply).to.equal(
					rate
				);
			}
		});

		it("claimBalanceWithdrawal pays POL and pops request", async function () {
			const { maticX, maticXAddress, stakerA, manager, pol } =
				await loadFixture(fullySunsetFixture);

			await maticX.connect(stakerA).requestWithdraw(stakeAmount);
			const requests = await maticX.getBalanceWithdrawalRequests(
				stakerA.address
			);
			const owedPol = requests[0].amountInPol;

			// Default delay is 0 — instant claim.
			const balBefore = await pol.balanceOf(stakerA.address);
			await expect(maticX.connect(stakerA).claimBalanceWithdrawal(0n))
				.to.emit(maticX, "ClaimBalanceWithdrawal")
				.withArgs(stakerA.address, 0n, owedPol);
			const balAfter = await pol.balanceOf(stakerA.address);
			expect(balAfter - balBefore).to.equal(owedPol);

			const after = await maticX.getBalanceWithdrawalRequests(
				stakerA.address
			);
			expect(after.length).to.equal(0);

			void maticXAddress;
			void manager;
		});

		it("Respects the configured redeem delay", async function () {
			const { maticX, manager, stakerA } = await loadFixture(
				fullySunsetFixture
			);
			await maticX
				.connect(manager)
				.setBalanceModeRedeemDelay(60 * 60);

			await maticX.connect(stakerA).requestWithdraw(stakeAmount);
			await expect(
				maticX.connect(stakerA).claimBalanceWithdrawal(0n)
			).to.be.revertedWithCustomError(maticX, "RequestNotUnlocked");
		});

		it("View functions return frozen state post-drain", async function () {
			const { maticX } = await loadFixture(fullySunsetFixture);
			const drained = await maticX.drainedPolBalance();
			expect(await maticX.getTotalPooledMatic()).to.equal(drained);

			const oneMaticX = ethers.parseUnits("1", 18);
			const [polValue] = await maticX.convertMaticXToPOL(oneMaticX);
			const rate = await maticX.frozenRate();
			expect(polValue).to.equal(rate);
		});
	});

	// ------------------ reward functions blocked post-drain ----------------

	describe("Reward functions post-drain", function () {
		it("withdrawRewards / withdrawValidatorsReward / stakeRewards revert", async function () {
			const {
				maticX,
				manager,
				bot,
				stakeManager,
				stakeManagerGovernance,
				validatorIds,
			} = await loadFixture(deployFixture);

			await maticX.connect(manager).bulkUnstakeAllValidators();
			await advancePastWithdrawalDelay(
				stakeManager,
				stakeManagerGovernance
			);
			const claimable: bigint[] = [];
			for (const id of validatorIds) {
				const nonce = await maticX.getDrainUnbondNonce(id);
				if (nonce !== 0n) claimable.push(id);
			}
			await maticX
				.connect(manager)
				.bulkClaimDrainedStake(claimable);
			await maticX.connect(manager).markDrainComplete();

			const botRole = await maticX.BOT();
			await maticX.connect(manager).grantRole(botRole, bot.address);

			await expect(
				maticX.connect(bot).withdrawRewards(validatorIds[0])
			).to.be.revertedWithCustomError(maticX, "DrainAlreadyComplete");
			await expect(
				maticX.connect(bot).withdrawValidatorsReward([validatorIds[0]])
			).to.be.revertedWithCustomError(maticX, "DrainAlreadyComplete");
			await expect(
				maticX
					.connect(bot)
					.stakeRewardsAndDistributeFees(validatorIds[0])
			).to.be.revertedWithCustomError(maticX, "DrainAlreadyComplete");
			await expect(
				maticX
					.connect(manager)
					.migrateDelegation(
						validatorIds[0],
						validatorIds[1],
						stakeAmount
					)
			).to.be.revertedWithCustomError(maticX, "DrainAlreadyComplete");
		});
	});

	// --------------------- ValidatorRegistry cleanup -----------------------

	describe("ValidatorRegistry post-drain cleanup", function () {
		it("clearPreferredValidators reverts pre-drain", async function () {
			const { validatorRegistry, manager } = await loadFixture(
				deployFixture
			);
			await expect(
				validatorRegistry.connect(manager).clearPreferredValidators()
			).to.be.revertedWith("Drain not complete");
		});

		it("Allows removing all validators after clearPreferredValidators", async function () {
			const {
				maticX,
				manager,
				validatorRegistry,
				stakeManager,
				stakeManagerGovernance,
				validatorIds,
			} = await loadFixture(deployFixture);

			await maticX.connect(manager).bulkUnstakeAllValidators();
			await advancePastWithdrawalDelay(
				stakeManager,
				stakeManagerGovernance
			);
			const claimable: bigint[] = [];
			for (const id of validatorIds) {
				const nonce = await maticX.getDrainUnbondNonce(id);
				if (nonce !== 0n) claimable.push(id);
			}
			await maticX
				.connect(manager)
				.bulkClaimDrainedStake(claimable);
			await maticX.connect(manager).markDrainComplete();

			// Pre-clear: removeValidator on the preferred id reverts.
			const preferredDeposit =
				await validatorRegistry.preferredDepositValidatorId();
			await expect(
				validatorRegistry
					.connect(manager)
					.removeValidator(preferredDeposit, true)
			).to.be.revertedWith(
				"Can't remove a preferred validator for deposits"
			);

			await expect(
				validatorRegistry.connect(manager).clearPreferredValidators()
			).to.emit(validatorRegistry, "ClearPreferredValidators");
			expect(
				await validatorRegistry.preferredDepositValidatorId()
			).to.equal(0n);
			expect(
				await validatorRegistry.preferredWithdrawalValidatorId()
			).to.equal(0n);

			for (const id of validatorIds) {
				await validatorRegistry
					.connect(manager)
					.removeValidator(id, true);
			}
			expect((await validatorRegistry.getValidators()).length).to.equal(
				0
			);
		});
	});

	// ---------------- access control / setter validation -------------------

	describe("Setters", function () {
		it("setBalanceModeRedeemDelay enforces max 7 days", async function () {
			const { maticX, manager } = await loadFixture(deployFixture);
			await maticX
				.connect(manager)
				.setBalanceModeRedeemDelay(7 * 24 * 3600);
			await expect(
				maticX
					.connect(manager)
					.setBalanceModeRedeemDelay(7 * 24 * 3600 + 1)
			).to.be.revertedWithCustomError(maticX, "DelayTooLong");
		});
	});
});
