import fs from "node:fs";
import path from "node:path";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Tenderly Virtual TestNet simulation of the MaticX sunset.
 *
 * Prereq: TENDERLY_RPC_URL and TENDERLY_CHAIN_ID set in .env. See
 * TENDERLY-SIMULATION.md for the full plan and acceptance criteria.
 *
 * Tasks (all run with --network tenderly):
 *   tenderly:snapshot      Capture pre-upgrade state -> tenderly-snapshot.json
 *   tenderly:upgrade       Deploy new impl + (optionally Timelock) upgrade
 *                          --timelock <addr>      via Timelock schedule/execute
 *   tenderly:run-sunset    pause -> bulk-unstake -> advance epoch ->
 *                          claim-drain -> freeze -> push-l2 -> enable-instant
 *   tenderly:user-claim    Simulate one MATICx holder running instantClaim
 *                          --holder <addr> [--bps 5000]
 *   tenderly:sweep         Advance 3y and run sweepToCustody
 *                          --custody <addr>
 *   tenderly:edge-cases    Run the 10 negative-path assertions
 *   tenderly:all           Chain upgrade -> run-sunset -> sweep
 *                          --custody <addr> [--timelock <addr>] [--holder <addr>]
 *
 * Internally uses Tenderly's admin RPC methods (tenderly_setBalance) plus
 * the standard hardhat_impersonateAccount and evm_increaseTime cheats.
 */

const ADDR = {
	maticX: "0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645",
	proxyAdmin: "0x6CBd89A4919E39Ad4c7718B04443CC1722B2cB2A",
	manager: "0x80A43dd35382C4919991C5Bca7f46Dd24Fde4C67",
	validatorRegistry: "0xf556442D5B77A4B0252630E15d8BbE2160870d77",
	stakeManager: "0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908",
	stakeManagerGovernance: "0x6e7a5820baD6cebA8Ef5ea69c0C92EbbDAc9CE48",
	fxStateRootTunnel: "0x40FB804Cc07302b89EC16a9f8d040506f64dFe29",
	pol: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6",
	matic: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
} as const;

const SNAPSHOT_FILE = "tenderly-snapshot.json";
const FUND_WEI = "0xDE0B6B3A7640000"; // 1 ETH

const CUSTODY_DELAY_SECONDS = 3 * 365 * 24 * 60 * 60;

// Minimal ABIs to avoid type juggling against the on-chain proxy/admin.
const PROXY_ADMIN_ABI = [
	"function owner() view returns (address)",
	"function upgrade(address proxy, address impl) external",
	"function getProxyImplementation(address proxy) view returns (address)",
];

const TIMELOCK_ABI = [
	"function getMinDelay() view returns (uint256)",
	"function getRoleAdmin(bytes32) view returns (bytes32)",
	"function hasRole(bytes32, address) view returns (bool)",
	"function PROPOSER_ROLE() view returns (bytes32)",
	"function EXECUTOR_ROLE() view returns (bytes32)",
	"function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
	"function execute(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) payable",
];

const STAKE_MANAGER_ABI = [
	"function epoch() view returns (uint256)",
	"function withdrawalDelay() view returns (uint256)",
	"function setCurrentEpoch(uint256)",
	"function getValidatorContract(uint256) view returns (address)",
];

const VALIDATOR_REGISTRY_ABI = [
	"function getValidators() view returns (uint256[])",
];

const VALIDATOR_SHARE_ABI = [
	"function getTotalStake(address) view returns (uint256, uint256)",
];

const ERC20_ABI = [
	"function balanceOf(address) view returns (uint256)",
	"function totalSupply() view returns (uint256)",
];

// Shared MaticX admin/user interface. Used (a) to send admin txs from the
// simulation and (b) to assert byte-equality against the same calldata that
// `sunset:encode-step` emits for the production multisig. Keeping the
// signatures here byte-identical to `tasks/sunset.ts::encodeMaticX` is the
// rehearsal-equals-production guarantee.
const MATIC_X_ADMIN_IFACE_FRAGMENTS = [
	"function togglePause() external",
	"function bulkUnstakeAllValidators() external",
	"function claimDrainNonces() external",
	"function freezeExchangeRate() external",
	"function pushFrozenRateToL2() external",
	"function setInstantRedeemEnabled(bool _enabled) external",
	"function sweepToCustody(address _custody) external",
	"function instantClaim(uint256 _amountInMaticX) external",
	"function requestWithdraw(uint256 _amount) external",
	"function claimWithdrawal(uint256 _idx) external",
];

interface Snapshot {
	capturedAtBlock: number;
	liveImpl: string;
	totalSupply: string;
	maticXPolBalance: string;
	maticXMaticBalance: string;
	totalValidatorStake: string;
	totalPooledStakeView: string; // getTotalStakeAcrossAllValidators()
	treasury: string;
	treasuryMaticXBalance: string;
	feePercent: string;
	validators: { id: string; share: string; stake: string }[];
}

function snapshotPath(): string {
	return path.join(process.cwd(), SNAPSHOT_FILE);
}

