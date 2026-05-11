import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
	reset,
	setBalance,
} from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
	IERC20,
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

// Mainnet addresses captured in the sunset plan.
const ADDR = {
	maticXProxy: "0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645",
	validatorRegistryProxy: "0xf556442D5B77A4B0252630E15d8BbE2160870d77",
	proxyAdmin: "0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A",
	timelock: "0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be",
	l1Multisig: "0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67",
	stakeManager: "0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908",
	stakeManagerGovernance: "0x6e7a5820baD6cebA8Ef5ea69c0C92EbbDAc9CE48",
	pol: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6",
	fxStateRootTunnel: "0x40FB804Cc07302b89EC16a9f8d040506f64dFe29",
};

const FROZEN_RATE_PRECISION = 10n ** 18n;

/**
 * End-to-end fork test against the LIVE mainnet MaticX deployment.
 * Impersonates the Timelock to upgrade both proxies, then drives the sunset
 * sequence on real state (~106M MaticX supply, real validator stake). The
 * Timelock 24h delay is skipped — that mechanic is tested elsewhere — we're
 * verifying contract behavior under upgrade.
 */
describe("MaticX Sunset — mainnet fork upgrade", function () {
	this.timeout(180_000);

	let timelock: SignerWithAddress;
	let multisig: SignerWithAddress;
	let stakeManagerGovernance: SignerWithAddress;
	let maticX: MaticX;
	let validatorRegistry: ValidatorRegistry;
	let stakeManager: IStakeManager;
	let pol: IERC20;
	let validatorIds: bigint[];

	let preUpgradeSnapshot: {
		treasury: string;
		version: string;
		feePercent: bigint;
		totalSupply: bigint;
		preferredDeposit: bigint;
		preferredWithdrawal: bigint;
		validatorList: bigint[];
		polBalance: bigint;
	};

	async function impersonate(addr: string): Promise<SignerWithAddress> {
		await setBalance(addr, ethers.parseEther("100"));
		return await ethers.getImpersonatedSigner(addr);
	}

	before(async function () {
		await reset(providerUrl, envVars.FORKING_BLOCK_NUMBER);

		timelock = await impersonate(ADDR.timelock);
		multisig = await impersonate(ADDR.l1Multisig);
		stakeManagerGovernance = await impersonate(ADDR.stakeManagerGovernance);

		stakeManager = (await ethers.getContractAt(
			"IStakeManager",
			ADDR.stakeManager
		)) as IStakeManager;
		pol = (await ethers.getContractAt("IERC20", ADDR.pol)) as IERC20;

		maticX = (await ethers.getContractAt(
			"MaticX",
			ADDR.maticXProxy
		)) as unknown as MaticX;
		validatorRegistry = (await ethers.getContractAt(
			"ValidatorRegistry",
			ADDR.validatorRegistryProxy
		)) as unknown as ValidatorRegistry;

		// Snapshot key public state before the upgrade. We re-read these
		// post-upgrade to confirm storage layout is preserved.
		preUpgradeSnapshot = {
			treasury: await maticX.treasury(),
			version: await maticX.version(),
			feePercent: await maticX.feePercent(),
			totalSupply: await maticX.totalSupply(),
			preferredDeposit:
				await validatorRegistry.preferredDepositValidatorId(),
			preferredWithdrawal:
				await validatorRegistry.preferredWithdrawalValidatorId(),
			validatorList: [...(await validatorRegistry.getValidators())],
			polBalance: await pol.balanceOf(ADDR.maticXProxy),
		};
		validatorIds = preUpgradeSnapshot.validatorList;

		// Deploy new implementations and upgrade both proxies via the
		// ProxyAdmin owner (the Timelock).
		const MaticXFactory = await ethers.getContractFactory("MaticX");
		const ValidatorRegistryFactory = await ethers.getContractFactory(
			"ValidatorRegistry"
		);

		// These are live proxies, so register them in the local fork manifest
		// before asking OZ to compare storage layouts.
		await upgrades.forceImport(ADDR.maticXProxy, MaticXFactory, {
			kind: "transparent",
		});
		await upgrades.forceImport(
			ADDR.validatorRegistryProxy,
			ValidatorRegistryFactory,
			{ kind: "transparent" }
		);

		// OZ validateUpgrade catches incompatible storage layout changes.
		await upgrades.validateUpgrade(ADDR.maticXProxy, MaticXFactory, {
			kind: "transparent",
		});
		await upgrades.validateUpgrade(
			ADDR.validatorRegistryProxy,
			ValidatorRegistryFactory,
			{ kind: "transparent" }
		);

		const newMaticXImpl = await MaticXFactory.deploy();
		const newVRImpl = await ValidatorRegistryFactory.deploy();
		await newMaticXImpl.waitForDeployment();
		await newVRImpl.waitForDeployment();

		const proxyAdmin = await ethers.getContractAt(
			[
				"function upgrade(address proxy, address impl) external",
				"function getProxyImplementation(address) view returns (address)",
			],
			ADDR.proxyAdmin
		);
		await proxyAdmin
			.connect(timelock)
			.upgrade(ADDR.maticXProxy, await newMaticXImpl.getAddress());
		await proxyAdmin
			.connect(timelock)
			.upgrade(
				ADDR.validatorRegistryProxy,
				await newVRImpl.getAddress()
			);
	});

	it("Preserves storage layout across the upgrade", async function () {
		expect(await maticX.treasury()).to.equal(preUpgradeSnapshot.treasury);
		expect(await maticX.version()).to.equal(preUpgradeSnapshot.version);
		expect(await maticX.feePercent()).to.equal(
			preUpgradeSnapshot.feePercent
		);
		expect(await maticX.totalSupply()).to.equal(
			preUpgradeSnapshot.totalSupply
		);
		expect(
			await validatorRegistry.preferredDepositValidatorId()
		).to.equal(preUpgradeSnapshot.preferredDeposit);
		expect(
			await validatorRegistry.preferredWithdrawalValidatorId()
		).to.equal(preUpgradeSnapshot.preferredWithdrawal);
		const postList = await validatorRegistry.getValidators();
		expect(postList.length).to.equal(
			preUpgradeSnapshot.validatorList.length
		);
		for (let i = 0; i < postList.length; i++) {
			expect(postList[i]).to.equal(
				preUpgradeSnapshot.validatorList[i]
			);
		}
	});

	it("New sunset state vars default to zero/false", async function () {
		expect(await maticX.depositsPaused()).to.equal(false);
		expect(await maticX.drainComplete()).to.equal(false);
		expect(await maticX.drainedPolBalance()).to.equal(0n);
		expect(await maticX.frozenRate()).to.equal(0n);
		expect(await maticX.balanceModeRedeemDelay()).to.equal(0n);
	});

	it("Drives the full Phase 1 → 2 → 3 sequence on live state", async function () {
		// Phase 1: pause deposits.
		await maticX.connect(multisig).pauseDeposits();
		expect(await maticX.depositsPaused()).to.equal(true);

		// Phase 2: bulk-unstake the active stake. Once active stake is zero,
		// legacy requestWithdraw reverts naturally (no validator can satisfy
		// the withdrawal), so no separate freeze flag is required.

		// Capture per-validator active stake before bulk unstake.
		const activeBefore: { id: bigint; amount: bigint; share: IValidatorShare }[] =
			[];
		for (const id of validatorIds) {
			const shareAddr = await stakeManager.getValidatorContract(id);
			const share = (await ethers.getContractAt(
				"IValidatorShare",
				shareAddr
			)) as IValidatorShare;
			const [amount] = await share.getTotalStake(ADDR.maticXProxy);
			activeBefore.push({ id, amount, share });
		}

		await maticX.connect(multisig).bulkUnstakeAllValidators();

		// Active stake is zero post-unstake; non-zero validators have nonces.
		for (const v of activeBefore) {
			const [after] = await v.share.getTotalStake(ADDR.maticXProxy);
			expect(after).to.equal(0n);
			const nonce = await maticX.getDrainUnbondNonce(v.id);
			if (v.amount > 0n) {
				expect(nonce).to.be.gt(0n);
			} else {
				expect(nonce).to.equal(0n);
			}
		}

		// Advance epochs past the withdrawal delay so unbonds become
		// claimable. Done via stake manager governance.
		const epoch = await stakeManager.epoch();
		const delay = await stakeManager.withdrawalDelay();
		await stakeManager
			.connect(stakeManagerGovernance)
			.setCurrentEpoch(epoch + delay + 1n);

		// Phase 3: claim drained POL + mark complete.
		const claimable: bigint[] = [];
		for (const v of activeBefore) {
			if (v.amount > 0n) claimable.push(v.id);
		}
		expect(claimable.length).to.be.gt(0);

		const polBefore = await pol.balanceOf(ADDR.maticXProxy);
		await maticX.connect(multisig).bulkClaimDrainedStake(claimable);
		const polAfter = await pol.balanceOf(ADDR.maticXProxy);
		const claimed = polAfter - polBefore;
		expect(claimed).to.be.gt(0n);
		expect(await maticX.drainedPolBalance()).to.equal(claimed);

		const supply = await maticX.totalSupply();
		const expectedRate = (claimed * FROZEN_RATE_PRECISION) / supply;

		await expect(maticX.connect(multisig).markDrainComplete())
			.to.emit(maticX, "DrainCompleted")
			.withArgs(claimed, supply, expectedRate);
		expect(await maticX.drainComplete()).to.equal(true);
		expect(await maticX.frozenRate()).to.equal(expectedRate);

		// View functions now reflect the frozen state.
		expect(await maticX.getTotalPooledMatic()).to.equal(claimed);
		const oneMaticX = ethers.parseUnits("1", 18);
		const [polForOne] = await maticX.convertMaticXToPOL(oneMaticX);
		expect(polForOne).to.equal(expectedRate);

		// Clean up validators.
		await validatorRegistry
			.connect(multisig)
			.clearPreferredValidators();
		for (const id of validatorIds) {
			await validatorRegistry
				.connect(multisig)
				.removeValidator(id, true);
		}
		expect((await validatorRegistry.getValidators()).length).to.equal(0);
	});

	it("Balance-mode redemption against frozen state on a real holder", async function () {
		// Use the L1-multisig itself as a balance-mode redeemer if it holds
		// MaticX. Otherwise this assertion is informational. The drain
		// completed in the previous test; both contract-level state and
		// drainedPolBalance are intact.
		expect(await maticX.drainComplete()).to.equal(true);

		const drainedBefore = await maticX.drainedPolBalance();
		const supplyBefore = await maticX.totalSupply();
		const rate = await maticX.frozenRate();

		// Find a known historical MaticX holder address. As a fallback, give
		// the multisig some MaticX by impersonating an existing holder.
		// The Polygon Bridge ERC20Predicate holds the majority of MaticX —
		// not usable here, so we pull a small amount from a known LP-style
		// holder if one exists at the fork block.
		const probableHolder = await impersonate(
			"0xb316fa9Fa91700D7084D377bfdC81Eb9F232f5Ff"
		);
		const probableBalance = await maticX.balanceOf(
			probableHolder.address
		);
		if (probableBalance < ethers.parseUnits("0.01", 18)) {
			this.skip();
		}

		const redeemAmount = ethers.parseUnits("0.01", 18);
		const expectedPol = (redeemAmount * rate) / FROZEN_RATE_PRECISION;
		await maticX
			.connect(probableHolder)
			.requestWithdraw(redeemAmount);

		expect(await maticX.drainedPolBalance()).to.equal(
			drainedBefore - expectedPol
		);
		expect(await maticX.totalSupply()).to.equal(
			supplyBefore - redeemAmount
		);

		// Rate invariant holds.
		expect(
			(((await maticX.drainedPolBalance()) * FROZEN_RATE_PRECISION) /
				(await maticX.totalSupply()))
		).to.equal(rate);

		const polBefore = await pol.balanceOf(probableHolder.address);
		await maticX.connect(probableHolder).claimBalanceWithdrawal(0n);
		const polAfter = await pol.balanceOf(probableHolder.address);
		expect(polAfter - polBefore).to.equal(expectedPol);
	});
});
