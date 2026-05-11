import fs from "node:fs";
import path from "node:path";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Deployment, upgrade and Gnosis-Safe batch helpers for the MaticX drain-and-
 * hold sunset. Invocation:
 *
 *   hardhat sunset:deploy-implementations --network ethereum
 *   hardhat sunset:encode-timelock --network ethereum
 *   hardhat sunset:verify-upgrade --network ethereum
 *   hardhat sunset:encode-phase1
 *   hardhat sunset:encode-phase2
 *   hardhat sunset:encode-phase3
 *
 * encode-* tasks emit Safe Transaction Builder JSON on stdout. Implementation
 * addresses persist to <network>-deployment-info.json under the keys
 * `maticX_sunset_impl` and `validator_registry_sunset_impl`.
 */

const ADDR = {
	maticXProxy: "0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645",
	validatorRegistryProxy: "0xf556442D5B77A4B0252630E15d8BbE2160870d77",
	proxyAdmin: "0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A",
	timelock: "0x20Ea6f63de406040E1e4B67aD98E84A0Eb3778Be",
	l1Multisig: "0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67",
} as const;

const SUNSET_VALIDATOR_IDS = [110, 79, 117, 121, 32];
const TIMELOCK_DELAY_SECONDS = 86_400;
const TIMELOCK_BATCH_SALT_TEXT = "MATICX_SUNSET_UPGRADE";

type Hex = `0x${string}`;
interface SafeTxItem {
	to: string;
	value: string;
	data: Hex;
	operation: 0;
}

function writeDeploymentField(
	network: string,
	key: string,
	value: string
): void {
	const filePath = path.join(process.cwd(), `${network}-deployment-info.json`);
	const current = fs.existsSync(filePath)
		? JSON.parse(fs.readFileSync(filePath, "utf8"))
		: {};
	current[key] = value;
	fs.writeFileSync(filePath, JSON.stringify(current, null, "\t") + "\n");
	console.log(`  saved ${key} = ${value} -> ${filePath}`);
}

function readDeploymentField(
	network: string,
	key: string
): string | undefined {
	const filePath = path.join(process.cwd(), `${network}-deployment-info.json`);
	if (!fs.existsSync(filePath)) return undefined;
	const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
	return data[key];
}

async function deployImplementation(
	hre: HardhatRuntimeEnvironment,
	contractName: string,
	proxyAddress: string
): Promise<string> {
	const Factory = await hre.ethers.getContractFactory(contractName);

	console.log(`Validating storage-layout compatibility for ${contractName}...`);
	await hre.upgrades.validateUpgrade(proxyAddress, Factory, {
		kind: "transparent",
	});

	console.log(`Deploying new ${contractName} implementation...`);
	const impl = await Factory.deploy();
	await impl.waitForDeployment();
	const addr = await impl.getAddress();
	console.log(`  ${contractName} impl at ${addr}`);
	return addr;
}

task("sunset:deploy-implementations")
	.setDescription(
		"Deploys the sunset MaticX + ValidatorRegistry implementations"
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		const network = hre.network.name;
		const maticXImpl = await deployImplementation(
			hre,
			"MaticX",
			ADDR.maticXProxy
		);
		const vrImpl = await deployImplementation(
			hre,
			"ValidatorRegistry",
			ADDR.validatorRegistryProxy
		);

		writeDeploymentField(network, "maticX_sunset_impl", maticXImpl);
		writeDeploymentField(
			network,
			"validator_registry_sunset_impl",
			vrImpl
		);

		console.log(
			"\nNext: hardhat sunset:encode-timelock --network",
			network
		);
	});

task("sunset:encode-timelock")
	.setDescription(
		"Emits the Timelock scheduleBatch / executeBatch calldata for the proxy upgrades"
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		const network = hre.network.name;
		const maticXImpl = readDeploymentField(
			network,
			"maticX_sunset_impl"
		);
		const vrImpl = readDeploymentField(
			network,
			"validator_registry_sunset_impl"
		);
		if (!maticXImpl || !vrImpl) {
			throw new Error(
				"Run sunset:deploy-implementations first to populate impl addresses."
			);
		}

		const proxyAdminIface = new hre.ethers.Interface([
			"function upgrade(address proxy, address impl) external",
		]);
		const upgradeMaticX = proxyAdminIface.encodeFunctionData("upgrade", [
			ADDR.maticXProxy,
			maticXImpl,
		]);
		const upgradeVR = proxyAdminIface.encodeFunctionData("upgrade", [
			ADDR.validatorRegistryProxy,
			vrImpl,
		]);

		const targets = [ADDR.proxyAdmin, ADDR.proxyAdmin];
		const values = [0n, 0n];
		const payloads = [upgradeMaticX, upgradeVR];
		const predecessor = hre.ethers.ZeroHash;
		const salt = hre.ethers.id(TIMELOCK_BATCH_SALT_TEXT);

		const timelockIface = new hre.ethers.Interface([
			"function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
			"function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
		]);

		const scheduleData = timelockIface.encodeFunctionData(
			"scheduleBatch",
			[
				targets,
				values,
				payloads,
				predecessor,
				salt,
				TIMELOCK_DELAY_SECONDS,
			]
		);
		const executeData = timelockIface.encodeFunctionData("executeBatch", [
			targets,
			values,
			payloads,
			predecessor,
			salt,
		]);

		console.log("Timelock target:", ADDR.timelock);
		console.log("Schedule calldata (call from Old-Admin-Safe):");
		console.log(" ", scheduleData);
		console.log(
			`After ${TIMELOCK_DELAY_SECONDS}s, Execute calldata (callable by anyone):`
		);
		console.log(" ", executeData);
	});