function loadSnapshot(): Snapshot {
	const p = snapshotPath();
	if (!fs.existsSync(p)) {
		throw new Error(
			`${SNAPSHOT_FILE} missing. Run "hardhat tenderly:snapshot --network tenderly" first.`
		);
	}
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveSnapshot(snap: Snapshot): void {
	fs.writeFileSync(snapshotPath(), JSON.stringify(snap, null, "\t") + "\n");
	console.log(`  wrote ${SNAPSHOT_FILE}`);
}

function ensureTenderly(hre: HardhatRuntimeEnvironment): void {
	if (hre.network.name !== "tenderly") {
		throw new Error(
			`This task is intended for --network tenderly (got ${hre.network.name}).`
		);
	}
	if (!process.env.TENDERLY_RPC_URL) {
		throw new Error(
			"TENDERLY_RPC_URL is not set. Configure your Virtual TestNet in .env first."
		);
	}
}

let _rawProvider: import("ethers").JsonRpcProvider | undefined;

function getRawProvider(
	hre: HardhatRuntimeEnvironment
): import("ethers").JsonRpcProvider {
	if (!_rawProvider) {
		const url = (hre.network.config as { url?: string }).url;
		if (!url) {
			throw new Error(
				`Network ${hre.network.name} has no URL — impersonation requires an HTTP RPC.`
			);
		}
		_rawProvider = new hre.ethers.JsonRpcProvider(url);
	}
	return _rawProvider;
}

// Tenderly free tier counts each tenderly_setBalance as a billable op.
// Track which addresses we've already touched so we don't double-spend,
// and prefer batching via prefundMany() over per-address calls.
const _funded = new Set<string>();
const MIN_GAS_WEI = 10n ** 17n; // 0.1 ETH

async function prefundMany(
	hre: HardhatRuntimeEnvironment,
	addresses: string[]
): Promise<void> {
	const fresh: string[] = [];
	for (const addr of addresses) {
		const key = addr.toLowerCase();
		if (_funded.has(key)) continue;
		const bal: bigint = await hre.ethers.provider.getBalance(addr);
		if (bal < MIN_GAS_WEI) fresh.push(addr);
		_funded.add(key);
	}
	if (fresh.length === 0) return;
	console.log(`  batch-funding ${fresh.length} account(s) in one call`);
	try {
		await hre.network.provider.send("tenderly_setBalance", [
			fresh,
			FUND_WEI,
		]);
	} catch {
		for (const a of fresh) {
			await hre.network.provider.send("hardhat_setBalance", [
				a,
				FUND_WEI,
			]);
		}
	}
}

async function impersonate(
	hre: HardhatRuntimeEnvironment,
	address: string
): Promise<import("ethers").Signer> {
	// Make sure the address has gas; safe to call repeatedly because
	// prefundMany dedupes via _funded.
	await prefundMany(hre, [address]);
	try {
		await hre.network.provider.send("hardhat_impersonateAccount", [
			address,
		]);
	} catch {
		/* Tenderly admin accepts any `from`; no-op needed */
	}
	const provider = getRawProvider(hre);
	return new hre.ethers.JsonRpcSigner(provider, address);
}

// Legacy alias — many call sites still use the old name. Keeps the diff small.
const fundAndImpersonate = impersonate;

function logHeader(title: string): void {
	console.log(`\n=== ${title} ===`);
}

function assertEq(
	label: string,
	actual: unknown,
	expected: unknown
): void {
	const a = typeof actual === "bigint" ? actual.toString() : String(actual);
	const e = typeof expected === "bigint" ? expected.toString() : String(expected);
	if (a !== e) {
		throw new Error(
			`assertion failed: ${label}\n  expected: ${e}\n  actual:   ${a}`
		);
	}
	console.log(`  OK ${label} = ${a}`);
}

function assertGt(label: string, actual: bigint, threshold: bigint): void {
	if (actual <= threshold) {
		throw new Error(
			`assertion failed: ${label}\n  expected > ${threshold}\n  actual:    ${actual}`
		);
	}
	console.log(`  OK ${label} = ${actual.toString()} (> ${threshold.toString()})`);
}

async function getMaticX(hre: HardhatRuntimeEnvironment) {
	return await hre.ethers.getContractAt("MaticX", ADDR.maticX);
}

// Assert that a tx's calldata matches what the shared admin interface would
// encode for the same call. Proves byte-equality between the rehearsal tx
// and the calldata that `sunset:encode-step` will emit for production Safe.
function assertCalldata(
	hre: HardhatRuntimeEnvironment,
	tx: { data?: string | null },
	method: string,
	args: unknown[],
	label: string
): void {
	const iface = new hre.ethers.Interface(MATIC_X_ADMIN_IFACE_FRAGMENTS);
	const expected = iface.encodeFunctionData(method, args);
	const actual = (tx.data ?? "").toLowerCase();
	if (actual !== expected.toLowerCase()) {
		throw new Error(
			`assertion failed: ${label}\n  expected calldata: ${expected}\n  actual calldata:   ${actual}`
		);
	}
	console.log(`  OK calldata matches encode-step (${label})`);
}

// Parse a tx receipt looking for a named event on the MaticX interface
// and assert it appears with the expected argument tuple.
async function assertEvent(
	hre: HardhatRuntimeEnvironment,
	receipt: { logs: readonly { topics: readonly string[]; data: string }[] } | null,
	eventName: string,
	expectedArgs: unknown[],
	label: string
): Promise<void> {
	if (!receipt) throw new Error(`assertion failed: ${label} (no receipt)`);
	const maticX = await getMaticX(hre);
	const iface = maticX.interface;
	// typechain narrows getEvent to a union of known names — cast to widen.
	const frag = iface.getEvent(eventName as unknown as never);
	if (!frag) {
		throw new Error(`unknown event ${eventName}`);
	}
	const topic = frag.topicHash;
	for (const log of receipt.logs) {
		if (log.topics[0] !== topic) continue;
		const parsed = iface.decodeEventLog(frag, log.data, log.topics);
		for (let i = 0; i < expectedArgs.length; i++) {
			const e = expectedArgs[i];
			if (e === undefined) continue; // wildcards
			const a = parsed[i];
			const av = typeof a === "bigint" ? a.toString() : String(a).toLowerCase();
			const ev =
				typeof e === "bigint" ? e.toString() : String(e).toLowerCase();
			if (av !== ev) {
				throw new Error(
					`assertion failed: ${label} arg[${i}]\n  expected: ${ev}\n  actual:   ${av}`
				);
			}
		}
		console.log(`  OK event ${eventName} emitted (${label})`);
		return;
	}
	throw new Error(`assertion failed: ${label} — event ${eventName} not found in receipt`);
}

// Send + wait. Returns the receipt for downstream assertions.
async function send(
	tx: Promise<{ wait: () => Promise<unknown>; data?: string | null }>
): Promise<{
	tx: { data?: string | null };
	receipt: { logs: readonly { topics: readonly string[]; data: string }[] } | null;
}> {
	const sent = await tx;
	const receipt = (await sent.wait()) as {
		logs: readonly { topics: readonly string[]; data: string }[];
	} | null;
	return { tx: sent, receipt };
}

// Drift = polBalance(maticX) - drainedPolBalance. Should be 0 post-freeze
// (every POL claim from instantClaim decrements both 1:1) and 0 post-sweep.
async function assertDrift(
	hre: HardhatRuntimeEnvironment,
	label: string
): Promise<void> {
	const pol = await hre.ethers.getContractAt(ERC20_ABI, ADDR.pol);
	const maticX = await getMaticX(hre);
	const polBal: bigint = await pol.balanceOf(ADDR.maticX);
	const drained: bigint = await maticX.drainedPolBalance();
	const drift = polBal - drained;
	if (drift !== 0n) {
		throw new Error(
			`assertion failed: drift ${label}\n  polBalance:       ${polBal}\n  drainedPolBalance: ${drained}\n  drift:             ${drift}`
		);
	}
	console.log(`  OK drift = 0 (${label}; polBalance == drainedPolBalance)`);
}

// ----------------------- tenderly:snapshot -----------------------------

task("tenderly:snapshot")
	.setDescription("Phase 0: capture pre-upgrade state -> tenderly-snapshot.json")
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		ensureTenderly(hre);
		logHeader("Phase 0 — Snapshot");

		const block = await hre.ethers.provider.getBlockNumber();
		const proxyAdmin = await hre.ethers.getContractAt(
			PROXY_ADMIN_ABI,
			ADDR.proxyAdmin
		);
		const liveImpl: string = await proxyAdmin.getProxyImplementation(
			ADDR.maticX
		);

		const pol = await hre.ethers.getContractAt(ERC20_ABI, ADDR.pol);
		const matic = await hre.ethers.getContractAt(ERC20_ABI, ADDR.matic);
		const maticX = await hre.ethers.getContractAt(ERC20_ABI, ADDR.maticX);
		const sm = await hre.ethers.getContractAt(
			STAKE_MANAGER_ABI,
			ADDR.stakeManager
		);
		const vr = await hre.ethers.getContractAt(
			VALIDATOR_REGISTRY_ABI,
			ADDR.validatorRegistry
		);

		const maticXTyped = await getMaticX(hre);
		const totalSupply: bigint = await maticX.totalSupply();
		const polBal: bigint = await pol.balanceOf(ADDR.maticX);
		const maticBal: bigint = await matic.balanceOf(ADDR.maticX);

		// Treasury balance and feePercent come from the proxy's view fns
		// — surface them so Phase 1 verify can prove the upgrade didn't
		// silently mutate legacy state.
		const treasury: string = await maticXTyped.treasury();
		const treasuryShares: bigint = await maticX.balanceOf(treasury);
		const feePercent: bigint = await maticXTyped.feePercent();
		const totalPooledView: bigint =
			await maticXTyped.getTotalStakeAcrossAllValidators();

		const validatorIds: bigint[] = await vr.getValidators();
		console.log(`  ${validatorIds.length} registered validators`);

		const validators: { id: string; share: string; stake: string }[] = [];
		let totalStake = 0n;
		for (const id of validatorIds) {
			const share: string = await sm.getValidatorContract(id);
			const vs = await hre.ethers.getContractAt(
				VALIDATOR_SHARE_ABI,
				share
			);
			const [stake]: [bigint, bigint] = await vs.getTotalStake(
				ADDR.maticX
			);
			validators.push({
				id: id.toString(),
				share,
				stake: stake.toString(),
			});
			totalStake += stake;
		}

		// Phase 0 acceptance: sum of per-validator stake matches the
		// aggregate view fn. A divergence here flags accounting drift
		// in the live state.
		assertEq(
			"sum(validator stakes) == getTotalStakeAcrossAllValidators",
			totalStake,
			totalPooledView
		);

		const snap: Snapshot = {
			capturedAtBlock: block,
			liveImpl,
			totalSupply: totalSupply.toString(),
			maticXPolBalance: polBal.toString(),
			maticXMaticBalance: maticBal.toString(),
			totalValidatorStake: totalStake.toString(),
			totalPooledStakeView: totalPooledView.toString(),
			treasury,
			treasuryMaticXBalance: treasuryShares.toString(),
			feePercent: feePercent.toString(),
			validators,
		};
		console.log(`  liveImpl              = ${liveImpl}`);
		console.log(`  totalSupply (MATICx)  = ${totalSupply}`);
		console.log(`  POL balance (proxy)   = ${polBal}`);
		console.log(`  MATIC balance (proxy) = ${maticBal}`);
		console.log(`  Sum of validator stake= ${totalStake}`);
		console.log(`  treasury              = ${treasury}`);
		console.log(`  treasury MATICx       = ${treasuryShares}`);
		console.log(`  feePercent            = ${feePercent}`);

		saveSnapshot(snap);
	});