task("sunset:verify-upgrade")
	.setDescription(
		"Verifies post-upgrade state: implementations correct, new state vars zeroed"
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		const proxyAdmin = await hre.ethers.getContractAt(
			[
				"function getProxyImplementation(address proxy) view returns (address)",
			],
			ADDR.proxyAdmin
		);
		const maticXImpl: string = await proxyAdmin.getProxyImplementation(
			ADDR.maticXProxy
		);
		const vrImpl: string = await proxyAdmin.getProxyImplementation(
			ADDR.validatorRegistryProxy
		);
		console.log("MaticX impl:", maticXImpl);
		console.log("ValidatorRegistry impl:", vrImpl);

		const maticX = await hre.ethers.getContractAt(
			"MaticX",
			ADDR.maticXProxy
		);
		const depositsPaused = await maticX.depositsPaused();
		const drainComplete = await maticX.drainComplete();
		const drainedPolBalance = await maticX.drainedPolBalance();
		const frozenRate = await maticX.frozenRate();
		const balanceModeRedeemDelay = await maticX.balanceModeRedeemDelay();

		console.log("depositsPaused        ", depositsPaused);
		console.log("drainComplete         ", drainComplete);
		console.log("drainedPolBalance     ", drainedPolBalance.toString());
		console.log("frozenRate            ", frozenRate.toString());
		console.log(
			"balanceModeRedeemDelay",
			balanceModeRedeemDelay.toString()
		);

		if (
			depositsPaused ||
			drainComplete ||
			drainedPolBalance !== 0n ||
			frozenRate !== 0n ||
			balanceModeRedeemDelay !== 0n
		) {
			throw new Error(
				"Post-upgrade state is not the expected fresh zeroed state."
			);
		}
		console.log("Sunset upgrade verified — state is fresh.");
	});

function buildSafeTx(items: SafeTxItem[]) {
	return {
		version: "1.0",
		chainId: "1",
		createdAt: Date.now(),
		meta: {
			name: "MaticX Sunset Batch",
			description:
				"Drain-and-hold sunset operations executed by L1-Multisig",
		},
		transactions: items,
	};
}

task("sunset:encode-phase1")
	.setDescription("Safe-builder JSON for Phase 1: pauseDeposits")
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		const iface = new hre.ethers.Interface([
			"function pauseDeposits()",
			"function setBalanceModeRedeemDelay(uint256)",
		]);
		const items: SafeTxItem[] = [
			{
				to: ADDR.maticXProxy,
				value: "0",
				data: iface.encodeFunctionData(
					"setBalanceModeRedeemDelay",
					[0]
				) as Hex,
				operation: 0,
			},
			{
				to: ADDR.maticXProxy,
				value: "0",
				data: iface.encodeFunctionData("pauseDeposits") as Hex,
				operation: 0,
			},
		];
		console.log(JSON.stringify(buildSafeTx(items), null, 2));
	});

task("sunset:encode-phase2")
	.setDescription(
		"Safe-builder JSON for Phase 2: bulkUnstakeAllValidators"
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		const iface = new hre.ethers.Interface([
			"function bulkUnstakeAllValidators()",
		]);
		const items: SafeTxItem[] = [
			{
				to: ADDR.maticXProxy,
				value: "0",
				data: iface.encodeFunctionData(
					"bulkUnstakeAllValidators"
				) as Hex,
				operation: 0,
			},
		];
		console.log(JSON.stringify(buildSafeTx(items), null, 2));
	});

task("sunset:encode-phase3")
	.setDescription(
		"Safe-builder JSON for Phase 3 atomic drain: bulkClaim + markDrainComplete + clearPreferredValidators + removeValidator x N"
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		const maticXIface = new hre.ethers.Interface([
			"function bulkClaimDrainedStake(uint256[] calldata)",
			"function markDrainComplete()",
		]);
		const vrIface = new hre.ethers.Interface([
			"function clearPreferredValidators()",
			"function removeValidator(uint256, bool)",
		]);

		const items: SafeTxItem[] = [];

		items.push({
			to: ADDR.maticXProxy,
			value: "0",
			data: maticXIface.encodeFunctionData("bulkClaimDrainedStake", [
				SUNSET_VALIDATOR_IDS,
			]) as Hex,
			operation: 0,
		});

		items.push({
			to: ADDR.maticXProxy,
			value: "0",
			data: maticXIface.encodeFunctionData(
				"markDrainComplete"
			) as Hex,
			operation: 0,
		});

		items.push({
			to: ADDR.validatorRegistryProxy,
			value: "0",
			data: vrIface.encodeFunctionData(
				"clearPreferredValidators"
			) as Hex,
			operation: 0,
		});

		for (const id of SUNSET_VALIDATOR_IDS) {
			items.push({
				to: ADDR.validatorRegistryProxy,
				value: "0",
				data: vrIface.encodeFunctionData("removeValidator", [
					id,
					true,
				]) as Hex,
				operation: 0,
			});
		}

		console.log(JSON.stringify(buildSafeTx(items), null, 2));
	});