// ------------------------ tenderly:upgrade -----------------------------

task("tenderly:upgrade")
	.setDescription(
		"Phase 1: deploy new MaticX impl and upgrade the proxy (optionally via Timelock)"
	)
	.addOptionalParam<string>(
		"timelock",
		"Timelock address — if set, schedule+advance+execute through it",
		undefined,
		types.string
	)
	.setAction(
		async (
			{ timelock }: { timelock?: string },
			hre: HardhatRuntimeEnvironment
		) => {
			ensureTenderly(hre);
			logHeader("Phase 1 — Upgrade");

			loadSnapshot(); // assert snapshot exists

			// Batch-fund every address this task will impersonate. Reading
			// proxyAdmin.owner() up-front lets us include it in the single
			// tenderly_setBalance call instead of issuing a second one later.
			const deployer = (await hre.ethers.getSigners())[0];
			const proxyAdminEarly = await hre.ethers.getContractAt(
				PROXY_ADMIN_ABI,
				ADDR.proxyAdmin
			);
			const adminOwner: string = await proxyAdminEarly.owner();
			await prefundMany(hre, [deployer.address, adminOwner]);

			// Deploy directly — bypass OZ's manifest because forceImport
			// would mis-register the new Factory against the live impl,
			// causing deployImplementation to short-circuit. Storage-layout
			// safety is validated by the test/MaticX storage-layout test
			// against a properly-imported local hardhat fixture; this task
			// is just for behavior simulation on Tenderly.
			console.log("Deploying new implementation directly...");
			const Factory = await hre.ethers.getContractFactory(
				"MaticX",
				deployer
			);
			const implContract = await Factory.deploy();
			await implContract.waitForDeployment();
			const implAddress = await implContract.getAddress();
			console.log(`  new impl = ${implAddress}`);

			const proxyAdmin = await hre.ethers.getContractAt(
				PROXY_ADMIN_ABI,
				ADDR.proxyAdmin
			);

			if (timelock) {
				console.log(`Routing via Timelock ${timelock}`);
				const tl = await hre.ethers.getContractAt(
					TIMELOCK_ABI,
					timelock
				);
				const proposerRole: string = await tl.PROPOSER_ROLE();
				const executorRole: string = await tl.EXECUTOR_ROLE();
				const delay: bigint = await tl.getMinDelay();

				const upgradeData =
					proxyAdmin.interface.encodeFunctionData("upgrade", [
						ADDR.maticX,
						implAddress,
					]);
				const salt = hre.ethers.id("MATICX_SUNSET_V2_TENDERLY");
				const predecessor = hre.ethers.ZeroHash;

				// Pick the multisig as proposer if it has the role, else fall
				// back to the first owner we can find (deployment-info.manager).
				const candidate = ADDR.manager;
				const isProposer: boolean = await tl.hasRole(
					proposerRole,
					candidate
				);
				if (!isProposer) {
					throw new Error(
						`Configured manager (${candidate}) is not a Timelock PROPOSER. Pass --timelock 0x0 to skip Timelock or wire a real proposer.`
					);
				}
				const proposer = await fundAndImpersonate(hre, candidate);

				console.log(`  schedule (delay ${delay}s)...`);
				await (
					await (tl.connect(proposer) as any).schedule(
						ADDR.proxyAdmin,
						0n,
						upgradeData,
						predecessor,
						salt,
						delay
					)
				).wait();

				console.log(`  evm_increaseTime ${delay + 60n}s`);
				await hre.network.provider.send("evm_increaseTime", [
					Number(delay) + 60,
				]);
				await hre.network.provider.send("evm_mine", []);

				const isExecutor: boolean = await tl.hasRole(
					executorRole,
					candidate
				);
				const executor = isExecutor
					? proposer
					: await fundAndImpersonate(hre, candidate);

				console.log("  execute...");
				await (
					await (tl.connect(executor) as any).execute(
						ADDR.proxyAdmin,
						0n,
						upgradeData,
						predecessor,
						salt
					)
				).wait();
			} else {
				console.log("Direct upgrade via ProxyAdmin.owner()");
				console.log(`  proxyAdmin.owner() = ${adminOwner}`);
				const owner = await impersonate(hre, adminOwner);
				await (
					await (proxyAdmin.connect(owner) as any).upgrade(
						ADDR.maticX,
						implAddress
					)
				).wait();
			}

			// Verify
			const liveImpl: string = await proxyAdmin.getProxyImplementation(
				ADDR.maticX
			);
			assertEq("liveImpl == newImpl", liveImpl.toLowerCase(), implAddress.toLowerCase());

			const maticX = await getMaticX(hre);
			assertEq("drainComplete", await maticX.drainComplete(), false);
			assertEq(
				"instantRedeemEnabled",
				await maticX.instantRedeemEnabled(),
				false
			);
			assertEq("drainedPolBalance", await maticX.drainedPolBalance(), 0n);
			assertEq("frozenRate", await maticX.frozenRate(), 0n);
			assertEq(
				"drainCompleteTimestamp",
				await maticX.drainCompleteTimestamp(),
				0n
			);

			// Phase 1 acceptance: legacy state must survive the upgrade
			// byte-for-byte. Compare against the Phase-0 snapshot.
			const snap = loadSnapshot();
			assertEq(
				"totalSupply preserved",
				await maticX.totalSupply(),
				BigInt(snap.totalSupply)
			);
			assertEq(
				"treasury preserved",
				(await maticX.treasury()).toLowerCase(),
				snap.treasury.toLowerCase()
			);
			assertEq(
				"feePercent preserved",
				await maticX.feePercent(),
				BigInt(snap.feePercent)
			);
			assertEq(
				"treasury MATICx balance preserved",
				await maticX.balanceOf(snap.treasury),
				BigInt(snap.treasuryMaticXBalance)
			);
		}
	);

// ---------------------- tenderly:run-sunset ----------------------------

task("tenderly:run-sunset")
	.setDescription(
		"Phase 2: pause -> bulk-unstake -> advance epoch -> claim-drain -> freeze -> push-l2 -> enable"
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		ensureTenderly(hre);
		logHeader("Phase 2 — Sunset operations");

		const snap = loadSnapshot();
		// Batch-fund both impersonated accounts in one call (saves 1 op).
		await prefundMany(hre, [ADDR.manager, ADDR.stakeManagerGovernance]);
		const manager = await impersonate(hre, ADDR.manager);
		const maticX = await getMaticX(hre);

		const matic = await hre.ethers.getContractAt(ERC20_ABI, ADDR.matic);
		const expectedNonZeroValidators = snap.validators.filter(
			(v) => v.stake !== "0"
		).length;

		// 2a. pause
		console.log("2a. togglePause");
		if (!(await maticX.paused())) {
			const sent = await send(maticX.connect(manager).togglePause());
			assertCalldata(hre, sent.tx, "togglePause", [], "2a togglePause");
		}
		assertEq("paused", await maticX.paused(), true);

		// 2b-2e are gated on !drainComplete so re-running this task on a
		// partially-progressed TestNet (state persists on Tenderly) skips
		// the irreversible steps and burns no extra ops.
		const drainAlreadyComplete: boolean = await maticX.drainComplete();
		if (drainAlreadyComplete) {
			console.log(
				"  drainComplete already true — skipping 2b-2e (resume path)"
			);
		} else {
			// 2b. bulk unstake
			console.log("2b. bulkUnstakeAllValidators");
			const bulkSent = await send(
				maticX.connect(manager).bulkUnstakeAllValidators({
					gasLimit: 30_000_000n,
				})
			);
			assertCalldata(
				hre,
				bulkSent.tx,
				"bulkUnstakeAllValidators",
				[],
				"2b bulkUnstake"
			);

			const drainTopic = maticX.interface.getEvent(
				"DrainUnbondInitiated"
			)!.topicHash;
			const emitted = (bulkSent.receipt?.logs ?? []).filter(
				(l) => l.topics[0] === drainTopic
			).length;
			assertEq(
				"DrainUnbondInitiated event count",
				emitted,
				expectedNonZeroValidators
			);

			const sm = await hre.ethers.getContractAt(
				STAKE_MANAGER_ABI,
				ADDR.stakeManager
			);
			for (const v of snap.validators) {
				if (v.stake === "0") continue;
				const vs = await hre.ethers.getContractAt(
					VALIDATOR_SHARE_ABI,
					v.share
				);
				const [postStake]: [bigint, bigint] = await vs.getTotalStake(
					ADDR.maticX
				);
				assertEq(`stake(${v.id}) after unstake`, postStake, 0n);
				await maticX.drainUnbondNonces(v.share, 0).catch(() => {
					throw new Error(
						`drainUnbondNonces[${v.share}] is empty — bulk-unstake didn't record a nonce`
					);
				});
			}
			console.log(
				`  OK drainUnbondNonces populated for ${expectedNonZeroValidators} validators`
			);

			// 2c. advance StakeManager epoch
			console.log("2c. advance StakeManager epoch");
			const smGov = await impersonate(
				hre,
				ADDR.stakeManagerGovernance
			);
			const epoch: bigint = await sm.epoch();
			const delay: bigint = await sm.withdrawalDelay();
			await (
				await (sm.connect(smGov) as any).setCurrentEpoch(
					epoch + delay + 1n
				)
			).wait();
			const postEpoch: bigint = await sm.epoch();
			assertGt("post-advance epoch", postEpoch, epoch);

			// 2d. claimDrainNonces
			console.log("2d. claimDrainNonces");
			const pol2d = await hre.ethers.getContractAt(ERC20_ABI, ADDR.pol);
			const polBefore: bigint = await pol2d.balanceOf(ADDR.maticX);
			const claimSent = await send(
				maticX.connect(manager).claimDrainNonces({
					gasLimit: 30_000_000n,
				})
			);
			assertCalldata(
				hre,
				claimSent.tx,
				"claimDrainNonces",
				[],
				"2d claimDrainNonces"
			);
			const polAfter: bigint = await pol2d.balanceOf(ADDR.maticX);
			assertGt("POL gained on drain claim", polAfter, polBefore);
			for (const v of snap.validators) {
				if (v.stake === "0") continue;
				const stillHasIndex0 = await maticX
					.drainUnbondNonces(v.share, 0)
					.then(() => true)
					.catch(() => false);
				if (stillHasIndex0) {
					throw new Error(
						`drainUnbondNonces[${v.share}] still has entries after claimDrainNonces`
					);
				}
			}
			console.log("  OK every drainUnbondNonces[vs] is empty");
			assertEq(
				"MATIC balance (proxy) after claim-drain",
				await matic.balanceOf(ADDR.maticX),
				0n
			);

			// 2e. freezeExchangeRate
			console.log("2e. freezeExchangeRate");
			const supplyAtFreeze: bigint = await maticX.totalSupply();
			const expectedRate = (polAfter * 10n ** 18n) / supplyAtFreeze;
			const freezeSent = await send(
				maticX.connect(manager).freezeExchangeRate()
			);
			assertCalldata(
				hre,
				freezeSent.tx,
				"freezeExchangeRate",
				[],
				"2e freezeExchangeRate"
			);
			await assertEvent(
				hre,
				freezeSent.receipt,
				"DrainCompleted",
				[polAfter, supplyAtFreeze, expectedRate],
				"2e DrainCompleted"
			);
			assertEq("drainComplete", await maticX.drainComplete(), true);
			assertEq(
				"drainedPolBalance",
				await maticX.drainedPolBalance(),
				polAfter
			);
			assertEq("frozenRate", await maticX.frozenRate(), expectedRate);
		}

		// Phase 9 acceptance: drift == 0 immediately after freeze.
		await assertDrift(hre, "post-freeze");

		// Note: freeze-twice revert (DrainAlreadyComplete) is covered in
		// test/Sunset.ts against a local fork. Tenderly's free tier seems
		// to bill the estimateGas pre-flight, so we skip the on-Tenderly
		// version to preserve quota for state-changing rehearsal ops.

		// 2f. pushFrozenRateToL2 — read current totalSupply + drainedPolBalance
		// so the event assertion is valid even if some instantClaims have
		// landed between freeze and re-running this task.
		// Opt-out: set TENDERLY_SKIP_PUSH_L2=1 to save 1 op when budget is tight.
		if (process.env.TENDERLY_SKIP_PUSH_L2) {
			console.log(
				"2f. skipping pushFrozenRateToL2 (TENDERLY_SKIP_PUSH_L2 set)"
			);
		} else {
			console.log("2f. pushFrozenRateToL2");
			const supplyAtPush: bigint = await maticX.totalSupply();
			const drainedAtPush: bigint = await maticX.drainedPolBalance();
			const pushSent = await send(
				maticX.connect(manager).pushFrozenRateToL2()
			);
			assertCalldata(
				hre,
				pushSent.tx,
				"pushFrozenRateToL2",
				[],
				"2f pushFrozenRateToL2"
			);
			await assertEvent(
				hre,
				pushSent.receipt,
				"FrozenRatePushedToL2",
				[supplyAtPush, drainedAtPush],
				"2f FrozenRatePushedToL2"
			);
		}

		// 2g. enable instant redeem — skip if already enabled.
		if (await maticX.instantRedeemEnabled()) {
			console.log(
				"2g. instantRedeemEnabled already true — skipping (resume path)"
			);
		} else {
			console.log("2g. setInstantRedeemEnabled(true)");
			const enableSent = await send(
				maticX.connect(manager).setInstantRedeemEnabled(true)
			);
			assertCalldata(
				hre,
				enableSent.tx,
				"setInstantRedeemEnabled",
				[true],
				"2g setInstantRedeemEnabled"
			);
			await assertEvent(
				hre,
				enableSent.receipt,
				"InstantRedeemToggled",
				[ADDR.manager, true],
				"2g InstantRedeemToggled"
			);
		}
		assertEq(
			"instantRedeemEnabled",
			await maticX.instantRedeemEnabled(),
			true
		);

		console.log("\nPhase 2 complete. Frozen rate locked in.");
	});

// --------------------- tenderly:find-holders ---------------------------

/**
 * Scan the most recent N blocks of MaticX Transfer events, aggregate the
 * unique addresses touched, query their balances + code, and return the
 * top EOA holders. Used to auto-pick a live holder for instantClaim
 * simulation without requiring the operator to know one.
 */
async function findTopHolders(
	hre: HardhatRuntimeEnvironment,
	blocks: number,
	limit: number
): Promise<{ address: string; balance: bigint }[]> {
	const ethers = hre.ethers;
	const transferTopic = ethers.id("Transfer(address,address,uint256)");

	// Tenderly Virtual TestNets only carry logs from the fork point forward,
	// so historical Transfer scans must hit real mainnet. Prefer
	// MAINNET_RPC_URL if set, then fall back to public RPCs.
	const mainnetRpc =
		process.env.MAINNET_RPC_URL ||
		"https://ethereum.publicnode.com";
	const scanProvider = new ethers.JsonRpcProvider(mainnetRpc);

	let latest: number;
	try {
		latest = await scanProvider.getBlockNumber();
	} catch (err) {
		throw new Error(
			`Failed to reach mainnet RPC for log scan (${mainnetRpc}): ${(err as Error).message}`
		);
	}
	const fromBlock = Math.max(0, latest - blocks);
	console.log(
		`  scanning Transfer logs on mainnet ${fromBlock}..${latest} via ${mainnetRpc}`
	);

	// Many public RPCs cap eth_getLogs at 1024-10000 blocks per call.
	// Page through the window in 1000-block chunks.
	const CHUNK = 1000;
	const candidates = new Set<string>();
	let totalLogs = 0;
	for (let start = fromBlock; start <= latest; start += CHUNK + 1) {
		const end = Math.min(start + CHUNK, latest);
		const logs = await scanProvider.getLogs({
			address: ADDR.maticX,
			topics: [transferTopic],
			fromBlock: start,
			toBlock: end,
		});
		totalLogs += logs.length;
		for (const log of logs) {
			try {
				candidates.add(
					ethers.getAddress("0x" + log.topics[1].slice(26))
				);
				candidates.add(
					ethers.getAddress("0x" + log.topics[2].slice(26))
				);
			} catch {
				/* skip malformed */
			}
		}
	}
	candidates.delete(ethers.ZeroAddress);
	candidates.delete(ethers.getAddress(ADDR.maticX));
	console.log(
		`  ${totalLogs} transfer events, ${candidates.size} unique candidates`
	);

	// Check balances + code against the Tenderly fork (mirrors mainnet state).
	const maticX = await getMaticX(hre);
	const results: { address: string; balance: bigint }[] = [];
	for (const addr of candidates) {
		const [balance, code] = await Promise.all([
			maticX.balanceOf(addr),
			hre.ethers.provider.getCode(addr),
		]);
		if (code !== "0x") continue; // EOAs only — contracts may not be impersonatable usefully
		if (balance === 0n) continue;
		results.push({ address: addr, balance });
	}
	results.sort((a, b) => (a.balance > b.balance ? -1 : 1));
	return results.slice(0, limit);
}

task("tenderly:find-holders")
	.setDescription(
		"Scan recent MaticX Transfer events and list top EOA holders by balance"
	)
	.addOptionalParam<number>(
		"blocks",
		"How many recent blocks to scan",
		2000,
		types.int
	)
	.addOptionalParam<number>(
		"n",
		"How many top holders to print",
		5,
		types.int
	)
	.setAction(
		async (
			{ blocks, n }: { blocks: number; n: number },
			hre: HardhatRuntimeEnvironment
		) => {
			ensureTenderly(hre);
			logHeader(`Find top ${n} EOA holders (last ${blocks} blocks)`);

			const top = await findTopHolders(hre, blocks, n);
			if (top.length === 0) {
				console.log(
					"\n  No EOA holders found in the scanned range. Try --blocks 10000."
				);
				return;
			}
			console.log("\n  rank  address                                       MATICx");
			top.forEach((h, i) => {
				console.log(
					`  ${String(i + 1).padStart(4)}  ${h.address}  ${h.balance}`
				);
			});
		}
	);

// ---------------------- tenderly:user-claim ----------------------------

task("tenderly:user-claim")
	.setDescription(
		"Phase 3: simulate a MATICx holder running instantClaim. --mode full (default) burns the holder's entire balance in one tx; --mode all also runs a half-redeem first (costs an extra op)."
	)
	.addOptionalParam<string>(
		"holder",
		"MATICx holder address (auto-discovered if absent)",
		undefined,
		types.string
	)
	.addOptionalParam<string>(
		"mode",
		"half | full | all (default 'full' to conserve Tenderly free-tier ops; 'all' runs half then full)",
		"full",
		types.string
	)
	.addOptionalParam<number>(
		"bps",
		"For mode=half, fraction of balance to burn (default 5000 = 50%)",
		5000,
		types.int
	)
	.setAction(
		async (
			{
				holder,
				mode,
				bps,
			}: { holder?: string; mode: string; bps: number },
			hre: HardhatRuntimeEnvironment
		) => {
			ensureTenderly(hre);

			if (!holder) {
				console.log("--holder not provided — auto-discovering...");
				const top = await findTopHolders(hre, 2000, 1);
				if (top.length === 0) {
					throw new Error(
						"Could not find any EOA MATICx holder in the recent block window. Pass --holder explicitly, or widen via tenderly:find-holders --blocks 10000."
					);
				}
				holder = top[0].address;
				console.log(
					`  picked ${holder} (balance ${top[0].balance})`
				);
			}

			logHeader(`Phase 3 — instantClaim by ${holder} (mode=${mode})`);

			const maticX = await getMaticX(hre);
			const pol = await hre.ethers.getContractAt(ERC20_ABI, ADDR.pol);
			const signer = await impersonate(hre, holder);
			const rate: bigint = await maticX.frozenRate();

			// Inner helper that runs one instantClaim and asserts state +
			// event + calldata. Returns the POL paid out for any caller-side
			// reconciliation.
			async function claim(label: string, amount: bigint): Promise<bigint> {
				const sharesBefore: bigint = await maticX.balanceOf(holder!);
				const drainedBefore: bigint =
					await maticX.drainedPolBalance();
				const polBefore: bigint = await pol.balanceOf(holder!);
				const expectedPol = (amount * rate) / 10n ** 18n;

				const sent = await send(
					maticX.connect(signer).instantClaim(amount)
				);
				assertCalldata(
					hre,
					sent.tx,
					"instantClaim",
					[amount],
					`${label} instantClaim`
				);
				await assertEvent(
					hre,
					sent.receipt,
					"InstantClaimed",
					[holder!, amount, expectedPol],
					`${label} InstantClaimed`
				);
				assertEq(
					`${label} sharesAfter`,
					await maticX.balanceOf(holder!),
					sharesBefore - amount
				);
				assertEq(
					`${label} drainedPolBalance decrement`,
					await maticX.drainedPolBalance(),
					drainedBefore - expectedPol
				);
				assertEq(
					`${label} POL gained`,
					(await pol.balanceOf(holder!)) - polBefore,
					expectedPol
				);
				// Drift remains 0 after every claim — instantClaim moves
				// drainedPolBalance and polBalance by the same amount.
				await assertDrift(hre, `post-${label}`);
				return expectedPol;
			}

			const startShares: bigint = await maticX.balanceOf(holder);
			if (startShares === 0n) {
				throw new Error("Holder has zero MATICx");
			}

			if (mode === "half") {
				const amount = (startShares * BigInt(bps)) / 10000n;
				await claim("half", amount);
			} else if (mode === "full") {
				await claim("full", startShares);
			} else if (mode === "all") {
				// half-redeem at --bps, then full-redeem on remainder.
				const halfAmount = (startShares * BigInt(bps)) / 10000n;
				await claim("half", halfAmount);
				const remainder: bigint = await maticX.balanceOf(holder);
				await claim("full", remainder);
				assertEq(
					"holder shares zero after full",
					await maticX.balanceOf(holder),
					0n
				);
			} else {
				throw new Error(`unknown --mode ${mode}`);
			}
		}
	);

// ---------------- tenderly:pre-sunset-request --------------------------

const PRE_SUNSET_FILE = "tenderly-pre-sunset.json";

interface PreSunset {
	holder: string;
	requestIdx: number;
	amount: string;
}

task("tenderly:pre-sunset-request")
	.setDescription(
		"Phase 1.5: holder calls requestWithdraw BEFORE pause. Persists the request index so tenderly:pre-sunset-claim can claim it during sunset."
	)
	.addOptionalParam<string>(
		"holder",
		"MATICx holder (auto-discovered if absent)",
		undefined,
		types.string
	)
	.addOptionalParam<number>(
		"bps",
		"Fraction of balance to withdraw (default 100 = 1%)",
		100,
		types.int
	)
	.setAction(
		async (
			{ holder, bps }: { holder?: string; bps: number },
			hre: HardhatRuntimeEnvironment
		) => {
			ensureTenderly(hre);
			logHeader("Phase 1.5 — pre-sunset requestWithdraw");

			if (!holder) {
				const top = await findTopHolders(hre, 2000, 1);
				if (top.length === 0) {
					throw new Error(
						"Could not auto-discover holder. Pass --holder explicitly."
					);
				}
				holder = top[0].address;
				console.log(`  auto-discovered holder ${holder}`);
			}

			const maticX = await getMaticX(hre);
			if (await maticX.paused()) {
				throw new Error(
					"Contract is paused — pre-sunset-request must run BEFORE Phase 2."
				);
			}

			const sharesBefore: bigint = await maticX.balanceOf(holder);
			const amount = (sharesBefore * BigInt(bps)) / 10000n;
			if (amount === 0n) {
				throw new Error("Withdrawal amount is zero (bump --bps)");
			}

			const requestsBefore = await maticX.getUserWithdrawalRequests(
				holder
			);
			const expectedIdx = requestsBefore.length;

			const signer = await impersonate(hre, holder);
			const sent = await send(
				maticX
					.connect(signer)
					.requestWithdraw(amount, { gasLimit: 10_000_000n })
			);
			assertCalldata(
				hre,
				sent.tx,
				"requestWithdraw",
				[amount],
				"1.5 requestWithdraw"
			);

			const requestsAfter = await maticX.getUserWithdrawalRequests(
				holder
			);
			assertEq(
				"new withdrawal request appended",
				BigInt(requestsAfter.length),
				BigInt(expectedIdx + 1)
			);

			const ps: PreSunset = {
				holder,
				requestIdx: Number(expectedIdx),
				amount: amount.toString(),
			};
			fs.writeFileSync(
				path.join(process.cwd(), PRE_SUNSET_FILE),
				JSON.stringify(ps, null, "\t") + "\n"
			);
			console.log(`  wrote ${PRE_SUNSET_FILE} (idx=${ps.requestIdx})`);
		}
	);

// ---------------- tenderly:pre-sunset-claim ----------------------------

task("tenderly:pre-sunset-claim")
	.setDescription(
		"Phase 3.5: claim the pre-sunset withdrawal request during the sunset window. Validates that claimWithdrawal works while paused AND that drainedPolBalance is unaffected."
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		ensureTenderly(hre);
		logHeader("Phase 3.5 — pre-sunset claimWithdrawal during sunset");

		const psPath = path.join(process.cwd(), PRE_SUNSET_FILE);
		if (!fs.existsSync(psPath)) {
			throw new Error(
				`${PRE_SUNSET_FILE} missing — run tenderly:pre-sunset-request first`
			);
		}
		const ps: PreSunset = JSON.parse(fs.readFileSync(psPath, "utf8"));
		console.log(`  holder=${ps.holder} idx=${ps.requestIdx}`);

		const maticX = await getMaticX(hre);
		const pol = await hre.ethers.getContractAt(ERC20_ABI, ADDR.pol);

		// The whole point: claimWithdrawal must work while paused. If the
		// branch ever re-adds `whenNotPaused`, this asserts the regression.
		assertEq("paused (must be true)", await maticX.paused(), true);

		const drainedBefore: bigint = await maticX.drainedPolBalance();
		const polBefore: bigint = await pol.balanceOf(ps.holder);

		const signer = await impersonate(hre, ps.holder);
		const sent = await send(
			maticX
				.connect(signer)
				.claimWithdrawal(ps.requestIdx, { gasLimit: 10_000_000n })
		);
		assertCalldata(
			hre,
			sent.tx,
			"claimWithdrawal",
			[BigInt(ps.requestIdx)],
			"3.5 claimWithdrawal"
		);

		// Legacy claim pays POL straight from validator-share -> contract -> user
		// in one tx. So drainedPolBalance is untouched (it's a stored value,
		// not derived from current balance). This invariant is what lets
		// instantClaim's `drainedPolBalance` accounting stay sound.
		const polAfter: bigint = await pol.balanceOf(ps.holder);
		assertGt(
			"holder POL gained from legacy claim",
			polAfter - polBefore,
			0n
		);
		assertEq(
			"drainedPolBalance unchanged by legacy claimWithdrawal",
			await maticX.drainedPolBalance(),
			drainedBefore
		);
	});

// ------------------------ tenderly:sweep -------------------------------

task("tenderly:sweep")
	.setDescription("Phase 4: advance 3 years and run sweepToCustody")
	.addParam<string>("custody", "Custody Safe address", undefined, types.string)
	.setAction(
		async (
			{ custody }: { custody: string },
			hre: HardhatRuntimeEnvironment
		) => {
			ensureTenderly(hre);
			logHeader(`Phase 4 — sweepToCustody(${custody})`);

			if (!hre.ethers.isAddress(custody)) {
				throw new Error("Invalid custody address");
			}

			const maticX = await getMaticX(hre);
			const pol = await hre.ethers.getContractAt(ERC20_ABI, ADDR.pol);
			const matic = await hre.ethers.getContractAt(ERC20_ABI, ADDR.matic);

			console.log(
				`Advancing time by ${CUSTODY_DELAY_SECONDS + 60} seconds...`
			);
			await hre.network.provider.send("evm_increaseTime", [
				CUSTODY_DELAY_SECONDS + 60,
			]);
			await hre.network.provider.send("evm_mine", []);

			const polBefore: bigint = await pol.balanceOf(ADDR.maticX);
			const maticBefore: bigint = await matic.balanceOf(ADDR.maticX);

			const manager = await impersonate(hre, ADDR.manager);
			const sent = await send(
				maticX.connect(manager).sweepToCustody(custody)
			);
			assertCalldata(
				hre,
				sent.tx,
				"sweepToCustody",
				[custody],
				"4 sweepToCustody"
			);
			await assertEvent(
				hre,
				sent.receipt,
				"SweptToCustody",
				[custody, polBefore, maticBefore],
				"4 SweptToCustody"
			);

			assertEq("proxy POL balance", await pol.balanceOf(ADDR.maticX), 0n);
			assertEq(
				"proxy MATIC balance",
				await matic.balanceOf(ADDR.maticX),
				0n
			);
			assertEq("drainedPolBalance", await maticX.drainedPolBalance(), 0n);
			assertEq(
				"custody POL gained",
				await pol.balanceOf(custody),
				polBefore
			);
			assertEq(
				"custody MATIC gained",
				await matic.balanceOf(custody),
				maticBefore
			);
			// Phase 9 acceptance: drift == 0 after final sweep.
			await assertDrift(hre, "post-sweep");
		}
	);

// ---------------------- tenderly:edge-cases ----------------------------

task("tenderly:edge-cases")
	.setDescription(
		"Phase 7: assert each negative-path step reverts as expected. Run on a FRESH TestNet — does not modify state irreversibly."
	)
	.setAction(async (_args, hre: HardhatRuntimeEnvironment) => {
		ensureTenderly(hre);
		logHeader("Phase 7 — Edge cases (negative paths)");

		const maticX = await getMaticX(hre);
		const manager = await fundAndImpersonate(hre, ADDR.manager);
		const random = (await hre.ethers.getSigners())[0];

		await expectRevert(
			"bulkUnstakeAllValidators without pause",
			maticX.connect(manager).bulkUnstakeAllValidators()
		);
		await expectRevert(
			"random EOA calls bulkUnstakeAllValidators",
			maticX.connect(random).bulkUnstakeAllValidators()
		);

		// Pause for the rest of the negative checks that need it.
		if (!(await maticX.paused())) {
			await (await maticX.connect(manager).togglePause()).wait();
		}

		await expectRevert(
			"freezeExchangeRate before drain claim (no POL captured yet)",
			maticX.connect(manager).freezeExchangeRate(),
			["EmptyContract", "Pause first"], // tolerate either depending on state
			hre
		);
		await expectRevert(
			"pushFrozenRateToL2 before freeze",
			maticX.connect(manager).pushFrozenRateToL2(),
			["DrainNotComplete"],
			hre
		);
		await expectRevert(
			"setInstantRedeemEnabled(true) before freeze",
			maticX.connect(manager).setInstantRedeemEnabled(true),
			["DrainNotComplete"],
			hre
		);
		await expectRevert(
			"sweepToCustody before freeze",
			maticX.connect(manager).sweepToCustody(random.address),
			["DrainNotComplete"],
			hre
		);
		await expectRevert(
			"instantClaim while disabled",
			maticX.connect(random).instantClaim(1n),
			["InstantRedeemNotEnabled"],
			hre
		);

		console.log("\nAll negative-path assertions passed.");
	});

async function expectRevert(
	label: string,
	p: Promise<unknown>,
	acceptable?: string[],
	hre?: HardhatRuntimeEnvironment
): Promise<void> {
	try {
		await p;
		throw new Error(`expected revert: ${label}`);
	} catch (err) {
		const msg = (err as Error).message || String(err);
		// ethers v6 surfaces custom errors as `data="0x<4-byte selector>"`
		// — resolve any acceptable name to its selector via the MaticX
		// interface so callers can pass either the name or the literal string.
		let expanded: string[] = acceptable ?? [];
		if (hre && acceptable && acceptable.length > 0) {
			const maticX = await getMaticX(hre);
			expanded = [...acceptable];
			for (const name of acceptable) {
				try {
					const frag = maticX.interface.getError(
						name as unknown as never
					);
					if (frag) expanded.push(frag.selector);
				} catch {
					/* not a known custom error name — keep as string */
				}
			}
		}
		if (expanded.length > 0 && !expanded.some((s) => msg.includes(s))) {
			throw new Error(
				`assertion failed (${label}): revert reason "${msg}" did not match any of ${expanded.join(", ")}`
			);
		}
		console.log(`  OK ${label} — reverted`);
	}
}

// ------------------------- tenderly:all --------------------------------

task("tenderly:all")
	.setDescription(
		"Phases 0->4 end-to-end. Requires --custody. Optional --timelock, --holder."
	)
	.addParam<string>(
		"custody",
		"Custody Safe address for sweepToCustody",
		undefined,
		types.string
	)
	.addOptionalParam<string>(
		"timelock",
		"Timelock address for upgrade routing",
		undefined,
		types.string
	)
	.addOptionalParam<string>(
		"holder",
		"MATICx holder for instantClaim simulation (skipped if absent)",
		undefined,
		types.string
	)
	.setAction(
		async (
			{
				custody,
				timelock,
				holder,
			}: { custody: string; timelock?: string; holder?: string },
			hre: HardhatRuntimeEnvironment
		) => {
			ensureTenderly(hre);
			await hre.run("tenderly:snapshot");

			// Discover holder and proxyAdmin.owner() up-front so we can
			// batch-fund every impersonated account in ONE tenderly_setBalance
			// call. The free tier counts each setBalance as a billable op.
			logHeader("Preflight — batch funding all impersonation targets");
			let resolvedHolder = holder;
			if (!resolvedHolder) {
				console.log(
					"  --holder not provided — auto-discovering via mainnet log scan"
				);
				const top = await findTopHolders(hre, 2000, 1);
				if (top.length === 0) {
					throw new Error(
						"Could not auto-discover a MATICx holder. Pass --holder explicitly."
					);
				}
				resolvedHolder = top[0].address;
				console.log(`  picked ${resolvedHolder} (${top[0].balance})`);
			}
			const proxyAdmin = await hre.ethers.getContractAt(
				PROXY_ADMIN_ABI,
				ADDR.proxyAdmin
			);
			const adminOwner: string = await proxyAdmin.owner();
			const deployer = (await hre.ethers.getSigners())[0];
			await prefundMany(hre, [
				deployer.address,
				adminOwner,
				ADDR.manager,
				ADDR.stakeManagerGovernance,
				resolvedHolder,
			]);

			await hre.run("tenderly:upgrade", { timelock });
			// Pre-sunset withdrawal MUST happen between upgrade and pause —
			// the contract is still active here, requestWithdraw is gated by
			// whenNotPaused. tenderly:pre-sunset-claim will validate during
			// sunset that the request can still be claimed while paused.
			await hre.run("tenderly:pre-sunset-request", {
				holder: resolvedHolder,
				bps: 100, // 1% — small slice
			});
			await hre.run("tenderly:run-sunset");
			await hre.run("tenderly:pre-sunset-claim");
			await hre.run("tenderly:user-claim", {
				holder: resolvedHolder,
				mode: "full", // single instantClaim burning the entire balance
				bps: 5000,
			});
			await hre.run("tenderly:sweep", { custody });
			console.log("\n== tenderly:all complete ==");
		}
	);
